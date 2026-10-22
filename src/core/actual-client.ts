import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as actual from '@actual-app/api';
import type { EngineConfig } from './config.js';
import type { Logger } from './logger.js';
import { describeError } from './errors.js';

/**
 * Owns the entire `@actual-app/api` lifecycle (SPECIFICATION.md §1.3, §3.4).
 *
 * Two hard constraints encoded here:
 *  1. `dataDir`/`serverFiles` MUST live under /tmp — the only writable path on Vercel.
 *  2. `actual.shutdown()` MUST run before the function returns, on EVERY path, or the warm
 *     instance leaks the SQLite handle + background workers. `withSession` is the only
 *     sanctioned way to open a session, and its `finally` guarantees teardown.
 */

/** Result of `importTransactions` we care about. */
export interface ImportResult {
  added: string[];
  updated: string[];
}

/** The narrow surface plugins/engine use inside a session. */
export interface ActualSession {
  importTransactions(accountId: string, transactions: ActualTransaction[]): Promise<ImportResult>;
  /** Read an account's transactions in [startDate, endDate] (used by balance reconcile). */
  getTransactions(accountId: string, startDate: string, endDate: string): Promise<ActualTransactionRecord[]>;
  /** Patch fields on an existing transaction by id. */
  updateTransaction(id: string, fields: Partial<ActualTransaction>): Promise<unknown>;
}

/** Actual's transaction shape (subset we populate). `imported_id` drives dedupe. */
export interface ActualTransaction {
  account: string;
  date: string;
  amount: number;
  payee_name?: string;
  notes?: string;
  cleared?: boolean;
  imported_id: string;
}

/** Subset of a stored Actual transaction we read back. */
export interface ActualTransactionRecord {
  id: string;
  amount: number;
  imported_id?: string;
}

let initialized = false;

async function init(config: EngineConfig, logger: Logger): Promise<void> {
  // Cold start = empty /tmp. Recreate the data dir every time; mkdir is idempotent.
  await mkdir(config.ACTUAL_DATA_DIR, { recursive: true });

  await actual.init({
    dataDir: config.ACTUAL_DATA_DIR, // MUST be under /tmp on Vercel
    serverURL: config.ACTUAL_SERVER_URL,
    password: config.ACTUAL_PASSWORD,
  });
  initialized = true;

  // (Re)hydrate the budget. On a warm instance this is a cheap delta sync; on cold start, a
  // full pull. Either way we never assume the /tmp cache survived.
  await actual.downloadBudget(config.ACTUAL_SYNC_ID);
  logger.info('actual session ready', { dataDir: config.ACTUAL_DATA_DIR });
}

/**
 * Run `fn` inside a fully-managed Actual session. Guarantees `shutdown()` afterwards.
 * This is the ONLY way the rest of the codebase is allowed to touch `@actual-app/api`.
 */
export async function withSession<T>(
  config: EngineConfig,
  logger: Logger,
  fn: (session: ActualSession) => Promise<T>,
): Promise<T> {
  await init(config, logger);

  const session: ActualSession = {
    importTransactions: (accountId, transactions) =>
      actual.importTransactions(accountId, transactions) as Promise<ImportResult>,
    getTransactions: (accountId, startDate, endDate) =>
      actual.getTransactions(accountId, startDate, endDate) as Promise<ActualTransactionRecord[]>,
    updateTransaction: (id, fields) => actual.updateTransaction(id, fields),
  };

  try {
    return await fn(session);
  } finally {
    try {
      if (initialized) {
        await actual.shutdown();
        initialized = false;
      }
    } catch (err) {
      // Never let a teardown failure mask the real result; just record it.
      logger.error('actual.shutdown() failed', { err: describeError(err) });
    }
  }
}

/**
 * True only when both versions are known AND differ.
 *
 * Deliberately conservative: an unknown client or an unreachable server must NOT be reported as
 * skew. The first cut of this check read the client version via `require('@actual-app/api/
 * package.json')`, which fails with ERR_PACKAGE_PATH_NOT_EXPORTED, so it reported skew on every
 * single call — a diagnostic that would have sent us chasing a version mismatch that wasn't there.
 */
export function isSkewed(client: string | null, server: string | null): boolean {
  return client !== null && server !== null && client !== server;
}

/** Client/server version pair, and whether they are known to disagree. */
export interface VersionSkew {
  client: string | null;
  server: string | null;
  skewed: boolean;
}

/** Installed @actual-app/api version, or null if it can't be determined. */
function installedClientVersion(): string | null {
  const require = createRequire(import.meta.url);

  // The package's `exports` map does NOT expose ./package.json, so requiring it directly fails
  // with ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the entry point and walk up to the manifest.
  try {
    let dir = dirname(require.resolve('@actual-app/api'));
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === '@actual-app/api' && manifest.version) return manifest.version;
      } catch {
        /* not here; keep walking */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through to our own pin */
  }

  // Fallback: we pin the dependency exactly, so our own manifest is authoritative enough.
  try {
    const own = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const pinned = own.dependencies?.['@actual-app/api'];
    if (pinned) return pinned.replace(/^[^\d]*/, '') || null;
  } catch {
    /* give up */
  }
  return null;
}

/**
 * Compare our pinned @actual-app/api version against the live sync-server's.
 *
 * Why this exists: Pikapods auto-updates the Actual sync-server about monthly, roughly 10-17
 * days after each npm release, while our client version is baked in at build time. When they
 * diverge the session still opens (init + downloadBudget succeed) but every API call above it
 * fails — so the symptom is a bare 503 against a server that looks perfectly healthy. That cost
 * four days in September 2026 (26.7.0 vs 26.9.0) and three more in October (26.9.0 vs 26.10.0).
 *
 * Never throws, and never claims skew it cannot prove: `skewed` is true only when BOTH versions
 * are known AND differ. A diagnostic that cries wolf is worse than no diagnostic.
 */
export async function checkVersionSkew(config: EngineConfig): Promise<VersionSkew> {
  const client = installedClientVersion();

  let server: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(new URL('/info', config.ACTUAL_SERVER_URL), {
      signal: controller.signal,
    });
    if (response.ok) {
      const info = (await response.json()) as { build?: { version?: string } };
      server = info.build?.version ?? null;
    }
  } catch {
    /* server unreachable or malformed; leave null */
  } finally {
    clearTimeout(timer);
  }

  return { client, server, skewed: isSkewed(client, server) };
}

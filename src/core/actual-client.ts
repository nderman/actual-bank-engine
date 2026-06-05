import { mkdir } from 'node:fs/promises';
import * as actual from '@actual-app/api';
import type { EngineConfig } from './config.js';
import type { Logger } from './logger.js';

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
      logger.error('actual.shutdown() failed', { err: String(err) });
    }
  }
}

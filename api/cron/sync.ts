import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSession } from '../../src/core/actual-client.js';
import { buildContext } from '../../src/core/context.js';
import { ingest } from '../../src/core/ledger.js';
import { isBankPlugin } from '../../src/core/plugin.js';
import type { NormalizedTransaction } from '../../src/core/schema.js';
import { allPlugins } from '../../src/plugins/registry.js';

/** Look back this many days each scheduled sweep; comfortably overlaps the daily cadence so
 *  nothing slips between runs. Duplicates are harmless — Actual dedupes on imported_id. */
const LOOKBACK_DAYS = 3;

/** Hard cap for manual backfills, so a stray `?days=99999` can't hammer the bank. */
const MAX_LOOKBACK_DAYS = 730;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function firstQuery(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Resolve the [startDate, endDate] window. Defaults to the rolling LOOKBACK_DAYS sweep, but a
 * bearer-authenticated caller can widen it for a one-time backfill via query params:
 *   ?days=180            → today-180 .. today
 *   ?from=YYYY-MM-DD[&to=YYYY-MM-DD]
 */
function resolveWindow(req: VercelRequest, now: Date): { startDate: string; endDate: string } {
  const from = firstQuery(req.query.from);
  const to = firstQuery(req.query.to);
  const daysRaw = firstQuery(req.query.days);

  const endDate = from && ISO_DATE.test(to ?? '') ? (to as string) : isoDate(now);

  if (from && ISO_DATE.test(from)) {
    return { startDate: from, endDate };
  }

  let days = LOOKBACK_DAYS;
  if (daysRaw !== undefined) {
    const parsed = Number(daysRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      days = Math.min(Math.floor(parsed), MAX_LOOKBACK_DAYS);
    }
  }
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { startDate: isoDate(start), endDate: isoDate(now) };
}

function authorized(req: VercelRequest, secret: string): boolean {
  // Vercel Cron presents `Authorization: Bearer <CRON_SECRET>`.
  const header = req.headers.authorization;
  return header === `Bearer ${secret}`;
}

interface PluginOutcome {
  plugin: string;
  ok: boolean;
  fetched?: number;
  error?: string;
}

/**
 * Scheduled polling sweep: GET /api/cron/sync (SPECIFICATION.md §1.1, §3.4, §3.5).
 *
 * One Actual session for the whole sweep (download budget once, import many, shut down once).
 * Per-plugin failures are isolated — a throwing plugin doesn't abort the others; we still import
 * the successes and report partial status with HTTP 200 so Vercel Cron doesn't retry-storm.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const ctx = buildContext({ path: '/api/cron/sync' });

  if (!authorized(req, ctx.config.CRON_SECRET)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const now = ctx.now();
  const { startDate, endDate } = resolveWindow(req, now);

  const pollers = allPlugins().filter(isBankPlugin);
  const outcomes: PluginOutcome[] = [];
  const collected: NormalizedTransaction[] = [];

  // Phase 1: fetch from every plugin, isolating failures.
  for (const plugin of pollers) {
    const log = ctx.logger.child({ source: plugin.id });
    const pluginCtx = { ...ctx, logger: log };
    try {
      await plugin.init(pluginCtx);
      const txns = await plugin.fetchTransactions(startDate, endDate, pluginCtx);
      collected.push(...txns);
      outcomes.push({ plugin: plugin.id, ok: true, fetched: txns.length });
    } catch (err) {
      log.error('plugin fetch failed', { err: String(err) });
      outcomes.push({ plugin: plugin.id, ok: false, error: String(err) });
    }
  }

  // Phase 2: import everything in one guarded session.
  let summary = { fetched: 0, imported: 0, skippedDuplicate: 0 };
  if (collected.length > 0) {
    try {
      summary = await withSession(ctx.config, ctx.logger, (session) =>
        ingest(session, ctx.logger, collected),
      );
    } catch (err) {
      ctx.logger.error('cron ingest failed', { err: String(err) });
      res.status(503).json({ window: { startDate, endDate }, outcomes, error: 'ingest failed' });
      return;
    }
  }

  res.status(200).json({ window: { startDate, endDate }, summary, outcomes });
}

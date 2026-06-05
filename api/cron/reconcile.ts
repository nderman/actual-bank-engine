import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSession } from '../../src/core/actual-client.js';
import { buildContext } from '../../src/core/context.js';
import { reconcileAccount } from '../../src/core/reconcile.js';
import type { ReconcileOutcome } from '../../src/core/reconcile.js';
import { fetchInvestecBalanceCents } from '../../src/plugins/investec/api.js';

function authorized(req: VercelRequest, secret: string): boolean {
  return req.headers.authorization === `Bearer ${secret}`;
}

/**
 * Scheduled balance reconciliation: GET /api/cron/reconcile.
 *
 * Run on a DAILY cadence, AFTER the transaction sync (so it computes against fresh data). For each
 * mapped account it fetches Investec's current balance and anchors the Actual account to it via a
 * self-correcting opening-balance adjustment. One Actual session for all accounts; guaranteed
 * teardown. Per-account failures are isolated and reported with HTTP 200.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const ctx = buildContext({ path: '/api/cron/reconcile' });

  if (!authorized(req, ctx.config.CRON_SECRET)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const accountMap = ctx.config.INVESTEC_ACCOUNT_MAP;
  const entries = Object.entries(accountMap);
  if (entries.length === 0) {
    res.status(200).json({ reconciled: [], note: 'no accounts mapped' });
    return;
  }

  const today = ctx.now().toISOString().slice(0, 10);

  try {
    const outcomes = await withSession(ctx.config, ctx.logger, async (session) => {
      const results: (ReconcileOutcome | { actualId: string; error: string })[] = [];
      for (const [investecId, actualId] of entries) {
        try {
          const targetCents = await fetchInvestecBalanceCents(investecId, ctx);
          results.push(await reconcileAccount(session, ctx.logger, actualId, targetCents, today));
        } catch (err) {
          ctx.logger.error('reconcile account failed', { actualId, err: String(err) });
          results.push({ actualId, error: String(err) });
        }
      }
      return results;
    });

    res.status(200).json({ reconciled: outcomes });
  } catch (err) {
    ctx.logger.error('reconcile failed', { err: String(err) });
    res.status(503).json({ error: 'reconcile failed, retry' });
  }
}

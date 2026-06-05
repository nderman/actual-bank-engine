/**
 * Anchor each Actual account to its real Investec balance (local runner).
 *
 * Shares the same core as the scheduled /api/cron/reconcile endpoint — see src/core/reconcile.ts
 * for the logic and rationale. Re-runnable and self-correcting.
 *
 *   node --env-file=.env --import tsx scripts/reconcile.ts
 */
import { withSession } from '../src/core/actual-client.js';
import { buildContext } from '../src/core/context.js';
import { reconcileAccount } from '../src/core/reconcile.js';
import { fetchInvestecBalanceCents } from '../src/plugins/investec/api.js';

async function main(): Promise<void> {
  const ctx = buildContext({ path: 'scripts/reconcile' });
  const entries = Object.entries(ctx.config.INVESTEC_ACCOUNT_MAP);
  const today = ctx.now().toISOString().slice(0, 10);

  await withSession(ctx.config, ctx.logger, async (session) => {
    for (const [investecId, actualId] of entries) {
      const targetCents = await fetchInvestecBalanceCents(investecId, ctx);
      const r = await reconcileAccount(session, ctx.logger, actualId, targetCents, today);
      console.log(`${r.action.padEnd(9)} ${r.actualId}: adjustment ${r.adjustment} (balance ${r.targetCents})`);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

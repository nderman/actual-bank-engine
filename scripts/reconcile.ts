/**
 * Anchor each Actual account to its real Investec balance.
 *
 * Actual computes an account's balance as (sum of its transactions). Because we created the
 * accounts at 0 and Investec history may not reach the account's opening, that sum won't equal
 * the bank's reported balance. This script fetches Investec's current balance and writes a single
 * "Opening balance (Investec reconcile)" adjustment per account so Actual matches reality.
 *
 * Re-runnable and self-correcting: it updates the existing adjustment rather than stacking new
 * ones, so running it again after more transactions sync keeps the balance exact.
 *
 *   node --env-file=.env --import tsx scripts/reconcile.ts
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as actual from '@actual-app/api';
import type { EngineConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { fetchInvestecBalanceCents } from '../src/plugins/investec/api.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const OPENING_DATE = '2000-01-01'; // sorts first so it reads as a starting balance

interface ActualTxn {
  id: string;
  amount: number;
  imported_id?: string;
}

async function main(): Promise<void> {
  const accountMap = JSON.parse(requireEnv('INVESTEC_ACCOUNT_MAP')) as Record<string, string>;

  // Minimal context for the Investec auth/balance calls.
  const cfg = {
    INVESTEC_CLIENT_ID: requireEnv('INVESTEC_CLIENT_ID'),
    INVESTEC_CLIENT_SECRET: requireEnv('INVESTEC_CLIENT_SECRET'),
    INVESTEC_API_KEY: requireEnv('INVESTEC_API_KEY'),
  } as unknown as EngineConfig;
  const ctx = { config: cfg, logger: createLogger(), now: () => new Date() };

  const dataDir = join(tmpdir(), 'actual-reconcile');
  await mkdir(dataDir, { recursive: true });
  await actual.init({
    dataDir,
    serverURL: requireEnv('ACTUAL_SERVER_URL'),
    password: requireEnv('ACTUAL_PASSWORD'),
  });

  try {
    await actual.downloadBudget(requireEnv('ACTUAL_SYNC_ID'));
    const today = new Date().toISOString().slice(0, 10);

    for (const [investecId, actualId] of Object.entries(accountMap)) {
      const targetCents = await fetchInvestecBalanceCents(investecId, ctx);
      const importedId = `investec:opening:${actualId}`;

      const txns = (await actual.getTransactions(actualId, OPENING_DATE, today)) as ActualTxn[];
      const opening = txns.find((t) => t.imported_id === importedId);
      const sumAll = txns.reduce((s, t) => s + t.amount, 0);

      // Real (non-adjustment) sum, then the adjustment needed to hit the Investec balance.
      const realSum = sumAll - (opening?.amount ?? 0);
      const desired = targetCents - realSum;

      if (opening) {
        if (opening.amount !== desired) {
          await actual.updateTransaction(opening.id, { amount: desired });
          console.log(`updated  ${actualId}: opening ${opening.amount} -> ${desired} (bal ${targetCents})`);
        } else {
          console.log(`ok       ${actualId}: already balanced (${targetCents})`);
        }
      } else if (desired !== 0) {
        await actual.importTransactions(actualId, [
          {
            account: actualId,
            date: OPENING_DATE,
            amount: desired,
            payee_name: 'Investec',
            notes: 'Opening balance (Investec reconcile)',
            cleared: true,
            imported_id: importedId,
          },
        ]);
        console.log(`created  ${actualId}: opening ${desired} (bal ${targetCents})`);
      } else {
        console.log(`ok       ${actualId}: no adjustment needed (${targetCents})`);
      }
    }

    await actual.sync();
  } finally {
    await actual.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

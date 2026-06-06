/**
 * Remove hash-keyed duplicate transactions left by the pending→posted bug.
 *
 * Before the api.ts fix, a not-yet-posted Investec transaction (no stable id) was imported under a
 * sha256 hash key, then re-imported under Investec's structured id once posted — two rows. This
 * deletes the hash-keyed copy ONLY when a stable-id twin with the same date+amount+notes exists,
 * so legitimately distinct transactions are never touched.
 *
 *   node --env-file=.env --import tsx scripts/dedupe-cleanup.ts          # dry run (lists)
 *   node --env-file=.env --import tsx scripts/dedupe-cleanup.ts --apply  # delete
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as actual from '@actual-app/api';
import { buildContext } from '../src/core/context.js';

interface Txn {
  id: string;
  date: string;
  amount: number;
  notes: string | null;
  imported_id: string | null;
}
interface Account {
  id: string;
  name: string;
}

const HASH_KEY = /^investec:[0-9a-f]{64}$/; // hash fallback; structured ids are short digit strings
const fieldKey = (t: Txn): string => `${t.date}|${t.amount}|${t.notes ?? ''}`;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { config, logger } = buildContext({ path: 'scripts/dedupe-cleanup' });
  const dataDir = join(tmpdir(), 'actual-dedupe');
  await mkdir(dataDir, { recursive: true });

  await actual.init({ dataDir, serverURL: config.ACTUAL_SERVER_URL, password: config.ACTUAL_PASSWORD });
  try {
    await actual.downloadBudget(config.ACTUAL_SYNC_ID);
    const accounts = (await actual.getAccounts()) as Account[];

    let deleted = 0;
    for (const acct of accounts) {
      const txns = (await actual.getTransactions(acct.id, '1900-01-01', '2999-12-31')) as Txn[];
      // Keys that have a stable-id (posted) transaction — the authoritative version.
      const postedKeys = new Set(
        txns.filter((t) => t.imported_id && !HASH_KEY.test(t.imported_id)).map(fieldKey),
      );
      const dupes = txns.filter((t) => t.imported_id && HASH_KEY.test(t.imported_id) && postedKeys.has(fieldKey(t)));

      for (const d of dupes) {
        console.log(`${apply ? 'DELETE' : 'would delete'}  ${acct.name}  ${d.date}  ${d.amount}  ${d.notes ?? ''}`);
        if (apply) {
          await actual.deleteTransaction(d.id);
          deleted++;
        }
      }
    }

    if (apply) {
      await actual.sync();
      console.log(`\nDeleted ${deleted} duplicate(s).`);
    } else {
      console.log(`\nDry run — re-run with --apply to delete.`);
    }
    logger.info('dedupe cleanup done', { apply, deleted });
  } finally {
    await actual.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Bulk-assign every transaction before a cutoff date to a single category — for starting a fresh
 * budget on top of imported history without hand-sorting years of transactions.
 *
 *   node --env-file=.env --import tsx scripts/categorize-history.ts "Pre Budget" 2026-01-01
 *
 * Args: [categoryName="Pre Budget"] [beforeDate=YYYY-MM-DD exclusive, default 2026-01-01].
 * Idempotent — skips transactions already in the target category.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as actual from '@actual-app/api';
import { buildContext } from '../src/core/context.js';

interface Category {
  id: string;
  name: string;
}
interface Txn {
  id: string;
  date: string;
  category: string | null;
}
interface Account {
  id: string;
  name: string;
}

async function main(): Promise<void> {
  const categoryName = process.argv[2] ?? 'Pre Budget';
  const before = process.argv[3] ?? '2026-01-01';

  const { config, logger } = buildContext({ path: 'scripts/categorize-history' });
  const dataDir = join(tmpdir(), 'actual-categorize');
  await mkdir(dataDir, { recursive: true });

  await actual.init({
    dataDir,
    serverURL: config.ACTUAL_SERVER_URL,
    password: config.ACTUAL_PASSWORD,
  });

  try {
    await actual.downloadBudget(config.ACTUAL_SYNC_ID);

    const categories = (await actual.getCategories()) as Category[];
    const target = categories.find((c) => c.name === categoryName);
    if (!target) {
      throw new Error(`Category "${categoryName}" not found. Create it in Actual first.`);
    }

    const accounts = (await actual.getAccounts()) as Account[];
    let updated = 0;
    let skipped = 0;

    for (const acct of accounts) {
      const txns = (await actual.getTransactions(acct.id, '1900-01-01', '2999-12-31')) as Txn[];
      const older = txns.filter((t) => t.date < before);
      for (const t of older) {
        if (t.category === target.id) {
          skipped++;
          continue;
        }
        await actual.updateTransaction(t.id, { category: target.id });
        updated++;
      }
      logger.info('account processed', {
        account: acct.name,
        before,
        matched: older.length,
      });
    }

    await actual.sync();
    console.log(`\nDone: ${updated} categorized → "${categoryName}", ${skipped} already set.`);
  } finally {
    await actual.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

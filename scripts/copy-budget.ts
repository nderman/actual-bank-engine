/**
 * Copy one month's budgeted amounts to other months (Actual's UI only copies *backwards* into
 * the current month, not forwards/onto arbitrary months).
 *
 *   node --env-file=.env --import tsx scripts/copy-budget.ts [sourceMonth] [targetMonth...]
 *   # default: copy 2026-06 onto 2026-01..2026-05
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as actual from '@actual-app/api';
import { buildContext } from '../src/core/context.js';

interface BudgetMonth {
  categoryGroups: {
    is_income: boolean;
    categories: { id: string; name: string; budgeted: number | null }[];
  }[];
}

async function main(): Promise<void> {
  const source = process.argv[2] ?? '2026-06';
  const targets =
    process.argv.slice(3).length > 0
      ? process.argv.slice(3)
      : ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];

  const { config, logger } = buildContext({ path: 'scripts/copy-budget' });
  const dataDir = join(tmpdir(), 'actual-copybudget');
  await mkdir(dataDir, { recursive: true });
  await actual.init({ dataDir, serverURL: config.ACTUAL_SERVER_URL, password: config.ACTUAL_PASSWORD });

  try {
    await actual.downloadBudget(config.ACTUAL_SYNC_ID);

    const src = (await actual.getBudgetMonth(source)) as unknown as BudgetMonth;
    const amounts: { id: string; name: string; budgeted: number }[] = [];
    for (const g of src.categoryGroups) {
      if (g.is_income) continue; // income categories aren't budgeted
      for (const c of g.categories) amounts.push({ id: c.id, name: c.name, budgeted: c.budgeted || 0 });
    }

    for (const month of targets) {
      for (const a of amounts) {
        await actual.setBudgetAmount(month, a.id, a.budgeted);
      }
      logger.info('budget copied', { source, month, categories: amounts.length });
      console.log(`${month}: set ${amounts.length} category budgets from ${source}`);
    }

    await actual.sync();
    console.log(`\nDone: copied ${source} → ${targets.join(', ')}.`);
  } finally {
    await actual.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

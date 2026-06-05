import type { ActualSession } from './actual-client.js';
import type { Logger } from './logger.js';

/**
 * Balance reconciliation (SPECIFICATION.md — balances).
 *
 * Actual derives an account's balance from the sum of its transactions. When imported history
 * doesn't reach the account's opening, that sum won't equal the bank's reported balance. We anchor
 * each account with a single "opening balance" adjustment so Actual matches reality.
 *
 * Self-correcting & idempotent: we identify the adjustment by a stable `imported_id` and UPDATE it
 * rather than stacking new ones, so re-running after more transactions sync keeps the balance exact.
 * Once anchored, this is a no-op unless the bank balance drifts from the transaction sum (e.g. an
 * interest/fee posting not represented as a transaction).
 */

/** Sorts first so it reads as a starting balance. */
const OPENING_DATE = '2000-01-01';

export interface ReconcileOutcome {
  actualId: string;
  targetCents: number;
  action: 'created' | 'updated' | 'unchanged';
  adjustment: number;
}

export function openingImportedId(actualId: string): string {
  return `investec:opening:${actualId}`;
}

/**
 * Anchor a single Actual account to `targetCents` (the bank's reported current balance).
 * Reads the account's transactions, computes the adjustment that makes the total equal the target,
 * and creates or updates the opening-balance line.
 */
export async function reconcileAccount(
  session: ActualSession,
  logger: Logger,
  actualId: string,
  targetCents: number,
  today: string,
): Promise<ReconcileOutcome> {
  const importedId = openingImportedId(actualId);
  const txns = await session.getTransactions(actualId, OPENING_DATE, today);
  const opening = txns.find((t) => t.imported_id === importedId);
  const sumAll = txns.reduce((s, t) => s + t.amount, 0);

  // Real (non-adjustment) sum, then the adjustment needed to hit the target balance.
  const realSum = sumAll - (opening?.amount ?? 0);
  const adjustment = targetCents - realSum;

  let action: ReconcileOutcome['action'];
  if (opening) {
    if (opening.amount === adjustment) {
      action = 'unchanged';
    } else {
      await session.updateTransaction(opening.id, { amount: adjustment });
      action = 'updated';
    }
  } else if (adjustment !== 0) {
    await session.importTransactions(actualId, [
      {
        account: actualId,
        date: OPENING_DATE,
        amount: adjustment,
        payee_name: 'Investec',
        notes: 'Opening balance (Investec reconcile)',
        cleared: true,
        imported_id: importedId,
      },
    ]);
    action = 'created';
  } else {
    action = 'unchanged';
  }

  logger.info('reconciled account', { actualId, targetCents, adjustment, action });
  return { actualId, targetCents, action, adjustment };
}

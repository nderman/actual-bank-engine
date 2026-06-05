import type { ActualSession, ActualTransaction } from './actual-client.js';
import { computeImportedId } from './dedupe.js';
import type { Logger } from './logger.js';
import type { NormalizedTransaction } from './schema.js';

/**
 * The Core Ledger Engine (SPECIFICATION.md §1.2).
 *
 * The single funnel both ingestion paths feed into: normalize → assign deterministic
 * `imported_id` → import into Actual. De-duplication is enforced by Actual via `imported_id`
 * (§3.1), so a transaction seen by both a webhook and a cron sweep lands exactly once.
 */

export interface IngestSummary {
  fetched: number;
  imported: number;
  skippedDuplicate: number;
}

/** Map a normalized transaction onto Actual's import shape, stamping the dedupe key. */
export function toActualTransaction(txn: NormalizedTransaction): ActualTransaction {
  return {
    account: txn.accountId,
    date: txn.date,
    amount: txn.amount, // already integer minor units, sign-correct
    payee_name: txn.payee || undefined,
    notes: txn.notes || undefined,
    cleared: txn.cleared,
    imported_id: computeImportedId(txn),
  };
}

/**
 * Import a batch of normalized transactions through an open Actual session.
 *
 * Transactions are grouped by `accountId` because `importTransactions` is per-account. Actual
 * silently skips any row whose `imported_id` already exists, which is exactly our dedupe — the
 * count of returned `added` ids tells us how many were genuinely new.
 */
export async function ingest(
  session: ActualSession,
  logger: Logger,
  transactions: NormalizedTransaction[],
): Promise<IngestSummary> {
  const byAccount = new Map<string, NormalizedTransaction[]>();
  for (const txn of transactions) {
    const bucket = byAccount.get(txn.accountId);
    if (bucket) bucket.push(txn);
    else byAccount.set(txn.accountId, [txn]);
  }

  let imported = 0;
  for (const [accountId, group] of byAccount) {
    const actualTxns = group.map(toActualTransaction);
    const result = await session.importTransactions(accountId, actualTxns);
    imported += result.added.length;
    logger.info('imported account batch', {
      accountId,
      submitted: actualTxns.length,
      added: result.added.length,
      updated: result.updated.length,
    });
  }

  const summary: IngestSummary = {
    fetched: transactions.length,
    imported,
    skippedDuplicate: transactions.length - imported,
  };
  logger.info('ingest complete', { ...summary });
  return summary;
}

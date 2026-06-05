import { createHash } from 'node:crypto';
import type { NormalizedTransaction } from './schema.js';

/**
 * Deterministic `imported_id` derivation (SPECIFICATION.md §3.1).
 *
 * The same economic event observed via a webhook AND via a cron sweep must yield the SAME
 * `imported_id`, so Actual's built-in `imported_id` dedupe drops the second copy. We never
 * dedupe ourselves — we just compute a stable key and let Actual enforce exactly-once.
 *
 * Strategy:
 *  1. If the bank gives a stable transaction id, use `${source}:${sourceTransactionId}`.
 *  2. Otherwise hash the INVARIANT economic fields — the ones identical across both feeds.
 *     We exclude `cleared`/`raw`/fetch-time data so a pending→posted transition or a richer
 *     poll payload does not change the key.
 */
export function computeImportedId(txn: NormalizedTransaction): string {
  if (txn.sourceTransactionId) {
    return `${txn.source}:${txn.sourceTransactionId}`;
  }
  const invariant = [
    txn.accountId,
    txn.date,
    String(txn.amount),
    txn.currency,
    txn.payee,
    txn.notes,
  ].join('|');
  const hash = createHash('sha256').update(invariant).digest('hex');
  return `${txn.source}:${hash}`;
}

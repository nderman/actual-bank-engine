import { z } from 'zod';
import type { EngineConfig } from '../../core/config.js';
import { parseTransaction } from '../../core/schema.js';
import type { NormalizedTransaction } from '../../core/schema.js';

export const PLUGIN_ID = 'investec';

/**
 * Shape of an Investec transaction record, tolerant of the fields that appear across the
 * accounts API and event/webhook feeds. Unknown extras are ignored (not .strict) because the
 * bank evolves its payloads; we only depend on what we map.
 */
export const InvestecTxnSchema = z.object({
  accountId: z.string(),
  // Older records return `null` for some fields (not just omit them), so use .nullish()
  // (accepts string | null | undefined). The mapper coalesces null/undefined uniformly.
  type: z.string().nullish(), // "DEBIT" | "CREDIT"
  status: z.string().nullish(), // "POSTED" | "PENDING"
  description: z.string().nullish(),
  cardNumber: z.string().nullish(),
  amount: z.union([z.number(), z.string()]),
  transactionDate: z.string().nullish(),
  postingDate: z.string().nullish(),
  valueDate: z.string().nullish(),
  // Investec exposes different id fields across endpoints; take whichever is present.
  uuid: z.string().nullish(),
  transactionId: z.string().nullish(),
});

export type InvestecTxn = z.infer<typeof InvestecTxnSchema>;

function toMinorUnits(amount: number | string): number {
  const major = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(major)) throw new Error(`Investec: non-numeric amount "${amount}"`);
  return Math.round(major * 100);
}

function toIsoDate(value: string | null | undefined): string {
  if (!value) throw new Error('Investec: transaction is missing a usable date');
  // Investec dates arrive as "YYYY-MM-DD" or full ISO timestamps; keep the calendar date.
  return value.slice(0, 10);
}

/** Resolve the Actual account UUID for an Investec account id via the configured map. */
function resolveAccountId(config: EngineConfig, investecAccountId: string): string {
  const mapped = config.INVESTEC_ACCOUNT_MAP[investecAccountId];
  if (!mapped) {
    throw new Error(
      `Investec account "${investecAccountId}" has no mapping in INVESTEC_ACCOUNT_MAP.`,
    );
  }
  return mapped;
}

/**
 * Map one Investec record → NormalizedTransaction. Sign convention: DEBIT is an outflow
 * (negative). Investec amounts are positive magnitudes, so we apply the sign from `type`.
 */
export function mapInvestecTransaction(
  raw: unknown,
  config: EngineConfig,
): NormalizedTransaction {
  const txn = InvestecTxnSchema.parse(raw);

  const magnitude = Math.abs(toMinorUnits(txn.amount));
  const isDebit = (txn.type ?? '').toUpperCase() === 'DEBIT';
  const amount = isDebit ? -magnitude : magnitude;

  const description = (txn.description ?? '').trim();

  return parseTransaction({
    source: PLUGIN_ID,
    // `||` (not `??`) so an empty-string id from older records is treated as absent, falling
    // back to the deterministic hash key in dedupe.ts.
    sourceTransactionId: txn.uuid || txn.transactionId || undefined,
    accountId: resolveAccountId(config, txn.accountId),
    date: toIsoDate(txn.transactionDate ?? txn.postingDate ?? txn.valueDate),
    amount,
    currency: 'ZAR',
    payee: description,
    notes: description,
    cleared: (txn.status ?? 'POSTED').toUpperCase() === 'POSTED',
    raw,
  });
}

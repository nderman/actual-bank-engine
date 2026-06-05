import { z } from 'zod';

/**
 * The Data Normalization Layer.
 *
 * Every bank plugin, regardless of source quirks, emits transactions that conform EXACTLY to this
 * schema. The engine never sees bank-shaped data — only `NormalizedTransaction`. This is the
 * single contract that makes the plugin system possible.
 *
 * Invariants (see SPECIFICATION.md §2.4):
 *  - `amount` is signed integer MINOR units (cents). Negative = outflow, positive = inflow.
 *    Integer-only to avoid floating point drift; matches Actual's integer-cents model.
 *  - `date` is an ISO-8601 calendar date (Actual stores dates, not timestamps).
 *  - `.strict()` rejects unknown keys, so a plugin typo fails at its own boundary, loudly.
 */
export const NormalizedTransactionSchema = z
  .object({
    /** Plugin id that produced this row, e.g. "investec". */
    source: z.string().min(1),

    /**
     * The bank's own stable id for this transaction, if exposed. Preferred basis for the
     * dedupe key. Optional because some banks don't provide one.
     */
    sourceTransactionId: z.string().min(1).optional(),

    /** Target Actual account (Actual account UUID). */
    accountId: z.string().uuid(),

    /** Posting date, "YYYY-MM-DD". */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),

    /** Signed integer minor units (cents). Negative = outflow. */
    amount: z.number().int(),

    /** ISO-4217 currency code, e.g. "ZAR". */
    currency: z.string().length(3),

    /** Cleaned counterparty / merchant name. */
    payee: z.string().default(''),

    /** Free-text reference / description. */
    notes: z.string().default(''),

    /** true once settled (not a pending authorization). */
    cleared: z.boolean().default(true),

    /** Opaque original record, for audit/debug only. Never read by engine logic. */
    raw: z.unknown().optional(),
  })
  .strict();

export type NormalizedTransaction = Readonly<z.infer<typeof NormalizedTransactionSchema>>;

/** Parse + freeze a single transaction. Throws ZodError on malformed plugin output. */
export function parseTransaction(input: unknown): NormalizedTransaction {
  return Object.freeze(NormalizedTransactionSchema.parse(input));
}

/** Parse + freeze an array of transactions. */
export function parseTransactions(input: unknown[]): NormalizedTransaction[] {
  return input.map(parseTransaction);
}

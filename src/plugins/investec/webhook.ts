import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { WebhookVerificationError } from '../../core/plugin.js';
import type { PluginContext, RawWebhookRequest } from '../../core/plugin.js';
import type { NormalizedTransaction } from '../../core/schema.js';
import { mapInvestecTransaction } from './map.js';

/**
 * Investec webhook verification + parsing (SPECIFICATION.md §4, §6).
 *
 * Baseline auth: HMAC-SHA256 over the RAW request body using INVESTEC_WEBHOOK_SECRET, compared
 * (constant-time) against the `x-signature` header. We verify against the raw bytes — never a
 * re-serialized object — because any re-encoding would change the digest.
 */
export async function verifyInvestecWebhook(
  req: RawWebhookRequest,
  ctx: PluginContext,
): Promise<void> {
  const secret = ctx.config.INVESTEC_WEBHOOK_SECRET;
  if (!secret) {
    throw new WebhookVerificationError('INVESTEC_WEBHOOK_SECRET is not configured.');
  }

  const provided = req.headers['x-signature'] ?? req.headers['x-investec-signature'];
  if (!provided) {
    throw new WebhookVerificationError('Missing webhook signature header.');
  }

  const expected = createHmac('sha256', secret).update(req.rawBody, 'utf8').digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookVerificationError('Webhook signature mismatch.');
  }
}

/**
 * Investec event payloads vary. We accept either a single transaction-shaped event or a batch,
 * and ignore non-transaction events (returning []). The map step enforces the strict normalized
 * schema downstream.
 */
const EventEnvelopeSchema = z.object({
  // Either a single object or an array under `transactions`/`data`.
  transactions: z.array(z.unknown()).optional(),
  data: z.unknown().optional(),
});

export async function parseInvestecWebhook(
  payload: unknown,
  ctx: PluginContext,
): Promise<NormalizedTransaction[]> {
  const env = EventEnvelopeSchema.passthrough().safeParse(payload);

  let records: unknown[];
  if (env.success && Array.isArray(env.data.transactions)) {
    records = env.data.transactions;
  } else if (env.success && env.data.data !== undefined) {
    records = Array.isArray(env.data.data) ? env.data.data : [env.data.data];
  } else {
    // Treat the whole payload as a single candidate record.
    records = [payload];
  }

  const out: NormalizedTransaction[] = [];
  for (const rec of records) {
    try {
      out.push(mapInvestecTransaction(rec, ctx.config));
    } catch (err) {
      // Non-transaction event (e.g. card status change) or unmapped account — skip, don't fail
      // the whole webhook. The bank shouldn't retry a 200 for events we intentionally ignore.
      ctx.logger.debug('skipping non-transaction webhook record', { err: String(err) });
    }
  }
  return out;
}

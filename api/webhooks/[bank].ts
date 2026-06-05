import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSession } from '../../src/core/actual-client.js';
import { buildContext } from '../../src/core/context.js';
import { ingest } from '../../src/core/ledger.js';
import { isWebhookPlugin, WebhookVerificationError } from '../../src/core/plugin.js';
import type { RawWebhookRequest } from '../../src/core/plugin.js';
import { getPlugin } from '../../src/plugins/registry.js';

// We need the RAW body for HMAC verification, so disable Vercel's automatic body parsing.
export const config = { api: { bodyParser: false } };

function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Real-time ingestion endpoint: POST /api/webhooks/<bank>
 *
 * Flow (SPECIFICATION.md §1.1, §3.5): resolve plugin → verify signature on RAW body → parse →
 * normalize → ingest via the guarded Actual session. Status codes encode whether the bank
 * should retry: 401 auth, 400 unparseable (don't retry), 503 transient import failure (retry).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const bank = String(req.query.bank ?? '');
  const ctx = buildContext({ path: '/api/webhooks', source: bank });

  const plugin = getPlugin(bank);
  if (!plugin || !isWebhookPlugin(plugin)) {
    res.status(404).json({ error: `no webhook plugin for "${bank}"` });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    res.status(400).json({ error: `could not read body: ${String(err)}` });
    return;
  }

  const rawReq: RawWebhookRequest = {
    headers: req.headers as Record<string, string | undefined>,
    rawBody,
  };

  // 1. Authenticity — before any expensive work, so floods are cheap to reject.
  try {
    await plugin.verify(rawReq, ctx);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      ctx.logger.warn('webhook verification failed', { err: err.message });
      res.status(401).json({ error: 'verification failed' });
      return;
    }
    throw err;
  }

  // 2. Parse payload → normalized transactions.
  let transactions;
  try {
    const payload = rawBody.length ? (JSON.parse(rawBody) as unknown) : {};
    transactions = await plugin.parseWebhook(payload, ctx);
  } catch (err) {
    ctx.logger.warn('webhook parse failed', { err: String(err) });
    res.status(400).json({ error: 'unparseable payload' });
    return;
  }

  if (transactions.length === 0) {
    res.status(200).json({ imported: 0, skippedDuplicate: 0, note: 'no transactions in event' });
    return;
  }

  // 3. Ingest through the guarded session (always shuts down).
  try {
    const summary = await withSession(ctx.config, ctx.logger, (session) =>
      ingest(session, ctx.logger, transactions),
    );
    res.status(200).json(summary);
  } catch (err) {
    ctx.logger.error('webhook ingest failed', { err: String(err) });
    res.status(503).json({ error: 'ingest failed, retry' });
  }
}

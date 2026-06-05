import type { EngineConfig } from './config.js';
import type { Logger } from './logger.js';
import type { NormalizedTransaction } from './schema.js';

/** Stable plugin identity. */
export interface PluginMeta {
  /** URL-safe slug, e.g. "investec". Registry key and `/api/webhooks/[bank]` segment. */
  readonly id: string;
  /** Human label for logs. */
  readonly displayName: string;
}

/** Services injected into every plugin call. */
export interface PluginContext {
  readonly config: EngineConfig;
  readonly logger: Logger;
  /** Injectable clock so tests are deterministic. */
  readonly now: () => Date;
}

/** Raw, unparsed webhook request — body preserved verbatim for signature checks. */
export interface RawWebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The exact raw body bytes/string as received (do NOT re-serialize before verifying). */
  readonly rawBody: string;
}

/** Polling capability — driven by the cron sweep. */
export interface BankPlugin extends PluginMeta {
  /** Acquire credentials/tokens. Idempotent; safe on cold start. */
  init(ctx: PluginContext): Promise<void>;

  /**
   * Fetch transactions in [startDate, endDate] (inclusive ISO dates).
   * MUST return fully normalized transactions. MUST NOT dedupe.
   */
  fetchTransactions(
    startDate: string,
    endDate: string,
    ctx: PluginContext,
  ): Promise<NormalizedTransaction[]>;
}

/** Real-time push capability. */
export interface WebhookPlugin extends PluginMeta {
  /** Verify authenticity of a raw request. Throws on failure. */
  verify(req: RawWebhookRequest, ctx: PluginContext): Promise<void>;

  /** Translate a verified payload into zero or more normalized transactions. */
  parseWebhook(payload: unknown, ctx: PluginContext): Promise<NormalizedTransaction[]>;
}

/** A plugin may implement either or both capabilities. */
export type AnyPlugin = (BankPlugin | WebhookPlugin) & PluginMeta;

export function isBankPlugin(p: AnyPlugin): p is BankPlugin {
  return typeof (p as BankPlugin).fetchTransactions === 'function';
}

export function isWebhookPlugin(p: AnyPlugin): p is WebhookPlugin {
  return typeof (p as WebhookPlugin).parseWebhook === 'function';
}

/** Thrown by `verify()` on signature/auth failure → maps to HTTP 401. */
export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
}

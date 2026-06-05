/**
 * Rate-limit-aware fetch helper shared by bank plugins (SPECIFICATION.md §3.2).
 *
 * Plugins are responsible for respecting their bank's quotas; this gives them a consistent
 * exponential-backoff-with-jitter retry that honours `Retry-After` on 429/503.
 */
export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Status codes that should be retried. */
  retryOn?: number[];
}

const DEFAULTS: Required<RetryOptions> = {
  retries: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  retryOn: [429, 500, 502, 503, 504],
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt: number, opts: Required<RetryOptions>, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, opts.maxDelayMs);
  }
  const expo = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  // Full jitter avoids thundering-herd retries across concurrent invocations.
  return Math.round(Math.random() * expo);
}

/** fetch() with retry/backoff. Throws on exhausted retries or non-retryable error status. */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const opts = { ...DEFAULTS, ...options };
  let lastErr: unknown;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetch(input, init);
      if (!opts.retryOn.includes(res.status)) return res;
      if (attempt === opts.retries) return res; // out of retries — let caller see the status
      await sleep(backoffDelay(attempt, opts, res.headers.get('retry-after')));
    } catch (err) {
      lastErr = err;
      if (attempt === opts.retries) break;
      await sleep(backoffDelay(attempt, opts));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetchWithRetry: exhausted retries');
}

/**
 * Turn an unknown thrown value into a string that actually says something.
 *
 * Why this exists: `String(err)` renders a plain object as the useless `"[object Object]"`, and
 * `@actual-app/api` rejects with plain property bags (`{ message, reason, ... }`), not `Error`
 * instances. So every Actual failure surfaced in the logs AND in the cron response body as
 * `"[object Object]"` — which is exactly how a broken sync went undiagnosed for four days in
 * September 2026. The error text is the diagnostic; never throw it away.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const base = err.message ? `${err.name}: ${err.message}` : err.name;
    // `cause` carries the underlying transport/HTTP failure for wrapped errors — the useful half.
    const { cause } = err as Error & { cause?: unknown };
    return cause === undefined ? base : `${base} (cause: ${describeError(cause)})`;
  }

  if (typeof err === 'string') return err;
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';

  if (typeof err === 'object') {
    // Serialise the whole bag: for Actual's rejections the sibling fields (reason, status, code)
    // are usually more diagnostic than `message` alone.
    const json = safeStringify(err);
    if (json !== '{}') return json;

    // Nothing enumerable (some SDKs use non-enumerable props). Fall back to a message if present.
    const { message } = err as { message?: unknown };
    return typeof message === 'string' && message.length > 0
      ? message
      : Object.prototype.toString.call(err);
  }

  return String(err);
}

/** `JSON.stringify` that can't itself throw — survives circular refs and BigInt. */
function safeStringify(value: object): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'bigint') return `${v.toString()}n`;
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

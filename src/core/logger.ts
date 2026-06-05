/**
 * Minimal structured JSON logger. Vercel captures stdout/stderr into its log drains, so
 * one JSON object per line is the most useful, dependency-free format.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a child logger that always merges `bindings` into every line. */
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, bindings: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, ...bindings, ...fields });
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', bindings, msg, fields),
    info: (msg, fields) => emit('info', bindings, msg, fields),
    warn: (msg, fields) => emit('warn', bindings, msg, fields),
    error: (msg, fields) => emit('error', bindings, msg, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import type { PluginContext } from './plugin.js';

/** Build a request-scoped PluginContext with validated config + bound logger. */
export function buildContext(bindings: Record<string, unknown> = {}): PluginContext {
  return {
    config: loadConfig(),
    logger: createLogger(bindings),
    now: () => new Date(),
  };
}

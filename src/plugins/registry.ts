import type { AnyPlugin } from '../core/plugin.js';
import investec from './investec/index.js';

/**
 * Explicit plugin registry (SPECIFICATION.md §2.3).
 *
 * Registration is a static import + map entry — not filesystem magic — so Vercel's bundler can
 * trace every plugin, and the enabled set is obvious at a glance. To add a bank: implement the
 * interfaces under src/plugins/<bank>/ and add one line here.
 */
const plugins: readonly AnyPlugin[] = [investec];

const byId = new Map<string, AnyPlugin>(plugins.map((p) => [p.id, p]));

export function getPlugin(id: string): AnyPlugin | undefined {
  return byId.get(id);
}

export function allPlugins(): readonly AnyPlugin[] {
  return plugins;
}

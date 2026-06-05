import type { BankPlugin, PluginContext } from '../../core/plugin.js';
import { fetchInvestecTransactions } from './api.js';
import { getAccessToken } from './auth.js';
import { PLUGIN_ID } from './map.js';

/**
 * Investec reference plugin.
 *
 * Investec's Private Bank Account Information API is POLL-ONLY (no webhooks), so this plugin
 * implements BankPlugin only. The engine still supports push-based banks via the generic
 * WebhookPlugin interface (src/core/plugin.ts) and the /api/webhooks/[bank] route — a future
 * plugin for a bank that pushes events can implement it. All Investec-specific quirks (OAuth,
 * x-api-key, ZAR, date windowing, account mapping) live under this folder and never leak into core.
 */
const investecPlugin: BankPlugin = {
  id: PLUGIN_ID,
  displayName: 'Investec Programmable Banking',

  async init(ctx: PluginContext): Promise<void> {
    // Warm the OAuth token; idempotent and cold-start safe.
    await getAccessToken(ctx);
  },

  fetchTransactions(startDate, endDate, ctx) {
    return fetchInvestecTransactions(startDate, endDate, ctx);
  },
};

export default investecPlugin;

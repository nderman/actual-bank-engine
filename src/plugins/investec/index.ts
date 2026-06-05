import type { BankPlugin, PluginContext, RawWebhookRequest, WebhookPlugin } from '../../core/plugin.js';
import { fetchInvestecTransactions } from './api.js';
import { getAccessToken } from './auth.js';
import { PLUGIN_ID } from './map.js';
import { parseInvestecWebhook, verifyInvestecWebhook } from './webhook.js';

/**
 * Investec reference plugin — implements BOTH polling (BankPlugin) and real-time
 * (WebhookPlugin) capabilities. All Investec-specific quirks (OAuth, x-api-key, ZAR, date
 * windowing, account mapping) live under this folder and never leak into core.
 */
const investecPlugin: BankPlugin & WebhookPlugin = {
  id: PLUGIN_ID,
  displayName: 'Investec Programmable Banking',

  async init(ctx: PluginContext): Promise<void> {
    // Warm the OAuth token; idempotent and cold-start safe.
    await getAccessToken(ctx);
  },

  fetchTransactions(startDate, endDate, ctx) {
    return fetchInvestecTransactions(startDate, endDate, ctx);
  },

  verify(req: RawWebhookRequest, ctx) {
    return verifyInvestecWebhook(req, ctx);
  },

  parseWebhook(payload, ctx) {
    return parseInvestecWebhook(payload, ctx);
  },
};

export default investecPlugin;

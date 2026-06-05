import { fetchWithRetry } from '../../core/http.js';
import type { PluginContext } from '../../core/plugin.js';

/**
 * Investec Programmable Banking OAuth2 (client-credentials).
 *
 * POST {base}/identity/v2/oauth2/token
 *   Authorization: Basic base64(client_id:client_secret)
 *   x-api-key: <api key>
 *   body: grant_type=client_credentials
 *
 * Tokens are short-lived. We cache in module scope ONLY as a warm-instance optimization, always
 * checking expiry, and always falling back to a fresh fetch on cold start (empty module state).
 */
export const INVESTEC_BASE_URL = 'https://openapi.investec.com';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cached: CachedToken | undefined;

export interface InvestecCredentials {
  clientId: string;
  clientSecret: string;
  apiKey: string;
}

export function readCredentials(ctx: PluginContext): InvestecCredentials {
  const { config } = ctx;
  if (!config.INVESTEC_CLIENT_ID || !config.INVESTEC_CLIENT_SECRET || !config.INVESTEC_API_KEY) {
    throw new Error('Investec credentials are not configured (INVESTEC_CLIENT_ID/SECRET/API_KEY).');
  }
  return {
    clientId: config.INVESTEC_CLIENT_ID,
    clientSecret: config.INVESTEC_CLIENT_SECRET,
    apiKey: config.INVESTEC_API_KEY,
  };
}

export async function getAccessToken(ctx: PluginContext): Promise<string> {
  const nowMs = ctx.now().getTime();
  // 30s safety margin so we never present a token that expires mid-request.
  if (cached && cached.expiresAtMs - 30_000 > nowMs) {
    return cached.token;
  }

  const creds = readCredentials(ctx);
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

  const res = await fetchWithRetry(`${INVESTEC_BASE_URL}/identity/v2/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'x-api-key': creds.apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Investec token request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as TokenResponse;
  cached = {
    token: data.access_token,
    expiresAtMs: nowMs + data.expires_in * 1000,
  };
  return cached.token;
}

/** Test-only reset of the cached token. */
export function resetTokenCache(): void {
  cached = undefined;
}

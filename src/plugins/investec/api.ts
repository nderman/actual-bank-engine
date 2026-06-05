import { z } from 'zod';
import { fetchWithRetry } from '../../core/http.js';
import type { PluginContext } from '../../core/plugin.js';
import type { NormalizedTransaction } from '../../core/schema.js';
import { getAccessToken, INVESTEC_BASE_URL, readCredentials } from './auth.js';
import { mapInvestecTransaction } from './map.js';

const AccountsResponseSchema = z.object({
  data: z.object({
    accounts: z.array(z.object({ accountId: z.string() })),
  }),
});

const TransactionsResponseSchema = z.object({
  data: z.object({
    transactions: z.array(z.unknown()),
  }),
});

async function authedGet(ctx: PluginContext, path: string): Promise<unknown> {
  const token = await getAccessToken(ctx);
  const { apiKey } = readCredentials(ctx);
  const res = await fetchWithRetry(`${INVESTEC_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-api-key': apiKey,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Investec GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** List the Investec account ids visible to these credentials. */
export async function listAccountIds(ctx: PluginContext): Promise<string[]> {
  const json = await authedGet(ctx, '/za/pb/v1/accounts');
  return AccountsResponseSchema.parse(json).data.accounts.map((a) => a.accountId);
}

/**
 * Fetch + normalize transactions across all visible accounts for the window. Each raw record is
 * stamped with its owning `accountId` before mapping so the account map can resolve the Actual
 * account. Accounts without a mapping are skipped (logged), not fatal.
 */
export async function fetchInvestecTransactions(
  startDate: string,
  endDate: string,
  ctx: PluginContext,
): Promise<NormalizedTransaction[]> {
  const accountIds = await listAccountIds(ctx);
  const out: NormalizedTransaction[] = [];

  for (const accountId of accountIds) {
    if (!ctx.config.INVESTEC_ACCOUNT_MAP[accountId]) {
      ctx.logger.warn('skipping unmapped Investec account', { accountId });
      continue;
    }
    const path = `/za/pb/v1/accounts/${encodeURIComponent(accountId)}/transactions?fromDate=${startDate}&toDate=${endDate}`;
    const json = await authedGet(ctx, path);
    const { transactions } = TransactionsResponseSchema.parse(json).data;

    for (const rec of transactions) {
      // Inject the owning accountId — the per-transaction payload may omit it.
      const withAccount = { ...(rec as Record<string, unknown>), accountId };
      out.push(mapInvestecTransaction(withAccount, ctx.config));
    }
  }

  ctx.logger.info('fetched investec transactions', {
    accounts: accountIds.length,
    transactions: out.length,
  });
  return out;
}

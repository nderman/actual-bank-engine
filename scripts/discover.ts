/**
 * Setup helper: list your Investec accounts and your Actual accounts side by side, then print a
 * starter INVESTEC_ACCOUNT_MAP you can paste into your env.
 *
 * Run (Node 20.6+ reads the .env file natively — no dotenv needed):
 *   node --env-file=.env --import tsx scripts/discover.ts
 *
 * Needs in .env: INVESTEC_CLIENT_ID / _SECRET / _API_KEY and
 *                ACTUAL_SERVER_URL / ACTUAL_PASSWORD / ACTUAL_SYNC_ID
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as actual from '@actual-app/api';
import type { EngineConfig } from '../src/core/config.js';
import { getAccessToken, INVESTEC_BASE_URL, readCredentials } from '../src/plugins/investec/auth.js';
import { createLogger } from '../src/core/logger.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

interface InvestecAccount {
  accountId: string;
  accountName?: string;
  referenceName?: string;
  productName?: string;
}

async function listInvestec(): Promise<InvestecAccount[]> {
  // Minimal context just for the auth/token flow.
  const cfg = {
    INVESTEC_CLIENT_ID: requireEnv('INVESTEC_CLIENT_ID'),
    INVESTEC_CLIENT_SECRET: requireEnv('INVESTEC_CLIENT_SECRET'),
    INVESTEC_API_KEY: requireEnv('INVESTEC_API_KEY'),
  } as unknown as EngineConfig;
  const ctx = { config: cfg, logger: createLogger(), now: () => new Date() };

  const token = await getAccessToken(ctx);
  const { apiKey } = readCredentials(ctx);
  const res = await fetch(`${INVESTEC_BASE_URL}/za/pb/v1/accounts`, {
    headers: { Authorization: `Bearer ${token}`, 'x-api-key': apiKey, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Investec accounts failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { accounts: InvestecAccount[] } };
  return json.data.accounts;
}

async function listActual(): Promise<{ id: string; name: string }[]> {
  const dataDir = join(tmpdir(), 'actual-discover');
  await mkdir(dataDir, { recursive: true });
  await actual.init({
    dataDir,
    serverURL: requireEnv('ACTUAL_SERVER_URL'),
    password: requireEnv('ACTUAL_PASSWORD'),
  });
  try {
    await actual.downloadBudget(requireEnv('ACTUAL_SYNC_ID'));
    return (await actual.getAccounts()) as { id: string; name: string }[];
  } finally {
    await actual.shutdown();
  }
}

async function main(): Promise<void> {
  const [investec, actualAccounts] = await Promise.all([listInvestec(), listActual()]);

  console.log('\n=== Investec accounts ===');
  for (const a of investec) {
    console.log(`  ${a.accountId}  ${a.referenceName ?? a.accountName ?? ''} (${a.productName ?? ''})`);
  }

  console.log('\n=== Actual accounts (use the id as the value) ===');
  for (const a of actualAccounts) {
    console.log(`  ${a.id}  ${a.name}`);
  }

  console.log('\n=== Starter INVESTEC_ACCOUNT_MAP (edit the UUIDs to match) ===');
  const starter = Object.fromEntries(
    investec.map((a) => [a.accountId, actualAccounts[0]?.id ?? '<actual-account-uuid>']),
  );
  console.log(`INVESTEC_ACCOUNT_MAP=${JSON.stringify(starter)}`);
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineConfig } from '../../core/config.js';
import { mapInvestecTransaction } from './map.js';

const ACTUAL_UUID = '11111111-1111-1111-1111-111111111111';

const config = {
  INVESTEC_ACCOUNT_MAP: { '987654321': ACTUAL_UUID },
} as unknown as EngineConfig;

test('maps a DEBIT to a negative integer-cents outflow', () => {
  const txn = mapInvestecTransaction(
    {
      accountId: '987654321',
      type: 'DEBIT',
      status: 'POSTED',
      description: 'Woolworths',
      amount: 123.45,
      transactionDate: '2026-06-01T10:00:00Z',
      uuid: 'inv-1',
    },
    config,
  );
  assert.equal(txn.amount, -12345);
  assert.equal(txn.accountId, ACTUAL_UUID);
  assert.equal(txn.date, '2026-06-01');
  assert.equal(txn.cleared, true);
  assert.equal(txn.sourceTransactionId, 'inv-1');
  assert.equal(txn.currency, 'ZAR');
});

test('maps a CREDIT to a positive inflow and string amount', () => {
  const txn = mapInvestecTransaction(
    {
      accountId: '987654321',
      type: 'CREDIT',
      status: 'PENDING',
      description: 'Salary',
      amount: '5000.00',
      postingDate: '2026-06-02',
      transactionId: 'inv-2',
    },
    config,
  );
  assert.equal(txn.amount, 500000);
  assert.equal(txn.cleared, false);
  assert.equal(txn.sourceTransactionId, 'inv-2');
});

test('throws on unmapped account', () => {
  assert.throws(() =>
    mapInvestecTransaction(
      { accountId: 'unknown', type: 'DEBIT', amount: 1, transactionDate: '2026-06-01' },
      config,
    ),
  );
});

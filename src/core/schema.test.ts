import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransaction } from './schema.js';

const valid = {
  source: 'investec',
  accountId: '00000000-0000-0000-0000-000000000001',
  date: '2026-06-01',
  amount: -100,
  currency: 'ZAR',
};

test('applies defaults and freezes', () => {
  const txn = parseTransaction(valid);
  assert.equal(txn.payee, '');
  assert.equal(txn.notes, '');
  assert.equal(txn.cleared, true);
  assert.equal(Object.isFrozen(txn), true);
});

test('rejects non-integer amount', () => {
  assert.throws(() => parseTransaction({ ...valid, amount: 1.5 }));
});

test('rejects bad date format', () => {
  assert.throws(() => parseTransaction({ ...valid, date: '06/01/2026' }));
});

test('rejects unknown keys (strict)', () => {
  assert.throws(() => parseTransaction({ ...valid, surprise: true }));
});

test('rejects non-uuid accountId', () => {
  assert.throws(() => parseTransaction({ ...valid, accountId: 'nope' }));
});

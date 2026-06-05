import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeImportedId } from './dedupe.js';
import { parseTransaction } from './schema.js';

const base = {
  source: 'investec',
  accountId: '00000000-0000-0000-0000-000000000001',
  date: '2026-06-01',
  amount: -12345,
  currency: 'ZAR',
  payee: 'Coffee Shop',
  notes: 'card purchase',
};

test('uses bank id when present', () => {
  const txn = parseTransaction({ ...base, sourceTransactionId: 'abc123' });
  assert.equal(computeImportedId(txn), 'investec:abc123');
});

test('same event via two paths yields identical id (bank-id path)', () => {
  const webhook = parseTransaction({ ...base, sourceTransactionId: 'tx-9', cleared: false, raw: { a: 1 } });
  const poll = parseTransaction({ ...base, sourceTransactionId: 'tx-9', cleared: true, raw: { b: 2 } });
  // cleared/raw differ but the bank id is the same → same imported_id → Actual dedupes.
  assert.equal(computeImportedId(webhook), computeImportedId(poll));
});

test('hash fallback is deterministic and excludes cleared/raw', () => {
  const a = parseTransaction({ ...base, cleared: false, raw: { x: 1 } });
  const b = parseTransaction({ ...base, cleared: true, raw: { y: 2 } });
  const id = computeImportedId(a);
  assert.equal(id, computeImportedId(b));
  assert.match(id, /^investec:[0-9a-f]{64}$/);
});

test('hash fallback changes when economic fields change', () => {
  const a = parseTransaction(base);
  const b = parseTransaction({ ...base, amount: -99999 });
  assert.notEqual(computeImportedId(a), computeImportedId(b));
});

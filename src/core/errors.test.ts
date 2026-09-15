import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError } from './errors.js';

test('regression: a plain object never renders as [object Object]', () => {
  // The exact shape @actual-app/api rejects with. `String(err)` gave "[object Object]" here,
  // which is what hid the 26.7-client/26.9-server break for four days.
  const actualStyle = { message: 'out-of-sync-migrations', reason: 'migration mismatch' };
  const described = describeError(actualStyle);
  assert.notEqual(described, '[object Object]');
  assert.match(described, /out-of-sync-migrations/);
  assert.match(described, /migration mismatch/);
});

test('Error renders name and message', () => {
  assert.equal(describeError(new TypeError('bad input')), 'TypeError: bad input');
});

test('Error cause chain is preserved', () => {
  const err = new Error('download failed', { cause: new Error('ECONNREFUSED') });
  assert.equal(describeError(err), 'Error: download failed (cause: Error: ECONNREFUSED)');
});

test('strings and primitives pass through', () => {
  assert.equal(describeError('plain failure'), 'plain failure');
  assert.equal(describeError(404), '404');
  assert.equal(describeError(null), 'null');
  assert.equal(describeError(undefined), 'undefined');
});

test('circular references do not throw', () => {
  const circular: Record<string, unknown> = { status: 503 };
  circular.self = circular;
  const described = describeError(circular);
  assert.match(described, /503/);
  assert.match(described, /circular/);
});

test('object with only non-enumerable props falls back to its message', () => {
  const weird = {};
  Object.defineProperty(weird, 'message', { value: 'hidden message', enumerable: false });
  assert.equal(describeError(weird), 'hidden message');
});

test('a genuinely empty object has nothing to report', () => {
  // Documented limitation, not a bug: with no enumerable fields and no message there is no
  // information to extract, so the tag is the honest answer.
  assert.equal(describeError({}), '[object Object]');
});

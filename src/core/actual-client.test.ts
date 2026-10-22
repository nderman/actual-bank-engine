import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSkewed } from './actual-client.js';

test('differing known versions are skew', () => {
  assert.equal(isSkewed('26.9.0', '26.10.0'), true);
  assert.equal(isSkewed('26.7.0', '26.9.0'), true);
});

test('matching versions are not skew', () => {
  assert.equal(isSkewed('26.10.0', '26.10.0'), false);
});

test('regression: unknown client must never be reported as skew', () => {
  // The first implementation could not read the client version (the package does not export
  // ./package.json) and so reported skew unconditionally.
  assert.equal(isSkewed(null, '26.10.0'), false);
});

test('unreachable server must never be reported as skew', () => {
  assert.equal(isSkewed('26.10.0', null), false);
  assert.equal(isSkewed(null, null), false);
});

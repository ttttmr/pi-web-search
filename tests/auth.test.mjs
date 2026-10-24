import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRequestHeaders } from '../src/providers/auth.ts';

test('Pi header overrides remove null values case-insensitively without changing their inputs', () => {
  const defaults = { Authorization: 'old-key', 'Content-Type': 'application/json', 'X-Remove': 'old' };
  const overrides = { authorization: 'new-key', 'x-remove': null };
  assert.deepEqual(mergeRequestHeaders(defaults, undefined, overrides), {
    'Content-Type': 'application/json', authorization: 'new-key',
  });
  assert.equal(defaults['X-Remove'], 'old');
  assert.equal(overrides['x-remove'], null);
  assert.deepEqual(mergeRequestHeaders(undefined, { authorization: null }), {});
});

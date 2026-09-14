import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version } from '../src/version.js';

test('package exposes a version string', () => {
  assert.equal(typeof version, 'string');
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

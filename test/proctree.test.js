import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descendants } from '../src/proctree.js';

test('descendants reports a missing ps instead of silently finding nothing', () => {
  const saved = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'at-nops-'));
  const warnings = [];
  try {
    assert.deepEqual(descendants(process.pid, (m) => warnings.push(m)), []);
  } finally { process.env.PATH = saved; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^ps failed: /);
});

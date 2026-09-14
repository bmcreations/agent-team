import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

test('the plugin manifest names the plugin and its version', () => {
  const m = read('.claude-plugin/plugin.json');
  assert.equal(m.name, 'agent-team');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
});

test('the plugin version matches package.json', () => {
  assert.equal(read('.claude-plugin/plugin.json').version, read('package.json').version);
});

test('the marketplace lists the plugin at the repo root', () => {
  const m = read('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'agent-team');
  const entry = m.plugins.find((p) => p.name === 'agent-team');
  assert.ok(entry, 'marketplace must list the agent-team plugin');
  assert.equal(entry.source, './');
});

test('every skill the marketplace ships actually exists', () => {
  for (const skill of ['red-team', 'delegate', 'agent-team-init']) {
    assert.ok(existsSync(join(ROOT, 'skills', skill, 'SKILL.md')), `missing skills/${skill}/SKILL.md`);
  }
});

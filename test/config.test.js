import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function projectWith(config) {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify(config));
  return root;
}

const VALID = {
  roles: { reviewer: { agent: 'codex', isolation: 'read-only' } },
  deny_paths: ['**/.env*']
};

test('loads roles and deny_paths', () => {
  const cfg = loadConfig(projectWith(VALID));
  assert.equal(cfg.roles.reviewer.agent, 'codex');
  assert.deepEqual(cfg.deny_paths, ['**/.env*']);
});

test('defaults on_unavailable to claude', () => {
  const cfg = loadConfig(projectWith(VALID));
  assert.equal(cfg.defaults.on_unavailable, 'claude');
});

test('explicit defaults override the built-in', () => {
  const cfg = loadConfig(projectWith({ ...VALID, defaults: { on_unavailable: 'mock' } }));
  assert.equal(cfg.defaults.on_unavailable, 'mock');
});

test('rejects a config with no deny_paths', () => {
  assert.throws(
    () => loadConfig(projectWith({ roles: VALID.roles })),
    /deny_paths/
  );
});

test('rejects a config with an empty deny_paths', () => {
  assert.throws(
    () => loadConfig(projectWith({ ...VALID, deny_paths: [] })),
    /deny_paths/
  );
});

test('rejects a config with no roles', () => {
  assert.throws(() => loadConfig(projectWith({ deny_paths: ['x'] })), /roles/);
});

test('reports the path when the file is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  assert.throws(() => loadConfig(root), /agent-team\.json/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, CONFIG_RELPATH } from '../src/config.js';

function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, CONFIG_RELPATH), JSON.stringify(config));
  return root;
}

const OK = {
  members: {
    coo: { agent: 'claude', isolation: 'none' },
    'eng-lead': { agent: 'claude', reports_to: 'coo' },
    implementer: { agent: 'codex', reports_to: 'eng-lead', isolation: 'workspace' }
  },
  deny_paths: ['credentials/**']
};

test('a missing config names the init skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  assert.throws(() => loadConfig(root), /agent-team-init/);
});

test('members is required', () => {
  const root = project({ deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /"members" is required/);
});

test('a config with no denylist is refused, and the message says why', () => {
  const root = project({ members: OK.members });
  assert.throws(() => loadConfig(root), /third party/);
});

test('an empty denylist is refused too', () => {
  const root = project({ members: OK.members, deny_paths: [] });
  assert.throws(() => loadConfig(root), /"deny_paths" is required/);
});

test('every member must name an agent', () => {
  const root = project({ members: { designer: { title: 'Designer' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /member "designer": "agent" is required/);
});

test('an unknown isolation level is refused', () => {
  const root = project({ members: { a: { agent: 'x', isolation: 'sandbox' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /isolation "sandbox" is not one of/);
});

test('an empty-string isolation is refused, not silently defaulted', () => {
  // "" is falsy but not nullish — this is what distinguishes `??` (correct: keeps ""
  // and rejects it) from `||` (bug: replaces it with 'read-only' and loads fine).
  const root = project({ members: { a: { agent: 'x', isolation: '' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /isolation "" is not one of/);
});

test('an unknown deliverable is refused', () => {
  const root = project({ members: { a: { agent: 'x', deliverable: 'vibes' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /deliverable "vibes" is not one of/);
});

test('a reporting cycle is refused at load time', () => {
  const root = project({
    members: { a: { agent: 'x', reports_to: 'b' }, b: { agent: 'x', reports_to: 'a' } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), /reporting cycle/);
});

test('isolation defaults to read-only and deliverable follows isolation', () => {
  const cfg = loadConfig(project(OK));
  assert.equal(cfg.members['eng-lead'].isolation, 'read-only');
  assert.equal(cfg.members['eng-lead'].deliverable, 'review');
  assert.equal(cfg.members.coo.deliverable, 'document');
  assert.equal(cfg.members.implementer.deliverable, 'diff');
});

test('an explicit deliverable overrides the one isolation would imply', () => {
  const cfg = loadConfig(project({
    members: { coo: { agent: 'claude', isolation: 'none', deliverable: 'decision' } },
    deny_paths: ['x']
  }));
  assert.equal(cfg.members.coo.deliverable, 'decision');
});

test('the org chart is built and returned alongside the members', () => {
  const cfg = loadConfig(project(OK));
  assert.deepEqual(cfg.org.roots, ['coo']);
  assert.deepEqual(cfg.org.reportsOf['eng-lead'], ['implementer']);
});

test('delegation caps have defaults a config can override', () => {
  const bare = loadConfig(project(OK));
  assert.equal(bare.defaults.on_unavailable, 'claude');
  assert.equal(bare.defaults.max_depth, 3);
  assert.equal(bare.defaults.max_delegations, 20);

  const tuned = loadConfig(project({ ...OK, defaults: { max_depth: 1 } }));
  assert.equal(tuned.defaults.max_depth, 1);
  assert.equal(tuned.defaults.on_unavailable, 'claude');
  assert.equal(tuned.defaults.max_delegations, 20);
});

test('an explicit null isolation or deliverable falls back to the default, rather than throwing', () => {
  const cfg = loadConfig(project({
    members: {
      a: { agent: 'claude', isolation: null },
      b: { agent: 'claude', deliverable: null }
    },
    deny_paths: ['x']
  }));
  assert.equal(cfg.members.a.isolation, 'read-only');
  assert.equal(cfg.members.a.deliverable, 'review');
  assert.equal(cfg.members.b.isolation, 'read-only');
  assert.equal(cfg.members.b.deliverable, 'review');
});

test('a falsy max_depth of 0 is preserved, not treated as absent', () => {
  const cfg = loadConfig(project({ ...OK, defaults: { max_depth: 0 } }));
  assert.equal(cfg.defaults.max_depth, 0);
  assert.equal(cfg.defaults.on_unavailable, 'claude');
  assert.equal(cfg.defaults.max_delegations, 20);
});

test('a malformed config names the file in the JSON parse error', () => {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  const path = join(root, CONFIG_RELPATH);
  writeFileSync(path, '{ "members": {, }');
  assert.throws(() => loadConfig(root), (err) => {
    assert.ok(err.message.startsWith(`${path}: `), err.message);
    assert.match(err.message, /Expected|JSON/);
    return true;
  });
});

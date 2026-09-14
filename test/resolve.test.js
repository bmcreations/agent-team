import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole } from '../src/resolve.js';

const CONFIG = {
  roles: {
    implementer: { agent: 'codex', model: 'gpt-5-codex', isolation: 'worktree' },
    reviewer:    { agent: 'codex', isolation: 'read-only' },
    'red-team':  { agent: 'grok', skill: 'red-team', isolation: 'worktree',
                   distinct_from: ['implementer'] }
  },
  deny_paths: ['**/.env*'],
  defaults: { on_unavailable: 'claude' }
};

const all = () => true;
const none = (a) => a === 'claude';

test('resolves a role to its configured agent', () => {
  const r = resolveRole(CONFIG, 'implementer', { probe: all });
  assert.equal(r.agent, 'codex');
  assert.equal(r.model, 'gpt-5-codex');
  assert.equal(r.isolation, 'worktree');
  assert.equal(r.warning, null);
});

test('carries the skill binding through', () => {
  const r = resolveRole(CONFIG, 'red-team', { probe: all });
  assert.equal(r.skill, 'red-team');
});

test('falls back when the agent is unavailable, and warns', () => {
  const r = resolveRole(CONFIG, 'reviewer', { probe: none });
  assert.equal(r.agent, 'claude');
  assert.match(r.warning, /codex.*unavailable.*claude/);
});

test('isolation defaults to read-only when unset', () => {
  const cfg = { ...CONFIG, roles: { researcher: { agent: 'claude' } } };
  assert.equal(resolveRole(cfg, 'researcher', { probe: all }).isolation, 'read-only');
});

test('model and skill default to null when the role omits them', () => {
  const cfg = { ...CONFIG, roles: { researcher: { agent: 'claude' } } };
  const r = resolveRole(cfg, 'researcher', { probe: all });
  assert.equal(r.model, null);
  assert.equal(r.skill, null);
});

test('distinct_from stops a self-review instead of falling back', () => {
  assert.throws(
    () => resolveRole(CONFIG, 'red-team', {
      probe: all,
      assignments: { implementer: 'grok' }
    }),
    /distinct_from/
  );
});

test('distinct_from also blocks a violation introduced BY the fallback', () => {
  // grok is unavailable so red-team falls back to claude, but claude
  // already implemented — the fallback must not be allowed to stand.
  assert.throws(
    () => resolveRole(CONFIG, 'red-team', {
      probe: none,
      assignments: { implementer: 'claude' }
    }),
    /distinct_from/
  );
});

test('throws when neither the agent nor the fallback is available', () => {
  assert.throws(
    () => resolveRole(CONFIG, 'reviewer', { probe: () => false }),
    /no usable fallback/
  );
});

test('throws on an unknown role', () => {
  assert.throws(() => resolveRole(CONFIG, 'nope', { probe: all }), /unknown role/);
});

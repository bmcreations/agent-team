import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrg } from '../src/org.js';
import { resolveMember } from '../src/resolve.js';

function config(members, defaults = { on_unavailable: 'claude' }) {
  const withDefaults = Object.fromEntries(Object.entries(members).map(([k, m]) => [
    k, { isolation: 'read-only', deliverable: 'review', ...m }
  ]));
  return { members: withDefaults, org: buildOrg(withDefaults), deny_paths: ['x'], defaults };
}

const CONFIG = config({
  'eng-lead': { agent: 'claude' },
  implementer: { agent: 'codex', reports_to: 'eng-lead', isolation: 'workspace', deliverable: 'diff' },
  reviewer: { agent: 'grok', reports_to: 'eng-lead', distinct_from: ['implementer'] }
});

const all = () => true;
const none = () => false;
const only = (...ok) => (a) => ok.includes(a);

test('an unknown member names what is configured', () => {
  assert.throws(() => resolveMember(CONFIG, 'ghost', { probe: all }), /unknown member: ghost/);
  assert.throws(() => resolveMember(CONFIG, 'ghost', { probe: all }), /implementer/);
});

test('an available agent is used as written, with no warning', () => {
  const r = resolveMember(CONFIG, 'implementer', { probe: all });
  assert.equal(r.agent, 'codex');
  assert.equal(r.warning, null);
});

test('an unavailable agent falls back to on_unavailable, with a warning', () => {
  const r = resolveMember(CONFIG, 'implementer', { probe: only('claude') });
  assert.equal(r.agent, 'claude');
  assert.match(r.warning, /codex/);
  assert.match(r.warning, /claude/);
});

test('no usable fallback is an error, not a silent skip', () => {
  assert.throws(() => resolveMember(CONFIG, 'implementer', { probe: none }), /no usable fallback/);
});

test('distinct_from is checked AFTER fallback, so a fallback cannot smuggle in self-review', () => {
  assert.throws(
    () => resolveMember(CONFIG, 'reviewer', {
      probe: only('claude'),
      assignments: { implementer: 'claude' }
    }),
    /refusing to let an agent review its own work/
  );
});

test('the distinct_from error says the conflict was reached through a fallback', () => {
  assert.throws(
    () => resolveMember(CONFIG, 'reviewer', {
      probe: only('claude'),
      assignments: { implementer: 'claude' }
    }),
    /reached via fallback/
  );
});

test('distinct_from does not fire when the agents genuinely differ', () => {
  const r = resolveMember(CONFIG, 'reviewer', { probe: all, assignments: { implementer: 'codex' } });
  assert.equal(r.agent, 'grok');
});

test('the resolved member carries its identity fields', () => {
  const cfg = config({
    designer: {
      agent: 'claude', title: 'Designer', charter: 'Own the visual system.',
      persona: 'Work from the design tokens.', isolation: 'none',
      deliverable: 'document', output_path: 'docs/design'
    }
  });
  const r = resolveMember(cfg, 'designer', { probe: all });
  assert.equal(r.title, 'Designer');
  assert.equal(r.charter, 'Own the visual system.');
  assert.equal(r.persona, 'Work from the design tokens.');
  assert.equal(r.isolation, 'none');
  assert.equal(r.deliverable, 'document');
  assert.equal(r.output_path, 'docs/design');
});

test('identity fields the member omits come back null, and title falls back to the name', () => {
  const r = resolveMember(CONFIG, 'eng-lead', { probe: all });
  assert.equal(r.title, 'eng-lead');
  assert.equal(r.charter, null);
  assert.equal(r.persona, null);
  assert.equal(r.model, null);
  assert.equal(r.skill, null);
  assert.equal(r.output_path, null);
});

test('the resolved member carries its direct reports and its manager', () => {
  const lead = resolveMember(CONFIG, 'eng-lead', { probe: all });
  assert.deepEqual(lead.reports, ['implementer', 'reviewer']);
  assert.equal(lead.reports_to, null);

  const impl = resolveMember(CONFIG, 'implementer', { probe: all });
  assert.deepEqual(impl.reports, []);
  assert.equal(impl.reports_to, 'eng-lead');
});

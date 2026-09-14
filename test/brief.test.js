import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, loadDialect } from '../src/brief.js';

const IMPL = {
  member: 'implementer', title: 'Implementer', agent: 'codex', model: null, skill: null,
  charter: null, persona: null, isolation: 'workspace', deliverable: 'diff',
  output_path: null, reports_to: 'eng-lead', reports: [], warning: null
};

const LEAD = {
  ...IMPL, member: 'eng-lead', title: 'Engineering lead', agent: 'claude',
  isolation: 'read-only', deliverable: 'decision', reports_to: null,
  reports: ['implementer', 'reviewer']
};

const base = { task: 't', cwd: '/tmp/ws', denyPaths: ['**/.env*'] };

test('the brief carries member, cwd, and deny_paths', () => {
  const b = buildBrief({ resolved: IMPL, ...base });
  assert.equal(b.member, 'implementer');
  assert.equal(b.title, 'Implementer');
  assert.equal(b.cwd, '/tmp/ws');
  assert.deepEqual(b.deny_paths, ['**/.env*']);
});

test('read_only is derived from isolation', () => {
  assert.equal(buildBrief({ resolved: IMPL, ...base }).read_only, false);
  assert.equal(buildBrief({ resolved: LEAD, ...base }).read_only, true);
  assert.equal(
    buildBrief({ resolved: { ...IMPL, isolation: 'none' }, ...base }).read_only, true
  );
});

test('the deliverable and its destination reach the adapter as fields', () => {
  const b = buildBrief({
    resolved: { ...IMPL, deliverable: 'document', output_path: 'docs/design' }, ...base
  });
  assert.equal(b.deliverable, 'document');
  assert.equal(b.output_path, 'docs/design');
});

test('sections run dialect, charter, persona, skill, then the task', () => {
  const b = buildBrief({
    resolved: { ...IMPL, charter: 'THE-CHARTER', persona: 'THE-PERSONA', skill: 'x' },
    ...base, task: 'THE-TASK', skillText: 'THE-SKILL', dialectText: 'THE-DIALECT'
  });
  const at = (s) => b.task.indexOf(s);
  assert.ok(at('THE-DIALECT') >= 0);
  assert.ok(at('THE-CHARTER') > at('THE-DIALECT'), 'charter after dialect');
  assert.ok(at('THE-PERSONA') > at('THE-CHARTER'), 'persona after charter');
  assert.ok(at('THE-SKILL') > at('THE-PERSONA'), 'skill after persona');
  assert.ok(at('THE-TASK') > at('THE-SKILL'), 'task last');
});

test('a member with no charter, persona, or skill gets just the task', () => {
  const b = buildBrief({ resolved: IMPL, ...base, task: 'ONLY' });
  assert.match(b.task, /ONLY/);
  assert.doesNotMatch(b.task, /Your charter/);
  assert.doesNotMatch(b.task, /How you work/);
});

test('a member with no reports is told nothing about delegating', () => {
  const b = buildBrief({ resolved: IMPL, ...base });
  assert.equal(b.can_delegate, false);
  assert.deepEqual(b.reports, []);
  assert.doesNotMatch(b.task, /delegating/i);
});

test('a manager is given the protocol, named reports, and its depth budget', () => {
  const b = buildBrief({ resolved: LEAD, ...base, depth: 1, maxDepth: 3 });
  assert.equal(b.can_delegate, true);
  assert.deepEqual(b.reports, ['implementer', 'reviewer']);
  assert.equal(b.depth, 1);
  assert.equal(b.max_depth, 3);
  assert.match(b.task, /"status":"delegating"/);
  assert.match(b.task, /implementer, reviewer/);
  assert.match(b.task, /depth 1 of a maximum of 3/);
});

test('a manager at the depth limit is told not to delegate', () => {
  const b = buildBrief({ resolved: LEAD, ...base, depth: 3, maxDepth: 3 });
  assert.equal(b.can_delegate, false);
  assert.match(b.task, /cannot delegate any further/);
});

test('results from reports appear before the task, on a synthesis round', () => {
  const b = buildBrief({
    resolved: LEAD, ...base, task: 'SYNTHESISE',
    priorResults: [{ member: 'implementer', status: 'ok', summary: 'SUB-RESULT' }]
  });
  assert.ok(b.task.indexOf('SUB-RESULT') < b.task.indexOf('SYNTHESISE'));
  assert.match(b.task, /Results from your reports/);
});

test('the claude dialect is empty, because no translation is needed', () => {
  assert.equal(loadDialect('claude'), null);
});

test('the grok dialect exists and mentions skills', () => {
  assert.match(loadDialect('grok'), /skill/i);
});

test('an unknown dialect is null rather than an error', () => {
  assert.equal(loadDialect('nonesuch'), null);
});

test('loadDialect rejects a traversal outside references, naming the value', () => {
  assert.throws(() => loadDialect('../../etc/passwd'), /\.\.\/\.\.\/etc\/passwd/);
});

test('loadDialect rejects a name with a parent-directory segment', () => {
  assert.throws(() => loadDialect('../package'));
});

test('loadDialect rejects a traversal disguised inside a longer name', () => {
  assert.throws(() => loadDialect('grok/../../../etc/passwd'));
});

test('loadDialect rejects an absolute path', () => {
  assert.throws(() => loadDialect('/etc/passwd'));
});

test('buildBrief throws when denyPaths is omitted', () => {
  assert.throws(() => buildBrief({ resolved: IMPL, task: 't', cwd: '/tmp/ws' }));
});

test('buildBrief throws when denyPaths is an empty array', () => {
  assert.throws(() => buildBrief({ resolved: IMPL, task: 't', cwd: '/tmp/ws', denyPaths: [] }));
});

test('buildBrief throws when denyPaths is null', () => {
  assert.throws(() => buildBrief({ resolved: IMPL, task: 't', cwd: '/tmp/ws', denyPaths: null }));
});

test('buildBrief throws when denyPaths is not an array', () => {
  assert.throws(() => buildBrief({
    resolved: IMPL, task: 't', cwd: '/tmp/ws', denyPaths: '**/.env*'
  }));
});

test('a normal denylist still round-trips intact, including globs', () => {
  const b = buildBrief({ resolved: IMPL, ...base, denyPaths: ['**/.env*', 'secrets/**'] });
  assert.deepEqual(b.deny_paths, ['**/.env*', 'secrets/**']);
});

test('an empty priorResults array is treated as absent — no section emitted', () => {
  const b = buildBrief({ resolved: LEAD, ...base, task: 'SYNTHESISE', priorResults: [] });
  assert.doesNotMatch(b.task, /Results from your reports/);
});

test('a populated priorResults array still renders the section with the summary', () => {
  const b = buildBrief({
    resolved: LEAD, ...base, task: 'SYNTHESISE',
    priorResults: [{ member: 'implementer', status: 'ok', summary: 'SUB-RESULT' }]
  });
  assert.match(b.task, /Results from your reports/);
  assert.match(b.task, /SUB-RESULT/);
});

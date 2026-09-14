import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';

const TEAM = {
  'eng-lead': { agent: 'mock', isolation: 'read-only', deliverable: 'decision' },
  implementer: { agent: 'mock', reports_to: 'eng-lead', isolation: 'workspace' },
  reviewer: { agent: 'mock', reports_to: 'eng-lead', isolation: 'read-only' },
  marketer: { agent: 'mock', isolation: 'none' }
};

function project(scripted, { members = TEAM, defaults = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'at-dsp-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');   // global commit.gpgsign=true would break the fixture
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, 'app.js'), 'ok\n');
  writeFileSync(join(root, 'credentials', 'key.p8'), 'SECRET\n');
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members,
    deny_paths: ['credentials/**'],
    defaults: { on_unavailable: 'mock', ...defaults }
  }));
  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify(scripted));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, script };
}

const adapterDir = new URL('../adapters/', import.meta.url).pathname;
const run = (root, script, member, extra = {}) => dispatch({
  projectRoot: root, member, task: 'go', adapterDir,
  env: { AGENT_TEAM_MOCK_SCRIPT: script }, ...extra
});

test('a successful run returns the result and prunes the workspace', async () => {
  const { root, script } = project({ status: 'ok', summary: 'clean' });
  const r = await run(root, script, 'implementer');
  assert.equal(r.status, 'ok');
  assert.equal(existsSync(r.workspace.dir), false, 'workspace should be pruned on success');
});

test('a failed run KEEPS the workspace for inspection', async () => {
  const { root, script } = project({ status: 'failed', summary: 'exploded' });
  const r = await run(root, script, 'implementer');
  assert.equal(r.status, 'failed');
  assert.equal(existsSync(r.workspace.dir), true, 'workspace should survive a failure');
});

test('a timed-out run also keeps the workspace', async () => {
  const { root, script } = project({ hang: true });
  const r = await run(root, script, 'implementer', { timeoutMs: 1500 });
  assert.equal(r.status, 'timeout');
  assert.equal(existsSync(r.workspace.dir), true, 'a timeout is a failure; keep the evidence');
});

test('the adapter is handed a workspace it cannot read the secret from', async () => {
  const { root, script } = project({ status: 'ok', summary: 's' });
  const r = await run(root, script, 'implementer');
  assert.ok(r.received.cwd.includes('workspaces'));
  assert.equal(existsSync(join(r.received.cwd, 'credentials', 'key.p8')), false);
});

test('an unknown member fails before any workspace is created', async () => {
  const { root, script } = project({ status: 'ok', summary: 's' });
  await assert.rejects(() => run(root, script, 'nope'), /unknown member/);
});

test('an isolation-none member runs without a repository', async () => {
  const { root, script } = project({ status: 'ok', summary: 'copy written' });
  const r = await run(root, script, 'marketer');
  assert.equal(r.status, 'ok');
  assert.equal(r.received.read_only, true);
  assert.equal(existsSync(join(r.received.cwd, '.git')), false);
});

test('a manager delegates, its report runs, and the manager synthesises', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'implementer', task: 'build it' }] },
      implementer: { status: 'ok', summary: 'built' }
    }
  });
  const r = await run(root, script, 'eng-lead');
  assert.equal(r.status, 'ok');
  assert.equal(r.delegated.length, 1);
  assert.equal(r.delegated[0].member, 'implementer');
  assert.equal(r.delegated[0].status, 'ok');
  // the second call to the manager carried the report's result
  assert.match(r.received.task, /Results from your reports/);
  assert.match(r.received.task, /built/);
});

test('delegating outside your direct reports is refused', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'marketer', task: 'x' }] }
    }
  });
  await assert.rejects(() => run(root, script, 'eng-lead'), /not a direct report/);
});

test('delegating with an empty list is a protocol error, not an infinite loop', async () => {
  const { root, script } = project({
    by_member: { 'eng-lead': { status: 'delegating', delegations: [] } }
  });
  const r = await run(root, script, 'eng-lead');
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /no delegations/);
});

test('max_depth stops a manager from delegating past the limit', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'implementer', task: 'x' }] },
      implementer: { status: 'ok', summary: 'built' }
    }
  }, { defaults: { max_depth: 0 } });
  const r = await run(root, script, 'eng-lead');
  // at depth 0 of max 0 the brief forbids delegating, and the dispatcher enforces it too
  assert.equal(r.received.can_delegate, false);
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /max_depth/);
});

test('max_delegations bounds the total number of adapter runs', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'implementer', task: 'x' }] },
      implementer: { status: 'ok', summary: 'built' }
    }
  }, { defaults: { max_delegations: 2 } });
  const r = await run(root, script, 'eng-lead');
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /budget/);
});

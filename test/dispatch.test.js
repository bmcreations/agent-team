import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';

// Recursively collects every path anywhere under `root` whose own name contains
// `needle`, at any depth. Used to make a filesystem claim ("no workspace for X
// exists anywhere") checkable instead of just asserting on the rejection message.
function findEntriesMentioning(root, needle) {
  if (!existsSync(root)) return [];
  const hits = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name.includes(needle)) hits.push(full);
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return hits;
}

// Gives the callback its own dedicated AGENT_TEAM_WORKSPACE_ROOT, isolated from
// every other test's workspaces, and restores the previous value afterwards.
async function withWorkspaceRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'at-dsp-wsroot-'));
  const prev = process.env.AGENT_TEAM_WORKSPACE_ROOT;
  process.env.AGENT_TEAM_WORKSPACE_ROOT = root;
  try {
    return await fn(root);
  } finally {
    process.env.AGENT_TEAM_WORKSPACE_ROOT = prev;
  }
}

// dispatch creates workspaces in-process via createWorkspace, which resolves its cache
// root from AGENT_TEAM_WORKSPACE_ROOT (real process.env, not the `env` object passed to
// dispatch — that only reaches the adapter subprocess). Point it at a throwaway root so
// these tests never write into the developer's real ~/.cache.
process.env.AGENT_TEAM_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-dsp-wsroot-'));

const TEAM = {
  'eng-lead': { agent: 'mock', isolation: 'read-only', deliverable: 'decision' },
  implementer: { agent: 'mock', reports_to: 'eng-lead', isolation: 'workspace' },
  reviewer: { agent: 'mock', reports_to: 'eng-lead', isolation: 'read-only' },
  marketer: { agent: 'mock', isolation: 'none' }
};

function project(scripted, { members = TEAM, defaults = {}, denyPaths = ['credentials/**'] } = {}) {
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
    deny_paths: denyPaths,
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

test('a member that binds a skill with no skillsDir provided is refused, not silently dropped', async () => {
  const { root, script } = project({ status: 'ok', summary: 's' }, {
    members: { ...TEAM, implementer: { ...TEAM.implementer, skill: 'some-skill' } }
  });
  await assert.rejects(
    () => run(root, script, 'implementer'),
    /member "implementer" binds skill "some-skill" but no skillsDir was provided/
  );
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
  await withWorkspaceRoot(async (wsRoot) => {
    const { root, script } = project({ status: 'ok', summary: 's' });
    await assert.rejects(() => run(root, script, 'nope'), /unknown member/);
    assert.deepEqual(
      findEntriesMentioning(wsRoot, 'nope'), [],
      'no directory anywhere under the workspace root should mention the unknown member'
    );
  });
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
      'eng-lead': [
        { status: 'delegating', delegations: [{ to: 'implementer', task: 'build it' }] },
        { status: 'ok', summary: 'synthesized from delegated results' }
      ],
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

test('a 1-level delegation-boundary violation leaves nothing under the workspace root', async () => {
  await withWorkspaceRoot(async (wsRoot) => {
    const { root, script } = project({
      by_member: {
        'eng-lead': { status: 'delegating', delegations: [{ to: 'marketer', task: 'x' }] }
      }
    });
    await assert.rejects(() => run(root, script, 'eng-lead'), /not a direct report/);
    assert.deepEqual(
      findEntriesMentioning(wsRoot, 'eng-lead'), [],
      'the manager workspace should be pruned, not stranded, when the boundary throws'
    );
  });
});

test('a 3-level delegation-boundary violation cleans both ancestor workspaces', async () => {
  const CHAIN = {
    manager: { agent: 'mock', isolation: 'workspace' },
    b: { agent: 'mock', reports_to: 'manager', isolation: 'workspace' },
    outsider: { agent: 'mock', isolation: 'workspace' }
  };
  await withWorkspaceRoot(async (wsRoot) => {
    const { root, script } = project({
      by_member: {
        manager: { status: 'delegating', delegations: [{ to: 'b', task: 'x' }] },
        b: { status: 'delegating', delegations: [{ to: 'outsider', task: 'y' }] }
      }
    }, { members: CHAIN });
    await assert.rejects(() => run(root, script, 'manager'), /not a direct report/);
    const stranded = [
      ...findEntriesMentioning(wsRoot, 'manager-'),
      ...findEntriesMentioning(wsRoot, 'b-')
    ];
    assert.deepEqual(
      stranded, [],
      'both ancestor workspaces (manager and b) should be pruned as the error propagates'
    );
  });
});

test('the reporting-line error message is unchanged by the pruning fix', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'marketer', task: 'x' }] }
    }
  });
  await assert.rejects(
    () => run(root, script, 'eng-lead'),
    /member "eng-lead" may not delegate to "marketer" — not a direct report \(reports: implementer, reviewer\)/
  );
});

test('a failed result still keeps its workspace even after the pruning fix', async () => {
  await withWorkspaceRoot(async (wsRoot) => {
    const { root, script } = project({ status: 'failed', summary: 'exploded' });
    const r = await run(root, script, 'implementer');
    assert.equal(r.status, 'failed');
    assert.equal(existsSync(r.workspace.dir), true);
    assert.notDeepEqual(
      findEntriesMentioning(wsRoot, 'implementer-'), [],
      'a failed result must still leave its workspace on disk for inspection'
    );
  });
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

test('a deny_paths entry matching nothing is warned about and returned in the result', async () => {
  const { root, script } = project(
    { status: 'ok', summary: 'clean' },
    { denyPaths: ['credentials/**', 'nope/never/matches/**'] }
  );
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const r = await run(root, script, 'implementer');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.unmatchedDenyPaths, ['nope/never/matches/**']);
    assert.ok(
      warnings.some((w) => w.includes('nope/never/matches/**')),
      `expected a console.warn naming the unmatched entry, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('an isolation-none run reports no unmatched deny_paths rather than throwing', async () => {
  const { root, script } = project(
    { status: 'ok', summary: 'copy written' },
    { denyPaths: ['credentials/**', 'nope/never/matches/**'] }
  );
  const r = await run(root, script, 'marketer');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.unmatchedDenyPaths, []);
});

test('a dropped tracked symlink is warned about and returned in the result', async () => {
  const { root, script } = project({ status: 'ok', summary: 'clean' });
  // project() already committed app.js/credentials/key.p8 — add a tracked symlink on top
  // and re-commit, following the same pattern the workspace.test.js fixtures use.
  symlinkSync(join(root, 'app.js'), join(root, 'app-link'));
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'add symlink'], { stdio: 'pipe' });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const r = await run(root, script, 'implementer');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.droppedSymlinks, ['app-link']);
    assert.ok(
      warnings.some((w) => w.includes('app-link')),
      `expected a console.warn naming the dropped symlink, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('an isolation-none run reports no dropped symlinks rather than throwing', async () => {
  const { root, script } = project({ status: 'ok', summary: 'copy written' });
  const r = await run(root, script, 'marketer');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.droppedSymlinks, []);
});

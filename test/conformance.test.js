import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conformanceReport } from './conformance.js';

const adapterDir = new URL('../adapters/', import.meta.url).pathname;
const MOCK = join(adapterDir, 'mock');
const CRASH = new URL('./fixtures/crash', import.meta.url).pathname;
const WRITES_DESPITE_READ_ONLY = new URL('./fixtures/writes-despite-read-only', import.meta.url).pathname;
const COMMITS_DESPITE_READ_ONLY = new URL('./fixtures/commits-despite-read-only', import.meta.url).pathname;
const BRANCHES_DESPITE_READ_ONLY = new URL('./fixtures/branches-despite-read-only', import.meta.url).pathname;

function writeMockScript(dir, scripted) {
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(scripted));
  return scriptPath;
}

function initGitFixtureRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.st'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

test('the mock adapter is conformant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-mock-'));
  const scriptPath = writeMockScript(dir, {
    status: 'ok', summary: 'mock reply', findings: [], checked_sound: []
  });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath }
  });

  assert.equal(report.conformant, true, JSON.stringify(report.failures));
});

test('an adapter missing capabilities is reported non-conformant', async () => {
  const report = await conformanceReport(CRASH, {});

  assert.equal(report.conformant, false);
  assert.ok(report.failures.length > 0);
});

test('a brief that forbids delegation is reported non-conformant when the adapter delegates anyway', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-delegate-'));
  const scriptPath = writeMockScript(dir, {
    status: 'delegating', delegations: [{ to: 'x', task: 't' }]
  });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath }
  });

  assert.equal(report.conformant, false);
  // Match the delegation cross-check by its distinct step name, not by a substring of its
  // message — "delegating" now also legitimately appears in the plain status-validity
  // failure's message, so a substring match here cannot tell the two apart.
  assert.ok(
    report.failures.some((f) => f.step === 'delegation-guard'),
    JSON.stringify(report.failures)
  );
  // The brief really did forbid delegation — otherwise this test proves nothing.
  assert.equal(report.brief.can_delegate, false);
});

test('a can_delegate brief is reported conformant when the adapter answers delegating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-delegate-ok-'));
  const scriptPath = writeMockScript(dir, {
    status: 'delegating', delegations: [{ to: 'worker', task: 't' }]
  });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath },
    reports: ['worker']
  });

  // The brief really did allow delegation — otherwise this test proves nothing.
  assert.equal(report.brief.can_delegate, true);
  assert.equal(report.conformant, true, JSON.stringify(report.failures));
});

test('a read_only brief leaves the working tree clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-readonly-'));
  initGitFixtureRepo(dir);

  // The mock's script file must live outside the repo under test, or it shows up as an
  // untracked file and the "clean working tree" assertion below is vacuously false.
  const scriptDir = mkdtempSync(join(tmpdir(), 'at-conf-readonly-script-'));
  const scriptPath = writeMockScript(scriptDir, {
    status: 'ok', summary: 'mock reply', findings: [], checked_sound: []
  });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath }
  });

  assert.equal(report.brief.read_only, true);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString(), '');
});

test('a read_only run that dirties the working tree is reported non-conformant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-dirty-'));
  initGitFixtureRepo(dir);

  // This fixture ignores brief.read_only and writes into brief.cwd unconditionally — the
  // reviewer's reproduction of a real vendor CLI that does not honor read-only mode.
  const report = await conformanceReport(WRITES_DESPITE_READ_ONLY, { cwd: dir });

  assert.equal(report.brief.read_only, true);
  assert.equal(report.conformant, false);
  assert.ok(
    report.failures.some(
      (f) => f.step === 'read-only-git-status' && /i-should-not-exist\.txt/.test(f.detail)
    ),
    JSON.stringify(report.failures)
  );
});

test('a run status outside the valid set is reported non-conformant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-badstatus-'));
  const scriptPath = writeMockScript(dir, { status: 'banana' });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath }
  });

  assert.equal(report.conformant, false);
  assert.ok(
    report.failures.some((f) => f.step === 'run' && /banana/.test(f.detail)),
    JSON.stringify(report.failures)
  );
});

test('a read_only run that commits is reported non-conformant even though the tree is clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-commits-'));
  initGitFixtureRepo(dir);

  const report = await conformanceReport(COMMITS_DESPITE_READ_ONLY, { cwd: dir });

  assert.equal(report.brief.read_only, true);
  // The defect this guards against: a commit leaves porcelain status clean, so the
  // working-tree-only check must not be the only signal that fires here.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString(), '');
  assert.equal(report.conformant, false);
  assert.ok(
    report.failures.some((f) => f.step === 'read-only-git-head' && /moved HEAD/.test(f.detail)),
    JSON.stringify(report.failures)
  );
});

test('a read_only run that creates a branch is reported non-conformant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-branch-'));
  initGitFixtureRepo(dir);

  const report = await conformanceReport(BRANCHES_DESPITE_READ_ONLY, { cwd: dir });

  assert.equal(report.brief.read_only, true);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString(), '');
  assert.equal(report.conformant, false);
  assert.ok(
    report.failures.some((f) => f.step === 'read-only-git-refs' && /unauthorized-branch/.test(f.detail)),
    JSON.stringify(report.failures)
  );
});

test('a read_only conformance run notes that a reverted write is outside what this check can detect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-honesty-'));
  initGitFixtureRepo(dir);
  const scriptDir = mkdtempSync(join(tmpdir(), 'at-conf-honesty-script-'));
  const scriptPath = writeMockScript(scriptDir, {
    status: 'ok', summary: 'mock reply', findings: [], checked_sound: []
  });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath }
  });

  assert.equal(report.brief.read_only, true);
  assert.ok(
    report.notes.some((n) => n.step === 'read-only-git-status' && /revert/.test(n.detail)),
    JSON.stringify(report.notes)
  );
});

// --- requireSuccess: the live-vendor mode needs to know the adapter actually reached the
// model, not just that it failed the way a conformant adapter is allowed to fail. ---

test('a failed status is still conformant by default — this is the graceful-failure contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-reqsucc-'));
  const scriptPath = writeMockScript(dir, { status: 'failed', summary: 'not signed in' });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath }
  });

  assert.equal(report.conformant, true, JSON.stringify(report.failures));
});

test('requireSuccess:true fails a run that never reached status ok', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-reqsucc-'));
  const scriptPath = writeMockScript(dir, { status: 'failed', summary: 'not signed in' });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath },
    requireSuccess: true
  });

  assert.equal(report.conformant, false);
});

test('the requireSuccess failure detail names the adapter\'s own summary, not a bare assertion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-reqsucc-'));
  const scriptPath = writeMockScript(dir, {
    status: 'failed', summary: 'Not signed in. Run `grok login` first.'
  });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath },
    requireSuccess: true
  });

  assert.equal(report.conformant, false);
  assert.ok(
    report.failures.some((f) => /Not signed in\. Run `grok login` first\./.test(f.detail)),
    JSON.stringify(report.failures)
  );
});

test('requireSuccess:true still passes a genuinely successful run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-reqsucc-'));
  const scriptPath = writeMockScript(dir, {
    status: 'ok', summary: 'reached the model', findings: [], checked_sound: []
  });

  const report = await conformanceReport(MOCK, {
    cwd: dir,
    env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath },
    requireSuccess: true
  });

  assert.equal(report.conformant, true, JSON.stringify(report.failures));
});

// Opt-in: AGENT_TEAM_CONFORMANCE=codex,grok npm test
const targets = (process.env.AGENT_TEAM_CONFORMANCE ?? '').split(',').filter(Boolean);
for (const agent of targets) {
  test(`real adapter "${agent}" is conformant`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'at-conf-real-'));
    const report = await conformanceReport(join(adapterDir, agent), { cwd: dir, requireSuccess: true });
    assert.equal(report.conformant, true, JSON.stringify(report.failures, null, 2));
  });
}

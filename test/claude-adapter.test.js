import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildBrief } from '../src/brief.js';
import { runAdapter } from '../src/adapter.js';

const ADAPTER = new URL('../adapters/claude', import.meta.url).pathname;

test('probe reports availability without making a network call', () => {
  // probe must be cheap: it checks the binary exists, it does not run a turn
  const started = Date.now();
  try { execFileSync(ADAPTER, ['probe'], { stdio: 'pipe' }); } catch { /* absent is fine */ }
  assert.ok(Date.now() - started < 5000, 'probe must not run an inference turn');
});

test('capabilities declares the claude dialect', () => {
  const caps = JSON.parse(execFileSync(ADAPTER, ['capabilities']).toString());
  assert.equal(caps.tool_dialect, 'claude');
  assert.equal(caps.write, true);
  assert.equal(caps.workspace, true);
});

// A stub "claude" binary: it records its own argv and cwd to a JSON file (path given via
// the CLAUDE_STUB_RECORD env var) and prints a Claude-Code-shaped JSON envelope on stdout,
// so the adapter's `JSON.parse(r.stdout.toString()).result` path is the one exercised.
// Plain CommonJS (require, not import) so Node's module-type detection can't get in the way
// of a shebang script with no file extension.
function createClaudeStub() {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-stub-'));
  const recordPath = join(stubDir, 'record.json');
  const stubPath = join(stubDir, 'claude');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.CLAUDE_STUB_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
    "process.stdout.write(JSON.stringify({ result: 'stub summary' }) + '\\n');",
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return { stubDir, recordPath };
}

function runAdapterAgainstStub(brief) {
  const { stubDir, recordPath } = createClaudeStub();
  execFileSync(ADAPTER, ['run'], {
    input: JSON.stringify(brief),
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, CLAUDE_STUB_RECORD: recordPath }
  });
  return JSON.parse(readFileSync(recordPath, 'utf8'));
}

test('a can_delegate brief reaches the subagent with its delegation section intact', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-cwd-'));
  const resolved = {
    member: 'lead',
    title: 'Lead',
    agent: 'claude',
    model: null,
    skill: null,
    charter: 'You coordinate the implementer and synthesize their result.',
    persona: null,
    isolation: 'workspace',
    deliverable: 'text',
    output_path: null,
    reports_to: null,
    reports: ['implementer'],
    warning: null
  };

  const brief = buildBrief({
    resolved,
    task: 'SENTINEL-TASK',
    cwd,
    denyPaths: ['**/.env*'],
    depth: 0,
    maxDepth: 3
  });

  // Sanity: if this is false, the rest of the test proves nothing.
  assert.equal(brief.can_delegate, true);

  const record = runAdapterAgainstStub(brief);
  const pIndex = record.argv.indexOf('-p');
  assert.notEqual(pIndex, -1, 'argv must contain -p');
  const promptArg = record.argv[pIndex + 1];
  assert.match(promptArg, /SENTINEL-TASK/);
  assert.match(promptArg, /# Delegating/);
  assert.match(promptArg, /"status":"delegating"/);
});

test('a read_only brief passes --permission-mode plan, and a writable one does not', () => {
  const baseResolved = {
    member: 'lead',
    title: 'Lead',
    agent: 'claude',
    model: null,
    skill: null,
    charter: null,
    persona: null,
    deliverable: 'text',
    output_path: null,
    reports_to: null,
    reports: [],
    warning: null
  };

  const roCwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-ro-'));
  const roBrief = buildBrief({
    resolved: { ...baseResolved, isolation: 'read-only' },
    task: 'x',
    cwd: roCwd,
    denyPaths: ['**/.env*']
  });
  assert.equal(roBrief.read_only, true);
  const roRecord = runAdapterAgainstStub(roBrief);
  const roPmIndex = roRecord.argv.indexOf('--permission-mode');
  assert.notEqual(roPmIndex, -1, 'read-only argv must contain --permission-mode');
  assert.equal(roRecord.argv[roPmIndex + 1], 'plan');

  const wCwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-w-'));
  const wBrief = buildBrief({
    resolved: { ...baseResolved, isolation: 'workspace' },
    task: 'x',
    cwd: wCwd,
    denyPaths: ['**/.env*']
  });
  assert.equal(wBrief.read_only, false);
  const wRecord = runAdapterAgainstStub(wBrief);
  assert.equal(wRecord.argv.includes('--permission-mode'), false);
});

test('a resolved model is passed as --model, and the flag is absent when model is null', () => {
  const baseResolved = {
    member: 'lead',
    title: 'Lead',
    agent: 'claude',
    model: null,
    skill: null,
    charter: null,
    persona: null,
    isolation: 'workspace',
    deliverable: 'diff',
    output_path: null,
    reports_to: null,
    reports: [],
    warning: null
  };

  const cwdWithModel = mkdtempSync(join(tmpdir(), 'agent-team-claude-model-'));
  const briefWithModel = buildBrief({
    resolved: { ...baseResolved, model: 'claude-opus-4' },
    task: 'x',
    cwd: cwdWithModel,
    denyPaths: ['**/.env*']
  });
  const recordWithModel = runAdapterAgainstStub(briefWithModel);
  const modelIndex = recordWithModel.argv.indexOf('--model');
  assert.notEqual(modelIndex, -1, 'argv must contain --model when brief.model is set');
  // Check the adjacent argv slot, not a joined string — a whitespace-splitting bug in the
  // arg list must not be able to pass this.
  assert.equal(recordWithModel.argv[modelIndex + 1], 'claude-opus-4');

  const cwdNoModel = mkdtempSync(join(tmpdir(), 'agent-team-claude-nomodel-'));
  const briefNoModel = buildBrief({
    resolved: { ...baseResolved, model: null },
    task: 'x',
    cwd: cwdNoModel,
    denyPaths: ['**/.env*']
  });
  const recordNoModel = runAdapterAgainstStub(briefNoModel);
  assert.equal(recordNoModel.argv.includes('--model'), false);
});

// A stub that emits a `result` string past the 64 KB OS pipe buffer, to prove the adapter's
// stdout write is fully drained before the process exits — not just that small payloads work.
function createLargeResultClaudeStub(resultLength) {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-stub-big-'));
  const stubPath = join(stubDir, 'claude');
  const big = 'x'.repeat(resultLength);
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    // No process.exit() here: this stub stands in for a well-behaved vendor CLI, and must
    // not itself carry the premature-exit bug under test. Letting Node exit naturally once
    // the write drains and the event loop is empty is what a correct binary would do.
    `process.stdout.write(JSON.stringify({ result: ${JSON.stringify(big)} }) + '\\n');`,
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return stubDir;
}

test('a run payload past the 64 KB pipe buffer survives intact through the real runAdapter', async () => {
  const RESULT_LENGTH = 100_000; // comfortably over the 64 KB pipe buffer that truncates it
  const stubDir = createLargeResultClaudeStub(RESULT_LENGTH);

  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-cwd-big-'));
  const resolved = {
    member: 'implementer',
    title: 'Implementer',
    agent: 'claude',
    model: null,
    skill: null,
    charter: null,
    persona: null,
    isolation: 'workspace',
    deliverable: 'diff',
    output_path: null,
    reports_to: null,
    reports: [],
    warning: null
  };
  const brief = buildBrief({ resolved, task: 'x', cwd, denyPaths: ['**/.env*'] });

  const started = Date.now();
  const res = await runAdapter(ADAPTER, 'run', {
    brief,
    env: { PATH: `${stubDir}:${process.env.PATH}` }
  });
  const elapsed = Date.now() - started;

  // A real, network-bound `claude` invocation would never return this fast — this is the
  // adapter's own signal (alongside the stub's presence first on PATH) that the stub, not
  // the real billable binary, answered.
  assert.ok(elapsed < 5000, `must not have reached the real claude binary (took ${elapsed}ms)`);
  assert.equal(res.status, 'ok');
  assert.equal(res.summary.length, RESULT_LENGTH);
});

function initGitFixtureRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.st'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'original\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

// A stub that always succeeds and carries no bookkeeping requirement (unlike createClaudeStub,
// it needs no CLAUDE_STUB_RECORD env var) — for tests that only care about the adapter's
// post-run diff handling, not argv or cwd captured from the stub itself.
function createSuccessClaudeStub() {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-ok-stub-'));
  const stubPath = join(stubDir, 'claude');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ result: 'ok' }) + '\\n');",
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return stubDir;
}

function briefForCwd(cwd) {
  const resolved = {
    member: 'implementer',
    title: 'Implementer',
    agent: 'claude',
    model: null,
    skill: null,
    charter: null,
    persona: null,
    isolation: 'workspace',
    deliverable: 'diff',
    output_path: null,
    reports_to: null,
    reports: [],
    warning: null
  };
  return buildBrief({ resolved, task: 'x', cwd, denyPaths: ['**/.env*'] });
}

test('a diff past the display cap is truncated with an explicit signal, not silently', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-bigdiff-'));
  initGitFixtureRepo(cwd);
  // Comfortably past the adapter's 200,000-char display cap.
  writeFileSync(join(cwd, 'f.txt'), 'x'.repeat(500_000));

  const stubDir = createSuccessClaudeStub();
  const brief = briefForCwd(cwd);
  const res = await runAdapter(ADAPTER, 'run', { brief, env: { PATH: `${stubDir}:${process.env.PATH}` } });

  assert.equal(res.status, 'ok');
  assert.equal(res.artifacts.diff.length, 200_000);
  assert.equal(res.artifacts.diff_truncated, true);
  assert.ok(res.artifacts.diff_full_length > 200_000, `expected full_length > 200000, got ${res.artifacts.diff_full_length}`);
  assert.equal(res.artifacts.diff_unreadable, false);
});

test('a diff too large to read is reported as unreadable, not as an empty diff', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-unreadable-'));
  initGitFixtureRepo(cwd);
  writeFileSync(join(cwd, 'f.txt'), 'x'.repeat(50_000));

  const stubDir = createSuccessClaudeStub();
  const brief = briefForCwd(cwd);
  // Force the diff-reading buffer well under the diff's real size, without needing a
  // multi-megabyte fixture to exceed the adapter's production default.
  const res = await runAdapter(ADAPTER, 'run', {
    brief,
    env: { PATH: `${stubDir}:${process.env.PATH}`, AGENT_TEAM_CLAUDE_DIFF_MAX_BUFFER: '1000' }
  });

  assert.equal(res.status, 'ok');
  assert.equal(res.artifacts.diff_unreadable, true);
  assert.equal(res.artifacts.diff, '', 'an unreadable diff must not be silently reported as an empty (no-change) diff');
});

test('a non-numeric diff maxBuffer override falls back to the default instead of swallowing a real diff', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-badbuffer-'));
  initGitFixtureRepo(cwd);
  writeFileSync(join(cwd, 'f.txt'), 'x'.repeat(5000));

  const stubDir = createSuccessClaudeStub();
  const brief = briefForCwd(cwd);
  const res = await runAdapter(ADAPTER, 'run', {
    brief,
    env: { PATH: `${stubDir}:${process.env.PATH}`, AGENT_TEAM_CLAUDE_DIFF_MAX_BUFFER: 'not-a-number' }
  });

  assert.equal(res.status, 'ok');
  // The dangerous direction this guards against: Number('not-a-number') is NaN, execFileSync
  // throws ERR_OUT_OF_RANGE, the catch block does not recognize it, and the genuine diff comes
  // back silently empty. A bad override must not read as "no diff".
  assert.ok(res.artifacts.diff.length > 0, 'a bad override must not swallow a real diff');
  assert.equal(res.artifacts.diff_unreadable, false);
  assert.equal(res.artifacts.diff_max_buffer_invalid_override, 'not-a-number');
});

test('a negative diff maxBuffer override falls back to the default instead of swallowing a real diff', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-negbuffer-'));
  initGitFixtureRepo(cwd);
  writeFileSync(join(cwd, 'f.txt'), 'x'.repeat(5000));

  const stubDir = createSuccessClaudeStub();
  const brief = briefForCwd(cwd);
  const res = await runAdapter(ADAPTER, 'run', {
    brief,
    env: { PATH: `${stubDir}:${process.env.PATH}`, AGENT_TEAM_CLAUDE_DIFF_MAX_BUFFER: '-1000' }
  });

  assert.equal(res.status, 'ok');
  assert.ok(res.artifacts.diff.length > 0, 'a bad override must not swallow a real diff');
  assert.equal(res.artifacts.diff_unreadable, false);
  assert.equal(res.artifacts.diff_max_buffer_invalid_override, '-1000');
});

test('a nonexistent brief.cwd is reported as a specific failure, not "claude exited null"', async () => {
  const brief = { ...briefForCwd(mkdtempSync(join(tmpdir(), 'agent-team-claude-tmpl-'))), cwd: '/no/such/directory/at/all' };

  const res = await runAdapter(ADAPTER, 'run', { brief, env: {} });

  assert.equal(res.status, 'failed');
  assert.match(res.summary, /cwd does not exist/);
});

test('a missing claude binary is reported distinctly from a nonexistent cwd', async () => {
  // PATH restricted to node's own directory: this adapter script (invoked via its #!/usr/bin/env
  // node shebang) still resolves, but "claude" resolves to nothing, while brief.cwd is real.
  const nodeOnlyPath = dirname(process.execPath);
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-realcwd-'));
  const brief = briefForCwd(cwd);

  const res = await runAdapter(ADAPTER, 'run', { brief, env: { PATH: nodeOnlyPath } });

  assert.equal(res.status, 'failed');
  assert.match(res.summary, /not installed or not on PATH/);
});

test('a hung claude is reported as a timeout, distinctly from a missing binary or bad cwd', async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-hang-'));
  const stubPath = join(stubDir, 'claude');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);

  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-timeoutcwd-'));
  const brief = { ...briefForCwd(cwd), timeout_s: 0.2 };

  const res = await runAdapter(ADAPTER, 'run', {
    brief, env: { PATH: `${stubDir}:${process.env.PATH}` }, timeoutMs: 10_000
  });

  assert.equal(res.status, 'failed');
  assert.match(res.summary, /timed out/);
});

test('a claude process killed by an external SIGTERM is reported as signal-terminated, not as our timeout', async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-sigterm-'));
  const stubPath = join(stubDir, 'claude');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    // Self-inflicted SIGTERM shortly after starting, standing in for a kill from outside this
    // process (an OOM killer, `pkill claude`, a supervisor) that has nothing to do with the
    // adapter's own timeout_s and fires long before it would ever elapse.
    'setTimeout(() => { process.kill(process.pid, "SIGTERM"); }, 300);',
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);

  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-sigtermcwd-'));
  // A generous timeout_s that never comes close to elapsing: if this SIGTERM is misreported
  // as our timeout, the summary will falsely claim the run took the full 300000ms this brief
  // allows, when the process was actually killed after ~300ms.
  const brief = { ...briefForCwd(cwd), timeout_s: 300 };

  const res = await runAdapter(ADAPTER, 'run', {
    brief, env: { PATH: `${stubDir}:${process.env.PATH}` }, timeoutMs: 10_000
  });

  assert.equal(res.status, 'failed');
  assert.doesNotMatch(res.summary, /timed out/);
  assert.match(res.summary, /SIGTERM/);
});

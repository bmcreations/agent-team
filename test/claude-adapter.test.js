import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
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

test('a read_only brief passes --permission-mode plan, and a writable one passes its permission_mode or auto', () => {
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
  // With no mode, headless `claude -p` refuses every tool call that would prompt, so a
  // workspace member could not edit its own clone. It defaults to auto.
  const wRecord = runAdapterAgainstStub(wBrief);
  const wPmIndex = wRecord.argv.indexOf('--permission-mode');
  assert.notEqual(wPmIndex, -1, 'workspace argv must contain --permission-mode');
  assert.equal(wRecord.argv[wPmIndex + 1], 'auto');

  const setCwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-pm-'));
  const setBrief = buildBrief({
    resolved: { ...baseResolved, isolation: 'workspace', permission_mode: 'acceptEdits' },
    task: 'x',
    cwd: setCwd,
    denyPaths: ['**/.env*']
  });
  const setRecord = runAdapterAgainstStub(setBrief);
  assert.equal(setRecord.argv[setRecord.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
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

test('a resolved effort is passed as --effort, and the flag is absent when effort is null', () => {
  const baseResolved = {
    member: 'lead',
    title: 'Lead',
    agent: 'claude',
    model: null,
    effort: null,
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

  const cwdWithEffort = mkdtempSync(join(tmpdir(), 'agent-team-claude-effort-'));
  const briefWithEffort = buildBrief({
    resolved: { ...baseResolved, effort: 'high' },
    task: 'x',
    cwd: cwdWithEffort,
    denyPaths: ['**/.env*']
  });
  const recordWithEffort = runAdapterAgainstStub(briefWithEffort);
  const effortIndex = recordWithEffort.argv.indexOf('--effort');
  assert.notEqual(effortIndex, -1, 'argv must contain --effort when brief.effort is set');
  assert.equal(recordWithEffort.argv[effortIndex + 1], 'high');

  const cwdNoEffort = mkdtempSync(join(tmpdir(), 'agent-team-claude-noeffort-'));
  const briefNoEffort = buildBrief({
    resolved: baseResolved,
    task: 'x',
    cwd: cwdNoEffort,
    denyPaths: ['**/.env*']
  });
  const recordNoEffort = runAdapterAgainstStub(briefNoEffort);
  assert.equal(recordNoEffort.argv.includes('--effort'), false);
});

test('a resolved advisor is passed as advisorModel in --settings, and no --settings when advisor is null', () => {
  // The claude CLI has no advisor flag; advisorModel is a settings key, and --settings takes
  // a JSON string that is merged over the user's own settings.
  const baseResolved = {
    member: 'lead',
    title: 'Lead',
    agent: 'claude',
    model: null,
    effort: null,
    advisor: null,
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

  const cwdWithAdvisor = mkdtempSync(join(tmpdir(), 'agent-team-claude-advisor-'));
  const recordWithAdvisor = runAdapterAgainstStub(buildBrief({
    resolved: { ...baseResolved, advisor: 'opus' },
    task: 'x',
    cwd: cwdWithAdvisor,
    denyPaths: ['**/.env*']
  }));
  const settingsIndex = recordWithAdvisor.argv.indexOf('--settings');
  assert.notEqual(settingsIndex, -1, 'argv must contain --settings when brief.advisor is set');
  assert.deepEqual(JSON.parse(recordWithAdvisor.argv[settingsIndex + 1]), { advisorModel: 'opus' });

  const cwdNoAdvisor = mkdtempSync(join(tmpdir(), 'agent-team-claude-noadvisor-'));
  const recordNoAdvisor = runAdapterAgainstStub(buildBrief({
    resolved: baseResolved,
    task: 'x',
    cwd: cwdNoAdvisor,
    denyPaths: ['**/.env*']
  }));
  assert.equal(recordNoAdvisor.argv.includes('--settings'), false);
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

// The permission_denials shape is copied from a real `claude -p --output-format json
// --permission-mode dontAsk` run that tried an Edit and was refused.
function createDeniedClaudeStub(summary) {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-denied-stub-'));
  const stubPath = join(stubDir, 'claude');
  const envelope = {
    result: summary,
    permission_denials: [
      { tool_name: 'Edit', tool_use_id: 'toolu_1', tool_input: { file_path: 'f.txt' } },
      { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'echo x >> f.txt' } }
    ]
  };
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))} + '\\n');`,
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return stubDir;
}

test('a workspace run whose edits were all refused fails and names the refused tools', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-denied-'));
  initGitFixtureRepo(cwd);
  const stubDir = createDeniedClaudeStub('Both writes were declined, so the file is unchanged.');
  const res = await runAdapter(ADAPTER, 'run', { brief: briefForCwd(cwd), env: { PATH: `${stubDir}:${process.env.PATH}` } });

  assert.equal(res.status, 'failed');
  assert.match(res.summary, /Edit, Bash/);
  assert.match(res.summary, /Both writes were declined/);
  assert.deepEqual(res.permission_denials, ['Edit', 'Bash']);
});

test('a workspace run that changed files despite a refusal fails but still returns its diff', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-partdenied-'));
  initGitFixtureRepo(cwd);
  writeFileSync(join(cwd, 'f.txt'), 'changed\n');
  const stubDir = createDeniedClaudeStub('Edited f.txt; one command was declined.');
  const res = await runAdapter(ADAPTER, 'run', { brief: briefForCwd(cwd), env: { PATH: `${stubDir}:${process.env.PATH}` } });

  assert.equal(res.status, 'failed');
  assert.match(res.artifacts.diff, /changed/);
  assert.deepEqual(res.permission_denials, ['Edit', 'Bash']);
});

// The envelope fields are copied from a real `claude -p --output-format json` run with
// advisorModel set. usage.iterations only covers the last API call, so the adapter counts
// advisor calls from the session transcript, written here under a fake CLAUDE_CONFIG_DIR.
function createUsageClaudeStub(sessionId) {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-usage-stub-'));
  const stubPath = join(stubDir, 'claude');
  const envelope = {
    result: 'done', session_id: sessionId, duration_ms: 4200, num_turns: 7, total_cost_usd: 0.5,
    modelUsage: {
      'claude-sonnet-5-5': { inputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, outputTokens: 30, costUSD: 0.08 },
      'claude-fable-5-1': { inputTokens: 40, outputTokens: 10, costUSD: 0.42 }
    }
  };
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))} + '\\n');`,
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return stubDir;
}

function writeTranscript(configDir, sessionId, advisorCalls) {
  const dir = join(configDir, 'projects', '-some-escaped-cwd');
  mkdirSync(dir, { recursive: true });
  const call = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} };
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    ...Array.from({ length: advisorCalls }, () => JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [call] } })),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'server_tool_use', name: 'web_search' }] } }),
    '{"torn'
  ];
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n'));
}

test('a run reports its usage, with advisor calls counted from the session transcript', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-usage-'));
  initGitFixtureRepo(cwd);
  const configDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-config-'));
  writeTranscript(configDir, 'sess-1', 2);
  const stubDir = createUsageClaudeStub('sess-1');
  const res = await runAdapter(ADAPTER, 'run', {
    brief: briefForCwd(cwd), env: { PATH: `${stubDir}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: configDir }
  });

  assert.equal(res.usage.duration_ms, 4200);
  assert.equal(res.usage.turns, 7);
  assert.equal(res.usage.cost_usd, 0.5);
  assert.equal(res.usage.session_id, 'sess-1');
  assert.equal(res.usage.advisor_calls, 2);
  // the advisor (fable) outspends the member, but the member's model comes from the transcript
  assert.equal(res.usage.model, 'claude-sonnet-5-5');
  assert.deepEqual(res.usage.models['claude-sonnet-5-5'], { input_tokens: 125, output_tokens: 30, cost_usd: 0.08 });
  assert.equal(res.usage.models['claude-fable-5-1'].cost_usd, 0.42);
});

test('advisor calls are null, not zero, when the session transcript cannot be found', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-usage-'));
  initGitFixtureRepo(cwd);
  const configDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-config-'));
  const stubDir = createUsageClaudeStub('sess-missing');
  const res = await runAdapter(ADAPTER, 'run', {
    brief: briefForCwd(cwd), env: { PATH: `${stubDir}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: configDir }
  });

  assert.equal(res.usage.advisor_calls, null);
  assert.equal(res.usage.model, null);
  assert.equal(res.usage.turns, 7);
});

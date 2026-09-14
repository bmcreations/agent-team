import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

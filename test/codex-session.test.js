import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER = new URL('../adapters/codex', import.meta.url).pathname;
const FAKE = new URL('./fixtures/fake-codex', import.meta.url).pathname;
const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

// `adapters/codex session` against test/fixtures/fake-codex. `next(type)` resolves with the next
// adapter line of that type; `exit` with the exit code. test/helpers/guard.js points
// AGENT_TEAM_CODEX_BIN at a sentinel, so the fake is named explicitly.
function session(env = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'at-fx-')), 'codex.jsonl');
  const child = spawn(ADAPTER, ['session'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env, AGENT_TEAM_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log,
      AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock', AGENT_TEAM_TEAM_TOKEN: 'tok-1', ...env
    }
  });
  const lines = [];
  const waiting = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    lines.push(JSON.parse(l));
    for (const w of waiting.splice(0)) w();
  });
  let seen = 0;
  const next = async (type) => {
    for (;;) {
      const i = lines.findIndex((m, k) => k >= seen && m.type === type);
      if (i >= 0) { seen = i + 1; return lines[i]; }
      await new Promise((r) => waiting.push(r));
    }
  };
  const exit = new Promise((r) => child.on('close', r));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const requests = (method) => logged().filter((l) => l.method === method).map((l) => l.params);
  const argvs = () => logged().filter((l) => l.argv).map((l) => l.argv);
  return { send, next, lines, exit, logged, requests, argvs };
}

const newCwd = () => mkdtempSync(join(tmpdir(), 'at-cx-'));

test('a fresh session starts a thread with the team tools and reports the first turn', { timeout: 10000 }, async () => {
  const s = session();
  const cwd = newCwd();
  s.send({ type: 'start', brief: { task: 'Say hi', cwd, read_only: true, model: 'gpt-5.5' }, resume: null, note: null });
  assert.deepEqual(await s.next('session'), { type: 'session', harness_id: 'thr-1', resume: 'thr-1' });
  const ev = await s.next('event');
  assert.deepEqual(ev, { type: 'event', kind: 'text', text: 'echo: Say hi' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', tokens: 100 });
  const [start] = s.requests('thread/start');
  assert.equal(start.cwd, cwd);
  assert.equal(start.model, 'gpt-5.5');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.sandbox, 'read-only');
  assert.deepEqual(start.config.mcp_servers['agent-team'], {
    command: process.execPath, args: [BIN, 'mcp'],
    env: { AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock', AGENT_TEAM_TEAM_TOKEN: 'tok-1' },
    default_tools_approval_mode: 'approve', tool_timeout_sec: 7500
  });
  // The token is never in any codex argv.
  assert.ok(s.argvs().every((a) => !a.join(' ').includes('tok-1')));
  s.send({ type: 'stop' });
  const result = await s.next('result');
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, 'echo: Say hi');
  assert.deepEqual(result.usage, { tokens: 100, session_id: 'thr-1', turns: 1 });
  assert.equal(await s.exit, 0);
});

test('a writable member runs in the workspace-write sandbox', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'Edit it', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('idle');
  const [start] = s.requests('thread/start');
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal('model' in start, false);
  s.send({ type: 'stop' });
  assert.equal((await s.next('result')).status, 'ok');
  assert.equal(await s.exit, 0);
});

test('tool calls become events, and other threads on the server are ignored', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'Use TOOL', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('idle');
  s.send({ type: 'stop' });
  const result = await s.next('result');
  await s.exit;
  const events = s.lines.filter((m) => m.type === 'event');
  assert.deepEqual(events, [
    { type: 'event', kind: 'tool_call', name: 'agent-team.report_progress', args: { note: 'hi' } },
    { type: 'event', kind: 'tool_result', name: 'agent-team.report_progress', is_error: false, text: 'ok' },
    { type: 'event', kind: 'text', text: 'echo: Use TOOL' }
  ]);
  assert.ok(!JSON.stringify(s.lines).includes('NOT YOURS'));
  assert.equal(result.summary, 'echo: Use TOOL');
});

test('server requests are answered so the turn can finish', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'ASK', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('idle');
  const replies = s.logged().filter((l) => l.reply);
  const by = (method) => replies.filter((r) => r.reply === method);
  const [elicAgentTeam, elicFigma] = by('mcpServer/elicitation/request');
  assert.deepEqual(elicAgentTeam.result, { action: 'accept', content: {} });
  assert.deepEqual(elicFigma.result, { action: 'decline' });
  assert.deepEqual(by('item/commandExecution/requestApproval')[0].result, { decision: 'decline' });
  assert.deepEqual(by('execCommandApproval')[0].result, { decision: 'denied' });
  const unsupported = by('item/tool/requestUserInput')[0];
  assert.equal(unsupported.result, null);
  assert.equal(unsupported.error.code, -32601);
  s.send({ type: 'stop' });
  assert.equal((await s.next('result')).status, 'ok');
  assert.equal(await s.exit, 0);
});

test('a failed turn makes a failed result', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'FAIL now', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('idle');
  s.send({ type: 'stop' });
  const result = await s.next('result');
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /model refused/);
  assert.equal(await s.exit, 0);
});

test('a start in a missing cwd fails without starting codex', { timeout: 10000 }, async () => {
  const s = session();
  const cwd = join(tmpdir(), 'at-cx-missing-dir');
  s.send({ type: 'start', brief: { task: 'x', cwd, read_only: false }, resume: null, note: null });
  const result = await s.next('result');
  assert.equal(result.status, 'failed');
  assert.equal(result.summary, `cwd does not exist: ${cwd}`);
  assert.equal(await s.exit, 0);
  assert.ok(!s.argvs().some((a) => a[0] === 'app-server'));
});

test('capabilities declare protocol 2', { timeout: 5000 }, () => {
  const caps = JSON.parse(execFileSync(ADAPTER, ['capabilities']).toString());
  assert.equal(caps.protocol, 2);
  assert.equal(caps.write, true);
  assert.equal(caps.workspace, true);
  assert.equal(caps.structured_output, true);
  assert.equal(caps.tool_dialect, 'codex');
});

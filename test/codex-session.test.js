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
  const close = () => child.stdin.end();
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const requests = (method) => logged().filter((l) => l.method === method).map((l) => l.params);
  const argvs = () => logged().filter((l) => l.argv).map((l) => l.argv);
  return { send, close, next, lines, exit, logged, requests, argvs };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the team token and socket stay out of the app-server process env', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'Say hi', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('idle');
  const [first] = s.logged();
  assert.equal(first.team_token, null);
  assert.equal(first.team_socket, null);
  s.send({ type: 'stop' });
  await s.next('result');
  assert.equal(await s.exit, 0);
});

test('a stop mid-turn waits for the turn, and the result carries that turn\'s text', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'Slow', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('session');
  s.send({ type: 'stop' });   // the first turn is in flight (or just finished)
  const result = await s.next('result');
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, 'echo: Slow');
  assert.equal(result.usage.turns, 1);
  assert.equal(await s.exit, 0);
});

test('an app-server that dies mid-turn after a stop is a failed result', { timeout: 10000 }, async () => {
  const s = session({ FAKE_CODEX_CRASH_ON: 'BOOM' });
  s.send({ type: 'start', brief: { task: 'BOOM', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('session');
  s.send({ type: 'stop' });
  const result = await s.next('result');
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /before the turn finished: .*fake-codex: crashed/s);
  assert.equal(await s.exit, 0);
});

test('an app-server that dies without a stop is a failed result', { timeout: 10000 }, async () => {
  const s = session({ FAKE_CODEX_CRASH_ON: 'BOOM' });
  s.send({ type: 'start', brief: { task: 'BOOM', cwd: newCwd(), read_only: false }, resume: null, note: null });
  const result = await s.next('result');
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /before it was asked to stop: .*fake-codex: crashed/s);
  assert.equal(await s.exit, 0);
});

test('SIGTERM to the adapter exits 143 and takes the app-server with it', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'HOLD it', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('session');
  const serverPid = s.logged().find((l) => l.argv)?.pid;
  assert.ok(alive(serverPid));
  // The adapter's pid is not exposed by the harness; signal it through its child's parent.
  const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(serverPid)]).toString().trim());
  process.kill(ppid, 'SIGTERM');
  assert.equal(await s.exit, 143);
  for (let i = 0; i < 40 && alive(serverPid); i++) await sleep(50);
  assert.ok(!alive(serverPid));
});

test('a thread/start failure is a failed result', { timeout: 10000 }, async () => {
  const s = session({ FAKE_CODEX_FAIL_THREAD: '1' });
  s.send({ type: 'start', brief: { task: 'x', cwd: newCwd(), read_only: false }, resume: null, note: null });
  const result = await s.next('result');
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /did not start a session: thread refused/);
  assert.equal(await s.exit, 0);
});

test('a turn/start rejection is worded as a rejected turn', { timeout: 10000 }, async () => {
  const s = session({ FAKE_CODEX_FAIL_TURN: '1' });
  s.send({ type: 'start', brief: { task: 'x', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('session');
  const result = await s.next('result');
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /codex rejected the turn: turn refused/);
  assert.equal(await s.exit, 0);
});

test('a final_answer message wins over a later non-final one', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'LATE', cwd: newCwd(), read_only: false }, resume: null, note: null });
  await s.next('idle');
  s.send({ type: 'stop' });
  assert.equal((await s.next('result')).summary, 'the final answer');
  assert.equal(await s.exit, 0);
});

test('brief.effort becomes model_reasoning_effort in the thread config', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: { task: 'x', cwd: newCwd(), read_only: false, effort: 'high' }, resume: null, note: null });
  await s.next('idle');
  assert.equal(s.requests('thread/start')[0].config.model_reasoning_effort, 'high');
  s.send({ type: 'stop' });
  await s.next('result');
  assert.equal(await s.exit, 0);
});

const START = (task, extra = {}) => ({ type: 'start', brief: { task, cwd: newCwd(), read_only: false }, resume: null, note: null, ...extra });
const turnStarts = (s) => s.requests('turn/start').map((p) => p.input[0].text);
const gone = async (pid, ms = 6000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    try { process.kill(pid, 0); } catch { return true; }
  }
  return false;
};
const serverPid = (s) => s.logged().find((l) => l.argv?.[0] === 'app-server').pid;

test('a message between turns starts a turn and is acked', { timeout: 10000 }, async () => {
  const s = session();
  s.send(START('Say hi'));
  await s.next('idle');
  s.send({ type: 'message', id: 7, from: 'lead', text: 'next' });
  assert.deepEqual(await s.next('ack'), { type: 'ack', message_id: 7 });
  assert.deepEqual(await s.next('event'), { type: 'event', kind: 'text', text: 'echo: [from: lead] next' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', tokens: 100 });
  assert.deepEqual(turnStarts(s), ['Say hi', '[from: lead] next']);
  s.send({ type: 'stop' });
  assert.equal((await s.next('result')).usage.turns, 2);
  assert.equal(await s.exit, 0);
});

test('a message mid-turn is steered into the running turn', { timeout: 10000 }, async () => {
  const s = session();
  s.send(START('HOLD please'));
  await s.next('session');
  s.send({ type: 'message', id: 8, from: 'lead', text: 'RELEASE now' });
  assert.deepEqual(await s.next('ack'), { type: 'ack', message_id: 8 });
  const [steer] = s.requests('turn/steer');
  assert.equal(steer.expectedTurnId, 'turn-1');
  assert.equal(steer.input[0].text, '[from: lead] RELEASE now');
  assert.deepEqual(await s.next('event'), { type: 'event', kind: 'text', text: 'echo: HOLD please | [from: lead] RELEASE now' });
  await s.next('idle');
  assert.equal(s.requests('turn/start').length, 1);
  s.send({ type: 'stop' });
  await s.next('result');
  assert.equal(await s.exit, 0);
});

test('a message sent before the turn id is known is steered once the id arrives', { timeout: 10000 }, async () => {
  const s = session();
  s.send(START('HOLD'));
  s.send({ type: 'message', id: 9, from: 'lead', text: 'RELEASE' });
  assert.deepEqual(await s.next('ack'), { type: 'ack', message_id: 9 });
  await s.next('idle');
  assert.equal(s.requests('turn/start').length, 1);
  const steers = s.requests('turn/steer');
  assert.equal(steers.length, 1);
  assert.equal(steers[0].expectedTurnId, 'turn-1');
  s.send({ type: 'stop' });
  await s.next('result');
  assert.equal(s.lines.filter((m) => m.type === 'ack').length, 1);
  assert.equal(await s.exit, 0);
});

test('a steer that loses the race with the end of the turn runs as the next turn', { timeout: 10000 }, async () => {
  const s = session({ FAKE_CODEX_STEER_FAIL: '1', FAKE_CODEX_HOLD_MS: '50' });
  s.send(START('HOLD'));
  await s.next('session');
  s.send({ type: 'message', id: 10, from: 'lead', text: 'more' });
  const first = await s.next('idle');
  assert.equal(s.lines.some((m) => m.type === 'ack'), false, 'no ack before the first idle');
  assert.deepEqual(first, { type: 'idle', tokens: 100 });
  assert.deepEqual(await s.next('ack'), { type: 'ack', message_id: 10 });
  assert.deepEqual(await s.next('idle'), { type: 'idle', tokens: 100 });
  assert.deepEqual(turnStarts(s), ['HOLD', '[from: lead] more']);
  s.send({ type: 'stop' });
  await s.next('result');
  assert.equal(s.lines.filter((m) => m.type === 'ack').length, 1);
  assert.equal(await s.exit, 0);
});

test('interrupt mid-turn reports an interrupted idle and ends the app-server', { timeout: 10000 }, async () => {
  const s = session();
  s.send(START('HOLD'));
  await s.next('session');
  s.send({ type: 'interrupt' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', interrupted: true });
  assert.equal(await s.exit, 0);
  assert.equal(s.lines.some((m) => m.type === 'result'), false);
  assert.deepEqual(s.requests('turn/interrupt'), [{ threadId: 'thr-1', turnId: 'turn-1' }]);
  assert.ok(await gone(serverPid(s)));
});

test('interrupt between turns reports an interrupted idle at once', { timeout: 10000 }, async () => {
  const s = session();
  s.send(START('Say hi'));
  await s.next('idle');
  s.send({ type: 'interrupt' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', interrupted: true });
  assert.equal(await s.exit, 0);
  assert.equal(s.lines.some((m) => m.type === 'result'), false);
  assert.equal(s.requests('turn/interrupt').length, 0);
  assert.ok(await gone(serverPid(s)));
});

test('resume restores the thread with the team tools and sends the note', { timeout: 10000 }, async () => {
  const s = session({ FAKE_CODEX_RESUME_TOKENS: '1000' });
  const cwd = newCwd();
  s.send({ type: 'start', brief: { task: 'ignored', cwd, read_only: true }, resume: 'thr-9', note: 'Resumed by bmc.', tokens: 1000 });
  assert.deepEqual(await s.next('session'), { type: 'session', harness_id: 'thr-9', resume: 'thr-9' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', tokens: 100 });
  assert.equal(s.requests('thread/start').length, 0);
  const [r] = s.requests('thread/resume');
  assert.equal(r.threadId, 'thr-9');
  assert.equal(r.excludeTurns, true);
  assert.equal(r.cwd, cwd);
  assert.equal(r.approvalPolicy, 'never');
  assert.equal(r.sandbox, 'read-only');
  assert.deepEqual(r.config.mcp_servers['agent-team'], {
    command: process.execPath, args: [BIN, 'mcp'],
    env: { AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock', AGENT_TEAM_TEAM_TOKEN: 'tok-1' },
    default_tools_approval_mode: 'approve', tool_timeout_sec: 7500
  });
  assert.deepEqual(turnStarts(s), ['Resumed by bmc.']);
  s.send({ type: 'stop' });
  assert.deepEqual((await s.next('result')).usage, { tokens: 100, session_id: 'thr-9', turns: 1 });
  assert.equal(await s.exit, 0);
});

test('resume with no note continues where it left off', { timeout: 10000 }, async () => {
  const s = session();
  s.send({ ...START('ignored'), resume: 'thr-9', tokens: 1000 });
  await s.next('idle');
  assert.deepEqual(turnStarts(s), ['Continue where you left off.']);
  s.send({ type: 'stop' });
  await s.next('result');
  assert.equal(await s.exit, 0);
});

test('resume with no recorded tokens counts the restored total once', { timeout: 10000 }, async () => {
  const s = session({ FAKE_CODEX_RESUME_TOKENS: '1000' });
  s.send({ ...START('ignored'), resume: 'thr-9' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', tokens: 1100 });
  s.send({ type: 'stop' });
  await s.next('result');
  assert.equal(await s.exit, 0);
});

test('closing stdin mid-turn interrupts the turn and kills a lingering app-server', { timeout: 15000 }, async () => {
  const s = session({ FAKE_CODEX_LINGER: '1' });
  s.send(START('HOLD'));
  await s.next('session');
  s.send({ type: 'message', id: 1, from: 'lead', text: 'sync' });
  await s.next('ack');
  const pid = serverPid(s);
  s.close();
  assert.ok(await gone(pid), 'app-server outlived the supervisor');
  assert.equal(s.requests('turn/interrupt').length, 1);
  assert.ok(s.logged().some((l) => l.sigterm === true));
  await s.exit;
});

// A shell command codex started runs in its own process group, so it outlives the app-server
// unless the adapter ends it too.
const sleepPids = (s) => s.logged().filter((l) => l.sleep_pid).map((l) => l.sleep_pid);
const killAll = (pids) => { for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };

async function withSleep(env, body) {
  const s = session({ FAKE_CODEX_SPAWN_SLEEP: '1', ...env });
  try {
    s.send(START('HOLD'));
    await s.next('session');
    for (let i = 0; i < 100 && !sleepPids(s).length; i++) await sleep(20);
    const [pid] = sleepPids(s);
    assert.ok(pid && alive(pid), 'the fake started a command');
    await body(s, pid);
    assert.ok(await gone(pid, 5000), 'the command outlived the session');
  } finally { killAll(sleepPids(s)); }
}

test('an interrupt ends the shell commands the app-server started', { timeout: 15000 }, async () => {
  await withSleep({}, async (s) => {
    s.send({ type: 'interrupt' });
    await s.next('idle');
    assert.equal(await s.exit, 0);
  });
});

test('closing stdin mid-turn ends the shell commands the app-server started', { timeout: 15000 }, async () => {
  await withSleep({ FAKE_CODEX_LINGER: '1' }, async (s) => {
    s.close();
    await s.exit;
  });
});

test('SIGTERM to the adapter ends the shell commands the app-server started', { timeout: 15000 }, async () => {
  await withSleep({}, async (s) => {
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(serverPid(s))]).toString().trim());
    process.kill(ppid, 'SIGTERM');
    assert.equal(await s.exit, 143);
  });
});

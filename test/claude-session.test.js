import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project, supervise } from './helpers/live.js';

const ADAPTER = new URL('../adapters/claude', import.meta.url).pathname;
// fake-claude answers to the name `claude` from a directory put first on PATH.
const FAKE_BIN = mkdtempSync(join(tmpdir(), 'at-fcb-'));
symlinkSync(new URL('./fixtures/fake-claude', import.meta.url).pathname, join(FAKE_BIN, 'claude'));
const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

// `adapters/claude session` against test/fixtures/fake-claude. `next(type)` resolves with the
// next adapter line of that type; `exit` with the exit code.
function session() {
  const log = join(mkdtempSync(join(tmpdir(), 'at-fc-')), 'claude.jsonl');
  const child = spawn(ADAPTER, ['session'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log,
      AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock', AGENT_TEAM_TEAM_TOKEN: 'tok-1'
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
  const starts = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { send, next, lines, exit, starts };
}

const brief = (extra = {}) => ({ task: 'build it', cwd: mkdtempSync(join(tmpdir(), 'at-cw-')), read_only: false, ...extra });

test('capabilities declares protocol 2', { timeout: 5000 }, () => {
  assert.equal(JSON.parse(execFileSync(ADAPTER, ['capabilities']).toString()).protocol, 2);
});

test('a session starts claude on stream-json with the team MCP server, then stops on request', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ read_only: true, model: 'haiku' }), resume: null, note: null });
  const started = await s.next('session');
  assert.match(started.harness_id, /^fake-sid-\d+$/);
  assert.equal(started.resume, started.harness_id);
  assert.deepEqual(await s.next('event'), { type: 'event', kind: 'user', text: 'build it' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', cost_usd: 0.25 });
  s.send({ type: 'stop' });
  const result = await s.next('result');
  assert.equal(await s.exit, 0);
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, 'echo: build it');
  assert.deepEqual(result.usage, { cost_usd: 0.25, session_id: started.harness_id, turns: 1 });

  const [run] = s.starts();
  for (const flag of ['--input-format', '--output-format', '--verbose', '--replay-user-messages']) assert.ok(run.argv.includes(flag), flag);
  assert.equal(run.argv[run.argv.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(run.argv[run.argv.indexOf('--allowedTools') + 1], 'mcp__agent-team__*');
  assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'haiku');
  assert.equal(run.mcp_tool_timeout, '7260000');
  assert.deepEqual(run.mcp.mcpServers['agent-team'], {
    command: process.execPath, args: [BIN, 'mcp'],
    env: { AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock', AGENT_TEAM_TEAM_TOKEN: 'tok-1' }
  });
  assert.ok(!JSON.stringify(run.argv).includes('tok-1'), 'the token stays out of argv');
  assert.deepEqual(s.lines.filter((m) => m.type === 'event' && m.kind !== 'user').map((m) => m.kind),
    ['text', 'tool_call', 'tool_result']);
});

test('a steered message is acked when claude replays it, not when it is written', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ task: 'HOLD the turn' }), resume: null, note: null });
  await s.next('session');
  s.send({ type: 'message', id: 41, from: 'ana (human)', text: 'also RELEASE' });
  assert.deepEqual(await s.next('ack'), { type: 'ack', message_id: 41 });
  assert.deepEqual(await s.next('idle'), { type: 'idle', cost_usd: 0.25 });
  const steered = s.lines.find((m) => m.type === 'event' && m.kind === 'user' && m.text.includes('RELEASE'));
  assert.equal(steered.text, '[from: ana (human)] also RELEASE');
  s.send({ type: 'stop' });
  assert.equal((await s.next('result')).summary, 'echo: HOLD the turn');
});

test('non-object claude lines are ignored and each turn reports its own cost', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ task: 'NOISE first' }), resume: null, note: null });
  await s.next('session');
  assert.deepEqual(await s.next('idle'), { type: 'idle', cost_usd: 0.25 });
  s.send({ type: 'message', id: 7, from: 'lead (manager)', text: 'NOISE again' });
  assert.deepEqual(await s.next('ack'), { type: 'ack', message_id: 7 });
  assert.deepEqual(await s.next('idle'), { type: 'idle', cost_usd: 0.25 });
  s.send({ type: 'stop' });
  assert.equal((await s.next('result')).status, 'ok');
});

test('interrupt ends a running turn with idle {interrupted} and exits without a result', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ task: 'HOLD forever' }), resume: null, note: null });
  await s.next('session');
  await s.next('event');
  s.send({ type: 'interrupt' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', interrupted: true, cost_usd: 0.25 });
  assert.equal(await s.exit, 0);
  assert.equal(s.lines.filter((m) => m.type === 'result').length, 0);
});

test('a resumed session passes --resume and opens with the note', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief(), resume: 'sid-7', note: 'Resumed by ana.' });
  assert.deepEqual(await s.next('session'), { type: 'session', harness_id: 'sid-7', resume: 'sid-7' });
  assert.deepEqual(await s.next('event'), { type: 'event', kind: 'user', text: 'Resumed by ana.' });
  s.send({ type: 'stop' });
  await s.next('result');
  const [run] = s.starts();
  assert.equal(run.argv[run.argv.indexOf('--resume') + 1], 'sid-7');
});

test('claude dying mid-session fails the member with its exit', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ task: 'CRASH now' }), resume: null, note: null });
  const result = await s.next('result');
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /^claude exited \(code 3\) before it was asked to stop/);
});

test('the result carries the workspace diff stat', { timeout: 5000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at-cg-'));
  const git = (...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base');
  writeFileSync(join(cwd, 'new.txt'), 'hello\n');
  const s = session();
  s.send({ type: 'start', brief: brief({ cwd }), resume: null, note: null });
  await s.next('idle');
  s.send({ type: 'stop' });
  const result = await s.next('result');
  assert.match(result.artifacts.diff_stat, /new\.txt \| 1 \+/);
});

test('the supervisor runs a claude member as a session and steers it', { timeout: 15_000 }, async () => {
  const { root, script } = project({ solo: { agent: 'claude', isolation: 'workspace' } }, {});
  // A file for the project's deny_paths to match, so dispatch does not warn that none does.
  writeFileSync(join(root, '.env'), 'X=1\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'env']);
  const { sup, store } = await supervise(script, { env: { PATH: `${FAKE_BIN}:${process.env.PATH}` } });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'HOLD until told' });
    while (!store.member(memberId).resume) await new Promise((r) => setTimeout(r, 20));
    assert.match(store.member(memberId).resume, /^fake-sid-\d+$/);
    const { message_id } = sup.send({ member_id: memberId, text: 'RELEASE it', from: 'ana' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.match(result.summary, /^echo: # Task\n\nHOLD until told\n/);
    assert.equal(store.message(message_id).state, 'delivered');
    assert.equal(store.run(runId).cost_usd, 0.25);
  } finally { await sup.close(); }
});

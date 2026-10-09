// Drives channel/server.js the way Claude Code would (MCP over stdio) while a caller uses
// src/channel.js over the socket. This proves the plumbing only: no fake can show that a
// real session calls `reply` instead of answering in its own transcript.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { askSession, listChannels, pickSession } from '../src/channel.js';
import { dispatch } from '../src/dispatch.js';

const SERVER = new URL('../channel/server.js', import.meta.url).pathname;
const SID = '0b6f2c1e-1111-4222-8333-944455556666';

// `cwd` is the session's working directory, which the server records in its registry entry.
function startServer({ cwd = process.cwd(), dir = mkdtempSync('/tmp/at-ch-'), sid = SID } = {}) {
  const env = { ...process.env, AGENT_TEAM_CHANNEL_DIR: dir, CLAUDE_CODE_SESSION_ID: sid };
  const child = spawn(process.execPath, [SERVER], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = [];   // [predicate, resolve]
  const seen = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    seen.push(msg);
    const i = waiting.findIndex(([p]) => p(msg));
    if (i >= 0) waiting.splice(i, 1)[0][1](msg);
  });
  const next = (pred) => {
    const hit = seen.find(pred);
    return hit ? Promise.resolve(hit) : new Promise((r) => waiting.push([pred, r]));
  };
  let id = 0;
  const call = (method, params) => {
    const myId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    return next((m) => m.id === myId);
  };
  const registered = async () => { while (!listChannels(env).length) await new Promise((r) => setTimeout(r, 10)); };
  return { child, env, dir, call, next, registered, seen };
}

test('initialize declares a two-way channel and tells Claude to answer with reply', async (t) => {
  const s = startServer();
  t.after(() => s.child.kill());
  const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.deepEqual(init.result.capabilities, { experimental: { 'claude/channel': {} }, tools: {} });
  assert.match(init.result.instructions, /reply tool exactly once with the same task_id/);
  const tools = await s.call('tools/list', {});
  assert.deepEqual(tools.result.tools.map((x) => x.name), ['reply']);
  assert.deepEqual(tools.result.tools[0].inputSchema.required, ['task_id', 'text']);
});

test('a task becomes a channel event tagged with its task_id, and reply returns the answer', async (t) => {
  const s = startServer();
  t.after(() => s.child.kill());
  await s.call('initialize', { protocolVersion: '2025-06-18' });
  await s.registered();
  const [entry] = listChannels(s.env);
  assert.equal(entry.session_id, SID);

  const answer = askSession(SID, 'what version is in package.json?', { env: s.env, timeoutMs: 5000 });
  const ev = await s.next((m) => m.method === 'notifications/claude/channel');
  assert.equal(ev.params.content, 'what version is in package.json?');
  assert.match(ev.params.meta.task_id, /^t_[0-9a-f]{12}$/);

  const res = await s.call('tools/call', { name: 'reply', arguments: { task_id: ev.params.meta.task_id, text: '0.4.0' } });
  assert.equal(res.result.isError, undefined);
  const got = await answer;
  assert.equal(got.text, '0.4.0');
  assert.equal(got.task_id, ev.params.meta.task_id);
});

test('two tasks in flight each get their own reply, whatever order Claude answers in', async (t) => {
  const s = startServer();
  t.after(() => s.child.kill());
  await s.call('initialize', {});
  await s.registered();
  const a = askSession(SID, 'task A', { env: s.env, timeoutMs: 5000 });
  const b = askSession(SID, 'task B', { env: s.env, timeoutMs: 5000 });
  const evA = await s.next((m) => m.params?.content === 'task A');
  const evB = await s.next((m) => m.params?.content === 'task B');
  await s.call('tools/call', { name: 'reply', arguments: { task_id: evB.params.meta.task_id, text: 'answer B' } });
  await s.call('tools/call', { name: 'reply', arguments: { task_id: evA.params.meta.task_id, text: 'answer A' } });
  assert.equal((await a).text, 'answer A');
  assert.equal((await b).text, 'answer B');
});

test('a reply to an unknown or abandoned task is a tool error, not a crash', async (t) => {
  const s = startServer();
  t.after(() => s.child.kill());
  await s.call('initialize', {});
  await s.registered();
  const res = await s.call('tools/call', { name: 'reply', arguments: { task_id: 't_nope', text: 'x' } });
  assert.equal(res.result.isError, true);

  // The caller gives up; Claude's late reply must not reach anyone.
  await assert.rejects(askSession(SID, 'slow task', { env: s.env, timeoutMs: 100 }), /no reply to t_\w+ .* within 100 ms/);
  const ev = await s.next((m) => m.params?.content === 'slow task');
  await new Promise((r) => setTimeout(r, 50));
  const late = await s.call('tools/call', { name: 'reply', arguments: { task_id: ev.params.meta.task_id, text: 'too late' } });
  assert.equal(late.result.isError, true);
});

test('the registry skips dead servers, and a server cleans up when its session ends', async (t) => {
  const s = startServer();
  await s.call('initialize', {});
  await s.registered();
  const entry = listChannels(s.env)[0];
  writeFileSync(join(s.dir, 'stale.json'), JSON.stringify({ session_id: 'stale', pid: 2 ** 22 + 7, socket: '/nonexistent' }));
  assert.deepEqual(listChannels(s.env).map((c) => c.session_id), [SID]);

  const exited = new Promise((r) => s.child.on('exit', r));
  s.child.stdin.end();   // Claude Code closing the server's stdin
  await exited;
  assert.equal(existsSync(entry.socket), false);
  assert.deepEqual(listChannels(s.env), []);
  await assert.rejects(askSession(SID, 'x', { env: s.env }), /no running agent-team channel/);
});

// Answers the next task the way a session would: one reply, carrying the task's id.
async function answer(s, text) {
  const ev = await s.next((m) => m.method === 'notifications/claude/channel');
  await s.call('tools/call', { name: 'reply', arguments: { task_id: ev.params.meta.task_id, text } });
  return ev;
}

test('pickSession takes the pinned session, or the only one in the project, and refuses to guess', async (t) => {
  const dir = mkdtempSync('/tmp/at-ch-');
  const here = mkdtempSync(join(tmpdir(), 'at-ch-proj-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'at-ch-other-'));
  const a = startServer({ dir, cwd: here, sid: 'aaaa' });
  const b = startServer({ dir, cwd: elsewhere, sid: 'bbbb' });
  t.after(() => { a.child.kill(); b.child.kill(); });
  while (listChannels(a.env).length < 2) await new Promise((r) => setTimeout(r, 10));

  assert.equal(pickSession({ projectRoot: here, env: a.env }).session_id, 'aaaa');
  assert.equal(pickSession({ sessionId: 'bbbb', projectRoot: here, env: a.env }).session_id, 'bbbb');
  assert.throws(() => pickSession({ sessionId: 'cccc', projectRoot: here, env: a.env }), /no running agent-team channel for session cccc/);
  assert.throws(() => pickSession({ projectRoot: mkdtempSync(join(tmpdir(), 'at-ch-none-')), env: a.env }), /channel enable/);

  const c = startServer({ dir, cwd: here, sid: 'cccc' });
  t.after(() => c.child.kill());
  while (listChannels(a.env).length < 3) await new Promise((r) => setTimeout(r, 10));
  assert.throws(() => pickSession({ projectRoot: here, env: a.env }), /2 sessions .* set "session_id"/);
});

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;
function cli(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

test('`agent-team channel list` and `channel ask` reach the session in this project', async (t) => {
  const s = startServer();
  t.after(() => s.child.kill());
  await s.call('initialize', {});
  await s.registered();

  const list = await cli(s.env, ['channel', 'list']);
  assert.equal(list.code, 0, list.err);
  assert.equal(list.out, `${SID}  ${process.cwd()}\n`);

  const asked = cli(s.env, ['channel', 'ask', '--task', 'which version?', '--project', process.cwd(), '--timeout', '5']);
  const ev = await answer(s, '0.4.0');
  assert.equal(ev.params.content, 'which version?');
  const r = await asked;
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '0.4.0\n');
});

// A project whose only member runs in the session; `extra` adds members alongside it.
function sessionProject(root, extra = {}) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members: { live: { agent: 'claude-session', isolation: 'read-only' }, ...extra },
    deny_paths: ['credentials/**'], defaults: { on_unavailable: 'fail' }
  }));
  return root;
}
const adapterDir = new URL('../adapters/', import.meta.url).pathname;

test('a claude-session member hands its task to the session and returns the reply', async (t) => {
  const root = sessionProject(mkdtempSync(join(tmpdir(), 'at-ch-dsp-')));
  const s = startServer({ cwd: root });
  t.after(() => s.child.kill());
  await s.call('initialize', {});
  await s.registered();

  const done = dispatch({ projectRoot: root, member: 'live', task: 'summarize app.js', adapterDir, env: { AGENT_TEAM_CHANNEL_DIR: s.env.AGENT_TEAM_CHANNEL_DIR }, timeoutMs: 20_000 });
  const ev = await answer(s, 'it prints ok');
  assert.match(ev.params.content, /summarize app\.js/);
  assert.match(ev.params.content, /^# Limits for this task\n\n- Do not edit, create or delete files.*\n- Do not read or open files matching: credentials\/\*\*/);
  const r = await done;
  assert.equal(r.status, 'ok', r.summary);
  assert.equal(r.agent, 'claude-session');
  assert.equal(r.summary, 'it prints ok');
});

test('another project\'s team cannot delegate to a claude-session member', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'at-ch-teams-'));
  const live = sessionProject(join(parent, 'live'));
  const app = join(parent, 'app');
  mkdirSync(join(app, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', app]);
  writeFileSync(join(app, '.claude', 'agent-team.json'), JSON.stringify({
    members: { other: { team: '../live' } }, deny_paths: ['credentials/**'], defaults: { on_unavailable: 'fail' }
  }));
  const s = startServer({ cwd: live });
  t.after(() => s.child.kill());
  await s.call('initialize', {});
  await s.registered();

  const r = await dispatch({ projectRoot: app, member: 'other', task: 'go', adapterDir, env: { AGENT_TEAM_CHANNEL_DIR: s.env.AGENT_TEAM_CHANNEL_DIR }, timeoutMs: 20_000 })
    .catch((err) => ({ status: 'failed', summary: err.message }));
  assert.notEqual(r.status, 'ok');
  assert.match(JSON.stringify(r), /only this project's own team can delegate to it/);
  assert.equal(s.seen.some((m) => m.method === 'notifications/claude/channel'), false, 'nothing reached the session');
});

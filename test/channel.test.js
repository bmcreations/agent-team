// Drives channel/server.js the way Claude Code would (MCP over stdio) while a caller uses
// src/channel.js over the socket. This proves the plumbing only: no fake can show that a
// real session calls `reply` instead of answering in its own transcript.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { askSession, listChannels } from '../src/channel.js';

const SERVER = new URL('../channel/server.js', import.meta.url).pathname;
const SID = '0b6f2c1e-1111-4222-8333-944455556666';

function startServer() {
  const dir = mkdtempSync('/tmp/at-ch-');
  const env = { ...process.env, AGENT_TEAM_CHANNEL_DIR: dir, CLAUDE_CODE_SESSION_ID: SID };
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'inherit'] });
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
  return { child, env, dir, call, next, registered };
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRpc } from '../src/rpc.js';

const bin = new URL('../bin/agent-team.js', import.meta.url).pathname;

async function withMcp(handler, fn, { socketPath } = {}) {
  const socket = join(mkdtempSync(join(tmpdir(), 'at-mcp-')), 's.sock');
  const server = await serveRpc(socket, handler);
  const child = spawn(process.execPath, [bin, 'mcp'], {
    env: { ...process.env, AGENT_TEAM_TEAM_SOCKET: socketPath ?? socket, AGENT_TEAM_TEAM_TOKEN: 'tok' }
  });
  const replies = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    replies.get(m.id)?.(m);
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try { await fn(rpc); } finally { child.kill(); await server.close(); }
}

test('lists the five team tools, each read-only', async () => {
  await withMcp(() => null, async (rpc) => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'agent-team');
    const { result } = await rpc('tools/list', {});
    assert.deepEqual(result.tools.map((t) => t.name), ['delegate', 'send_to', 'wait_for', 'report_progress', 'ask_human']);
    assert.ok(result.tools.every((t) => t.annotations.readOnlyHint === true));
  });
});

test('a tool call is forwarded with the member token; errors come back as isError', async () => {
  const seen = [];
  await withMcp(({ token, method, params }) => {
    seen.push({ token, method, params });
    if (method === 'delegate') throw new Error('"x" is not a direct report of "lead"');
    return { report_id: 4 };
  }, async (rpc) => {
    const ok = await rpc('tools/call', { name: 'send_to', arguments: { to: 'a', text: 'hi' } });
    assert.deepEqual(JSON.parse(ok.result.content[0].text), { report_id: 4 });
    const bad = await rpc('tools/call', { name: 'delegate', arguments: { to: 'x', task: 't' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /not a direct report/);
  });
  assert.deepEqual(seen[0], { token: 'tok', method: 'send_to', params: { to: 'a', text: 'hi' } });
});

test('an {error} result from the supervisor comes back as isError', async () => {
  await withMcp(() => ({ error: 'member finished' }), async (rpc) => {
    const r = await rpc('tools/call', { name: 'wait_for', arguments: { member: 'a' } });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.content[0].text, 'member finished');
  });
});

test('no supervisor listening comes back as isError, not a crash', async () => {
  const gone = join(mkdtempSync(join(tmpdir(), 'at-mcp-')), 'none.sock');
  await withMcp(() => null, async (rpc) => {
    const r = await rpc('tools/call', { name: 'send_to', arguments: { to: 'a', text: 'hi' } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /ENOENT|ECONNREFUSED/);
    assert.ok((await rpc('ping', {})).result);
  }, { socketPath: gone });
});

test('unknown methods get -32601', async () => {
  await withMcp(() => null, async (rpc) => {
    const r = await rpc('resources/list', {});
    assert.equal(r.error.code, -32601);
  });
});

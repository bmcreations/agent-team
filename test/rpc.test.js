import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRpc, callRpc, isListening, SupervisorRunning } from '../src/rpc.js';

const sockPath = () => join(mkdtempSync(join(tmpdir(), 'at-rpc-')), 's', 'sup.sock');

test('a call reaches the handler with its token and gets the result', async () => {
  const path = sockPath();
  const server = await serveRpc(path, async ({ token, method, params }) => ({ token, method, n: params.n + 1 }));
  try {
    assert.deepEqual(await callRpc(path, { token: 't1', method: 'inc', params: { n: 1 } }),
      { token: 't1', method: 'inc', n: 2 });
    assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
  } finally { await server.close(); }
});

test('a handler error rejects the call with its message', async () => {
  const path = sockPath();
  const server = await serveRpc(path, () => { throw new Error('nope'); });
  try {
    await assert.rejects(callRpc(path, { method: 'x' }), /nope/);
  } finally { await server.close(); }
});

test('a stale socket file is replaced; a live one refuses a second server', async () => {
  const path = sockPath();
  const first = await serveRpc(path, () => 1);
  await assert.rejects(serveRpc(path, () => 2), SupervisorRunning);
  await first.close();
  writeFileSync(path, '');                 // what a crashed supervisor leaves behind
  assert.equal(await isListening(path), false);
  const second = await serveRpc(path, () => 3);
  try {
    assert.equal(await callRpc(path, { method: 'x' }), 3);
  } finally { await second.close(); }
});

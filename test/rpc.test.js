import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { serveRpc, callRpc, isListening, SupervisorRunning } from '../src/rpc.js';

const sockPath = () => join(mkdtempSync(join(tmpdir(), 'at-rpc-')), 's', 'sup.sock');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Writes raw lines to the socket and collects the parsed replies until `count` arrive.
function rawExchange(path, lines, count) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const replies = [];
    sock.on('error', reject);
    sock.once('close', () => reject(new Error('closed before all replies')));
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        replies.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (replies.length === count) { sock.destroy(); resolve(replies); return; }
      }
    });
    sock.write(lines.join('\n') + '\n');
  });
}

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
  // A supervisor that dies without unlinking leaves a real socket inode behind.
  const child = spawn(process.execPath,
    ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)})`],
    { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !(await isListening(path)); i++) await sleep(20);
    assert.equal(await isListening(path), true);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(existsSync(path), true);
    assert.equal(await isListening(path), false);
  } finally { child.kill('SIGKILL'); }
  const second = await serveRpc(path, () => 3);
  try {
    assert.equal(await callRpc(path, { method: 'x' }), 3);
  } finally { await second.close(); }
});

test('a bad request line is dropped and the server keeps answering', async () => {
  const path = sockPath();
  const server = await serveRpc(path, ({ method }) => (method === 'boom' ? undefined : 'ok'));
  try {
    const replies = await rawExchange(path, ['null', '42', '"str"', '[1]', 'not json',
      '{"id":7,"method":"x"}'], 1);
    assert.deepEqual(replies, [{ id: 7, result: 'ok' }]);
    assert.equal(await callRpc(path, { method: 'x' }), 'ok');
  } finally { await server.close(); }
});

test('a handler that throws null is answered with an error, not a crash', async () => {
  const path = sockPath();
  const server = await serveRpc(path, () => { throw null; });
  try {
    await assert.rejects(callRpc(path, { method: 'x' }), /null/);
    await assert.rejects(callRpc(path, { method: 'y' }), /null/);
  } finally { await server.close(); }
});

test('a result that cannot be serialized is answered with an error, not a crash', async () => {
  const path = sockPath();
  const server = await serveRpc(path, () => {
    const circular = {};
    circular.self = circular;
    return circular;
  });
  try {
    await assert.rejects(callRpc(path, { method: 'x' }), /unserializable result/);
    await assert.rejects(callRpc(path, { method: 'y' }), /unserializable result/);
  } finally { await server.close(); }
});

test('a connection dropped without a reply rejects the call', async () => {
  const path = sockPath();
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => sock.destroy());
  await new Promise((resolve) => server.listen(path, resolve));
  try {
    await assert.rejects(callRpc(path, { method: 'x' }), /closed the connection/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

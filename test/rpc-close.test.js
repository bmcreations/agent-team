import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRpc, callRpc } from '../src/rpc.js';

test('close() resolves promptly while a client is blocked in a call', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-rc-')), 's.sock');
  const server = await serveRpc(path, () => new Promise(() => {}));
  const blocked = callRpc(path, { method: 'wait_run', params: {} });
  const rejected = assert.rejects(blocked, /closed the connection/);
  await new Promise((r) => setTimeout(r, 100));
  await Promise.race([
    server.close(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('close hung')), 2000))
  ]);
  await rejected;
});

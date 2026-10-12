import { createServer, connect } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// One JSON object per line each way: {id, token, method, params} in, {id, result} or
// {id, error} out. The only access control is the directory mode (0700, same user), as for
// the channel sockets; member tokens identify the caller, they do not authenticate a user.
export class SupervisorRunning extends Error {}

export async function serveRpc(path, handler) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const server = createServer((sock) => {
    sock.on('error', () => {});
    createInterface({ input: sock }).on('line', async (line) => {
      let req;
      try { req = JSON.parse(line); } catch { return; }
      let reply;
      try {
        reply = { id: req.id, result: await handler({ token: req.token ?? null, method: req.method, params: req.params ?? {} }) };
      } catch (err) {
        reply = { id: req.id, error: err.message };
      }
      if (!sock.destroyed) sock.write(JSON.stringify(reply) + '\n');
    });
  });
  await listenExclusive(server, path);
  return { path, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
}

// A socket file with nothing behind it is what a crashed supervisor leaves; remove it once
// and retry. A second EADDRINUSE means another supervisor won the race.
async function listenExclusive(server, path) {
  try {
    await listen(server, path);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    if (await isListening(path)) throw new SupervisorRunning(`a supervisor is already listening on ${path}`);
    try { unlinkSync(path); } catch { /* already gone */ }
    try {
      await listen(server, path);
    } catch (again) {
      if (again.code === 'EADDRINUSE') throw new SupervisorRunning(`a supervisor is already listening on ${path}`);
      throw again;
    }
  }
}

export function isListening(path) {
  return new Promise((resolve) => {
    const sock = connect(path);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

export function callRpc(path, { token = null, method, params = {} }) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    sock.once('error', reject);
    createInterface({ input: sock }).once('line', (line) => {
      sock.destroy();
      let reply;
      try { reply = JSON.parse(line); } catch { return reject(new Error('unreadable reply from the supervisor')); }
      if (reply.error !== undefined) reject(new Error(reply.error));
      else resolve(reply.result);
    });
    sock.write(JSON.stringify({ id: 1, token, method, params }) + '\n');
  });
}

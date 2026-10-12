import { createServer, connect } from 'node:net';
import { mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// One JSON object per line each way: {id, token, method, params} in, {id, result} or
// {id, error} out. The only access control is the directory mode (0700, same user), as for
// the channel sockets; member tokens identify the caller, they do not authenticate a user.
export class SupervisorRunning extends Error {}

// sun_path is 104 bytes on macOS (108 on Linux), including the terminating NUL.
const MAX_SOCKET_PATH = 103;

export async function serveRpc(path, handler) {
  const bytes = Buffer.byteLength(path);
  if (bytes > MAX_SOCKET_PATH) {
    throw new Error(`socket path is too long (${bytes} bytes, the limit is ${MAX_SOCKET_PATH}): ${path}`);
  }
  // Only a directory we created is ours to lock down; a user-supplied socket path may sit in
  // a shared directory such as /tmp.
  if (mkdirSync(dirname(path), { recursive: true, mode: 0o700 }) !== undefined) chmodSync(dirname(path), 0o700);
  const sockets = new Set();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    onLines(sock, (line) => {
      // answer() handles its own failures; this catch only stops a bug there from becoming
      // an unhandled rejection that takes the supervisor down.
      answer(sock, line, handler).catch(() => {});
    });
  });
  await listenExclusive(server, path);
  // Open connections (a client blocked in wait_run, a member's bridge) would otherwise hold
  // server.close() open indefinitely.
  return {
    path,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const sock of sockets) sock.destroy();
    })
  };
}

// Splits the socket into lines with our own listener. readline left the socket's error path
// unhandled when the peer closed first, so the client could crash on a dropped connection.
function onLines(sock, onLine) {
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      onLine(line);
    }
  });
}

function errorMessage(err) {
  return err?.message ?? String(err);
}

async function answer(sock, line, handler) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  // A line that is not an object has no id to reply to, so it is dropped.
  if (req === null || typeof req !== 'object' || Array.isArray(req)) return;
  const id = req.id;
  let reply;
  try {
    reply = { id, result: await handler({ token: req.token ?? null, method: req.method, params: req.params ?? {} }) };
  } catch (err) {
    reply = { id, error: errorMessage(err) };
  }
  let text;
  try {
    text = JSON.stringify(reply);
  } catch (err) {
    text = JSON.stringify({ id, error: `unserializable result: ${errorMessage(err)}` });
  }
  try {
    if (!sock.destroyed) sock.write(text + '\n');
  } catch { /* the peer is gone; nothing to answer */ }
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

// No default timeout: wait_for legitimately blocks for minutes. A connection that closes
// before a reply rejects the call.
export function callRpc(path, { token = null, method, params = {} }) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    // Node emits 'close' after any 'error', so the call settles on close. "No supervisor at
    // this path" is reported as such; a connection that drops mid-call is a plain close.
    let noSupervisor = null;
    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') noSupervisor = err;
    });
    sock.once('close', () => reject(noSupervisor ?? new Error('supervisor closed the connection')));
    let answered = false;
    onLines(sock, (line) => {
      if (answered) return;
      answered = true;
      sock.destroy();
      let reply;
      try { reply = JSON.parse(line); } catch { return reject(new Error('unreadable reply from the supervisor')); }
      if (reply.error !== undefined) reject(new Error(reply.error));
      else resolve(reply.result);
    });
    sock.write(JSON.stringify({ id: 1, token, method, params }) + '\n');
  });
}

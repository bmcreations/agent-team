import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, constants } from 'node:os';
import { join } from 'node:path';
import { descendants, endTree, merge } from './proctree.js';

const LISTEN_TIMEOUT_MS = 10_000;
const KILL_AFTER_MS = 2_000;
const STDERR_TAIL = 2_000;
const TOKEN_ENV = 'AGENT_TEAM_CODEX_REMOTE_TOKEN';
const LISTENING = /listening on: (ws:\/\/\S+)/;

// `adapters/codex attach <thread>`: the human's take-over of a codex member. The member's own
// app-server has exited; this starts a private one on a loopback websocket, guarded by a
// capability token, and runs the codex TUI against it on the member's thread. The token is in
// a 0600 file for the server and an env var for the TUI, never in argv. The server is stopped
// however the TUI ends. Returns the exit code: the TUI's, or 3 when the TUI or the server
// never started (agent-team attach then hands back with drove: false).
export async function codexAttach(threadId) {
  const bin = process.env.AGENT_TEAM_CODEX_BIN || 'codex';
  let dir = null;
  let server = null;
  let tui = null;
  let cleaning = null;
  // The TUI is stopped too: after a targeted kill of attach it would hold the terminal against
  // a dead server. When the TUI has already exited, stopping it is a no-op.
  const cleanup = () => (cleaning ??= (async () => {
    if (tui) await stop(tui);
    if (server) await stop(server);
    if (dir) rmSync(dir, { recursive: true, force: true });
  })());
  // Ctrl-C belongs to the TUI; this process must outlive it to stop the server. A closed
  // terminal or a kill still stops the TUI and the server before this process goes.
  const ignore = () => {};
  const onSignal = (sig) => { cleanup().finally(() => process.exit(128 + constants.signals[sig])); };
  process.on('SIGINT', ignore);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  try {
    let tokenFile;
    let token;
    try {
      dir = mkdtempSync(join(tmpdir(), 'agent-team-codex-attach-'));
      chmodSync(dir, 0o700);
      tokenFile = join(dir, 'token');
      token = randomBytes(32).toString('hex');
      writeFileSync(tokenFile, token, { mode: 0o600 });
    } catch (err) {
      process.stderr.write(`agent-team: could not set up the codex take-over: ${err.message}\n`);
      return 3;
    }
    // Its own process group, so a signal meant for the terminal's foreground job (the TUI)
    // does not end the server under the human.
    server = spawn(bin, ['app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token',
                         '--ws-token-file', tokenFile], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    const listen = await listening(server);
    if (listen.error !== undefined) {
      process.stderr.write(`agent-team: codex app-server did not start listening: ${listen.error}\n`);
      return 3;
    }
    tui = spawn(bin, ['resume', threadId, '--remote', listen.url, '--remote-auth-token-env', TOKEN_ENV], {
      stdio: 'inherit', env: { ...process.env, [TOKEN_ENV]: token }
    });
    return await new Promise((resolve) => {
      tui.once('error', (err) => {
        process.stderr.write(`agent-team: could not run codex: ${err.message}\n`);
        resolve(3);
      });
      tui.once('exit', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
    });
  } finally {
    await cleanup();
    process.off('SIGINT', ignore);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
  }
}

// Resolves { url } once the server prints its listening line on stderr, or { error } with the
// stderr tail when it exits, cannot start, or has not listened within LISTEN_TIMEOUT_MS. The
// stderr pipe is drained for the server's whole life, so a chatty server never blocks on it.
function listening(server) {
  return new Promise((resolve) => {
    let seen = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const fail = (why) => finish({ error: seen.trim().slice(-STDERR_TAIL) || why });
    const timer = setTimeout(() => fail(`no listening line after ${LISTEN_TIMEOUT_MS / 1000} s`), LISTEN_TIMEOUT_MS);
    server.stderr.setEncoding('utf8');
    server.stderr.on('data', (chunk) => {
      if (done) return;
      seen = (seen + chunk).slice(-STDERR_TAIL * 2);
      const m = LISTENING.exec(seen);
      if (m) finish({ url: m[1] });
    });
    server.once('error', (err) => fail(err.message));
    // 'close', not 'exit': by then the server's last words on stderr have been read.
    server.once('close', (code, signal) => fail(`exited (${signal ?? code})`));
  });
}

// SIGTERM, then SIGKILL if the server is still alive after KILL_AFTER_MS.
// Whatever the child started (codex runs commands in their own process groups) is ended with it.
async function stop(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let tree = descendants(child.pid);
  child.kill('SIGTERM');
  endTree(tree, 'SIGTERM');
  const timer = setTimeout(() => {
    tree = merge(tree, descendants(child.pid));
    child.kill('SIGKILL');
    endTree(tree, 'SIGKILL');
  }, KILL_AFTER_MS);
  await exited;
  clearTimeout(timer);
  endTree(tree, 'SIGKILL');
}

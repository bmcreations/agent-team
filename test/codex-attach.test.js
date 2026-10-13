import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { project, supervise } from './helpers/live.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;
const FAKE = new URL('./fixtures/fake-codex', import.meta.url).pathname;
const ADAPTERS = new URL('../adapters/', import.meta.url).pathname;
const ME = userInfo().username;
const until = async (f, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Runs a command with the guard's environment overridden by `env` (guard.js points
// AGENT_TEAM_CODEX_BIN at its sentinel, so every call names the fake explicitly).
function run(file, args, env) {
  return promisify(execFile)(file, args, { env: { ...process.env, ...env } })
    .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
          (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
}

// A supervised codex member `solo` against test/fixtures/fake-codex. `env` reaches both the
// supervisor (the member's app-server) and the attach CLI (the take-over server and the TUI).
async function setup(extra = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'at-ca-')), 'codex.jsonl');
  const env = { AGENT_TEAM_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, ...extra };
  const { root, script } = project({ solo: { agent: 'codex', isolation: 'none' } }, {});
  const { sup, store } = await supervise(script, { env });
  const entries = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const calls = (method) => entries().filter((e) => e.method === method);
  const submit = (task) => sup.submit({ projectRoot: root, member: 'solo', task });
  const attach = (runId) => run(process.execPath, [BIN, 'attach', String(runId), 'solo'],
    { ...env, AGENT_TEAM_SUPERVISOR_SOCK: sup.socketPath });
  return { sup, store, entries, calls, submit, attach };
}

// The take-over server's start and its exit, the TUI, in log order.
function takeoverLog(entries) {
  const serverStart = entries.find((e) => e.argv?.[0] === 'app-server' && e.argv.includes('--listen'));
  const server = entries.find((e) => e.listen && e.pid === serverStart?.pid);
  const exit = entries.find((e) => e.serverExit && e.pid === serverStart?.pid);
  const tui = entries.find((e) => e.tui);
  return { serverStart, server, exit, tui, index: (e) => entries.indexOf(e) };
}

test('attach takes a codex member over through a private remote app-server and hands it back', { timeout: 30_000 }, async () => {
  const { sup, store, entries, calls, submit, attach } = await setup();
  try {
    const { runId, memberId } = submit('HOLD the work');
    await until(() => calls('turn/start').length === 1);

    const { code, stdout, stderr } = await attach(runId);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /^agent-team: solo is paused and yours\.\nagent-team: exit codex to hand the session back\.\n/);
    assert.deepEqual(JSON.parse(stdout), { members: [{ id: memberId, name: 'solo' }], skipped: [] });

    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.match(result.summary, new RegExp(`${ME} drove this session in a terminal while you were paused`));

    const all = entries();
    const { serverStart, server, exit, tui, index } = takeoverLog(all);
    const a = serverStart.argv;
    const file = a[a.indexOf('--ws-token-file') + 1];
    assert.deepEqual(a, ['app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token', '--ws-token-file', file]);
    assert.equal(server.listen, 'ws://127.0.0.1:0');
    assert.match(server.token, /^[0-9a-f]{64}$/);
    assert.equal(server.mode, 0o600);
    assert.deepEqual(all.find((e) => e.pid === tui.pid && e.argv).argv,
      ['resume', 'thr-1', '--remote', 'ws://127.0.0.1:45454', '--remote-auth-token-env', 'AGENT_TEAM_CODEX_REMOTE_TOKEN']);
    assert.equal(tui.thread, 'thr-1');
    assert.equal(tui.remote, 'ws://127.0.0.1:45454');
    assert.equal(tui.token, server.token);
    for (const e of all.filter((x) => x.argv)) assert.ok(!e.argv.includes(server.token), 'the ws token is never in argv');
    assert.ok(exit, 'the take-over server was stopped');
    assert.ok(index(server) < index(tui) && index(tui) < index(exit));
    assert.equal(existsSync(file), false);

    const resumed = all.filter((e) => e.method === 'thread/resume');
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].params.threadId, 'thr-1');
    assert.ok(index(exit) < index(resumed[0]));
    assert.equal(store.member(memberId).state, 'done');
  } finally { await sup.close(); }
});

test('a codex TUI that exits non-zero still stops the server and hands back', { timeout: 30_000 }, async () => {
  const { sup, entries, calls, submit, attach } = await setup({ FAKE_CODEX_TUI_EXIT: '1' });
  try {
    const { runId, memberId } = submit('HOLD the work');
    await until(() => calls('turn/start').length === 1);
    const { code, stdout, stderr } = await attach(runId);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { members: [{ id: memberId, name: 'solo' }], skipped: [] });
    const { serverStart, exit, tui } = takeoverLog(entries());
    assert.ok(tui);
    assert.ok(exit);
    assert.equal(alive(serverStart.pid), false);
    assert.equal((await sup.waitRun(runId)).status, 'ok');
  } finally { await sup.close(); }
});

test('a take-over server that never listens fails the attach, starts no TUI, and hands back undriven', { timeout: 40_000 }, async () => {
  const { sup, entries, calls, submit, attach } = await setup({ FAKE_CODEX_NO_LISTEN: '1' });
  try {
    const { runId } = submit('HOLD the work');
    await until(() => calls('turn/start').length === 1);
    const t0 = Date.now();
    const { code, stderr } = await attach(runId);
    assert.ok(Date.now() - t0 < 15_000, `attach took ${Date.now() - t0} ms`);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /agent-team: codex app-server did not start listening/);
    const { serverStart, exit, tui } = takeoverLog(entries());
    assert.equal(tui, undefined);
    assert.ok(exit);
    assert.equal(alive(serverStart.pid), false);
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.doesNotMatch(result.summary, /drove this session/);
  } finally { await sup.close(); }
});

test('adapters/codex attach exits non-zero when the server never listens', { timeout: 30_000 }, async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'at-ca-')), 'codex.jsonl');
  const t0 = Date.now();
  const { code, stderr } = await run(join(ADAPTERS, 'codex'), ['attach', 'thr-1'],
    { AGENT_TEAM_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, FAKE_CODEX_NO_LISTEN: '1' });
  assert.ok(Date.now() - t0 < 15_000);
  assert.equal(code, 3);
  assert.match(stderr, /^agent-team: codex app-server did not start listening: /);
  const all = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(all.filter((e) => e.tui).length, 0);
  assert.equal(all.filter((e) => e.serverExit).length, 1);
});

test('adapters/codex attach stops the server and removes the token when it is hung up on', { timeout: 30_000 }, async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'at-ca-')), 'codex.jsonl');
  const entries = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const child = spawn(join(ADAPTERS, 'codex'), ['attach', 'thr-1'], {
    stdio: 'ignore', env: { ...process.env, AGENT_TEAM_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, FAKE_CODEX_TUI_HOLD: '1' }
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    await until(() => entries().some((e) => e.tui));
    child.kill('SIGHUP');
    assert.equal(await exited, 129);
    const { serverStart, exit } = takeoverLog(entries());
    assert.ok(exit, 'the take-over server was stopped');
    assert.equal(alive(serverStart.pid), false);
    const a = serverStart.argv;
    assert.equal(existsSync(a[a.indexOf('--ws-token-file') + 1]), false);
    const tuiPid = entries().find((e) => e.tui).pid;
    assert.equal(alive(tuiPid), false, 'the TUI does not outlive attach');
  } finally {
    child.kill('SIGKILL');
    for (const e of entries().filter((x) => x.tui)) { try { process.kill(e.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

test('adapters/codex attach that fails to set up exits as never started and runs no codex', { timeout: 30_000 }, async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'at-ca-')), 'codex.jsonl');
  const { code, stderr } = await run(join(ADAPTERS, 'codex'), ['attach', 'thr-1'],
    { AGENT_TEAM_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, TMPDIR: join(tmpdir(), 'at-ca-missing', 'nowhere') });
  assert.equal(code, 3, stderr);
  assert.match(stderr, /^agent-team: could not set up the codex take-over: /);
  assert.equal(existsSync(log), false, 'no codex was started');
});

test('the claude and codex adapters declare take-over', async () => {
  const caps = async (agent) => JSON.parse((await run(join(ADAPTERS, agent), ['capabilities'], {})).stdout);
  assert.deepEqual((await caps('codex')).takeover, { notice: null });
  assert.deepEqual((await caps('claude')).takeover, { notice: 'claude may first ask whether to trust {cwd}.' });
});

// The resumed thread restores a total above what the member recorded (a human's turns): the
// gap is counted once, on the first turn after the hand-back, together with that turn.
test('tokens a human spent in a taken-over codex thread are counted once after hand-back', { timeout: 30_000 }, async () => {
  const { sup, store, calls, submit, attach } = await setup({ FAKE_CODEX_HOLD_MS: '400', FAKE_CODEX_RESUME_TOKENS: '1000' });
  try {
    const { runId, memberId } = submit('HOLD for a moment');
    await until(() => calls('turn/start').length === 1);
    sup.pause({ member_id: memberId });
    await until(() => store.member(memberId).state === 'paused');
    assert.equal(store.member(memberId).tokens, 100);

    const { code, stderr } = await attach(runId);
    assert.equal(code, 0, stderr);
    assert.equal((await sup.waitRun(runId)).status, 'ok');
    assert.equal(calls('thread/resume').length, 1);
    // 100 recorded, + 900 the human spent, + 100 for the resumed turn.
    assert.equal(store.member(memberId).tokens, 1100);
    assert.equal(store.run(runId).tokens, 1100);
    assert.equal(store.run(runId).cost_usd, 0);
  } finally { await sup.close(); }
});

test('the take-over server\'s shell commands end with it', { timeout: 30_000 }, async () => {
  const { sup, entries, calls, submit, attach } = await setup({ FAKE_CODEX_SPAWN_SLEEP: '1' });
  const sleeps = () => entries().filter((e) => e.sleep_pid).map((e) => e.sleep_pid);
  try {
    const { runId } = submit('HOLD the work');
    await until(() => calls('turn/start').length === 1);
    const { code, stderr } = await attach(runId);
    assert.equal(code, 0, stderr);
    const { serverStart } = takeoverLog(entries());
    const mine = entries().filter((e) => e.sleep_pid && e.pid === serverStart.pid).map((e) => e.sleep_pid);
    assert.equal(mine.length, 1, 'the take-over server started a command');
    await until(() => !alive(mine[0]), 5000);
    await sup.waitRun(runId);
  } finally {
    for (const p of sleeps()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    await sup.close();
  }
});

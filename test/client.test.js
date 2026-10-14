import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, statSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { project, LIVE } from './helpers/live.js';
import { runThroughSupervisor, resolveRootMember } from '../src/client.js';
import { dispatch } from '../src/dispatch.js';
import { openStore } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';

const adapterDir = new URL('../adapters/', import.meta.url).pathname;

function env(script) {
  const dir = mkdtempSync(join(tmpdir(), 'at-cl-'));
  return { AGENT_TEAM_MOCK_SCRIPT: script, AGENT_TEAM_SUPERVISOR_SOCK: join(dir, 's.sock'),
           AGENT_TEAM_SUPERVISOR_DB: join(dir, 's.db') };
}

test('resolveRootMember marks only protocol 2 adapters live', async () => {
  const { root, script } = project({ live: LIVE(), old: { agent: 'mock', isolation: 'none' } }, {});
  assert.equal((await resolveRootMember({ projectRoot: root, member: 'live', adapterDir, env: env(script) })).live, true);
  assert.equal((await resolveRootMember({ projectRoot: root, member: 'old', adapterDir, env: env(script) })).live, false);
});

test('a member that cannot be resolved is treated as v1, so dispatch records its failure', async () => {
  const { root, script } = project({ old: { agent: 'nope', isolation: 'none' } }, {}, { on_unavailable: 'nope' });
  const r = await resolveRootMember({ projectRoot: root, member: 'old', adapterDir, env: env(script) });
  assert.deepEqual(r, { live: false, preresolved: null });
});

test('a v1 member is probed once when dispatch reuses the root resolution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-cl-ad-'));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'counted'), `#!/bin/sh\necho "$1" >> "${calls}"\nexec "${join(adapterDir, 'mock')}" "$@"\n`);
  chmodSync(join(dir, 'counted'), 0o755);
  const { root, script } = project({ old: { agent: 'counted', isolation: 'none' } }, { status: 'ok', summary: 'v1' });
  const opts = { projectRoot: root, member: 'old', task: 'go', adapterDir: dir, env: { AGENT_TEAM_MOCK_SCRIPT: script } };
  const { live, preresolved } = await resolveRootMember(opts);
  assert.equal(live, false);
  const result = await dispatch({ ...opts, preresolved });
  assert.equal(result.summary, 'v1');
  const lines = readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(lines.filter((l) => l === 'probe').length, 1);
  assert.equal(lines.filter((l) => l === 'capabilities').length, 1);
});

test('with no supervisor running, a run starts one in-process and leaves no socket behind', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [], result: { status: 'ok', summary: 'hi' } } } });
  const e = env(script);
  const result = await runThroughSupervisor({ projectRoot: root, member: 'solo', task: 'go', adapterDir, env: e });
  assert.equal(result.summary, 'hi');
  const { isListening } = await import('../src/rpc.js');
  assert.equal(await isListening(e.AGENT_TEAM_SUPERVISOR_SOCK), false);
  const store = openStore(e.AGENT_TEAM_SUPERVISOR_DB);
  assert.equal(store.run(1).status, 'done');
  store.close();
});

test('with a supervisor running, a run is submitted to it', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [], result: { status: 'ok', summary: 'remote' } } } });
  const e = env(script);
  const store = openStore(':memory:');
  const sup = new Supervisor({ store, adapterDir, socketPath: e.AGENT_TEAM_SUPERVISOR_SOCK, env: { AGENT_TEAM_MOCK_SCRIPT: script } });
  await sup.start();
  try {
    const result = await runThroughSupervisor({ projectRoot: root, member: 'solo', task: 'go', adapterDir, env: e });
    assert.equal(result.summary, 'remote');
    assert.equal(store.run(1).status, 'done', 'the running supervisor recorded the run');
  } finally { await sup.close(); }
});

// Short base: macOS caps Unix socket paths at 104 bytes and tmpdir() there is ~50 already.
const shortCache = () => mkdtempSync('/tmp/at-c-');

test('the default socket and store sit in a supervisor directory locked to this user', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [], result: { status: 'ok', summary: 'hi' } } } });
  const cache = shortCache();
  const dir = join(cache, 'agent-team', 'supervisor');
  mkdirSync(dir, { recursive: true, mode: 0o755 });   // as an older install might have left it
  chmodSync(dir, 0o755);
  const e = { AGENT_TEAM_MOCK_SCRIPT: script, XDG_CACHE_HOME: cache,
              AGENT_TEAM_SUPERVISOR_SOCK: '', AGENT_TEAM_SUPERVISOR_DB: '' };
  const result = await runThroughSupervisor({ projectRoot: root, member: 'solo', task: 'go', adapterDir, env: e });
  assert.equal(result.summary, 'hi');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'supervisor.db')).mode & 0o777, 0o600);
});

test('a directory the user named for the socket keeps its mode', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [], result: { status: 'ok', summary: 'hi' } } } });
  const e = env(script);
  const dir = dirname(e.AGENT_TEAM_SUPERVISOR_SOCK);
  chmodSync(dir, 0o755);
  await runThroughSupervisor({ projectRoot: root, member: 'solo', task: 'go', adapterDir, env: e });
  assert.equal(statSync(dir).mode & 0o777, 0o755);
});

test('two in-process runs each keep a private socket and both finish', async () => {
  const sleepy = (ms, summary) => ({ steps: [{ sleep_ms: ms }], result: { status: 'ok', summary } });
  const { root, script } = project({ a: LIVE(), b: LIVE() }, { by_member: { a: sleepy(400, 'a'), b: sleepy(1200, 'b') } });
  const e = env(script);
  const { isListening } = await import('../src/rpc.js');
  const first = runThroughSupervisor({ projectRoot: root, member: 'a', task: 'go', adapterDir, env: e });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await isListening(e.AGENT_TEAM_SUPERVISOR_SOCK), false, 'an in-process run must not take the shared socket');
  const second = runThroughSupervisor({ projectRoot: root, member: 'b', task: 'go', adapterDir, env: e });
  const [ra, rb] = await Promise.all([first, second]);
  assert.equal(ra.summary, 'a');
  assert.equal(rb.summary, 'b');
  const left = readdirSync(dirname(e.AGENT_TEAM_SUPERVISOR_SOCK)).filter((f) => f.endsWith('.sock'));
  assert.deepEqual(left, [], 'each run removes its socket');
});

test('a relative project root is submitted to a running supervisor as an absolute path', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [], result: { status: 'ok', summary: 'rel' } } } });
  const e = env(script);
  const store = openStore(':memory:');
  const sup = new Supervisor({ store, adapterDir, socketPath: e.AGENT_TEAM_SUPERVISOR_SOCK, env: { AGENT_TEAM_MOCK_SCRIPT: script } });
  await sup.start();
  try {
    await runThroughSupervisor({ projectRoot: relative(process.cwd(), root), member: 'solo', task: 'go', adapterDir, env: e });
    assert.equal(store.run(1).project, root);
  } finally { await sup.close(); }
});

test('a client resubmitting the same task attaches to the active run; fresh starts another; the title is carried', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ sleep_ms: 1200 }], result: { status: 'ok', summary: 'once' } } } });
  const e = env(script);
  const store = openStore(':memory:');
  const sup = new Supervisor({ store, adapterDir, socketPath: e.AGENT_TEAM_SUPERVISOR_SOCK, env: { AGENT_TEAM_MOCK_SCRIPT: script } });
  await sup.start();
  try {
    const seen = [];
    const go = (extra) => runThroughSupervisor({ projectRoot: root, member: 'solo', task: 'go', adapterDir, env: e,
      onSubmitted: (s) => seen.push(s), ...extra });
    const first = go({ title: 'Named by hand' });
    while (seen.length < 1) await new Promise((r) => setTimeout(r, 10));
    const second = go({});
    const third = go({ fresh: true });
    await Promise.all([first, second, third]);
    assert.deepEqual(seen.map((s) => [s.runId, s.attached, s.remote]), [[1, false, true], [1, true, true], [2, false, true]]);
    assert.equal(store.run(1).title, 'Named by hand');
    assert.equal(store.run(2).title, null);
  } finally { await sup.close(); }
});

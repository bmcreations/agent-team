import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { project, LIVE } from './helpers/live.js';
import { runThroughSupervisor, isLiveMember } from '../src/client.js';
import { openStore } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';

const adapterDir = new URL('../adapters/', import.meta.url).pathname;

function env(script) {
  const dir = mkdtempSync(join(tmpdir(), 'at-cl-'));
  return { AGENT_TEAM_MOCK_SCRIPT: script, AGENT_TEAM_SUPERVISOR_SOCK: join(dir, 's.sock'),
           AGENT_TEAM_SUPERVISOR_DB: join(dir, 's.db') };
}

test('isLiveMember is true only for protocol 2 adapters', async () => {
  const { root, script } = project({ live: LIVE(), old: { agent: 'mock', isolation: 'none' } }, {});
  assert.equal(await isLiveMember({ projectRoot: root, member: 'live', adapterDir, env: env(script) }), true);
  assert.equal(await isLiveMember({ projectRoot: root, member: 'old', adapterDir, env: env(script) }), false);
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

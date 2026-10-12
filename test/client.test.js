import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

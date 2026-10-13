import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { formatRow, watchRun } from '../src/watch.js';
import { project, supervise, LIVE } from './helpers/live.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

test('a row reads as time, member, kind and the event\'s line', () => {
  const at = new Date('2026-10-13T09:05:07').getTime();
  assert.equal(formatRow({ type: 'event', at, member: 'lead', kind: 'delegated', body: { to: 'worker' } }),
               '09:05:07  lead  delegated  delegated to worker');
  assert.equal(formatRow({ type: 'message', at, from_name: 'b', from_kind: 'human', to_name: 'lead', text: 'use\ntabs' }),
               '09:05:07  b → lead  message  use tabs');
});

test('watch prints what is there, follows new rows, and returns when the run ends', async () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  store.setRunRoot(runId, lead.id);
  store.addEvent(lead.id, 'started', {});
  const lines = [];
  const done = watchRun({ store, runId, write: (s) => lines.push(s), pollMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  store.addEvent(lead.id, 'text', { text: 'halfway' });
  store.addEvent(lead.id, 'finished', { state: 'done', summary: 'ok' });
  store.finishRun(runId, 'done');
  assert.equal(await done, 'done');
  assert.deepEqual(lines.map((l) => l.split('  ').slice(2).join('  ').trim()),
                   ['started', 'text  halfway', 'finished  done: ok']);
  store.close();
});

test('watch --json follows a live run from another process and exits 0 when it ends', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-w-')), 's.db');
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'one' }, { sleep_ms: 300 }, { say: 'two' }] } }
  });
  const { sup } = await supervise(script, { store: openStore(path) });
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const r = await promisify(execFile)(process.execPath, [BIN, 'watch', String(runId), '--json'], {
      env: { ...process.env, AGENT_TEAM_SUPERVISOR_DB: path }, timeout: 20_000
    });
    const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.filter((x) => x.kind === 'text').map((x) => x.body.text), ['one', 'two']);
    assert.equal(rows.at(-1).kind, 'finished');
    const missing = await promisify(execFile)(process.execPath, [BIN, 'watch', '999'], {
      env: { ...process.env, AGENT_TEAM_SUPERVISOR_DB: path }
    }).catch((e) => e);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /unknown run 999/);
  } finally { await sup.close(); }
});

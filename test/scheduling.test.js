import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { project, adapterDir, supervise, LIVE } from './helpers/live.js';

test('a manager blocked in wait_for holds no slot, so a deep team runs with maxRunning 1', { timeout: 15_000 }, async () => {
  const { root, script } = project({
    lead: LIVE(), mid: LIVE({ reports_to: 'lead' }), leaf: LIVE({ reports_to: 'mid' })
  }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'mid', task: 'plan' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      mid: { steps: [
        { tool: 'delegate', args: { to: 'leaf', task: 'do' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      leaf: { steps: [] }
    }
  });
  const { sup, store } = await supervise(script, { maxRunning: 1 });
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.deepEqual(store.members(runId).map((m) => m.state), ['done', 'done', 'done']);
  } finally { await sup.close(); }
});

test('send_to a queued report that resolves to a v1 adapter is refused, not lost', async () => {
  const { root, script } = project({
    lead: LIVE(), a: LIVE({ reports_to: 'lead' }), old: { agent: 'mock', reports_to: 'lead', isolation: 'none' }
  }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'first' }, save: 'ra' },
        { tool: 'delegate', args: { to: 'old', task: 'second' }, save: 'ro' },
        { tool: 'send_to', args: { to: 'old', text: 'hi' } },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id', '$ro.report_id'] }
      ] },
      a: { steps: [{ sleep_ms: 300 }] },
      old: { status: 'ok', summary: 'old done' }
    }
  }, { max_parallel: 1 });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    const sent = result.tool_results.find((t) => t.tool === 'send_to').result;
    assert.match(sent.error ?? '', /"old" runs one-shot and cannot receive messages/);
    const old = store.members(runId).find((m) => m.name === 'old');
    assert.equal(old.state, 'done');
    assert.deepEqual(store.takeQueued(old.id), [], 'nothing was left in the v1 member\'s inbox');
  } finally { await sup.close(); }
});

test('a v1 member is resolved once per launch', async () => {
  const dir = adapterDir();
  const log = join(dir, 'calls.log');
  // Logs each subcommand, then behaves exactly like the mock adapter.
  writeFileSync(join(dir, 'counted'), `#!/bin/sh\necho "$1" >> "${log}"\nexec "$(dirname "$0")/mock" "$@"\n`);
  chmodSync(join(dir, 'counted'), 0o755);
  const { root, script } = project({ solo: { agent: 'counted', isolation: 'none' } },
    { status: 'ok', summary: 'done' });
  const { sup } = await supervise(script, { adapterDir: dir });
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    assert.equal((await sup.waitRun(runId)).status, 'ok');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter((c) => c === 'capabilities').length, 1);
  } finally { await sup.close(); }
});

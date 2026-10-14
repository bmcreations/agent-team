import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, supervise, LIVE } from './helpers/live.js';

const TEAM = { lead: LIVE(), w: LIVE({ reports_to: 'lead' }) };

test('a root member can name its run, and the title lands on the run with an event', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'set_title', args: { title: '  Jump to bottom   design ' }, save: 't' }], result: { status: 'ok', summary: 'x' } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.equal(store.run(runId).title, 'Jump to bottom design');
    assert.equal(store.run(runId).title_by, 'agent');
    const ev = store.events(memberId).find((e) => e.kind === 'titled');
    assert.deepEqual(ev.body, { title: 'Jump to bottom design', by: 'agent' });
  } finally { await sup.close(); }
});

test('set_title from a delegated member is refused', async () => {
  const { root, script } = project(TEAM, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'w', task: 'job' }, save: 'r' },
                      { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }], result: { status: 'ok', summary: 'x' } },
      w: { steps: [{ tool: 'set_title', args: { title: 'Nope' } }], result: { status: 'ok', summary: 'w' } }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await sup.waitRun(runId);
    assert.equal(store.run(runId).title, null);
    const w = store.members(runId).find((m) => m.name === 'w');
    const res = w.result.tool_results.find((t) => t.tool === 'set_title').result;
    assert.match(res.error, /only the root member/);
  } finally { await sup.close(); }
});

test('a title given with --title is not overwritten by set_title', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'set_title', args: { title: 'Agent name' }, save: 't' }], result: { status: 'ok', summary: 'x' } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go', title: 'Human name' });
    const result = await sup.waitRun(runId);
    assert.equal(store.run(runId).title, 'Human name');
    assert.equal(store.run(runId).title_by, 'human');
    const res = store.member(memberId).result.tool_results.find((t) => t.tool === 'set_title').result;
    assert.equal(res.ok, false);
    assert.match(res.note, /set by a human/);
    assert.equal(result.status, 'ok');
  } finally { await sup.close(); }
});

const SLOW = { by_member: { solo: { steps: [{ sleep_ms: 1500 }], result: { status: 'ok', summary: 'x' } } } };

test('an identical submit while the run is active attaches to it', async () => {
  const { root, script } = project({ solo: LIVE() }, SLOW);
  const { sup, store } = await supervise(script);
  try {
    const a = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    assert.equal(a.attached, false);
    const b = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    assert.deepEqual([b.runId, b.memberId, b.attached], [a.runId, a.memberId, true]);
    assert.equal(store.listRuns({ limit: 10 }).length, 1);
    const other = sup.submit({ projectRoot: root, member: 'solo', task: 'a different task' });
    assert.notEqual(other.runId, a.runId);
    assert.equal(other.attached, false);
    // Both callers wait on the one run.
    const [r1, r2] = await Promise.all([sup.waitRun(a.runId), sup.waitRun(b.runId)]);
    assert.equal(r1.summary, r2.summary);
  } finally { await sup.close(); }
});

test('a submit after the earlier run finished starts a new run', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [], result: { status: 'ok', summary: 'x' } } } });
  const { sup } = await supervise(script);
  try {
    const a = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(a.runId);
    const b = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    assert.notEqual(b.runId, a.runId);
    assert.equal(b.attached, false);
    await sup.waitRun(b.runId);
  } finally { await sup.close(); }
});

test('fresh forces a new run even when an identical one is active', async () => {
  const { root, script } = project({ solo: LIVE() }, SLOW);
  const { sup } = await supervise(script);
  try {
    const a = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const b = sup.submit({ projectRoot: root, member: 'solo', task: 'go', fresh: true });
    assert.notEqual(b.runId, a.runId);
    assert.equal(b.attached, false);
  } finally { await sup.close(); }
});

test('attaching with --title names the run unless a human already did', async () => {
  const { root, script } = project({ solo: LIVE() }, SLOW);
  const { sup, store } = await supervise(script);
  try {
    const a = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    sup.submit({ projectRoot: root, member: 'solo', task: 'go', title: 'First' });
    sup.submit({ projectRoot: root, member: 'solo', task: 'go', title: 'Second' });
    assert.equal(store.run(a.runId).title, 'First');
  } finally { await sup.close(); }
});

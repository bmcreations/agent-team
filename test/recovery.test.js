import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { project, supervise, adapterDir, LIVE } from './helpers/live.js';

const until = async (f, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// A manager waiting on a slow report. After a restart both resume: the report plays
// `on_resume.steps` (none) and finishes; the manager waits for it again.
const team = () => project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
  by_member: {
    lead: {
      steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }],
      on_resume: { steps: [{ tool: 'wait_for', args: {} }] }
    },
    worker: { steps: [{ sleep_ms: 30_000 }], on_resume: { steps: [] } }
  }
});

test('a restart resumes working members from their sessions and tells the manager its reports', async () => {
  const { root, script } = team();
  const first = await supervise(script);
  const { store } = first;
  const { runId, memberId: leadId } = first.sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
  await until(() => store.member(leadId).state === 'waiting' && store.children(leadId)[0]?.resume);
  const workerId = store.children(leadId)[0].id;
  const sid = store.member(workerId).resume;
  await first.sup.close();
  assert.equal(store.member(workerId).state, 'running');

  const { sup } = await supervise(script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const note = result.received[0];
    assert.match(note, /^\[resume mock-session-lead-\d+\] The agent-team supervisor restarted while you were working/);
    assert.match(note, /A wait_for or ask_human call you were in was ended/);
    assert.match(note, new RegExp(`- worker \\(#${workerId}\\): running`));
    // The worker's notice comes as the wait_for result, or on stdin if it beat the lead's launch.
    const seen = [...result.received, ...result.tool_results[0].result.messages.map((m) => m.text)];
    assert.equal(seen.filter((t) => /finished ok: done/.test(t)).length, 1);
    assert.equal(store.member(workerId).resume, sid, 'the worker came back to the same session');
    assert.deepEqual(store.events(workerId).filter((e) => e.kind === 'interrupted').map((e) => e.body),
      [{ by: 'supervisor restart' }]);
    assert.equal(store.run(runId).owner, sup.socketPath);
  } finally { await sup.close(); }
});

test('a member adopted after a restart is passed its recorded spend as the cost baseline', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }], on_resume: { steps: [] }, turn_cost_usd: 0.5 },
      worker: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }], on_resume: { steps: [] } }
    }
  });
  const first = await supervise(script);
  const { store } = first;
  const { runId, memberId: leadId } = first.sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
  await until(() => store.run(runId).cost_usd === 0.5 && store.children(leadId)[0]?.resume);
  await first.sup.close();
  assert.equal(store.member(leadId).cost_usd, 0.5);

  const { sup } = await supervise(script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.equal(result.start_cost_usd, 0.5);
    assert.equal(store.member(store.children(leadId)[0].id).result.start_cost_usd, 0);
  } finally { await sup.close(); }
});

// lead -> mid -> worker. The cascade to a cancelled manager's reports runs once its adapter has
// exited, so a close() in that window must record it, or recover() relaunches the reports.
test('a mid-level cancel in flight when the supervisor closes takes its reports with it', async () => {
  const { root, script } = project({
    lead: LIVE(), mid: LIVE({ reports_to: 'lead' }), worker: LIVE({ reports_to: 'mid' })
  }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'mid', task: 'm' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ], on_resume: { steps: [] } },
      mid: { steps: [
        { tool: 'delegate', args: { to: 'worker', task: 'w' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      worker: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }], on_resume: { steps: [] } }
    }
  });
  const first = await supervise(script);
  const { store } = first;
  const { runId, memberId: leadId } = first.sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
  const mid = () => store.children(leadId)[0];
  const worker = () => mid() && store.children(mid().id)[0];
  await until(() => worker() && store.events(worker().id).some((e) => e.kind === 'text'));
  first.sup.cancel({ member_id: mid().id });
  await first.sup.close();
  assert.equal(store.member(mid().id).state, 'cancelled');
  assert.equal(store.member(worker().id).state, 'cancelled');
  // Worded as the live cascade words it.
  assert.deepEqual(store.member(worker().id).result, { status: 'failed', summary: 'cancelled by local' });

  const { sup } = await supervise(script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    assert.equal((await sup.waitRun(runId)).status, 'ok');
    assert.equal(store.events(worker().id).filter((e) => e.kind === 'started').length, 1, 'the worker was relaunched');
  } finally { await sup.close(); }
});

test('a run whose project config is gone fails with the reason; other runs still recover', async () => {
  const a = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], on_resume: { steps: [] } } } });
  const b = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], on_resume: { steps: [] } } } });
  const first = await supervise(a.script);
  const { store } = first;
  const runA = first.sup.submit({ projectRoot: a.root, member: 'solo', task: 'go' });
  const runB = first.sup.submit({ projectRoot: b.root, member: 'solo', task: 'go' });
  await until(() => store.member(runA.memberId).state === 'waiting' && store.member(runB.memberId).state === 'waiting');
  await first.sup.close();
  rmSync(join(a.root, '.claude', 'agent-team.json'));

  const { sup } = await supervise(a.script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runB.runId], failed: [runA.runId] });
    assert.equal(store.run(runA.runId).status, 'failed');
    assert.match(store.member(runA.memberId).result.summary, /^could not recover after a supervisor restart: /);
    assert.equal((await sup.waitRun(runB.runId)).status, 'ok');
  } finally { await sup.close(); }
});

test('recover leaves alone a run whose supervisor is still listening', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } } });
  const first = await supervise(script);
  const second = await supervise(script, { store: first.store });
  try {
    const { memberId } = first.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => first.store.member(memberId).state === 'waiting');
    assert.deepEqual(await second.sup.recover(), { recovered: [], failed: [] });
    assert.throws(() => second.sup.pause({ member_id: memberId }), /is run by another supervisor/);
    assert.equal(first.store.member(memberId).state, 'waiting');
  } finally {
    await second.sup.close();
    await first.sup.close();
  }
});

test('a one-shot member left running fails on recovery: it has no session to resume', async () => {
  const { root, script } = project({ solo: { agent: 'mock', isolation: 'none' } }, {});
  const { sup, store } = await supervise(script);
  try {
    const runId = store.createRun({ project: root, task: 'go', owner: join(root, 'gone.sock') });
    const { id } = store.addMember({ runId, parentId: null, name: 'solo', task: 'go', depth: 0 });
    store.setRunRoot(runId, id);
    store.setState(id, 'running');
    await sup.recover();
    assert.deepEqual(await sup.waitRun(runId), { status: 'failed', summary: 'interrupted by a supervisor restart' });
  } finally { await sup.close(); }
});

test('a restart on the same socket path adopts the runs its predecessor owned', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], on_resume: { steps: [] } } }
  });
  const first = await supervise(script);
  const { runId, memberId } = first.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  await until(() => first.store.member(memberId).state === 'waiting');
  await first.sup.close();
  // serve listens on its fixed path before it recovers, so the old owner looks alive.
  const { sup } = await supervise(script, { store: first.store, socketPath: first.socketPath });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    assert.equal((await sup.waitRun(runId)).status, 'ok');
  } finally { await sup.close(); }
});

test('a run with no recorded owner (written before owners existed) fails instead of relaunching', async () => {
  const { root, script } = project({ solo: LIVE() }, {});
  const { sup, store } = await supervise(script);
  try {
    const runId = store.createRun({ project: root, task: 'go' });
    const { id } = store.addMember({ runId, parentId: null, name: 'solo', task: 'go', depth: 0 });
    store.setRunRoot(runId, id);
    store.setState(id, 'running');
    const qid = store.addQuestion({ memberId: id, question: 'q?' });
    assert.deepEqual(await sup.recover(), { recovered: [], failed: [runId] });
    assert.equal(store.run(runId).status, 'failed');
    assert.match(store.member(id).result.summary, /left by an older agent-team; start it again/);
    assert.equal(store.question(qid).closed, 1, 'its open question is closed');
  } finally { await sup.close(); }
});

test('a pause in flight when the supervisor closes is kept: the member stays paused after a restart', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }], on_resume: { steps: [] } } }
  });
  const first = await supervise(script);
  const { store } = first;
  const { runId, memberId } = first.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  await until(() => store.events(memberId).some((e) => e.kind === 'text'));
  first.sup.pause({ member_id: memberId, by: 'ann' });   // waits for the turn, which outlasts close()
  await first.sup.close();
  assert.equal(store.member(memberId).state, 'paused');
  assert.deepEqual(store.events(memberId).findLast((e) => e.kind === 'paused').body, { by: 'ann', now: false });

  const { sup } = await supervise(script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    assert.equal(store.member(memberId).state, 'paused');
    assert.ok(!store.events(memberId).some((e) => e.kind === 'interrupted'), 'the paused member was relaunched');
  } finally { await sup.close(); }
});

test('a cancel in flight when the supervisor closes is kept: the member and its run end cancelled', async () => {
  const { root, script } = project({ solo: { agent: 'slowint', isolation: 'none' } }, {});
  const dir = adapterDir();
  copyFileSync(new URL('./fixtures/session-slow-interrupt', import.meta.url).pathname, join(dir, 'slowint'));
  chmodSync(join(dir, 'slowint'), 0o755);
  const first = await supervise(script, { adapterDir: dir });
  const { store } = first;
  const { runId, memberId } = first.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  await until(() => store.events(memberId).some((e) => e.body.text === 'working'));
  first.sup.cancel({ member_id: memberId });   // slowint lingers 600 ms after the interrupt
  const waited = first.sup.waitRun(runId);
  await first.sup.close();
  assert.equal(store.member(memberId).state, 'cancelled');
  assert.deepEqual(store.member(memberId).result, { status: 'failed', summary: 'cancelled by local' });
  assert.equal(store.run(runId).status, 'cancelled');
  assert.deepEqual(await waited, { status: 'failed', summary: 'cancelled by local' });

  const { sup } = await supervise(script, { store, adapterDir: dir });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [], failed: [] });
    assert.equal(store.member(memberId).state, 'cancelled');
  } finally { await sup.close(); }
});

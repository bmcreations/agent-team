import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { project, supervise, adapterDir, LIVE } from './helpers/live.js';
import { callRpc } from '../src/rpc.js';

const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };
const kinds = (store, id) => store.events(id).map((e) => e.kind);

test('pause settles a blocked wait_for with a note, then the member stops as paused', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    assert.deepEqual(sup.pause({ member_id: memberId }), { members: [{ id: memberId, name: 'solo' }], skipped: [] });
    await until(() => store.member(memberId).state === 'paused');
    const result = store.events(memberId).find((e) => e.kind === 'tool_result').body.result;
    assert.deepEqual(result, { messages: [], timed_out: false, note: 'paused by local — end your turn now' });
    assert.equal(store.run(runId).status, 'running', 'a paused root does not end its run');
    assert.ok(!kinds(store, memberId).includes('finished'));
    assert.throws(() => sup.pause({ member_id: memberId }), /"solo" is already paused/);
  } finally { await sup.close(); }
});

test('pause --now interrupts the turn instead of waiting for it', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }] } }
  });
  const { sup, store } = await supervise(script, { graceMs: 10_000 });
  try {
    const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => kinds(store, memberId).includes('text'));
    const started = Date.now();
    sup.pause({ member_id: memberId, now: true, by: 'ann' });
    await until(() => store.member(memberId).state === 'paused');
    assert.ok(Date.now() - started < 3000, 'pause --now waited for SIGTERM instead of interrupting');
    assert.deepEqual(store.events(memberId).find((e) => e.kind === 'paused').body, { by: 'ann', now: true });
  } finally { await sup.close(); }
});

test('pause while the member is still launching stops it before the adapter spawns', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ say: 'ran' }] } } });
  const { sup, store } = await supervise(script);
  try {
    // submit() starts the launch, which awaits the adapter's capabilities: still launching here.
    const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    sup.pause({ member_id: memberId });
    await until(() => store.member(memberId).state === 'paused');
    assert.equal(store.member(memberId).harness_id, null, 'the adapter was spawned');
    assert.ok(!kinds(store, memberId).includes('text'));
  } finally { await sup.close(); }
});

test('cancel a subtree: reports first, the manager is told, the run ends cancelled', async () => {
  const { root, script } = project({
    lead: LIVE(), worker: LIVE({ reports_to: 'lead', isolation: 'workspace' })
  }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'worker', task: 'slow' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      worker: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }] }
    }
  });
  const { sup, store } = await supervise(script, { graceMs: 10_000 });
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.children(leadId).some((c) => kinds(store, c.id).includes('text')));
    const workerId = store.children(leadId)[0].id;
    const res = sup.cancel({ run_id: runId, member: 'lead', subtree: true });
    assert.deepEqual(res.members.map((m) => m.name), ['worker', 'lead']);
    const result = await sup.waitRun(runId);
    assert.deepEqual(result, { status: 'failed', summary: 'cancelled by local' });
    assert.equal(store.run(runId).status, 'cancelled');
    // Both were interrupted at once; the report's adapter may exit after its manager's.
    await until(() => store.member(workerId).state === 'cancelled');
    assert.equal(store.member(leadId).state, 'cancelled');
    assert.ok(existsSync(store.member(workerId).workspace), 'cancel kept the workspace');
    const notice = store.takeQueued(leadId).map((m) => m.text);
    assert.deepEqual(notice, ['finished cancelled: cancelled by local']);
  } finally { await sup.close(); }
});

test('a queued member is paused or cancelled at once', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 30_000 }] } }
  });
  const { sup, store } = await supervise(script, { maxRunning: 1, graceMs: 200 });
  try {
    sup.submit({ projectRoot: root, member: 'solo', task: 'first' });
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'second' });
    assert.equal(store.member(memberId).state, 'queued');
    sup.pause({ member_id: memberId });
    assert.equal(store.member(memberId).state, 'paused');
    sup.cancel({ member_id: memberId });
    assert.equal(store.member(memberId).state, 'cancelled');
    assert.equal((await sup.waitRun(runId)).summary, 'cancelled by local');
  } finally { await sup.close(); }
});

test('verbs out of order are refused and change nothing', async () => {
  const { root, script } = project({ solo: LIVE(), old: { agent: 'mock', isolation: 'none' } }, {
    by_member: { solo: { steps: [] }, old: { hang: true } }
  });
  const { sup, store } = await supervise(script);
  try {
    const done = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(done.runId);
    assert.throws(() => sup.cancel({ member_id: done.memberId }), /"solo" has already finished \(done\)/);
    assert.equal(store.member(done.memberId).state, 'done');

    // A v1 adapter that never answers; the run's timeout ends it after the assertions.
    const v1 = sup.submit({ projectRoot: root, member: 'old', task: 'go', timeoutMs: 1500 });
    await new Promise((r) => setTimeout(r, 500));   // past resolution, into the one-shot run
    assert.throws(() => sup.pause({ member_id: v1.memberId }), /"old" runs one-shot and cannot be paused/);
    assert.equal(store.member(v1.memberId).state, 'running');
    await sup.waitRun(v1.runId);
    assert.throws(() => sup.pause({ run_id: done.runId, member: 'nobody' }), /has no member "nobody"/);
  } finally { await sup.close(); }
});

test('pause and cancel are admin RPCs that name a member by run and name', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const res = await callRpc(sup.socketPath, { method: 'cancel', params: { run_id: runId, member: 'solo', by: 'bob' } });
    assert.deepEqual(res.members, [{ id: memberId, name: 'solo' }]);
    assert.equal((await sup.waitRun(runId)).summary, 'cancelled by bob');
  } finally { await sup.close(); }
});

test('send_to a report that is being cancelled is refused, not left unread', async () => {
  const { root, script } = project({
    lead: LIVE(), worker: { agent: 'slowint', reports_to: 'lead', isolation: 'none' }
  }, {
    by_member: { lead: { steps: [
      { tool: 'delegate', args: { to: 'worker', task: 'slow' }, save: 'r' },
      { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
    ] } }
  });
  const dir = adapterDir();
  copyFileSync(new URL('./fixtures/session-slow-interrupt', import.meta.url).pathname, join(dir, 'slowint'));
  chmodSync(join(dir, 'slowint'), 0o755);
  const { sup, store } = await supervise(script, { adapterDir: dir, graceMs: 10_000 });
  try {
    const { memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const deadline = Date.now() + 10_000;
    const worker = () => store.children(leadId)[0];
    while (!(worker() && store.events(worker().id).some((e) => e.body.text === 'working'))) {
      assert.ok(Date.now() < deadline, 'worker never started');
      await new Promise((r) => setTimeout(r, 20));
    }
    const workerId = worker().id;
    sup.cancel({ member_id: workerId });
    const res = await callRpc(sup.socketPath, {
      token: store.member(leadId).token, method: 'send_to', params: { to: 'worker', text: 'too late' }
    }).catch((err) => ({ error: err.message }));
    assert.match(String(res.error ?? JSON.stringify(res)), /"worker" has finished/);
    await until(() => store.member(workerId).state === 'cancelled');
    assert.deepEqual(store.takeQueued(workerId), [], 'a message was left in a cancelled inbox');
  } finally { await sup.close(); }
});

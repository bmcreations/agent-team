import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { project, adapterDir, supervise, LIVE } from './helpers/live.js';

test('a v2 member with no reports runs to its result and the run finishes', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }], result: { status: 'ok', summary: 'all good' } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.equal(result.summary, 'all good');
    assert.equal(store.member(memberId).state, 'done');
    assert.equal(store.run(runId).status, 'done');
    assert.ok(store.member(memberId).harness_id.startsWith('mock-live-solo-'));
    assert.deepEqual(store.events(memberId).map((e) => e.kind), ['started', 'text', 'finished']);
  } finally { await sup.close(); }
});

test('a human message sent mid-turn is acked at the next step and delivered once', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 300 }, { say: 'after' }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await new Promise((r) => setTimeout(r, 100));
    const { message_id } = sup.send({ member_id: memberId, text: 'use tabs', from: 'brandon' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.received, ['[from: brandon (human)] use tabs']);
    assert.equal(store.message(message_id).state, 'delivered');
  } finally { await sup.close(); }
});

test('an adapter that dies without a result fails the member with its stderr', async () => {
  const { root, script } = project({ solo: { agent: 'crash', isolation: 'none' } }, {});
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /boom: harness exploded/);
    assert.equal(store.member(memberId).state, 'failed');
    assert.equal(store.run(runId).status, 'failed');
  } finally { await sup.close(); }
});

test('report_progress from a root member is recorded as an event', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'report_progress', args: { text: 'half way' } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(runId);
    assert.ok(store.events(memberId).some((e) => e.kind === 'progress' && e.body.text === 'half way'));
  } finally { await sup.close(); }
});

test('a message to a member that is stopping is refused and nothing is left queued', async () => {
  const { root, script } = project({ solo: { agent: 'slow', isolation: 'none' } }, {});
  const dir = adapterDir();
  copyFileSync(new URL('./fixtures/session-slow-stop', import.meta.url).pathname, join(dir, 'slow'));
  chmodSync(join(dir, 'slow'), 0o755);
  const { sup, store } = await supervise(script, { adapterDir: dir });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const deadline = Date.now() + 10_000;
    while (!store.events(memberId).some((e) => e.body.text === 'stop-received')) {
      assert.ok(Date.now() < deadline, 'member never received stop');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(store.member(memberId).state, 'running');
    assert.throws(() => sup.send({ member_id: memberId, text: 'too late', from: 'brandon' }), /"solo" has finished/);
    assert.deepEqual(store.offerQueued(memberId), []);
    assert.equal((await sup.waitRun(runId)).status, 'ok');
  } finally { await sup.close(); }
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('close() ends live adapters and leaves their members for recovery', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }] } }
  });
  const { sup, store } = await supervise(script, { graceMs: 200 });
  const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  while (!store.events(memberId).some((e) => e.kind === 'text')) await new Promise((r) => setTimeout(r, 20));
  const pid = Number(store.member(memberId).harness_id.split('-').at(-1));
  const started = Date.now();
  await sup.close();
  assert.ok(Date.now() - started < 3000, 'close() waited on the adapter');
  assert.equal(alive(pid), false, 'the adapter process outlived close()');
  assert.equal(store.member(memberId).state, 'running');
  assert.ok(!store.events(memberId).some((e) => e.kind === 'finished'));
});

test('close() settles a blocked wait_for instead of leaving its connection open', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } }
  });
  const { sup, store } = await supervise(script, { graceMs: 200 });
  const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  while (store.member(memberId).state !== 'waiting') await new Promise((r) => setTimeout(r, 20));
  await sup.close();
  const results = store.events(memberId).filter((e) => e.kind === 'tool_result');
  assert.deepEqual(results.map((e) => e.body.result), [{ error: 'the agent-team supervisor is shutting down' }]);
});

test('a launched member records its harness, model and whether it could write', async () => {
  const { root, script } = project({ solo: LIVE({ model: 'mock-1' }) }, {
    by_member: { solo: { steps: [], result: { status: 'ok', summary: 'ok' } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(runId);
    const m = store.member(memberId);
    assert.deepEqual([m.agent, m.model, m.read_only], ['mock-live', 'mock-1', 1]);   // isolation none is read-only
  } finally { await sup.close(); }
});

test('send names a member by run and name, as pause does', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 400 }, { say: 'done' }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const { message_id } = sup.send({ run_id: runId, member: 'solo', text: 'use tabs', from: 'b' });
    assert.equal(store.timeline({ memberId }).messages.find((m) => m.id === message_id).text, 'use tabs');
    await sup.waitRun(runId);
  } finally { await sup.close(); }
});

test('send and answer refuse a run another supervisor is running', async () => {
  const { script } = project({ solo: LIVE() }, { by_member: {} });
  const { sup, store } = await supervise(script);
  try {
    // Seeded after start, so recovery never sees it.
    const runId = store.createRun({ project: '/p', task: 't', owner: '/elsewhere.sock' });
    const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
    store.setRunRoot(runId, lead.id);
    store.setState(lead.id, 'waiting');
    const qid = store.addQuestion({ memberId: lead.id, question: 'ok?' });
    assert.throws(() => sup.send({ member_id: lead.id, text: 'hi' }), /run by another supervisor/);
    assert.throws(() => sup.answer({ question_id: qid, answer: 'yes' }), /run by another supervisor/);
    assert.equal(store.question(qid).answer, null);
  } finally { await sup.close(); }
});

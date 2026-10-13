import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, supervise, LIVE } from './helpers/live.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
};

test('a quiet working member is reported stalled to its manager, once', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }] },
      worker: { steps: [{ sleep_ms: 3500 }] }
    }
  }, { stall_minutes: 0.02 });   // 1.2 s: longer than an adapter takes to start under load
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await Promise.race([sup.waitRun(runId), sleep(20_000).then(() => { throw new Error('run did not finish'); })]);
    assert.equal(result.status, 'ok');
    const [stalled] = result.tool_results[1].result.messages;
    assert.match(stalled.text, /^stalled: no events for \d+s$/);
    const workerId = store.children(leadId)[0].id;
    assert.equal(store.events(workerId).filter((e) => e.kind === 'stalled').length, 1);
    assert.equal(store.events(leadId).filter((e) => e.kind === 'stalled').length, 0, 'a blocked manager is not stalled');
  } finally { await sup.close(); }
});

test('a v2 member past its timeout is interrupted and fails', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ sleep_ms: 30_000 }] } } });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go', timeoutMs: 300 });
    assert.deepEqual(await sup.waitRun(runId), { status: 'failed', summary: 'timed out after 0.3s of work' });
    assert.equal(store.member(memberId).state, 'failed');
    assert.deepEqual(store.events(memberId).find((e) => e.kind === 'timed_out').body, { after_s: 0.3 });
  } finally { await sup.close(); }
});

test('time blocked in wait_for does not count toward the timeout', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } } });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go', timeoutMs: 2000 });
    await until(() => store.member(memberId).state === 'waiting');
    await sleep(3000);
    sup.send({ member_id: memberId, text: 'done waiting' });
    assert.equal((await sup.waitRun(runId)).status, 'ok');
  } finally { await sup.close(); }
});

test('a run past max_cost_usd pauses, and resumes only with a higher cap', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }],
              on_resume: { steps: [] }, turn_cost_usd: 0.5 },
      worker: { steps: [], turn_cost_usd: 0.7 }
    }
  }, { max_cost_usd: 1 });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.member(leadId).state === 'paused');
    assert.equal(store.run(runId).cost_usd, 1.2);
    assert.deepEqual(store.events(leadId).find((e) => e.kind === 'cost_cap').body, { cost_usd: 1.2, max_cost_usd: 1 });
    assert.equal(store.events(leadId).findLast((e) => e.kind === 'paused').body.by, 'cost cap');
    assert.throws(() => sup.resume({ member_id: leadId }), /run \d+ has spent \$1\.20 of its \$1\.00 cap — pass max_cost_usd to raise it/);
    assert.equal(store.member(leadId).state, 'paused');
    sup.resume({ member_id: leadId, max_cost_usd: 5 });
    assert.equal((await sup.waitRun(runId)).status, 'ok');
    assert.equal(store.run(runId).max_cost_usd, 5);
    assert.equal(store.run(runId).cost_usd, 1.7);
  } finally { await sup.close(); }
});

test('a resume that fails leaves the run cost cap as it was', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }],
              on_resume: { steps: [] }, turn_cost_usd: 0.5 },
      worker: { steps: [], turn_cost_usd: 0.7 }
    }
  }, { max_cost_usd: 1 });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.member(leadId).state === 'paused');
    const workerId = store.members(runId).find((m) => m.name === 'worker').id;
    assert.throws(() => sup.resume({ member_id: leadId, max_cost_usd: 1.1 }), /has spent \$1\.20 of its \$1\.10 cap/);
    assert.throws(() => sup.resume({ member_id: workerId, max_cost_usd: 5 }), /is not paused/);
    assert.equal(store.run(runId).max_cost_usd, 1);
    assert.throws(() => sup.submit({ projectRoot: root, member: 'lead', task: 'go', maxCostUsd: 0 }),
                  /max_cost_usd must be a positive number/);
  } finally { await sup.close(); }
});

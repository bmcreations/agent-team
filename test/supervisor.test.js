import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, supervise, LIVE } from './helpers/live.js';

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

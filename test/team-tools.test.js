import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, supervise, LIVE } from './helpers/live.js';

const TEAM = {
  lead: LIVE(),
  a: LIVE({ reports_to: 'lead' }),
  b: LIVE({ reports_to: 'lead' })
};

test('a manager steers a report that is running in parallel', async () => {
  const { root, script } = project(TEAM, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'slow job' }, save: 'ra' },
        { tool: 'delegate', args: { to: 'b', task: 'left or right' }, save: 'rb' },
        { tool: 'wait_for', args: { report_ids: ['$rb.report_id'] }, save: 'w1' },
        { tool: 'send_to', args: { to: 'b', text: 'go right' } },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id', '$rb.report_id'] }
      ], result: { status: 'ok', summary: 'merged' } },
      a: { steps: [{ sleep_ms: 400 }], result: { status: 'ok', summary: 'a done' } },
      b: { steps: [
        { tool: 'report_progress', args: { text: 'going left' } },
        { tool: 'wait_for', args: {} }
      ], result: { status: 'ok', summary: 'b done' } }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'ship' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');

    const [w1] = result.tool_results.filter((t) => t.tool === 'wait_for');
    assert.deepEqual(w1.result.messages.map((m) => m.text), ['progress: going left']);
    assert.equal(w1.result.messages[0].from, 'b (report)');

    const members = store.members(runId);
    const b = members.find((m) => m.name === 'b');
    const bWait = b.result.tool_results.find((t) => t.tool === 'wait_for');
    assert.deepEqual(bWait.result.messages.map((m) => [m.from, m.text]), [['lead (manager)', 'go right']]);

    // a and b ran at the same time: b started before a finished.
    const a = members.find((m) => m.name === 'a');
    const at = (m, kind) => store.events(m.id).find((e) => e.kind === kind).at;
    assert.ok(at(b, 'started') <= at(a, 'finished'));
    assert.deepEqual(members.map((m) => m.state), ['done', 'done', 'done']);
  } finally { await sup.close(); }
});

test('wait_for with no open reports returns at once only for a member that delegated', async () => {
  const { root, script } = project(TEAM, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'one' }, save: 'ra' },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id'] },
        { tool: 'wait_for', args: {} }
      ] },
      a: { steps: [{ tool: 'wait_for', args: { timeout_s: 1 } }] }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.tool_results.at(-1).result.note, 'no open reports');
    const a = store.members(runId).find((m) => m.name === 'a');
    assert.equal(a.result.tool_results[0].result.timed_out, true, 'the leaf blocked until its timeout');
  } finally { await sup.close(); }
});

test('delegation outside the rules is a tool error and the run carries on', async () => {
  const { root, script } = project({ ...TEAM, outsider: LIVE() }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'outsider', task: 'x' } },
        { tool: 'delegate', args: { to: 'a', task: 'one' } },
        { tool: 'delegate', args: { to: 'b', task: 'two' } }
      ] },
      a: { steps: [] }, b: { steps: [] }
    }
  }, { max_delegations: 1 });
  const { sup } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    const errors = result.tool_results.map((t) => t.result.error ?? null);
    assert.match(errors[0], /"outsider" is not a direct report of "lead"/);
    assert.equal(errors[1], null);
    assert.match(errors[2], /max_delegations/);
    assert.equal(result.status, 'ok');
  } finally { await sup.close(); }
});

test('max_depth 0 refuses any delegation', async () => {
  const { root, script } = project(TEAM, {
    by_member: { lead: { steps: [{ tool: 'delegate', args: { to: 'a', task: 'x' } }] } }
  }, { max_depth: 0 });
  const { sup } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.match(result.tool_results[0].result.error, /max_depth 0/);
  } finally { await sup.close(); }
});

test('max_parallel queues reports beyond the limit', async () => {
  const { root, script } = project(TEAM, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'one' }, save: 'ra' },
        { tool: 'delegate', args: { to: 'b', task: 'two' }, save: 'rb' },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id', '$rb.report_id'] }
      ] },
      a: { steps: [{ sleep_ms: 200 }] }, b: { steps: [] }
    }
  }, { max_parallel: 1 });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await sup.waitRun(runId);
    const [, a, b] = store.members(runId);
    const at = (m, kind) => store.events(m.id).find((e) => e.kind === kind).at;
    assert.ok(at(b, 'started') >= at(a, 'finished'), 'b waited for a');
  } finally { await sup.close(); }
});

test('ask_human blocks until answered, and times out to no answer', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [
      { tool: 'ask_human', args: { question: 'tabs or spaces?', options: ['tabs', 'spaces'] } },
      { tool: 'ask_human', args: { question: 'still there?', timeout_s: 1 } }
    ] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    let open;
    while (!(open = store.openQuestions()).length) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(open[0].options, ['tabs', 'spaces']);
    sup.answer({ question_id: open[0].id, answer: 'tabs', by: 'brandon' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result, { answer: 'tabs', answered_by: 'brandon', timed_out: false });
    assert.deepEqual(result.tool_results[1].result, { answer: null, timed_out: true });
  } finally { await sup.close(); }
});

test('a message to a queued member is delivered once after it launches', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 50 }] } }
  });
  const { sup, store } = await supervise(script, { maxRunning: 0 });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    assert.equal(store.member(memberId).state, 'queued');
    sup.send({ member_id: memberId, text: 'early note', from: 'brandon' });
    sup.maxRunning = 1;
    sup.kick();
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.received, ['[from: brandon (human)] early note']);
  } finally { await sup.close(); }
});

test('a tool call from a finished or unknown member is an error, not a crash', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [] } } });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(runId);
    const { callRpc } = await import('../src/rpc.js');
    const token = store.member(memberId).token;
    await assert.rejects(callRpc(sup.socketPath, { token, method: 'report_progress', params: { text: 'x' } }), /not running/);
    await assert.rejects(callRpc(sup.socketPath, { token: 'forged', method: 'wait_for' }), /not running/);
    assert.throws(() => sup.send({ member_id: memberId, text: 'late' }), /has finished/);
  } finally { await sup.close(); }
});

const blocked = async (store, memberId) => {
  while (store.member(memberId).state !== 'waiting') await new Promise((r) => setTimeout(r, 20));
};

test('a second blocking call from a blocked member is rejected and the first still resolves', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: { timeout_s: 30 } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await blocked(store, memberId);
    const { callRpc } = await import('../src/rpc.js');
    const token = store.member(memberId).token;
    await assert.rejects(callRpc(sup.socketPath, { token, method: 'wait_for', params: {} }),
      /member "solo" is already blocked in wait_for — one blocking call at a time/);
    await assert.rejects(callRpc(sup.socketPath, { token, method: 'ask_human', params: { question: 'q?' } }),
      /already blocked in wait_for/);
    sup.send({ member_id: memberId, text: 'wake', from: 'brandon' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result.messages.map((m) => m.text), ['wake']);
    assert.equal(result.tool_results[0].result.timed_out, false);
  } finally { await sup.close(); }
});

test('wait_for is refused while the member has a question pending', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'q?' } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await blocked(store, memberId);
    const { callRpc } = await import('../src/rpc.js');
    const token = store.member(memberId).token;
    await assert.rejects(callRpc(sup.socketPath, { token, method: 'wait_for', params: {} }), /already blocked in ask_human/);
    sup.answer({ question_id: store.openQuestions()[0].id, answer: 'yes' });
    const result = await sup.waitRun(runId);
    assert.equal(result.tool_results[0].result.answer, 'yes');
  } finally { await sup.close(); }
});

test('a timed-out question is closed and a late answer is refused', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'q?', timeout_s: 1 } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    let open;
    while (!(open = store.openQuestions()).length) await new Promise((r) => setTimeout(r, 20));
    const qid = open[0].id;
    const result = await sup.waitRun(runId);
    assert.equal(result.tool_results[0].result.timed_out, true);
    assert.deepEqual(store.openQuestions(), []);
    assert.throws(() => sup.answer({ question_id: qid, answer: 'late' }), /no longer open/);
  } finally { await sup.close(); }
});

test('wait_for on reports that are all finished and already read returns at once', async () => {
  const { root, script } = project(TEAM, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'one' }, save: 'ra' },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id'] },
        { tool: 'wait_for', args: { report_ids: ['$ra.report_id'], timeout_s: 30 } }
      ] },
      a: { steps: [] }
    }
  });
  const { sup } = await supervise(script);
  try {
    const t0 = Date.now();
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.tool_results.at(-1).result.note, 'no open reports');
    assert.ok(Date.now() - t0 < 10000);
  } finally { await sup.close(); }
});

test('wait_for accepts report ids sent as strings', async () => {
  const { root, script } = project(TEAM, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'one' }, save: 'ra' },
        { tool: 'wait_for', args: { report_ids: ['2'], timeout_s: 5 } },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id'] }
      ] },
      a: { steps: [{ tool: 'report_progress', args: { text: 'half' } }] }
    }
  });
  const { sup } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    const w = result.tool_results[1].result;
    assert.equal(w.timed_out, false);
    assert.deepEqual(w.messages.map((m) => [m.report_id, m.text]), [[2, 'progress: half']]);
  } finally { await sup.close(); }
});

test('send_to a v1 report is refused: it has no session to deliver to', async () => {
  const { root, script } = project({ lead: LIVE(), old: { agent: 'mock', reports_to: 'lead', isolation: 'none' } }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'old', task: 'one' }, save: 'ro' },
        { sleep_ms: 500 },
        { tool: 'send_to', args: { to: 'old', text: 'hi' } },
        { tool: 'wait_for', args: {}, until_finished: ['$ro.report_id'] }
      ] },
      old: { hang: true }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go', timeoutMs: 2000 });
    const result = await sup.waitRun(runId);
    const sent = result.tool_results.find((t) => t.tool === 'send_to').result;
    assert.match(sent.error ?? '', /"old" runs one-shot and cannot receive messages/);
    assert.equal(store.members(runId).find((m) => m.name === 'old').state, 'failed', 'the hung v1 report timed out');
  } finally { await sup.close(); }
});

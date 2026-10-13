import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, supervise, LIVE } from './helpers/live.js';
import { callRpc } from '../src/rpc.js';

// Poll with a deadline so a regression fails the test instead of hanging the runner.
const until = async (f, ms = 10000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('a human message cuts ask_human short and closes the question', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'a or b?' } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.openQuestions().length === 1);
    const [{ id: questionId }] = store.openQuestions();
    const { message_id } = sup.send({ member_id: memberId, text: 'use b', from: 'ann' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result, {
      answer: null, timed_out: false,
      messages: [{ id: message_id, from: 'ann (human)', text: 'use b', report_id: null, thread_id: null }],
      note: 'question closed: a message arrived before an answer'
    });
    assert.deepEqual(result.received, [], 'the message was delivered twice');
    assert.equal(store.question(questionId).closed, 1);
    assert.throws(() => sup.answer({ question_id: questionId, answer: 'a' }), /no longer open/);
  } finally { await sup.close(); }
});

test("a report's progress does not cut its manager's question short", async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'worker', task: 'w' } },
        { tool: 'ask_human', args: { question: 'ship it?' } }
      ] },
      worker: { steps: [{ tool: 'report_progress', args: { text: 'half way' } }] }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.openQuestions().length === 1 && store.children(leadId)[0]?.state === 'done');
    assert.equal(store.member(leadId).state, 'waiting');
    sup.answer({ question_id: store.openQuestions()[0].id, answer: 'yes', by: 'ann' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[1].result, { answer: 'yes', answered_by: 'ann', timed_out: false });
    assert.equal(result.received.length, 2, 'progress and the finish notice arrive after the answer');
  } finally { await sup.close(); }
});

test('the questions RPC lists open questions with who asked them', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'a or b?', options: ['a', 'b'] } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.openQuestions().length === 1);
    const listed = await callRpc(sup.socketPath, { method: 'questions', params: { run_id: runId } });
    assert.equal(listed.length, 1);
    assert.deepEqual({ ...listed[0], id: 0, asked_at: 0 }, {
      id: 0, run_id: runId, member_id: memberId, member: 'solo', question: 'a or b?', options: ['a', 'b'], asked_at: 0
    });
    assert.deepEqual(await callRpc(sup.socketPath, { method: 'questions', params: { run_id: runId + 1 } }), []);
    await callRpc(sup.socketPath, { method: 'answer', params: { question_id: listed[0].id, answer: 'a' } });
    await sup.waitRun(runId);
    assert.deepEqual(sup.questions(), []);
  } finally { await sup.close(); }
});

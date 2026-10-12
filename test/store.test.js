import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';

function seeded() {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 'ship it' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 'ship it', depth: 0 });
  store.setRunRoot(runId, lead.id);
  return { store, runId, lead };
}

test('members get unique tokens and parse their results', () => {
  const { store, runId, lead } = seeded();
  const kid = store.addMember({ runId, parentId: lead.id, name: 'worker', task: 't', depth: 1 });
  assert.notEqual(lead.token, kid.token);
  assert.equal(store.memberByToken(kid.token).name, 'worker');
  assert.deepEqual(store.children(lead.id).map((m) => m.name), ['worker']);
  store.setResult(kid.id, { status: 'ok', summary: 'done' });
  assert.deepEqual(store.member(kid.id).result, { status: 'ok', summary: 'done' });
  assert.equal(store.member(kid.id).state, 'queued');
});

test('an offered message is delivered once on ack and never offered again', () => {
  const { store, lead } = seeded();
  const id = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'brandon', text: 'hi' });
  assert.deepEqual(store.offerQueued(lead.id).map((m) => m.id), [id]);
  assert.deepEqual(store.offerQueued(lead.id), []);
  store.ackMessage(id);
  store.requeue(id);                       // too late: already delivered
  assert.equal(store.message(id).state, 'delivered');
  assert.deepEqual(store.offerQueued(lead.id), []);
  assert.deepEqual(store.takeQueued(lead.id), []);
});

test('an offered message that was not acked goes back to the queue', () => {
  const { store, lead } = seeded();
  const id = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'brandon', text: 'hi' });
  store.offerQueued(lead.id);
  store.requeue(id);
  assert.deepEqual(store.takeQueued(lead.id).map((m) => m.id), [id]);
  assert.equal(store.message(id).state, 'delivered');
});

test('takeQueued with report ids leaves other reports\' messages queued', () => {
  const { store, lead } = seeded();
  store.enqueue({ to: lead.id, fromKind: 'report', fromName: 'a', reportId: 10, text: 'a' });
  store.enqueue({ to: lead.id, fromKind: 'report', fromName: 'b', reportId: 11, text: 'b' });
  store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'brandon', text: 'h' });
  assert.deepEqual(store.takeQueued(lead.id, [11]).map((m) => m.text), ['b', 'h']);
  assert.deepEqual(store.takeQueued(lead.id).map((m) => m.text), ['a']);
});

test('claimForWait takes offered messages as well as queued ones', () => {
  const { store, lead } = seeded();
  const offered = store.enqueue({ to: lead.id, fromKind: 'manager', fromName: 'boss', text: 'one' });
  store.offerQueued(lead.id);
  const queued = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'brandon', text: 'two' });
  assert.deepEqual(store.claimForWait(lead.id).map((m) => m.id), [offered, queued]);
  store.ackMessage(offered);               // the stdin copy's late ack changes nothing
  assert.equal(store.message(offered).state, 'delivered');
  assert.deepEqual(store.claimForWait(lead.id), []);
});

test('questions open, then close with who answered', () => {
  const { store, lead } = seeded();
  const q = store.addQuestion({ memberId: lead.id, question: 'which?', options: ['a', 'b'] });
  assert.deepEqual(store.openQuestions().map((r) => r.id), [q]);
  store.answerQuestion(q, 'a', 'brandon');
  assert.deepEqual(store.question(q).options, ['a', 'b']);
  assert.equal(store.question(q).answered_by, 'brandon');
  assert.deepEqual(store.openQuestions(), []);
});

test('a closed question is no longer open or answerable', () => {
  const { store, lead } = seeded();
  const q = store.addQuestion({ memberId: lead.id, question: 'which?' });
  store.closeQuestion(q);
  assert.deepEqual(store.openQuestions(), []);
  assert.equal(store.answerQuestion(q, 'a', 'brandon'), false);
  assert.equal(store.question(q).answer, null);
  const q2 = store.addQuestion({ memberId: lead.id, question: 'again?' });
  assert.equal(store.answerQuestion(q2, 'a', 'brandon'), true);
  assert.equal(store.answerQuestion(q2, 'b', 'other'), false, 'the first answer stands');
  assert.equal(store.question(q2).answer, 'a');
});

test('events keep their order and body', () => {
  const { store, lead } = seeded();
  store.addEvent(lead.id, 'text', { text: 'one' });
  store.addEvent(lead.id, 'text', { text: 'two' });
  assert.deepEqual(store.events(lead.id).map((e) => e.body.text), ['one', 'two']);
});

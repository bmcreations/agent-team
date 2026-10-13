import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, realpathSync, symlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadsView } from '../src/view.js';
import { basename } from 'node:path';
import { project, supervise, LIVE } from './helpers/live.js';

const until = async (f, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// Two repos sharing one script: A (a manager) and B (a lead with a report, by default).
// `script(aRoot, bRoot)` is built once both exist, with real paths.
function twoTeams(script, { aMembers, bMembers, aDefaults = {}, bDefaults = {} } = {}) {
  const b = project(bMembers ?? { 'b-lead': LIVE(), 'b-dev': LIVE({ reports_to: 'b-lead' }) }, {}, bDefaults);
  const a = project(aMembers ?? { manager: LIVE() }, {}, aDefaults);
  const bReal = realpathSync(b.root);
  const aReal = realpathSync(a.root);
  const body = JSON.stringify(script({ a: aReal, b: bReal }));
  writeFileSync(a.script, body);
  writeFileSync(b.script, body);
  return { a, b, aReal, bReal };
}

const results = (store, memberId, tool) =>
  store.events(memberId).filter((e) => e.kind === 'tool_result' && e.body.name === tool).map((e) => e.body.result);

// Runs A's manager and returns its first `request` result.
async function requestOutcome(script, opts = {}, supOpts = { shared: true }) {
  const t = twoTeams(script, opts);
  const { sup, store } = await supervise(t.a.script, supOpts);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const threads = store.threads();
    return { ...t, runId, threads, result: results(store, memberId, 'request')[0] };
  } finally { await sup.close(); store.close(); }
}

const ask = (args) => ({ a, b }) => ({ by_member: {
  manager: { steps: [{ tool: 'request', args: typeof args === 'function' ? args({ a, b }) : args }] },
  'b-lead': { steps: [{ say: 'looking' }] }
} });

test('a request with no live lead starts a run in the receiving project that carries the thread', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [{ tool: 'request', args: { team: b, text: 'crash on rotate', task: 'fix it' }, save: 't' }] },
    'b-lead': { steps: [{ say: 'looking' }] }
  } }), { bDefaults: { max_delegations: 3 } });
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const r = results(store, memberId, 'request')[0];
    assert.equal(r.thread_id, 1);
    assert.equal(r.state, 'open');
    assert.deepEqual(r.team, { name: basename(t.bReal), root: t.bReal });
    assert.equal(typeof r.run_id, 'number');
    const bRun = store.run(r.run_id);
    assert.equal(bRun.project, t.bReal);
    assert.equal(bRun.thread_id, 1);
    assert.equal(store.member(bRun.root_member).name, 'b-lead');
    const th = store.thread(1);
    assert.equal(th.kind, 'task');
    assert.equal(th.owner_member, bRun.root_member);
    assert.equal(th.run_id, r.run_id);
    assert.deepEqual(th.chain, [t.aReal]);
    assert.equal(th.task, 'fix it');
    assert.equal(store.threadPosts(1).filter((p) => p.side === 'requester').length, 1);
    // The receiving team's budget starts from its own config; the requester paid for the request.
    assert.equal(bRun.budget, 3);
    assert.equal(store.run(runId).budget, 19);   // the default 20, less the one request
    await sup.waitRun(r.run_id);
  } finally { await sup.close(); store.close(); }
});

test('the lead of a thread-run sees the thread in its brief', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [{ tool: 'request', args: { team: b, text: 'crash on rotate', task: 'fix it' } }] },
    'b-lead': { steps: [{ tool: 'report_progress', args: { text: '$brief.thread.from' } }] }
  } }));
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const { run_id } = results(store, memberId, 'request')[0];
    await sup.waitRun(run_id);
    const lead = store.members(run_id)[0];
    assert.equal(lead.task, 'Thread #1: fix it');
    const progress = store.events(lead.id).find((e) => e.kind === 'progress');
    assert.equal(progress.body.text, `${basename(t.aReal)}/manager`);
  } finally { await sup.close(); store.close(); }
});

test('a request without a task opens a question thread', async () => {
  const { threads, result } = await requestOutcome(ask(({ b }) => ({ team: b, text: 'which api level?' })));
  assert.equal(result.state, 'open');
  assert.equal(threads[0].kind, 'question');
  assert.equal(threads[0].task, null);
});

test('a live lead receives the request in its inbox, with no new run', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [{ sleep_ms: 400 }, { tool: 'request', args: { team: b, text: 'crash on rotate', task: 'fix it' } }] },
    'b-lead': { steps: [{ tool: 'wait_for', args: { timeout_s: 10 } }] }
  } }));
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const lead = sup.submit({ projectRoot: t.b.root, member: 'b-lead', task: 'own it' });
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(mgr.runId);
    await sup.waitRun(lead.runId);
    const r = results(store, mgr.memberId, 'request')[0];
    assert.equal(r.run_id, undefined);
    assert.equal(store.threadPosts(1).filter((p) => p.side === 'requester').length, 1);   // delivery does not record a second opening post
    assert.equal(store.thread(r.thread_id).owner_member, lead.memberId);
    // The lead's run ended without accepting, so the thread closed and the requester was released.
    assert.equal(store.thread(r.thread_id).state, 'declined');
    const got = results(store, lead.memberId, 'wait_for')[0].messages[0];
    assert.equal(got.thread_id, 1);
    assert.equal(got.from, `${basename(t.aReal)}/manager (team)`);
    assert.match(got.text, /crash on rotate/);
  } finally { await sup.close(); store.close(); }
});

test('refusals: unknown team, self, in-process, exhausted budget, cloud team', async () => {
  const unknown = await requestOutcome(ask({ team: '/nowhere', text: 'x' }));
  assert.match(unknown.result.error, /not found: no agent-team config/);

  const self = await requestOutcome(ask(({ a }) => ({ team: a, text: 'x' })));
  assert.match(self.result.error, /already in this chain/);

  const inProcess = await requestOutcome(ask(({ b }) => ({ team: b, text: 'x' })), {}, { shared: false });
  assert.match(inProcess.result.error, /threads need `agent-team serve`/);

  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [{ tool: 'request', args: { team: b, text: 'one' } }, { tool: 'request', args: { team: b, text: 'two' } }] },
    'b-lead': { steps: [{ say: 'looking' }] }
  } }), { aDefaults: { max_delegations: 1 } });
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const [first, second] = results(store, memberId, 'request');
    assert.equal(first.thread_id, 1);
    assert.match(second.error, /delegation budget exhausted/);
    assert.equal(store.threads().length, 1);
    assert.equal(store.run(runId).budget, 0);
    await sup.waitRun(first.run_id);
  } finally { await sup.close(); store.close(); }

  const cloud = await requestOutcome(ask({ team: 'github:me/loupe', text: 'x' }));
  assert.match(cloud.result.error, /is a GitHub repository/);
});

test('a team with several roots is refused with the entry error', async () => {
  const { result, threads } = await requestOutcome(ask(({ b }) => ({ team: b, text: 'x' })),
    { bMembers: { one: LIVE(), two: LIVE() } });
  assert.match(result.error, /top-level members/);
  assert.equal(threads.length, 0);
});

test('a thread-run cannot request the team that started it', async () => {
  const t = twoTeams(({ a, b }) => ({ by_member: {
    manager: { steps: [{ tool: 'request', args: { team: b, text: 'x', task: 'y' } }] },
    'b-lead': { steps: [{ tool: 'request', args: { team: a, text: 'back' } }] }
  } }));
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const { run_id } = results(store, memberId, 'request')[0];
    await sup.waitRun(run_id);
    const lead = store.members(run_id)[0];
    assert.match(results(store, lead.id, 'request')[0].error,
      /request refused: team ".*" is already in this chain/);
    assert.equal(store.threads().length, 1);
  } finally { await sup.close(); store.close(); }
});

test('a live cross-team member cannot request the team it was entered from', async () => {
  const b = project({ 'b-lead': LIVE() }, {});
  const a = project({ manager: LIVE(), loupe: { team: b.root, reports_to: 'manager' } }, {});
  const aReal = realpathSync(a.root);
  const body = JSON.stringify({ by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'loupe', task: 'go' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ] },
    'b-lead': { steps: [{ tool: 'request', args: { team: aReal, text: 'back' } }] }
  } });
  writeFileSync(a.script, body);
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const lead = store.members(runId).find((m) => m.name === 'b-lead');
    assert.match(results(store, lead.id, 'request')[0].error, /request refused: team ".*" is already in this chain/);
  } finally { await sup.close(); store.close(); }
});

test('a live lead that owns a thread cannot request the team that opened it', async () => {
  const t = twoTeams(({ a, b }) => ({ by_member: {
    manager: { steps: [{ sleep_ms: 400 }, { tool: 'request', args: { team: b, text: 'hi', task: 'go' } }] },
    'b-lead': { steps: [{ tool: 'wait_for', args: { timeout_s: 10 } }, { tool: 'request', args: { team: a, text: 'back' } }] }
  } }));
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const lead = sup.submit({ projectRoot: t.b.root, member: 'b-lead', task: 'own it' });
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(mgr.runId);
    await sup.waitRun(lead.runId);
    assert.equal(store.threadPosts(1).filter((p) => p.side === 'requester').length, 1);
    assert.match(results(store, lead.memberId, 'request')[0].error, /request refused: team ".*" is already in this chain/);
    assert.equal(store.threads().length, 1);
  } finally { await sup.close(); store.close(); }
});

test('A -> live B -> C -> A is refused at the last hop', async () => {
  const c = project({ 'c-lead': LIVE() }, {});
  const t = twoTeams(({ a, b }) => ({ by_member: {
    manager: { steps: [{ sleep_ms: 400 }, { tool: 'request', args: { team: b, text: 'hi', task: 'go' } }] },
    'b-lead': { steps: [{ tool: 'wait_for', args: { timeout_s: 10 } }, { tool: 'request', args: { team: realpathSync(c.root), text: 'c', task: 'go' } }] },
    'c-lead': { steps: [{ tool: 'request', args: { team: a, text: 'loop' } }] }
  } }));
  writeFileSync(c.script, readFileSync(t.a.script, 'utf8'));
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const lead = sup.submit({ projectRoot: t.b.root, member: 'b-lead', task: 'own it' });
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(mgr.runId);
    await sup.waitRun(lead.runId);
    const { run_id } = results(store, lead.memberId, 'request')[0];
    await sup.waitRun(run_id);
    const cLead = store.members(run_id)[0];
    assert.match(results(store, cLead.id, 'request')[0].error, /already in this chain/);
    assert.equal(store.threads().length, 2);
  } finally { await sup.close(); store.close(); }
});

test('a member another run entered cross-team is not a lead for threads', async () => {
  const b = project({ 'b-lead': LIVE() }, {});
  const a = project({ manager: LIVE(), loupe: { team: b.root, reports_to: 'manager' } }, {});
  const x = project({ xer: LIVE() }, {});
  const bReal = realpathSync(b.root);
  writeFileSync(a.script, JSON.stringify({ by_member: {
    manager: { steps: [{ tool: 'delegate', args: { to: 'loupe', task: 'go' }, save: 'd' },
                       { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }] },
    'b-lead': { steps: [{ sleep_ms: 1500 }] },
    xer: { steps: [{ sleep_ms: 300 }, { tool: 'request', args: { team: bReal, text: 'q', task: 't' } }] }
  } }));
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const mgr = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await new Promise((r) => setTimeout(r, 100));
    const xr = sup.submit({ projectRoot: x.root, member: 'xer', task: 'x' });
    await sup.waitRun(xr.runId);
    const r = results(store, xr.memberId, 'request')[0];
    assert.equal(typeof r.run_id, 'number');   // its own run, not the entered member
    await sup.waitRun(mgr.runId);
    await sup.waitRun(r.run_id);
  } finally { await sup.close(); store.close(); }
});

test('a request whose run cannot start leaves a declined thread and spends nothing', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [{ tool: 'request', args: { team: b, text: 'x', task: 'y' } }] }
  } }));
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const real = sup.submit.bind(sup);
    sup.submit = (p) => { if (p.threadId) throw new Error('boom'); return real(p); };
    const { runId, memberId } = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    assert.match(results(store, memberId, 'request')[0].error, /boom/);
    assert.equal(store.thread(1).state, 'declined');
    assert.equal(store.run(runId).budget, 20);
  } finally { await sup.close(); store.close(); }
});

// ---- reply, the state machine, and closing ----

// Plays A's manager (and whatever its script starts), waits for B's thread-run if there is
// one, then hands the pieces to `fn` before the store closes.
async function withTeams(script, opts, fn) {
  const t = twoTeams(script, opts);
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(mgr.runId);
    const runId = store.thread(1)?.run_id;
    if (runId) await sup.waitRun(runId);
    return await fn({ sup, store, t, mgr, bRun: runId ? store.run(runId) : null });
  } finally { await sup.close(); store.close(); }
}

const messagesOf = (store, memberId) => results(store, memberId, 'wait_for').flatMap((r) => r.messages ?? []);
const asking = (extra = {}) => ({ b }) => ({ by_member: {
  manager: { steps: [
    { tool: 'request', args: { team: b, text: 'crash on rotate', task: 'fix it' }, save: 't' },
    { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
  ] },
  ...extra
} });
const lead = (steps, more = {}) => ({ 'b-lead': { steps, ...more } });
const replyTo = (args) => ({ tool: 'reply', args: { thread: '$brief.thread.id', ...args } });

test('the receiving lead accepts, delegates, finishes, and the requester picks up the result', async () => {
  await withTeams(asking({
    ...lead([
      replyTo({ text: 'on it', state: 'accepted' }),
      { tool: 'delegate', args: { to: 'b-dev', task: 'patch' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ], { result: { status: 'ok', summary: 'fixed rotate' }, turn_cost_usd: 0.5 }),
    'b-dev': { steps: [{ say: 'patched' }] }
  }), { aDefaults: { max_delegations: 5 }, bDefaults: { max_delegations: 3 } }, ({ store, mgr, bRun }) => {
    const th = store.thread(1);
    assert.equal(th.state, 'done');
    assert.deepEqual(th.result, { status: 'ok', summary: 'fixed rotate' });
    const got = messagesOf(store, mgr.memberId);
    const accepted = got.findIndex((m) => m.thread_id === 1 && m.text.endsWith('on it'));
    const closed = got.findIndex((m) => m.thread_id === 1 && m.text === 'thread #1 done ok: fixed rotate');
    assert.ok(accepted >= 0 && closed > accepted, JSON.stringify(got));
    assert.deepEqual(store.threadPosts(1).slice(1).map((p) => [p.side, p.text, p.state]),
      [['receiver', 'on it', 'accepted'], ['receiver', 'fixed rotate', 'done']]);
    assert.equal(store.threadPosts(1)[0].side, 'requester');
    // Each side spends its own budgets: A paid for the request, B for its delegation.
    assert.equal(store.run(mgr.runId).budget, 4);
    assert.equal(bRun.budget, 2);
    assert.equal(store.run(mgr.runId).cost_usd, 0);
    assert.ok(bRun.cost_usd >= 0.5, `thread-run cost ${bRun.cost_usd}`);
    // The manager stayed alive for the close: nothing ended its wait with "no open reports".
    assert.ok(results(store, mgr.memberId, 'wait_for').every((r) => !r.note && !r.error));
  });
});

test('delegate is refused until a task thread is accepted', async () => {
  await withTeams(asking(lead([{ tool: 'delegate', args: { to: 'b-dev', task: 'patch' } }])), {}, ({ store, bRun }) => {
    const lid = store.run(bRun.id).root_member;
    assert.match(results(store, lid, 'delegate')[0].error, /accept thread #1 first/);
    assert.equal(store.children(lid).length, 0);
  });
});

test('declining notifies the requester and does not fail the lead run', async () => {
  await withTeams(asking(lead([replyTo({ text: 'not ours', state: 'declined' })])), {}, async ({ sup, store, mgr, bRun }) => {
    assert.equal(store.thread(1).state, 'declined');
    assert.ok(messagesOf(store, mgr.memberId).some((m) => m.text === 'thread #1 declined: not ours' && m.thread_id === 1));
    assert.equal(bRun.status, 'done');
  });
});

test('declining needs a reason, and a lead that finishes without accepting declines the thread', async () => {
  await withTeams(asking(lead([replyTo({ text: '', state: 'declined' })])), {}, ({ store, mgr, bRun }) => {
    const lid = bRun.root_member;
    assert.match(results(store, lid, 'reply')[0].error, /a reason/);
    assert.equal(store.thread(1).state, 'declined');
    assert.ok(messagesOf(store, mgr.memberId).some((m) => m.text === 'thread #1 declined: the lead finished without accepting'));
  });
  await withTeams(asking(lead([{ say: 'hmm' }])), {}, ({ store, mgr }) => {
    assert.equal(store.thread(1).state, 'declined');
    assert.ok(messagesOf(store, mgr.memberId).some((m) => m.text === 'thread #1 declined: the lead finished without accepting'));
  });
});

test('a question is answered with state done, or by the lead run finishing', async () => {
  const q = ({ b }) => ({ by_member: {
    manager: { steps: [
      { tool: 'request', args: { team: b, text: 'which api?' }, save: 't' },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] },
    ...lead([replyTo({ text: '42', state: 'done' })])
  } });
  await withTeams(q, {}, ({ store, mgr }) => {
    assert.equal(store.thread(1).state, 'done');
    assert.deepEqual(store.threadPosts(1).map((p) => [p.side, p.state]), [['requester', null], ['receiver', 'done']]);
    assert.ok(messagesOf(store, mgr.memberId).some((m) => m.text === 'thread #1 done ok: 42'));
  });
  const open = ({ b }) => ({ by_member: {
    manager: { steps: [
      { tool: 'request', args: { team: b, text: 'which api?' }, save: 't' },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] },
    ...lead([{ say: 'thinking' }], { result: { status: 'ok', summary: 'use v2' } })
  } });
  await withTeams(open, {}, ({ store, mgr }) => {
    assert.equal(store.thread(1).state, 'done');
    assert.deepEqual(store.thread(1).result, { status: 'ok', summary: 'use v2' });
    assert.ok(messagesOf(store, mgr.memberId).some((m) => m.text === 'thread #1 done ok: use v2'));
  });
});

test('a cancelled thread-run closes its accepted thread as failed', async () => {
  const t = twoTeams(asking(lead([replyTo({ text: 'on it', state: 'accepted' }), { sleep_ms: 20_000 }])));
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await until(() => store.thread(1)?.state === 'accepted');
    sup.cancel({ member_id: store.thread(1).owner_member });
    await sup.waitRun(mgr.runId);
    const th = store.thread(1);
    assert.equal(th.state, 'done');
    assert.equal(th.result.status, 'failed');
    assert.ok(messagesOf(store, mgr.memberId).some((m) => /^thread #1 done failed: /.test(m.text)));
    await sup.waitRun(th.run_id);
  } finally { await sup.close(); store.close(); }
});

test('illegal moves and members that are not on the thread are refused', async () => {
  const script = ({ b }) => ({ by_member: {
    manager: { steps: [
      { tool: 'request', args: { team: b, text: 'x', task: 'y' }, save: 't' },
      { tool: 'reply', args: { thread: '$t.thread_id', text: 'me too', state: 'accepted' } },
      { tool: 'reply', args: { thread: 99, text: 'x' } },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] },
    ...lead([
      replyTo({ text: 'early', state: 'done' }),
      replyTo({ text: 'on it', state: 'accepted' }),
      replyTo({ text: 'again', state: 'accepted' }),
      { tool: 'delegate', args: { to: 'b-dev', task: 'patch' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ]),
    'b-dev': { steps: [{ tool: 'reply', args: { thread: 1, text: 'hi' } }] }
  } });
  await withTeams(script, {}, ({ store, mgr, bRun }) => {
    const [early, ok, again] = results(store, bRun.root_member, 'reply');
    assert.match(early.error, /cannot move thread #1 from open to done/);
    assert.equal(ok.state, 'accepted');
    assert.match(again.error, /cannot move thread #1 from accepted to accepted/);
    const [byRequester, unknown] = results(store, mgr.memberId, 'reply');
    assert.match(byRequester.error, /only .* can change its state/);
    assert.match(unknown.error, /no thread #99/);
    const dev = store.children(bRun.root_member)[0];
    assert.match(results(store, dev.id, 'reply')[0].error, /is not on thread #1/);
  });
});

test('a question back reaches the requester, and its answer reaches the lead', async () => {
  const script = ({ b }) => ({ by_member: {
    manager: { steps: [
      { tool: 'request', args: { team: b, text: 'fix the build' }, save: 't' },
      { tool: 'wait_for', args: { timeout_s: 10 }, save: 'q' },
      { tool: 'reply', args: { thread: '$t.thread_id', text: 'pixel 8' } },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] },
    ...lead([
      replyTo({ text: 'which device?' }),
      { tool: 'wait_for', args: { timeout_s: 10 } }
    ])
  } });
  await withTeams(script, {}, ({ store, mgr, bRun }) => {
    const q = results(store, mgr.memberId, 'wait_for')[0].messages[0];
    assert.equal(q.thread_id, 1);
    assert.match(q.text, /which device\?/);
    const a = results(store, bRun.root_member, 'wait_for')[0].messages[0];
    assert.equal(a.thread_id, 1);
    assert.match(a.text, /pixel 8/);
    assert.deepEqual(store.threadPosts(1).map((p) => p.side).slice(0, 3), ['requester', 'receiver', 'requester']);
  });
});

test('when the requester has finished, its manager gets the thread traffic', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'android', task: 'ask b' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] },
      { tool: 'wait_for', args: {}, until_threads: [1] }
    ] },
    android: { steps: [{ tool: 'request', args: { team: b, text: 'q' } }, { sleep_ms: 20_000 }] },
    ...lead([{ sleep_ms: 1500 }], { result: { status: 'ok', summary: 'late' } })
  } }), { aMembers: { manager: LIVE(), android: LIVE({ reports_to: 'manager' }) } });
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await until(() => store.thread(1));
    const android = store.children(mgr.memberId)[0];
    sup.cancel({ member_id: android.id });
    await sup.waitRun(mgr.runId);
    assert.equal(store.thread(1).state, 'done');
    assert.ok(messagesOf(store, mgr.memberId).some((m) => m.text === 'thread #1 done ok: late'));
    await sup.waitRun(store.thread(1).run_id);
  } finally { await sup.close(); store.close(); }
});

test('thread traffic does not cut ask_human short', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [
      { tool: 'request', args: { team: b, text: 'x', task: 'y' } },
      { tool: 'ask_human', args: { question: 'ship it?' } }
    ] },
    ...lead([replyTo({ text: 'on it', state: 'accepted' })])
  } }), {});
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await until(() => store.thread(1)?.state === 'done' && store.openQuestions().length === 1);
    assert.equal(store.openQuestions().length, 1, 'the question is still open');
    sup.answer({ question_id: store.openQuestions()[0].id, answer: 'yes', by: 'ann' });
    await sup.waitRun(mgr.runId);
    const [ask] = results(store, mgr.memberId, 'ask_human');
    assert.equal(ask.answer, 'yes');
    assert.equal(ask.note, undefined);
  } finally { await sup.close(); store.close(); }
});

test('a live lead that accepts a task starts a run for the thread under its own budgets', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [
      { sleep_ms: 400 },
      { tool: 'request', args: { team: b, text: 'crash', task: 'fix it' }, save: 't' },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] },
    'b-lead': { steps: [
      { tool: 'wait_for', args: { timeout_s: 3 }, save: 'w' },
      { tool: 'reply', args: { thread: '$w.messages.0.thread_id', text: 'on it', state: 'accepted' } }
    ] }
  } }), {});
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const live = sup.submit({ projectRoot: t.b.root, member: 'b-lead', task: 'own it' });
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(mgr.runId);
    await sup.waitRun(live.runId);
    const th = store.thread(1);
    assert.equal(th.state, 'done');
    assert.notEqual(th.run_id, live.runId);
    const run = store.run(th.run_id);
    assert.equal(run.thread_id, 1);
    assert.equal(store.member(run.root_member).name, 'b-lead');
    assert.equal(th.owner_member, run.root_member);
    const accept = results(store, live.memberId, 'reply')[0];
    assert.equal(accept.state, 'accepted');
    assert.equal(accept.run_id, th.run_id);
    assert.match(accept.note, new RegExp(`thread #1: started run #${th.run_id}`));
    await sup.waitRun(th.run_id);
  } finally { await sup.close(); store.close(); }
});

test('a question refuses accepted and an empty answer; a closed thread refuses posts', async () => {
  const script = ({ b }) => ({ by_member: {
    manager: { steps: [
      { tool: 'request', args: { team: b, text: 'which api?' }, save: 't' },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] },
      { tool: 'reply', args: { thread: '$t.thread_id', text: 'thanks' } }
    ] },
    ...lead([
      replyTo({ text: 'on it', state: 'accepted' }),
      replyTo({ text: '  ', state: 'done' }),
      replyTo({ text: '42', state: 'done' }),
      replyTo({ text: 'one more thing' })
    ])
  } });
  await withTeams(script, {}, ({ store, mgr, bRun }) => {
    const [accepted, empty, ok, late] = results(store, bRun.root_member, 'reply');
    assert.match(accepted.error, /cannot move thread #1 from open to accepted/);
    assert.match(empty.error, /needs the answer/);
    assert.equal(ok.state, 'done');
    assert.match(late.error, /thread #1 is closed/);
    assert.match(results(store, mgr.memberId, 'reply')[0].error, /thread #1 is closed/);
    assert.equal(store.threadPosts(1).length, 2);
  });
});

test('a question delivered to a live lead is declined when that run ends unanswered', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [
      { sleep_ms: 400 },
      { tool: 'request', args: { team: b, text: 'which api?' }, save: 't' },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] },
    'b-lead': { steps: [{ tool: 'wait_for', args: { timeout_s: 3 } }], result: { status: 'ok', summary: 'unrelated work' } }
  } }), {});
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const live = sup.submit({ projectRoot: t.b.root, member: 'b-lead', task: 'own it' });
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(mgr.runId);
    await sup.waitRun(live.runId);
    assert.equal(store.thread(1).state, 'declined');
    const got = messagesOf(store, mgr.memberId).map((m) => m.text);
    assert.ok(got.includes('thread #1 declined: the lead finished without answering'), JSON.stringify(got));
    assert.ok(!got.some((x) => x.includes('unrelated work')));
  } finally { await sup.close(); store.close(); }
});

// ---- the receiving side asks back and waits ----

test('a lead with a finished report asks the requester a question and waits for the answer', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    'b-dev': { steps: [{ say: 'did it' }] },
    'b-lead': { steps: [
      { tool: 'delegate', args: { to: 'b-dev', task: 'x' }, save: 'd' },
      { tool: 'wait_for', args: { report_ids: ['$d.report_id'] }, until_finished: ['$d.report_id'] },
      { sleep_ms: 1200 },
      { tool: 'reply', args: { thread: 1, text: 'which screen?' } },
      { tool: 'wait_for', args: { timeout_s: 8 }, save: 'w' },
      { tool: 'reply', args: { thread: 1, state: 'done', text: '$w.messages.0.text' } }
    ] },
    manager: { steps: [
      { sleep_ms: 600 },
      { tool: 'request', args: { team: b, text: 'does rotate crash?' }, save: 't' },
      { tool: 'wait_for', args: { timeout_s: 10 }, save: 'q' },
      { tool: 'reply', args: { thread: '$t.thread_id', text: 'login' } },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] }
  } }));
  const { sup, store } = await supervise(t.a.script, { shared: true, stopMs: 500 });
  try {
    const live = sup.submit({ projectRoot: t.b.root, member: 'b-lead', task: 'own work' });
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(mgr.runId);
    await sup.waitRun(live.runId);
    const waits = results(store, live.memberId, 'wait_for');
    assert.ok(!waits.some((w) => w.note === 'no open reports' && w.messages.length === 0 && !w.timed_out && w === waits.at(-1)),
      JSON.stringify(waits.at(-1)));
    const th = store.thread(1);
    assert.equal(th.state, 'done');
    assert.match(th.result.summary, /login/);
    assert.ok(!store.threadPosts(1).some((p) => /without answering/.test(p.text)));
  } finally { await sup.close(); store.close(); }
});

test('a thread run that asks back and goes idle stays until the answer arrives', async () => {
  await withTeams(({ b }) => ({ by_member: {
    manager: { steps: [
      { tool: 'request', args: { team: b, text: 'what now?' }, save: 't' },
      { tool: 'wait_for', args: { timeout_s: 10 }, save: 'q' },
      { sleep_ms: 700 },   // long enough for an idle lead to be stopped, if nothing keeps it
      { tool: 'reply', args: { thread: '$t.thread_id', text: 'pixel 8' } },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] },
    ...lead([replyTo({ text: 'which device?' })], { result: { status: 'ok', summary: 'pixel 8 it is' } })
  } }), {}, ({ store, mgr }) => {
    const th = store.thread(1);
    assert.equal(th.state, 'done');
    assert.deepEqual(store.threadPosts(1).map((p) => [p.side, p.text]).slice(0, 3),
      [['requester', 'what now?'], ['receiver', 'which device?'], ['requester', 'pixel 8']]);
    assert.equal(th.result.summary, 'pixel 8 it is');
    assert.ok(messagesOf(store, mgr.memberId).some((m) => /done ok: pixel 8 it is/.test(m.text)));
  });
});

test('a thread opened from a symlinked project path is stored and found by its real path', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [{ tool: 'request', args: { team: b, text: 'hi' } }] },
    'b-lead': { steps: [{ say: 'looking' }] }
  } }));
  const link = join(mkdtempSync(join(tmpdir(), 'at-link-')), 'a-link');
  symlinkSync(t.a.root, link);
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: link, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    assert.equal(store.thread(1).from_project, t.aReal);
    assert.equal(threadsView(store, { project: link }).pairs.length, 1);
  } finally { await sup.close(); store.close(); }
});

test('an accepted thread with no run is closed failed when its lead ends, not done with an unrelated summary', async () => {
  const t = twoTeams(({ b }) => ({ by_member: {
    manager: { steps: [
      { sleep_ms: 400 },
      { tool: 'request', args: { team: b, text: 'x', task: 'do it' }, save: 't' },
      { tool: 'wait_for', args: {}, until_threads: ['$t.thread_id'] }
    ] },
    'b-lead': { steps: [{ sleep_ms: 2000 }], result: { status: 'ok', summary: 'unrelated work' } }
  } }));
  const { sup, store } = await supervise(t.a.script, { shared: true });
  try {
    const live = sup.submit({ projectRoot: t.b.root, member: 'b-lead', task: 'own it' });
    const mgr = sup.submit({ projectRoot: t.a.root, member: 'manager', task: 'ship' });
    await until(() => store.thread(1));
    // The window a crash leaves: accepted, owned by a live lead, with no run started.
    assert.ok(store.moveThread(1, 'open', 'accepted'));
    await sup.waitRun(live.runId);
    await sup.waitRun(mgr.runId);
    const th = store.thread(1);
    assert.equal(th.state, 'done');
    assert.deepEqual(th.result, { status: 'failed', summary: 'the lead finished without starting the work' });
    assert.ok(!messagesOf(store, mgr.memberId).some((m) => /unrelated work/.test(m.text)));
  } finally { await sup.close(); store.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
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
    assert.equal(store.threadPosts(1).length, 1);
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
    assert.equal(store.threadPosts(1).length, 1);   // delivery does not record a second opening post
    assert.equal(store.thread(r.thread_id).owner_member, lead.memberId);
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
    assert.equal(store.threadPosts(1).length, 1);
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

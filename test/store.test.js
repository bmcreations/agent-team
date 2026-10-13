import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('a store file is readable by its owner only: it holds member tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-store-'));
  const path = join(dir, 's.db');
  const store = openStore(path);
  store.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a 1a database is migrated in place and keeps its rows', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig-')), 's.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL,
              root_member INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE members (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, parent_id INTEGER,
              name TEXT NOT NULL, task TEXT NOT NULL, depth INTEGER NOT NULL, state TEXT NOT NULL,
              token TEXT NOT NULL UNIQUE, harness_id TEXT, workspace TEXT, result TEXT,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            INSERT INTO runs VALUES (1, '/p', 'old run', NULL, 'running', 0);`);
  old.close();
  const store = openStore(path);
  assert.equal(store.run(1).task, 'old run');
  assert.equal(store.run(1).cost_usd, 0);
  const lead = store.addMember({ runId: 1, parentId: null, name: 'lead', task: 't', depth: 0 });
  store.setResume(lead.id, 'sid-1');
  assert.equal(store.member(lead.id).resume, 'sid-1');
  store.close();
  openStore(path).close();   // a second open finds the migrations applied and does nothing
});

test('run cost accumulates and run limits are stored', () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't', timeoutMs: 5000, budget: 7, maxCostUsd: 2 });
  assert.equal(store.run(runId).timeout_ms, 5000);
  assert.equal(store.run(runId).budget, 7);
  assert.equal(store.run(runId).max_cost_usd, 2);
  store.setBudget(runId, 6);
  assert.equal(store.run(runId).budget, 6);
  store.setRunCap(runId, 3.5);
  assert.equal(store.run(runId).max_cost_usd, 3.5);
  assert.equal(store.addRunCost(runId, 0.25), 0.25);
  assert.equal(store.addRunCost(runId, 0.5), 0.75);
});

test('a member\'s spend is kept on its row as well as the run\'s', () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't' });
  const a = store.addMember({ runId, parentId: null, name: 'a', task: 't', depth: 0 });
  const b = store.addMember({ runId, parentId: a.id, name: 'b', task: 't', depth: 1 });
  assert.equal(store.member(a.id).cost_usd, 0);
  assert.equal(store.addRunCost(runId, 0.25, a.id), 0.25);
  assert.equal(store.addRunCost(runId, 0.5, b.id), 0.75);
  assert.equal(store.addRunCost(runId, 0.5, a.id), 1.25);
  assert.equal(store.member(a.id).cost_usd, 0.75);
  assert.equal(store.member(b.id).cost_usd, 0.5);
});

test('membersInStates finds members across runs', () => {
  const store = openStore(':memory:');
  const r1 = store.createRun({ project: '/a', task: 't' });
  const r2 = store.createRun({ project: '/b', task: 't' });
  const a = store.addMember({ runId: r1, parentId: null, name: 'a', task: 't', depth: 0 });
  const b = store.addMember({ runId: r2, parentId: null, name: 'b', task: 't', depth: 0 });
  store.setState(a.id, 'running');
  store.setState(b.id, 'waiting');
  assert.deepEqual(store.membersInStates(['running', 'waiting']).map((m) => m.name), ['a', 'b']);
  assert.deepEqual(store.membersInStates(['paused']), []);
});

test('claimForQuestion takes human and manager messages and leaves report messages queued', () => {
  const { store, lead } = seeded();
  const human = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'b', text: 'h' });
  const report = store.enqueue({ to: lead.id, fromKind: 'report', fromName: 'r', reportId: 99, text: 'progress: x' });
  assert.deepEqual(store.claimForQuestion(lead.id).map((m) => m.id), [human]);
  assert.equal(store.message(human).state, 'delivered');
  assert.equal(store.message(report).state, 'queued');
});

test('runs record their owner, and recovery queries find running runs and offered messages', () => {
  const { store, runId, lead } = seeded();
  store.setRunOwner(runId, '/tmp/a.sock');
  assert.equal(store.run(runId).owner, '/tmp/a.sock');
  assert.deepEqual(store.runsWithStatus('running').map((r) => r.id), [runId]);
  store.finishRun(runId, 'done');
  assert.deepEqual(store.runsWithStatus('running'), []);
  const a = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'b', text: 'a' });
  store.offerQueued(lead.id);
  store.requeueOffered(lead.id);
  assert.equal(store.message(a).state, 'queued');
});

test('a version 3 database gains token columns at 0, and reopening changes nothing', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig4-')), 's.db');
  const first = openStore(path);
  const runId = first.createRun({ project: '/p', task: 't' });
  const lead = first.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  first.close();
  const raw = new DatabaseSync(path);   // rewind to version 3: no token columns
  raw.exec('ALTER TABLE members DROP COLUMN project; ALTER TABLE members DROP COLUMN alias; ' +
           'ALTER TABLE members DROP COLUMN scope_budget; ' +
           'ALTER TABLE members DROP COLUMN tokens; ALTER TABLE runs DROP COLUMN tokens; ' +
           'ALTER TABLE members DROP COLUMN agent; ALTER TABLE members DROP COLUMN model; ' +
           'ALTER TABLE members DROP COLUMN read_only; PRAGMA user_version = 3');
  raw.close();
  const store = openStore(path);
  assert.equal(store.member(lead.id).tokens, 0);
  assert.equal(store.run(runId).tokens, 0);
  store.addTokens(runId, lead.id, 7);
  store.addTokens(runId, lead.id, 5);
  assert.equal(store.member(lead.id).tokens, 12);
  assert.equal(store.run(runId).tokens, 12);
  store.close();
  const again = openStore(path);
  assert.equal(again.run(runId).tokens, 12);
  again.close();
});

test('a version 4 database gains agent, model and read_only, unset', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig5-')), 's.db');
  const first = openStore(path);
  const runId = first.createRun({ project: '/p', task: 't' });
  const lead = first.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec('ALTER TABLE members DROP COLUMN project; ALTER TABLE members DROP COLUMN alias; ' +
           'ALTER TABLE members DROP COLUMN scope_budget; ' +
           'ALTER TABLE members DROP COLUMN agent; ALTER TABLE members DROP COLUMN model; ' +
           'ALTER TABLE members DROP COLUMN read_only; PRAGMA user_version = 4');
  raw.close();
  const store = openStore(path);
  assert.equal(store.member(lead.id).agent, null);
  store.setHarnessInfo(lead.id, { agent: 'codex', model: 'gpt-5.5', readOnly: true });
  const m = store.member(lead.id);
  assert.deepEqual([m.agent, m.model, m.read_only], ['codex', 'gpt-5.5', 1]);
  store.close();
});

test('the timeline pages forward from a cursor and backward from the newest', () => {
  const { store, runId, lead } = seeded();
  const other = store.createRun({ project: '/q', task: 'x' });
  const stranger = store.addMember({ runId: other, parentId: null, name: 'x', task: 'x', depth: 0 });
  for (let i = 1; i <= 5; i++) store.addEvent(lead.id, 'text', { text: `t${i}` });
  store.addEvent(stranger.id, 'text', { text: 'elsewhere' });
  store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'b', text: 'hi' });

  const top = store.maxIds();
  assert.deepEqual(top, { event: 6, message: 1 });
  const tail = store.timeline({ runId, beforeEvent: top.event + 1, beforeMessage: top.message + 1, limit: 2 });
  assert.deepEqual(tail.events.map((e) => e.body.text), ['t4', 't5']);
  assert.equal(tail.events[0].member, 'lead');
  assert.equal(tail.events[0].run_id, runId);
  assert.equal(tail.messages[0].to_name, 'lead');

  const after = store.timeline({ runId, afterEvent: 2, limit: 10 });
  assert.deepEqual(after.events.map((e) => e.body.text), ['t3', 't4', 't5']);
  assert.equal(store.timeline({ afterEvent: 5 }).events[0].body.text, 'elsewhere');   // every run
  assert.equal(store.timeline({ memberId: stranger.id }).events.length, 1);
});

test('version changes on a write from this connection and from another', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-ver-')), 's.db');
  const a = openStore(path);
  const b = openStore(path);
  const v0 = a.version();
  a.createRun({ project: '/p', task: 't' });
  const v1 = a.version();
  assert.notEqual(v1, v0);
  b.createRun({ project: '/p', task: 'u' });
  assert.notEqual(a.version(), v1);
  assert.equal(a.version(), a.version());
  a.close();
  b.close();
});

test('runs list newest first, by project; a member span runs from its first event to finished', () => {
  const { store, runId, lead } = seeded();
  store.createRun({ project: '/q', task: 'other' });
  assert.deepEqual(store.listRuns({ project: '/p' }).map((r) => r.id), [runId]);
  assert.equal(store.listRuns().length, 2);
  assert.equal(store.listRuns({ limit: -1 }).length, 2);
  assert.deepEqual(store.memberSpan(lead.id), { started: null, finished: null });
  store.addEvent(lead.id, 'started', {});
  store.addEvent(lead.id, 'finished', { status: 'ok', state: 'done' });
  const span = store.memberSpan(lead.id);
  assert.ok(span.started <= span.finished);
  assert.equal(store.lastEvent(lead.id).kind, 'finished');
  assert.equal(store.event(store.lastEvent(lead.id).id).body.state, 'done');
});

test('a version 5 database gains project, alias and scope_budget, unset', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig6-')), 's.db');
  const first = openStore(path);
  const runId = first.createRun({ project: '/a', task: 't' });
  const lead = first.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec('ALTER TABLE members DROP COLUMN project; ALTER TABLE members DROP COLUMN alias; ' +
           'ALTER TABLE members DROP COLUMN scope_budget; PRAGMA user_version = 5');
  raw.close();
  const store = openStore(path);
  const m = store.member(lead.id);
  assert.deepEqual([m.project, m.alias, m.scope_budget], [null, null, null]);
  store.close();
});

test('an entry member records its project, alias and budget; projects and liveMembersIn see it', () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/a', task: 't' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  const entry = store.addMember({ runId, parentId: lead.id, name: 'lead', task: 'fix', depth: 0,
                                  project: '/b', alias: 'loupe', scopeBudget: 3 });
  const below = store.addMember({ runId, parentId: entry.id, name: 'dev', task: 'x', depth: 1 });
  store.setScopeBudget(entry.id, 2);
  const e = store.member(entry.id);
  assert.deepEqual([e.project, e.alias, e.scope_budget], ['/b', 'loupe', 2]);
  assert.deepEqual(store.projects(), ['/a', '/b']);
  // `dev` has no project of its own: liveMembersIn('/b') matches members by their own column
  // only, so a scope's descendants are found by walking parent_id (the supervisor does that).
  assert.deepEqual(store.liveMembersIn('/b').map((m) => m.id), [entry.id]);
  assert.deepEqual(store.liveMembersIn('/a').map((m) => m.id), [lead.id, below.id]);
  store.finishRun(runId, 'done');
  assert.deepEqual(store.liveMembersIn('/a'), []);
  store.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { teamStatus } from '../src/view.js';
import { project, LIVE } from './helpers/live.js';
import { get, view } from './helpers/http.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

function seeded() {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 'ship it', owner: '/elsewhere.sock' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 'ship it', depth: 0 });
  store.setRunRoot(runId, lead.id);
  store.setState(lead.id, 'running');
  return { store, runId, lead };
}

test('runs and a run\'s members come back without member tokens', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'hello' }], result: { status: 'ok', summary: 'done it' } } }
  });
  const v = await view(script);
  try {
    const { runId, memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await v.sup.waitRun(runId);
    const runs = await get(v.base, '/api/runs');
    assert.equal(runs.status, 200);
    assert.equal(runs.json.runs[0].id, runId);
    assert.equal(runs.json.runs[0].root, 'solo');
    assert.equal(runs.json.runs[0].status, 'done');
    assert.equal(runs.json.runs[0].steerable, false);   // finished: nothing to steer

    const detail = await get(v.base, `/api/runs/${runId}`);
    const m = detail.json.members[0];
    assert.equal(m.id, memberId);
    assert.equal(m.agent, 'mock-live');
    assert.equal(m.read_only, true);
    assert.deepEqual(m.result, { status: 'ok', summary: 'done it' });
    assert.equal(m.attach, `agent-team attach ${runId} solo`);
    assert.deepEqual(detail.json.deny_paths, ['**/.env*']);
    assert.ok(!('token' in m) && !('resume' in m));
    assert.ok(!detail.text.includes(v.store.member(memberId).token));
  } finally { await v.close(); }
});

test('run listings and details carry the run title, null until one is set', async () => {
  const { store, runId } = seeded();
  const web = await startHttp({ store, port: 0 });
  try {
    assert.equal((await get(web.url, '/api/runs')).json.runs[0].title, null);
    store.setRunTitle(runId, 'Ship the thing', 'agent');
    assert.equal((await get(web.url, '/api/runs')).json.runs[0].title, 'Ship the thing');
    assert.equal((await get(web.url, `/api/runs/${runId}`)).json.run.title, 'Ship the thing');
  } finally { await web.close(); store.close(); }
});

test('a member entered into another project carries project and alias, and that project\'s deny_paths', async () => {
  const { store, runId, lead } = seeded();
  const { root } = project({ solo: LIVE() }, { by_member: {} });
  const cfg = join(root, '.claude', 'agent-team.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), deny_paths: ['secret/**'] }));
  const m = store.addMember({ runId, parentId: lead.id, name: 'b-lead', task: 'x', depth: 1, project: root, alias: 'loupe', scopeBudget: 3 });
  const web = await startHttp({ store, port: 0 });
  try {
    const detail = await get(web.url, `/api/runs/${runId}`);
    const got = detail.json.members.find((x) => x.id === m.id);
    assert.equal(got.project, root);
    assert.equal(got.alias, 'loupe');
    assert.ok(!('scope_budget' in got));
    assert.equal(detail.json.members.find((x) => x.id === lead.id).project, null);
    assert.deepEqual(detail.json.deny_paths_by_project, { [root]: ['secret/**'] });
  } finally { await web.close(); }
});

test('the timeline returns a tail with a cursor, pages after it, and clips huge bodies', async () => {
  const { store, runId, lead } = seeded();
  for (let i = 1; i <= 3; i++) store.addEvent(lead.id, 'text', { text: `t${i}` });
  store.addEvent(lead.id, 'tool_result', { name: 'Read', text: 'x'.repeat(10_000) });
  const web = await startHttp({ store, port: 0 });
  try {
    const tail = await get(web.url, `/api/runs/${runId}/timeline?limit=2`);
    assert.deepEqual(tail.json.events.map((e) => e.kind), ['text', 'tool_result']);
    assert.deepEqual(tail.json.cursor, { event: 4, message: 0 });
    const big = tail.json.events[1];
    assert.equal(big.body.clipped, true);
    assert.equal(big.body.text.length, 4001);   // 4000 characters and an ellipsis
    const full = await get(web.url, `/api/events/${big.id}`);
    assert.equal(full.json.body.text.length, 10_000);
    const after = await get(web.url, `/api/runs/${runId}/timeline?after_event=1`);
    assert.deepEqual(after.json.events.map((e) => e.id), [2, 3, 4]);
    const member = await get(web.url, `/api/members/${lead.id}/timeline?after_event=0`);
    assert.equal(member.json.events.length, 4);
    const all = await get(web.url, '/api/timeline?after_event=3');
    assert.deepEqual(all.json.events.map((e) => e.id), [4]);
  } finally { await web.close(); store.close(); }
});

test('needs-you lists open questions, stalled members and runs paused by the cost cap', async () => {
  const { store, runId, lead } = seeded();
  const qid = store.addQuestion({ memberId: lead.id, question: 'tabs or spaces?', options: ['tabs', 'spaces'] });
  store.addEvent(lead.id, 'stalled', { quiet_s: 600 });
  const capped = store.createRun({ project: '/p', task: 'spend' });
  const boss = store.addMember({ runId: capped, parentId: null, name: 'boss', task: 'spend', depth: 0 });
  store.setRunRoot(capped, boss.id);
  store.setState(boss.id, 'paused');
  store.addEvent(boss.id, 'cost_cap', { cost_usd: 5.2, max_cost_usd: 5 });
  const web = await startHttp({ store, port: 0 });
  try {
    const { json } = await get(web.url, '/api/needs-you');
    assert.deepEqual(json.questions.map((q) => [q.id, q.run_id, q.member, q.options]),
                     [[qid, runId, 'lead', ['tabs', 'spaces']]]);
    assert.deepEqual(json.stalled.map((s) => [s.member, s.quiet_s]), [['lead', 600]]);
    assert.deepEqual(json.cost_capped.map((c) => [c.run_id, c.member, c.cost_usd, c.max_cost_usd]),
                     [[capped, 'boss', 5.2, 5]]);
  } finally { await web.close(); store.close(); }
});

test('a run another supervisor owns reads as running but not steerable', async () => {
  const { store, runId } = seeded();
  const web = await startHttp({ store, sup: { socketPath: '/mine.sock' }, port: 0 });
  try {
    const { json } = await get(web.url, `/api/runs/${runId}`);
    assert.equal(json.run.status, 'running');
    assert.equal(json.run.steerable, false);
    assert.match(json.run.read_only_note, /agent-team serve/);
  } finally { await web.close(); store.close(); }
});

test('a request naming another host is refused, so a rebound DNS name cannot read the API', async () => {
  const { store } = seeded();
  const web = await startHttp({ store, port: 0 });
  try {
    const refused = await get(web.url, '/api/runs', { Host: `evil.example:${web.port}` });
    assert.equal(refused.status, 403);
    assert.equal((await get(web.url, '/api/runs', { Host: `localhost:${web.port}` })).status, 200);
  } finally { await web.close(); store.close(); }
});

test('bad ids, unknown paths and wrong methods get JSON errors', async () => {
  const { store } = seeded();
  const web = await startHttp({ store, port: 0 });
  try {
    assert.equal((await get(web.url, '/api/runs/999')).status, 404);
    assert.equal((await get(web.url, '/api/nope')).status, 404);
    assert.equal((await get(web.url, '/api/runs?limit=-1')).status, 400);
    const r = await get(web.url, '/api/runs');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  } finally { await web.close(); store.close(); }
});

test('a port already in use is reported with what to do about it', async () => {
  const busy = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => busy.once('listening', r));
  const port = busy.address().port;
  const store = openStore(':memory:');
  try {
    await assert.rejects(startHttp({ store, port }), (err) => {
      assert.equal(err.code, 'EADDRINUSE');
      assert.match(err.message, new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already in use; pass --port`));
      return true;
    });
    const dir = mkdtempSync(join(tmpdir(), 'at-sv-'));
    const r = await promisify(execFile)(process.execPath, [BIN, 'serve', '--port', String(port)], {
      env: { ...process.env, AGENT_TEAM_SUPERVISOR_SOCK: join(dir, 's.sock'), AGENT_TEAM_SUPERVISOR_DB: join(dir, 's.db') },
      timeout: 15_000
    }).then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code, stderr: e.stderr }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use; pass --port/);
  } finally { busy.close(); store.close(); }
});

test('/api/teams lists the known teams; /api/teams/status serves only known ones', async () => {
  const bProj = project({ lead: LIVE() }, { by_member: {} });
  const aProj = project({ solo: LIVE() }, { by_member: {} });
  const cfgFile = join(aProj.root, '.claude', 'agent-team.json');
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), peers: [bProj.root] }));
  const store = openStore(':memory:');
  const runId = store.createRun({ project: aProj.root, task: 'a work' });
  store.addMember({ runId, parentId: null, name: 'solo', task: 't', depth: 0 });
  const bRun = store.createRun({ project: bProj.root, task: 'b work' });
  const bLead = store.addMember({ runId: bRun, parentId: null, name: 'lead', task: 't', depth: 0 });
  store.addEvent(bLead.id, 'progress', { text: 'checkpoint' });
  const web = await startHttp({ store, port: 0 });
  try {
    const teams = await get(web.url, `/api/teams?project=${encodeURIComponent(aProj.root)}`);
    assert.equal(teams.status, 200);
    assert.ok(teams.json.teams.some((t) => t.root === realpathSync(bProj.root) && t.source === 'peer'));
    assert.equal((await get(web.url, '/api/teams?project=/not/known')).status, 404);

    const st = await get(web.url, `/api/teams/status?root=${encodeURIComponent(realpathSync(bProj.root))}`);
    assert.equal(st.status, 200);
    assert.deepEqual(st.json, teamStatus(store, st.json.team));
    assert.equal(st.json.team.source, 'peer');
    assert.equal(st.json.runs[0].members[0].checkpoint.text, 'checkpoint');
    assert.equal((await get(web.url, '/api/teams/status?root=/not/known')).status, 404);
  } finally { await web.close(); }
});

function seededThreads() {
  const store = openStore(':memory:');
  const run = store.createRun({ project: '/a', task: 't', owner: '/elsewhere.sock' });
  const m = store.addMember({ runId: run, parentId: null, name: 'mgr', task: 't', depth: 0 });
  const open = (toProject, text, task = null, chain = ['/secret/path']) => store.addThread({
    kind: task ? 'task' : 'question', fromProject: '/a', fromRun: run, fromMember: m.id,
    toProject, toMember: 'lead', chain, text, task
  });
  const t1 = open('/b', 'first', 'fix the bug');
  const t2 = open('/b', 'second');
  const t3 = open('/c', 'third', 'other');
  store.addThreadPost({ threadId: t1, side: 'receiver', author: 'lead', text: 'on it' });
  store.moveThread(t1, 'open', 'accepted');
  store.moveThread(t1, 'accepted', 'done', { result: { status: 'ok', summary: 'fixed', secret: '/secret/path' } });
  return { store, t1, t2, t3 };
}

test('threads group by team pair, newest pair first, with no chain and only allowlisted post fields', async () => {
  const { store } = seededThreads();
  const web = await startHttp({ store, port: 0 });
  try {
    const all = await get(web.url, '/api/threads');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.pairs.map((p) => p.pair), ['a → c', 'a → b']);
    assert.deepEqual(all.json.pairs[1].threads.map((t) => t.id), [2, 1]);
    for (const p of all.json.pairs) for (const t of p.threads) assert.equal('chain' in t, false);
    assert.equal(all.text.includes('/secret/path'), false);
    assert.deepEqual(all.json.pairs[1].threads[1].result, { status: 'ok', summary: 'fixed' });
    assert.deepEqual(all.json.pairs[1].threads[1].from_member.name, 'mgr');

    const one = await get(web.url, '/api/threads?project=/c');
    assert.deepEqual(one.json.pairs.map((p) => p.pair), ['a → c']);

    const detail = await get(web.url, '/api/threads/1');
    assert.equal(detail.status, 200);
    assert.equal(detail.text.includes('/secret/path'), false);
    assert.deepEqual(detail.json.posts.map((p) => p.author), ['mgr', 'lead']);
    for (const p of detail.json.posts) assert.deepEqual(Object.keys(p), ['id', 'side', 'author', 'text', 'state', 'at']);
    assert.equal((await get(web.url, '/api/threads/99')).status, 404);
  } finally { await web.close(); store.close(); }
});

test('a thread exposes the run of the lead that owns it', async () => {
  const { store, t2 } = seededThreads();
  const run = store.createRun({ project: '/b', task: 'own work' });
  const lead = store.addMember({ runId: run, parentId: null, name: 'lead', task: 't', depth: 0 });
  store.setThreadOwner(t2, lead.id ?? lead.memberId ?? lead);
  const web = await startHttp({ store, port: 0 });
  try {
    const d = (await get(web.url, `/api/threads/${t2}`)).json.thread;
    assert.deepEqual(d.owner, { id: lead.id ?? lead.memberId ?? lead, name: 'lead', run_id: run });
    assert.equal((await get(web.url, '/api/threads/3')).json.thread.owner, null);
  } finally { await web.close(); store.close(); }
});

test('thread text is clipped in the view and kept whole in the store', async () => {
  const { store, t1 } = seededThreads();
  const long = 'x'.repeat(10_000);
  store.addThreadPost({ threadId: t1, side: 'receiver', author: 'lead', text: long });
  const web = await startHttp({ store, port: 0 });
  try {
    const posts = (await get(web.url, '/api/threads/1')).json.posts;
    assert.ok(posts.at(-1).text.length < 5000);
    assert.equal(store.threadPosts(t1).at(-1).text.length, 10_000);
  } finally { await web.close(); store.close(); }
});

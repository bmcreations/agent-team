import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { project, supervise, LIVE } from './helpers/live.js';
import { call, get, post, until, view } from './helpers/http.js';

const LONG = { steps: [{ say: 'working' }, { sleep_ms: 30_000 }], on_resume: { steps: [{ say: 'back' }] } };

test('a message from the page lands in the member\'s inbox, signed by the serve user', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script, { http: { by: 'tester' } });
  try {
    const { memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const r = await post(v.base, `/api/members/${memberId}/message`, { text: 'use tabs' });
    assert.equal(r.status, 200);
    const msg = v.store.timeline({ memberId }).messages.find((m) => m.id === r.json.message_id);
    assert.deepEqual([msg.from_kind, msg.from_name, msg.text], ['human', 'tester', 'use tabs']);
  } finally { await v.close(); }
});

test('pause now, resume with a note, then cancel, all from the page', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script, { http: { by: 'tester' } });
  try {
    const { memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => v.store.events(memberId).some((e) => e.kind === 'text'));
    const paused = await post(v.base, `/api/members/${memberId}/pause`, { now: true });
    assert.deepEqual(paused.json, { members: [{ id: memberId, name: 'solo' }], skipped: [] });
    await until(() => v.store.member(memberId).state === 'paused');
    assert.equal(v.store.events(memberId).find((e) => e.kind === 'paused').body.by, 'tester');
    assert.equal((await post(v.base, `/api/members/${memberId}/resume`, { note: 'carry on' })).status, 200);
    await until(() => v.store.events(memberId).some((e) => e.kind === 'text' && e.body.text === 'back'));
  } finally { await v.close(); }
});

test('cancel from the page ends the member as cancelled', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script);
  try {
    const { runId, memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => v.store.events(memberId).some((e) => e.kind === 'text'));
    assert.equal((await post(v.base, `/api/members/${memberId}/cancel`, { subtree: true })).status, 200);
    await v.sup.waitRun(runId);
    assert.equal(v.store.member(memberId).state, 'cancelled');
    const late = await post(v.base, `/api/members/${memberId}/message`, { text: 'too late' });
    assert.equal(late.status, 409);
    assert.match(late.json.error, /has finished/);
  } finally { await v.close(); }
});

test('an ask_human question is answered from the page', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'Ship it?', options: ['yes', 'no'] } }] } }
  });
  const v = await view(script, { http: { by: 'tester' } });
  try {
    const { runId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    let q;
    await until(async () => { [q] = (await get(v.base, '/api/needs-you')).json.questions; return q; });
    assert.equal((await post(v.base, `/api/questions/${q.id}/answer`, { answer: 'yes' })).status, 200);
    const result = await v.sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result, { answer: 'yes', answered_by: 'tester', timed_out: false });
    assert.equal((await post(v.base, `/api/questions/${q.id}/answer`, { answer: 'no' })).status, 409);
  } finally { await v.close(); }
});

test('a run another supervisor owns is read-only from the page', async () => {
  const { script } = project({ solo: LIVE() }, { by_member: {} });
  const v = await view(script);
  try {
    const runId = v.store.createRun({ project: '/p', task: 't', owner: '/elsewhere.sock' });
    const lead = v.store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
    v.store.setRunRoot(runId, lead.id);
    v.store.setState(lead.id, 'running');
    for (const action of ['pause', 'cancel', 'resume']) {
      const r = await post(v.base, `/api/members/${lead.id}/${action}`, {});
      assert.equal(r.status, 409, action);
      assert.match(r.json.error, /^read-only: started without `agent-team serve`/);
    }
  } finally { await v.close(); }
});

test('with no supervisor, steering says it needs serve', async () => {
  const store = openStore(':memory:');
  const web = await startHttp({ store, port: 0 });
  try {
    const r = await post(web.url, '/api/members/1/pause', {});
    assert.equal(r.status, 503);
    assert.match(r.json.error, /agent-team serve/);
  } finally { await web.close(); store.close(); }
});

test('cross-site and malformed requests cannot steer', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script);
  try {
    const { memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const path = `/api/members/${memberId}/pause`;
    // A form post or no-cors fetch from another site cannot set application/json.
    assert.equal((await call(v.base, 'POST', path, { body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await post(v.base, path, {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(v.base, path, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post(v.base, path, {}, { Origin: `http://127.0.0.1:${v.web.port}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    // A preflight gets no CORS headers, so a browser never sends the real request.
    const pre = await call(v.base, 'OPTIONS', path, { headers: { Origin: 'https://evil.example' } });
    assert.equal(pre.status, 405);
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
    const msg = `/api/members/${memberId}/message`;
    assert.equal((await call(v.base, 'POST', msg, { body: '{"text":', headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal((await post(v.base, msg, { text: '   ' })).status, 400);
    assert.equal((await post(v.base, msg, { text: 'x'.repeat(70_000) })).status, 413);
    assert.equal((await post(v.base, `/api/members/${memberId}/resume`, { max_cost_usd: 'lots' })).status, 400);
    assert.equal((await post(v.base, '/api/members/999/pause', {})).status, 404);
    assert.equal(v.store.member(memberId).state !== 'cancelled', true);
  } finally { await v.close(); }
});

// Team A's manager opens a task thread with team B's lead; both then wait.
function threadPair() {
  const b = project({ 'b-lead': LIVE() }, {});
  const a = project({ manager: LIVE() }, {});
  const bReal = realpathSync(b.root);
  const body = JSON.stringify({ by_member: {
    manager: { steps: [{ tool: 'request', args: { team: bReal, text: 'crash on rotate', task: 'fix it' } }, { sleep_ms: 30_000 }] },
    'b-lead': { steps: [{ sleep_ms: 30_000 }] }
  } });
  writeFileSync(a.script, body);
  writeFileSync(b.script, body);
  return { a, b };
}

test('a human reply from the page reaches both sides and leaves the thread state alone', async () => {
  const { a } = threadPair();
  const v = await view(a.script, { shared: true, http: { by: 'tester' } });
  try {
    const { memberId } = v.sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await until(() => v.store.thread(1)?.owner_member != null);
    const t = v.store.thread(1);
    const r = await post(v.base, '/api/threads/1/reply', { text: 'try rebooting' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { thread_id: 1, state: 'open' });
    assert.equal(v.store.thread(1).state, 'open');
    for (const id of [memberId, t.owner_member]) {
      const msg = v.store.timeline({ memberId: id }).messages.find((m) => m.text === '[thread #1] try rebooting');
      assert.ok(msg, `member ${id} got it`);
      assert.deepEqual([msg.from_kind, msg.from_name, msg.thread_id], ['human', 'tester', 1]);
    }
    const post1 = v.store.threadPosts(1).at(-1);
    assert.deepEqual([post1.side, post1.author, post1.state], ['human', 'tester', null]);

    assert.equal((await post(v.base, '/api/threads/1/reply', { text: '   ' })).status, 400);
    assert.equal((await post(v.base, '/api/threads/1/reply', {})).status, 400);
    const withState = await post(v.base, '/api/threads/1/reply', { text: 'decline it', state: 'declined' });
    assert.equal(withState.status, 400);
    assert.match(withState.json.error, /humans cannot change a thread's state/);
    assert.equal(v.store.thread(1).state, 'open');
    assert.equal((await post(v.base, '/api/threads/99/reply', { text: 'hi' })).status, 404);
    assert.equal((await post(v.base, '/api/threads/1/reply', { text: 'hi' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(v.base, '/api/threads/1/reply', { text: 'hi' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call(v.base, 'POST', '/api/threads/1/reply', { body: '{"text":"x"}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal(v.store.threadPosts(1).filter((p) => p.side === 'human').length, 1);
  } finally { await v.close(); }
});

test('a human cannot reply to a closed thread', async () => {
  const { a } = threadPair();
  const v = await view(a.script, { shared: true });
  try {
    v.sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await until(() => v.store.thread(1)?.owner_member != null);
    v.store.moveThread(1, 'open', 'declined', { result: { reason: 'no' } });
    const r = await post(v.base, '/api/threads/1/reply', { text: 'late' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /thread #1 is declined/);
    assert.equal(v.store.threadPosts(1).some((p) => p.side === 'human'), false);
  } finally { await v.close(); }
});

test('a human reply with no supervisor needs serve', async () => {
  const store = openStore(':memory:');
  const web = await startHttp({ store, port: 0 });
  try {
    assert.equal((await post(web.url, '/api/threads/1/reply', { text: 'hi' })).status, 503);
  } finally { await web.close(); store.close(); }
});

test('a human reply to a thread whose runs another supervisor owns is refused and stores nothing', async () => {
  const { a } = threadPair();
  const v = await view(a.script, { shared: true });
  try {
    const run = v.store.createRun({ project: '/a', task: 't', owner: '/elsewhere.sock' });
    const m = v.store.addMember({ runId: run, parentId: null, name: 'mgr', task: 't', depth: 0 });
    v.store.setRunRoot(run, m.id);
    v.store.setState(m.id, 'running');
    const id = v.store.addThread({ kind: 'question', fromProject: '/a', fromRun: run, fromMember: m.id,
      toProject: '/b', toMember: 'lead', chain: ['/a'], text: 'q' });
    const before = v.store.threadPosts(id).length;
    const r = await post(v.base, `/api/threads/${id}/reply`, { text: 'hello' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /^read-only: /);
    assert.equal(v.store.threadPosts(id).length, before);
  } finally { await v.close(); }
});

test('a run is renamed from the page, cleared, and refused cross-site', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script, { http: { by: 'tester' } });
  try {
    const { runId, memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const path = `/api/runs/${runId}/title`;
    const set = await post(v.base, path, { title: '  Jump   button  design ' });
    assert.equal(set.status, 200);
    assert.deepEqual(set.json, { title: 'Jump button design' });
    assert.deepEqual([v.store.run(runId).title, v.store.run(runId).title_by], ['Jump button design', 'human']);
    assert.deepEqual(v.store.events(memberId).findLast((e) => e.kind === 'titled').body, { title: 'Jump button design', by: 'human' });
    assert.equal((await get(v.base, `/api/runs/${runId}`)).json.run.title, 'Jump button design');
    await post(v.base, path, { title: 'x'.repeat(200) });
    assert.equal(v.store.run(runId).title.length, 80);
    const cleared = await post(v.base, path, { title: '   ' });
    assert.deepEqual(cleared.json, { title: null });
    assert.deepEqual([v.store.run(runId).title, v.store.run(runId).title_by], [null, null]);
    assert.equal((await post(v.base, path, { title: 'Nope' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(v.base, path, { title: 'Nope' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call(v.base, 'POST', path, { body: '{"title":"x"}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await post(v.base, path, { title: 5 })).status, 400);
    assert.equal((await post(v.base, '/api/runs/999/title', { title: 'x' })).status, 404);
    assert.equal(v.store.run(runId).title, null);
  } finally { await v.close(); }
});

test('a finished run can still be renamed', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script, { http: { by: 'tester' } });
  try {
    const { runId, memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    v.sup.cancel({ member_id: memberId, by: 'tester' });
    for (let i = 0; i < 200 && v.store.run(runId).status === 'running'; i++) await new Promise((r) => setTimeout(r, 25));
    assert.notEqual(v.store.run(runId).status, 'running');
    assert.equal((await post(v.base, `/api/runs/${runId}/title`, { title: 'Old run' })).status, 200);
    assert.deepEqual([v.store.run(runId).title, v.store.run(runId).title_by], ['Old run', 'human']);
  } finally { await v.close(); }
});

test('renaming needs a supervisor', async () => {
  const { script } = project({ solo: LIVE() }, {});
  const v = await view(script, { http: { sup: null } });
  try { assert.equal((await post(v.base, '/api/runs/1/title', { title: 'x' })).status, 503); } finally { await v.close(); }
});

test('set_title is refused once a person renamed the run from the page', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'ready' }, { sleep_ms: 800 }, { tool: 'set_title', args: { title: 'Agent name' } }], result: { status: 'ok', summary: 'x' } } }
  });
  const v = await view(script);
  try {
    const { runId, memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => v.store.events(memberId).some((e) => e.kind === 'text'));
    assert.equal((await post(v.base, `/api/runs/${runId}/title`, { title: 'Human name' })).status, 200);
    await v.sup.waitRun(runId);
    assert.equal(v.store.run(runId).title, 'Human name');
    const res = v.store.member(memberId).result.tool_results.find((t) => t.tool === 'set_title').result;
    assert.equal(res.ok, false);
  } finally { await v.close(); }
});

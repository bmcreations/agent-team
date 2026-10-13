import { test } from 'node:test';
import assert from 'node:assert/strict';
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { project, LIVE } from './helpers/live.js';
import { get, stream, until, view } from './helpers/http.js';

function seeded(path = ':memory:') {
  const store = openStore(path);
  const runId = store.createRun({ project: '/p', task: 'ship it' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 'ship it', depth: 0 });
  store.setRunRoot(runId, lead.id);
  store.setState(lead.id, 'running');
  return { store, runId, lead };
}
const timeline = (f) => f.event === 'timeline';
const hasEvent = (text) => (f) => timeline(f) && f.data.events.some((e) => e.body.text === text);

test('a stream sends state at once, then events and messages after its cursor', async () => {
  const { store, runId, lead } = seeded();
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  try {
    await s.ready;
    const state = await s.waitFor((f) => f.event === 'state');
    assert.equal(state.data.run.id, runId);
    assert.equal(state.data.members[0].name, 'lead');
    assert.ok(!('token' in state.data.members[0]));
    store.addEvent(lead.id, 'text', { text: 'hello' });
    store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'b', text: 'hi' });
    const frame = await s.waitFor((f) => timeline(f) && f.data.messages.length);
    assert.equal(frame.id, '1.1');
    assert.ok(s.frames.some(hasEvent('hello')));
  } finally { s.close(); await web.close(); store.close(); }
});

test('an unknown run is a 404, not an empty stream', async () => {
  const { store } = seeded();
  const web = await startHttp({ store, port: 0 });
  try {
    assert.equal((await get(web.url, '/api/stream?run=999')).status, 404);
  } finally { await web.close(); store.close(); }
});

test('a run that finishes while watched arrives as finished, and reads still work after', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 300 }, { say: 'last words' }], result: { status: 'ok', summary: 'shipped' } } }
  });
  const v = await view(script, { http: { pollMs: 20 } });
  try {
    const { runId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const s = stream(v.base, `/api/stream?run=${runId}&after_event=0&after_message=0`);
    await s.ready;
    await v.sup.waitRun(runId);
    await s.waitFor((f) => timeline(f) && f.data.events.some((e) => e.kind === 'finished'));
    await s.waitFor((f) => f.event === 'state' && f.data.run.status === 'done');
    s.close();
    const after = await get(v.base, `/api/runs/${runId}`);
    assert.equal(after.json.members[0].result.summary, 'shipped');
  } finally { await v.close(); }
});

test('a write from another connection to the same file reaches the stream', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-sse-')), 's.db');
  const { store, runId, lead } = seeded(path);
  const other = openStore(path);   // an in-process supervisor in another CLI writes like this
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  try {
    await s.ready;
    await s.waitFor((f) => f.event === 'state');
    other.addEvent(lead.id, 'text', { text: 'from elsewhere' });
    await s.waitFor(hasEvent('from elsewhere'));
  } finally { s.close(); await web.close(); other.close(); store.close(); }
});

test('reconnecting with Last-Event-ID resumes after it', async () => {
  const { store, runId, lead } = seeded();
  for (const text of ['a', 'b', 'c']) store.addEvent(lead.id, 'text', { text });
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0`, { 'Last-Event-ID': '2.0' });
  try {
    const frame = await s.waitFor(timeline);
    assert.deepEqual(frame.data.events.map((e) => e.body.text), ['c']);
  } finally { s.close(); await web.close(); store.close(); }
});

test('a long backlog arrives in frames of at most 500 events', async () => {
  const { store, runId, lead } = seeded();
  for (let i = 0; i < 1200; i++) store.addEvent(lead.id, 'text', { text: `e${i}` });
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  try {
    const count = () => s.frames.filter(timeline).reduce((n, f) => n + f.data.events.length, 0);
    await until(() => count() === 1200);
    const sizes = s.frames.filter(timeline).map((f) => f.data.events.length);
    assert.deepEqual(sizes, [500, 500, 200]);
  } finally { s.close(); await web.close(); store.close(); }
});

test('a closed tab drops its client and the poll stops', async () => {
  const { store, runId } = seeded();
  const web = await startHttp({ store, port: 0, pollMs: 20, heartbeatMs: 30 });
  const s = stream(web.url, `/api/stream?run=${runId}`);
  try {
    await s.ready;
    await until(() => web.clients() === 1);
    await until(() => s.comments() > 0);   // the heartbeat
    s.close();
    await until(() => web.clients() === 0);
  } finally { await web.close(); store.close(); }
});

test('a reader that stops reading is cut off instead of buffering forever', async () => {
  const { store, runId, lead } = seeded();
  const web = await startHttp({ store, port: 0, pollMs: 20, stallMs: 300 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  try {
    await s.ready;
    await until(() => web.clients() === 1);
    s.pause();
    const big = 'x'.repeat(3900);
    for (let i = 0; i < 3000; i++) store.addEvent(lead.id, 'tool_result', { text: big });
    await until(() => web.clients() === 0);
  } finally { s.close(); await web.close(); store.close(); }
});

test('close() ends open streams at once', async () => {
  const { store, runId } = seeded();
  const web = await startHttp({ store, port: 0 });
  const s = stream(web.url, `/api/stream?run=${runId}`);
  await s.ready;
  const started = Date.now();
  await web.close();
  assert.ok(Date.now() - started < 1000, 'close() waited on an open stream');
  await until(() => s.ended());
  store.close();
});

test('a push that throws drops that client and leaves serve and the other streams running', async () => {
  const { store, runId, lead } = seeded();
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const a = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  const b = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  const real = store.timeline;
  try {
    await Promise.all([a.ready, b.ready]);
    await until(() => web.clients() === 2);
    let thrown = 0;
    store.timeline = (...args) => {
      if (!thrown++) throw new Error('SQLITE_BUSY');
      return real.apply(store, args);
    };
    store.addEvent(lead.id, 'text', { text: 'after the throw' });
    await until(() => web.clients() === 1);
    await until(() => a.ended() || b.ended());
    const survivor = a.ended() ? b : a;
    await survivor.waitFor(hasEvent('after the throw'));
    assert.equal((await get(web.url, '/api/runs')).status, 200);
  } finally { store.timeline = real; a.close(); b.close(); await web.close(); store.close(); }
});

test('a Last-Event-ID beyond the safe integer range is treated as malformed', async () => {
  const { store, runId, lead } = seeded();
  store.addEvent(lead.id, 'text', { text: 'x' });
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`, { 'Last-Event-ID': '99999999999999999999.0' });
  try {
    const frame = await s.waitFor(timeline);
    assert.deepEqual(frame.data.events.map((e) => e.body.text), ['x']);
  } finally { s.close(); await web.close(); store.close(); }
});

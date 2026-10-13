import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { get } from './helpers/http.js';
import { describe, memberTree, activity, countLabel, mergeTimeline, conversation, matches, hourly, ago, summary } from '../src/web/feed.js';

const WEB = new URL('../src/web/', import.meta.url);
const XSS = '<img src=x onerror="alert(1)"></script><script>alert(2)</script>';

test('the page and its assets are served with their types and a CSP with no inline code', async () => {
  const store = openStore(':memory:');
  const web = await startHttp({ store, port: 0 });
  try {
    for (const [path, type] of [['/', /^text\/html/], ['/app.js', /^text\/javascript/],
                                ['/feed.js', /^text\/javascript/], ['/style.css', /^text\/css/],
                                ['/icon.svg', /^image\/svg\+xml/]]) {
      const r = await get(web.url, path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers['content-type'], type, path);
      assert.doesNotMatch(r.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    }
    const html = (await get(web.url, '/')).text;
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'inline script');
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, 'inline style or handler');
    assert.equal((await get(web.url, '/%2e%2e/src/http.js')).status, 404);
    assert.equal((await get(web.url, '/index.html')).status, 404);
  } finally { await web.close(); store.close(); }
});

test('nothing in src/web parses text as HTML', () => {
  for (const name of readdirSync(WEB)) {
    const src = readFileSync(new URL(name, WEB), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|srcdoc/, name);
    assert.doesNotMatch(src, /setAttribute\(\s*['"`]on/i, name);
  }
  // Links built from data go through safeHref, which allows only this page's own paths.
  assert.match(readFileSync(new URL('app.js', WEB), 'utf8'), /k === 'href'\) el\.setAttribute\('href', safeHref\(v\)\)/);
});

test('markup in member output comes back as JSON text, never as a page', async () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: XSS });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: XSS, depth: 0 });
  store.addEvent(lead.id, 'tool_result', { name: 'Read', text: XSS });
  const web = await startHttp({ store, port: 0 });
  try {
    const r = await get(web.url, `/api/runs/${runId}/timeline`);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.json.events[0].body.text, XSS);
  } finally { await web.close(); store.close(); }
});

test('describe gives one line per event and keeps markup as text', () => {
  assert.equal(describe({ kind: 'text', body: { text: XSS } }), XSS);
  assert.equal(describe({ kind: 'tool_call', body: { name: 'Bash', args: { command: 'ls\n-la' } } }), 'Bash {"command":"ls\\n-la"}');
  assert.equal(describe({ kind: 'delegated', body: { to: 'worker', report_id: 3 } }), 'delegated to worker');
  assert.equal(describe({ kind: 'finished', body: { state: 'done', summary: 'shipped' } }), 'done: shipped');
  assert.equal(describe({ kind: 'paused', body: { by: 'b' } }), 'by b');
  assert.ok(describe({ kind: 'tool_result', body: { name: 'Read', text: 'y'.repeat(500) } }).length < 200);
});

test('activity nests calls under each member and collapses identical repeats', () => {
  const call = (id, member_id, command) => ({ id, member_id, member: `m${member_id}`, run_id: 1, kind: 'tool_call', at: id, body: { name: 'Bash', args: { command } } });
  const events = [
    call(1, 1, 'npm test'), call(2, 1, 'npm test'), call(3, 1, 'npm test'),
    { id: 4, member_id: 1, member: 'm1', run_id: 1, kind: 'tool_result', at: 4, body: { name: 'Bash', text: 'ok' } },
    call(5, 2, 'ls'), call(6, 1, 'git status'), call(7, 1, 'npm test')
  ];
  const feed = activity(events);
  assert.deepEqual(feed.map((e) => e.member), ['m1', 'm2']);
  assert.deepEqual(feed[0].items.map((i) => [i.label, i.count]),
                   [['Bash {"command":"npm test"}', 3], ['Bash {"command":"git status"}', 1], ['Bash {"command":"npm test"}', 1]]);
  assert.equal(countLabel(12), '12 times');
  assert.equal(countLabel(1), '');
});

test('the member tree nests reports under their managers', () => {
  const roots = memberTree([
    { id: 3, parent_id: 1, name: 'reviewer' }, { id: 1, parent_id: null, name: 'lead' }, { id: 2, parent_id: 1, name: 'worker' }
  ]);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].children.map((c) => c.name), ['worker', 'reviewer']);
});

test('merging a batch keeps ids unique and the newest `cap` rows', () => {
  const e = (id) => ({ id, at: id });
  let model = { events: [e(1), e(2)], messages: [] };
  model = mergeTimeline(model, { events: [e(2), e(3)], messages: [{ id: 1, at: 1 }], cursor: { event: 3, message: 1 } }, 2);
  assert.deepEqual(model.events.map((x) => x.id), [2, 3]);
  assert.deepEqual(model.cursor, { event: 3, message: 1 });
});

test('the conversation interleaves messages and team events by time', () => {
  const rows = conversation({
    events: [{ id: 1, kind: 'delegated', member: 'lead', at: 10, body: { to: 'worker' } },
             { id: 2, kind: 'tool_call', member: 'lead', at: 11, body: { name: 'Read' } }],
    messages: [{ id: 1, from_name: 'b', from_kind: 'human', to_name: 'worker', text: 'use tabs', at: 12 }]
  });
  assert.deepEqual(rows.map((r) => r.text), ['delegated: delegated to worker', 'use tabs']);
  assert.ok(matches('wor', 'lead', 'Worker'));
  assert.ok(!matches('x', null, 'lead'));
});

test('app.js guards what the DOM cannot test here: stale loads, null children, bad frames', () => {
  const src = readFileSync(new URL('app.js', WEB), 'utf8');
  assert.match(src, /\+\+S\.gen/, 'open() takes a generation token');
  assert.ok((src.match(/gen !== S\.gen/g) ?? []).length >= 4, 'open() re-checks it after each await and in listeners');
  assert.match(src, /replaceChildren\(\.\.\.present\(/, 'the run header filters absent children');
  assert.match(src, /try \{ data = JSON\.parse\(ev\.data\); \} catch/, 'stream frames are parsed defensively');
  assert.match(src, /S\.failed = /, 'a failed load is shown in the view');
});

test('every script in src/web parses as a module', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const f of readdirSync(new URL('../src/web/', import.meta.url)).filter((n) => n.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', new URL(`../src/web/${f}`, import.meta.url).pathname], { stdio: 'pipe' });
  }
});

test('hourly bins today\'s tool calls by hour and ignores other days and kinds', () => {
  const now = new Date(2026, 9, 13, 15, 30).getTime();
  const at = (h) => new Date(2026, 9, 13, h, 5).getTime();
  const bins = hourly([{ kind: 'tool_call', at: at(9) }, { kind: 'tool_call', at: at(9) }, { kind: 'text', at: at(10) },
                       { kind: 'tool_call', at: at(14) }, { kind: 'tool_call', at: now - 86_400_000 }], now);
  assert.equal(bins.length, 24);
  assert.equal(bins[9], 2);
  assert.equal(bins[10], 0);
  assert.equal(bins[14], 1);
  assert.equal(bins.reduce((a, b) => a + b), 3);
});

test('ago rounds to now, minutes, hours and days', () => {
  const now = 10_000_000_000;
  assert.equal(ago(now - 10_000, now), 'now');
  assert.equal(ago(now - 4 * 60_000, now), '4m');
  assert.equal(ago(now - 2 * 3_600_000, now), '2h');
  assert.equal(ago(now - 3 * 86_400_000, now), '3d');
  assert.equal(ago(now + 60_000, now), 'now');
});

test('summary names who is working, paused and asking in one sentence', () => {
  assert.equal(summary([], { questions: [] }), 'All quiet. No team is running right now.');
  const live = [{ name: 'lead', state: 'waiting' }, { name: 'engineer', state: 'running' }, { name: 'designer', state: 'paused' }];
  assert.equal(summary(live, { questions: [{ member: 'lead' }] }), 'Engineer is working, 1 teammate is paused and lead needs you.');
  const many = ['a', 'b', 'c', 'd'].map((name) => ({ name, state: 'running' }));
  assert.equal(summary(many, { questions: [] }), 'A, b and 2 others are working.');
});

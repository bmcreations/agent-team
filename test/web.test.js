import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { get } from './helpers/http.js';
import { describe, memberTree, activity, tasks, countLabel, mergeTimeline, conversation, matches, hourly, ago, summary, snippet, taskTitle, deriveTitle, runTitle, hasMoreThanTitle, isLongText, openThreadCount, threadTouched, canPostToThread, threadRunIds } from '../src/web/feed.js';
import { publicMessage } from '../src/view.js';

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
  assert.match(src, /deny_paths_by_project/, 'the member panel reads the entered project\'s deny_paths');
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

test('progress folds into one running task per member, not a line per update', () => {
  const ev = (id, member_id, kind, text, at) => ({ id, member_id, member: `m${member_id}`, run_id: 1, kind, at, body: { text } });
  const events = [ev(1, 1, 'progress', 'reading', 10), ev(2, 2, 'progress', 'spec', 11), ev(3, 1, 'tool_call', null, 12),
                  ev(4, 1, 'progress', 'writing', 13), ev(5, 1, 'progress', '', 14)];
  const t = tasks(events);
  assert.deepEqual(t.map((x) => [x.member, x.latest.text, x.count]), [['m1', 'writing', 2], ['m2', 'spec', 1]]);
  const feed = activity(events);
  const mine = feed.find((e) => e.member_id === 1).items.filter((it) => it.kind === 'progress');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].count, 3);
  assert.equal(countLabel(3, 'progress'), '3 updates');
  assert.equal(countLabel(3, 'tool_call'), '3 times');
  assert.ok(!conversation({ events, messages: [] }).some((r) => r.kind === 'progress'));
});

test('the threads page is routed, fetches the thread API, and posts through the page\'s api helper', () => {
  const src = readFileSync(new URL('app.js', WEB), 'utf8');
  assert.match(src, /#\\\/threads/, 'parseRoute matches #/threads');
  assert.match(src, /'\/api\/threads'/);
  assert.match(src, /`\/api\/threads\/\$\{id\}\/reply`/);
  assert.match(readFileSync(new URL('feed.js', WEB), 'utf8'), /thread_opened/);
  assert.match(readFileSync(new URL('index.html', WEB), 'utf8'), /href="#\/threads"/);
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('thread helpers: snippets are one clipped line and the badge counts open and accepted threads', () => {
  assert.equal(snippet('a\n  b\tc'), 'a b c');
  assert.equal(snippet('x'.repeat(200), 120), `${'x'.repeat(120)}…`);
  assert.equal(snippet(null), '');
  const pairs = [{ pair: 'a → b', threads: [{ state: 'open' }, { state: 'done' }] }, { pair: 'c → d', threads: [{ state: 'accepted' }, { state: 'declined' }] }];
  assert.equal(openThreadCount(pairs), 2);
  assert.equal(openThreadCount([]), 0);
});

test('stream messages carry only the thread id of a thread, so the page can refetch', () => {
  const row = { id: 1, run_id: 1, to_member: 2, to_name: 'b', from_kind: 'team', from_name: 'x/y', report_id: null, thread_id: 7,
                text: 't', state: 'delivered', at: 1, token: 'secret' };
  assert.equal(publicMessage(row).thread_id, 7);
  assert.equal('token' in publicMessage(row), false);
  assert.equal(publicMessage({ ...row, thread_id: undefined }).thread_id, null);
});

test('thread message text is clipped like the thread pages clip it', () => {
  const row = { id: 1, run_id: 1, to_member: 2, to_name: 'b', from_kind: 'team', from_name: 'x/y', report_id: null, thread_id: 7,
                text: 'y'.repeat(10000), state: 'delivered', at: 1 };
  assert.equal(publicMessage(row).text, `${'y'.repeat(4000)}…`);
  assert.equal(publicMessage({ ...row, text: 'short' }).text, 'short');
  assert.equal(publicMessage({ ...row, thread_id: null }).text.length, 10000);
});

test('threadTouched: a thread message for this thread, any thread on the list, or a new thread', () => {
  const msg = (thread_id) => ({ messages: [{ id: 1, thread_id }], events: [] });
  assert.equal(threadTouched(msg(3), 3), true);
  assert.equal(threadTouched(msg(3), 4), false);
  assert.equal(threadTouched(msg(3), null), true);
  assert.equal(threadTouched(msg(null), null), false);
  assert.equal(threadTouched({ events: [{ kind: 'thread_opened' }] }, 4), true);
  assert.equal(threadTouched({ events: [{ kind: 'text' }] }, null), false);
  assert.equal(threadTouched({}, null), false);
});

test('canPostToThread: only an open thread with a steerable run on a side', () => {
  const live = { id: 1, status: 'running', steerable: true };
  const done = { id: 2, status: 'done', steerable: false };
  const mine = { id: 3, status: 'running', steerable: false };
  assert.equal(canPostToThread({ state: 'open', from_run: 1 }, [live]), true);
  assert.equal(canPostToThread({ state: 'accepted', from_run: 2, run_id: 1 }, [done, live]), true);
  assert.equal(canPostToThread({ state: 'open', from_run: 2 }, [done, live]), false, 'a live run on neither side');
  assert.equal(canPostToThread({ state: 'open', from_run: 2, owner: { run_id: 1 } }, [done, live]), true, 'a live lead owns it');
  assert.equal(canPostToThread({ state: 'open', from_run: 2 }, [done]), false, 'finished');
  assert.equal(canPostToThread({ state: 'open', from_run: 3 }, [mine]), false, 'not serve\'s');
  assert.equal(canPostToThread({ state: 'open', from_run: 1 }, []), false, 'runs missing');
  assert.equal(canPostToThread({ state: 'done', from_run: 1 }, [live]), false, 'closed');
  assert.equal(canPostToThread({ state: 'declined', from_run: 1 }, [live]), false, 'closed');
  assert.deepEqual(threadRunIds({ from_run: 1, run_id: 1, owner: { run_id: 4 } }), [1, 4]);
  assert.deepEqual(threadRunIds({ from_run: 1, run_id: null, owner: null }), [1]);
});

test('a thread result status is cut to 100 characters', async () => {
  const store = openStore(':memory:');
  const run = store.createRun({ project: '/p', task: 't' });
  const m = store.addMember({ runId: run, parentId: null, name: 'a', task: 't', depth: 0 });
  const id = store.addThread({ kind: 'task', fromProject: '/p', fromRun: run, fromMember: m.id ?? m.memberId ?? m, toProject: '/q', toMember: m.id ?? m.memberId ?? m, chain: [], text: 'x', task: 'x' });
  store.moveThread(id, 'open', 'accepted');
  store.moveThread(id, 'accepted', 'done', { result: { status: 's'.repeat(300), summary: 'ok' } });
  const web = await startHttp({ store, port: 0 });
  try {
    const r = await get(web.url, `/api/threads/${id}`);
    assert.equal(r.json.thread.result.status.length, 101);
    assert.equal(r.json.thread.result.summary, 'ok');
  } finally { await web.close(); store.close(); }
});

test('task titles: the first line of a brief, without heading marks, and whether there is more', () => {
  const brief = '\n# Brief: flexible New device create\n\nApproved by Brandon.\n## Goal\nMake it create either.';
  assert.equal(taskTitle(brief), 'Brief: flexible New device create');
  assert.equal(hasMoreThanTitle(brief), true);
  assert.equal(taskTitle('fix the rotate crash'), 'fix the rotate crash');
  assert.equal(hasMoreThanTitle('fix the rotate crash'), false);
  assert.equal(taskTitle('x'.repeat(200)).length, 121);
  assert.equal(hasMoreThanTitle('x'.repeat(200)), false);
  assert.equal(taskTitle(null), '');
});

test('a conversation message is clipped past 480 characters or 6 lines', () => {
  assert.equal(isLongText('finished ok: done'), false);
  assert.equal(isLongText('a\nb\nc\nd\ne\nf'), false);
  assert.equal(isLongText('a\nb\nc\nd\ne\nf\ng'), true);
  assert.equal(isLongText('x'.repeat(481)), true);
  assert.equal(isLongText(null), false);
});

test('splitDiff gives one entry per file with each line tagged by kind, and counts only hunk lines', async () => {
  const { splitDiff, changeCounts } = await import('../src/web/feed.js');
  const diff = [
    'diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt',
    '@@ -1,2 +1,2 @@', ' same', '-old', '+new',
    'diff --git a/b.txt b/b.txt', 'new file mode 100644', '--- /dev/null', '+++ b/b.txt',
    '@@ -0,0 +1 @@', '+--x', ''
  ].join('\n');
  const files = splitDiff(diff);
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed]), [['a.txt', 1, 1], ['b.txt', 1, 0]]);
  assert.deepEqual(files[0].lines.map((l) => l.kind), ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add']);
  assert.equal(files[1].lines.at(-1).kind, 'add');   // "+--x" is content, not a header
  assert.equal(changeCounts(files[0]), '+1 −1');
  assert.deepEqual(splitDiff(''), []);
  assert.deepEqual(splitDiff(null), []);
});

test('deriveTitle names a run from the brief when nobody did', () => {
  assert.equal(deriveTitle("Exploration only, no implementation. Goal: decide the design for a floating 'jump to bottom' button with an unread counter ..."),
    "Floating 'jump to bottom' button with an unread counter");
  assert.equal(deriveTitle('Objective: render the new system-message content type in private group chats, on iOS ... and Android ...'),
    'System-message content type in private group chats');
  assert.equal(deriveTitle('# Brief: flexible New device create (Android + iOS)\n\nApproved by Chris.'),
    'Flexible New device create (Android + iOS)');
  assert.equal(deriveTitle('Intro line\n\n## Real heading\nbody'), 'Real heading');
  assert.equal(deriveTitle('fix the rotate crash. Then more'), 'Rotate crash');
  assert.equal(deriveTitle('Task: Goal: nested labels'), 'Nested labels');
  assert.equal(deriveTitle(null), '');
  assert.equal(deriveTitle('x'.repeat(200)).length, 61);
});

test('deriveTitle keeps the subject first without emptying the title', () => {
  // A lead-in that would leave under two words is kept.
  assert.equal(deriveTitle('Fix flakes'), 'Fix flakes');
  assert.equal(deriveTitle('add support for it'), 'Add support for it');
  assert.equal(deriveTitle('Investigate'), 'Investigate');
  // A trailing clause is cut only when three or more words remain.
  assert.equal(deriveTitle('Create the retry queue; then wire it up'), 'Retry queue; then wire it up');
  assert.equal(deriveTitle('Create the upload retry queue; then wire it up'), 'Upload retry queue');
  assert.equal(deriveTitle('Build a cache: with eviction'), 'Cache: with eviction');
  assert.equal(deriveTitle('Implement a retry queue for uploads \u2014 see notes'), 'Retry queue for uploads');
  // A long subject is cut at a word boundary.
  const long = deriveTitle('Explore the onboarding flow for returning customers who changed devices recently and lost their sessions');
  assert.ok(long.length <= 61 && long.endsWith('\u2026') && long.startsWith('Onboarding flow'), long);
});

test('runTitle prefers the run title and falls back to the brief', () => {
  assert.equal(runTitle({ title: 'Jump button design', task: 'Goal: something else' }), 'Jump button design');
  assert.equal(runTitle({ title: null, task: 'Goal: something else' }), 'Something else');
  assert.equal(runTitle({ title: '  ', task: 'Do it' }), 'Do it');
});

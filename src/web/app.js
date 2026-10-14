import { describe, memberTree, activity, tasks, isProgressReport, isProgressEcho, countLabel, todayCount, mergeTimeline, conversation, matches, hourly, ago, summary, snippet, taskTitle, runTitle, hasMoreThanTitle, isLongText, openThreadCount, threadTouched, canPostToThread, splitDiff, changeCounts, TERMINAL } from './feed.js';

// Member output is untrusted. Every node is built here with createElement and text nodes;
// nothing from the API is parsed as HTML.
const $ = (id) => document.getElementById(id);
const S = { expanded: new Set(), gen: 0, failed: null, route: null, state: null, detail: null, model: { events: [], messages: [] }, source: null,
            query: '', panel: null, open: new Set(), threads: null, thread: null };

const safeHref = (v) => { const s = String(v); return s.startsWith('#') || (s.startsWith('/') && !s.startsWith('//')) ? s : '#'; };
// replaceChildren stringifies null, so anything that may be absent goes through here first.
const present = (...list) => list.flat(Infinity).filter((c) => c != null && c !== false);
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.setAttribute('href', safeHref(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  send: 'M12 19V5M5.5 11.5 12 5l6.5 6.5', back: 'M15 5l-7 7 7 7', chevron: 'M9 6l6 6-6 6', copy: 'M9 9h10v10H9zM15 9V5H5v10h4',
  pause: 'M9 6v12M15 6v12', now: 'M7 6v12M12 6v12M17 9l3 3-3 3', play: 'M8 5.5v13l10-6.5z', x: 'M6 6l12 12M18 6 6 18',
  tool: 'M14.5 6.5a4 4 0 0 0 5 5L13 18a2.1 2.1 0 0 1-3-3l6.5-6.5a4 4 0 0 0-2-2z', term: 'M5 7l5 5-5 5M12 17h7',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z', spark: 'M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M5.6 18.4l3.5-3.5M14.9 9.1l3.5-3.5',
  check: 'M5 12.5l4.5 4.5L19 7', device: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2', ext: 'M14 5h5v5M19 5l-8 8M17 14v5H5V7h5'
};
function icon(name, cls = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// Rebuilds a list, reusing the node of every row whose key is unchanged, so a half-typed
// answer survives an update and a long transcript is not rebuilt on every event.
function keyed(container, items, key, build) {
  const old = new Map([...container.children].map((el) => [el.dataset.key, el]));
  container.replaceChildren(...items.map((it) => {
    const k = key(it);
    const el = old.get(k) ?? build(it);
    el.dataset.key = k;
    return el;
  }));
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
let flashTimer = null;
const flash = (text) => {
  const el = $('flash');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 2600);
};
const act = (path, body, done) => api(path, body).then((r) => { flash(done); return r; }, (err) => { flash(err.message); });
function button(label, path, body, opts = {}) {
  return h('button', { type: 'button', class: `btn small ${opts.cls ?? ''}`.trim(), onclick: () => {
    if (opts.confirm && !confirm(opts.confirm)) return;
    act(path, typeof body === 'function' ? body() : body, opts.done ?? `${label}: sent`);
  } }, opts.icon ? icon(opts.icon) : null, label);
}

// Small pieces every view shares.
const money = (usd) => (usd ? `$${usd.toFixed(2)}` : null);
const tokens = (n) => (n ? `${n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : n} tokens` : null);
const shortPath = (p) => String(p ?? '').split('/').filter(Boolean).at(-1) ?? String(p ?? '');
const projectOf = (runId) => S.state?.runs.find((r) => r.id === runId)?.project ?? null;
const STATE_LABEL = { running: 'Working', waiting: 'Waiting', paused: 'Paused', taken_over: 'Taken over', done: 'Done',
                      failed: 'Failed', cancelled: 'Cancelled', pending: 'Starting', queued: 'Queued' };
const stateLabel = (s) => STATE_LABEL[s] ?? String(s ?? '').replace(/_/g, ' ');
const pill = (s, text = stateLabel(s)) => h('span', { class: `pill ${s ?? ''}` }, text);
const dot = (s) => h('span', { class: `dot ${s ?? ''}`, title: stateLabel(s) });
function harness(agent) {
  const a = String(agent ?? '').toLowerCase();
  if (a.startsWith('claude')) return { cls: 'claude', label: 'Claude' };
  if (a.startsWith('codex')) return { cls: 'codex', label: 'Codex' };
  return agent ? { cls: 'other', label: agent } : null;
}
const hue = (name) => [...String(name)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % 8;
const initials = (name) => {
  const parts = String(name ?? '?').split(/[\s_\-.]+/).filter(Boolean);
  return ((parts.length > 1 ? parts[0][0] + parts[1][0] : String(name ?? '?').slice(0, 1)) || '?').toUpperCase();
};
function avatar(name, { agent = null, human = false, size = '' } = {}) {
  const hn = harness(agent);
  return h('span', { class: `av ${human ? 'you' : `av-${hue(name)}`} ${size}`.trim(), 'aria-hidden': 'true' }, initials(name),
    hn ? h('span', { class: `av-badge ${hn.cls}` }) : human ? h('span', { class: 'av-badge human' }) : null);
}
const when = (at) => h('time', { 'data-at': String(at), datetime: new Date(at).toISOString(), title: new Date(at).toLocaleString() }, ago(at));
const memberHref = (runId, memberId) => `#/run/${runId}/member/${memberId}`;
const mateLink = (runId, memberId, name) => h('a', { href: memberHref(runId, memberId) }, name);

function parseRoute() {
  const t = /^#\/threads(?:\/(\d+))?$/.exec(location.hash);
  if (t) return { run: null, member: null, threads: true, thread: t[1] ? Number(t[1]) : null };
  const m = /^#\/run\/(\d+)(?:\/member\/(\d+))?$/.exec(location.hash);
  return m ? { run: Number(m[1]), member: m[2] ? Number(m[2]) : null } : { run: null, member: null };
}

// The thread list feeds the sidebar count on every page; the thread view also reloads its own
// thread. Calls that arrive while one is in flight collapse into one more fetch, and a fetch
// that finishes after the view changed is dropped and redone for the new view.
let threadsBusy = false, threadsAgain = false;
async function refreshThreads() {
  if (threadsBusy) { threadsAgain = true; return; }
  threadsBusy = true;
  try {
    do {
      threadsAgain = false;
      const gen = S.gen;
      const id = S.route?.thread ?? null;
      try {
        const [list, detail] = await Promise.all([api('/api/threads'),
          id == null ? null : api(`/api/threads/${id}`).then((d) => d, (err) => ({ error: err.message }))]);
        if (gen !== S.gen) { threadsAgain = true; continue; }
        S.threads = list.pairs;
        if (id != null) {
          if (detail.error && S.thread?.thread?.id === id) flash(detail.error);   // keep what is on screen
          else S.thread = detail;
        }
        if (S.route?.threads) S.failed = null;
      } catch (err) {
        if (gen !== S.gen) { threadsAgain = true; continue; }
        if (S.route?.threads) S.failed = `Could not load threads: ${err.message}`;
      }
      schedule();
    } while (threadsAgain);
  } finally { threadsBusy = false; }
}

function setConn(text, cls) {
  const el = $('conn');
  el.textContent = text;
  el.className = `conn ${cls}`;
}

// Each view loads a tail over HTTP, then streams from that tail's cursor.
async function open() {
  setDrawer(false);
  const route = parseRoute();
  if (route.threads && S.route?.threads && route.thread === S.route.thread) return;
  if (S.route && route.run === S.route.run && route.run != null) {   // another member, same run
    S.route = route;
    scrollTo({ top: 0 });
    return schedule();
  }
  S.source?.close();
  const gen = ++S.gen;
  Object.assign(S, { route, failed: null, panel: null, detail: null, thread: null, model: { events: [], messages: [] } });
  $('view').replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
  scrollTo({ top: 0 });
  try {
    const tl = await api(route.run ? `/api/runs/${route.run}/timeline?limit=500` : `/api/timeline?limit=${route.threads ? 20 : 500}`);
    if (gen !== S.gen) return;
    const detail = route.run ? await api(`/api/runs/${route.run}`) : null;
    if (gen !== S.gen) return;
    S.model = { events: tl.events, messages: tl.messages };
    S.detail = detail;
    const q = new URLSearchParams({ after_event: tl.cursor.event, after_message: tl.cursor.message });
    if (route.run) q.set('run', route.run);
    const src = new EventSource(`/api/stream?${q}`);
    const on = (name, f) => src.addEventListener(name, (ev) => {
      if (gen !== S.gen) return;
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }   // one bad frame must not stop the stream
      f(data);
      schedule();
    });
    on('state', (data) => { S.state = data; });
    on('timeline', (data) => {
      S.model = mergeTimeline(S.model, data);
      if (threadTouched(data, route.thread)) refreshThreads();
    });
    src.onopen = () => { setConn('Live', 'live'); };
    src.onerror = () => { setConn('Reconnecting', 'down'); };
    S.source = src;
    refreshThreads();
  } catch (err) {
    if (gen !== S.gen) return;
    S.failed = `Could not load this view: ${err.message}`;
    flash(err.message);
  }
  schedule();
}

// At most one redraw per frame, however many batches arrive.
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; draw(); });
}

function draw() {
  drawSidebar();
  drawNeeds();
  if (S.failed) {
    $('view').replaceChildren(h('div', { class: 'card empty' }, h('p', { class: 'big' }, 'That view would not load'), h('p', {}, S.failed),
      h('a', { class: 'btn', href: '#/' }, 'Back to activity')));
  } else if (S.route.threads) drawThreads(); else if (S.route.run) drawRun(); else drawActivity();
}

function drawSidebar() {
  const live = S.state?.live ?? [];
  const byProject = new Map();
  for (const run of S.state?.runs ?? []) {
    const members = live.filter((m) => m.run_id === run.id);
    if (S.query && !matches(S.query, run.project, run.task, run.root, ...members.map((m) => m.name))) continue;
    byProject.set(run.project, [...(byProject.get(run.project) ?? []), { run, members }]);
  }
  $('home').classList.toggle('current', !S.route?.run && !S.route?.threads);
  const n = openThreadCount(S.threads ?? []);
  $('threads-link').classList.toggle('current', S.route?.threads === true);
  $('threads-count').textContent = n ? String(n) : '';
  $('threads-count').hidden = !n;
  const groups = [...byProject].map(([project, items]) => h('div', { class: 'project' },
    h('h2', { title: project }, shortPath(project)),
    h('ul', {}, items.map(({ run, members }) => h('li', {},
      h('a', { href: `#/run/${run.id}`, class: `run-link${run.id === S.route?.run ? ' current' : ''}`, title: run.task },
        dot(run.status), h('span', { class: 'label' }, runTitle(run) || run.root || `Run ${run.id}`), h('span', { class: 'num' }, `#${run.id}`)),
      members.length ? h('ul', { class: 'members' }, members.map((m) => h('li', {},
        h('a', { href: memberHref(m.run_id, m.id), class: `member-link${m.id === S.route?.member ? ' current' : ''}` },
          avatar(m.name, { agent: m.agent, size: 'sm' }), h('span', { class: 'label' }, m.name), dot(m.state))))) : null)))));
  $('projects').replaceChildren(...(groups.length ? groups
    : [h('p', { class: 'empty-side' }, S.query ? 'Nothing matches that search.' : S.state ? 'No runs yet.' : 'Connecting…')]));
}

function drawNeeds() {
  const n = S.state?.needs ?? { questions: [], stalled: [], cost_capped: [] };
  const items = [
    ...n.questions.map((q) => ({ key: `q${q.id}`, build: () => questionCard(q) })),
    ...n.stalled.map((s) => ({ key: `s${s.member_id}.${s.at}`, build: () => h('div', { class: 'ask' },
      avatar(s.member),
      h('div', { class: 'body' },
        h('div', { class: 'who-line' }, mateLink(s.run_id, s.member_id, s.member), ' went quiet · ', when(s.at)),
        h('p', { class: 'q' }, `No word for ${Math.round((s.quiet_s ?? 0) / 60)} minutes.`),
        h('div', { class: 'row' },
          button('Pause now', `/api/members/${s.member_id}/pause`, { now: true }, { cls: 'primary', done: 'Paused' }),
          button('Cancel', `/api/members/${s.member_id}/cancel`, {}, { cls: 'danger', confirm: `Cancel ${s.member}?`, done: 'Cancelled' })))) })),
    ...n.cost_capped.map((c) => ({ key: `c${c.run_id}.${c.max_cost_usd}`, build: () => capCard(c) }))
  ];
  const section = $('needs');
  section.hidden = items.length === 0;
  if (!section.firstChild) {
    section.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Needs you'), h('span', { class: 'badge' })), h('div', { class: 'asks' })));
  }
  section.querySelector('.badge').textContent = String(items.length);
  keyed(section.querySelector('.asks'), items, (i) => i.key, (i) => i.build());
}

function questionCard(q) {
  const input = h('input', { type: 'text', placeholder: 'Or write an answer', 'aria-label': `Answer ${q.member}` });
  const send = (answer) => act(`/api/questions/${q.id}/answer`, { answer }, `Answered ${q.member}`);
  const options = q.options ?? [];
  return h('form', { class: 'ask', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) send(input.value); } },
    avatar(q.member),
    h('div', { class: 'body' },
      h('div', { class: 'who-line' }, mateLink(q.run_id, q.member_id, q.member), ' asks', q.asked_at ? [' · ', when(q.asked_at)] : null),
      h('p', { class: 'q' }, q.question),
      h('div', { class: 'row' },
        options.map((o, i) => h('button', { type: 'button', class: `btn ${i === 0 ? 'primary' : ''}`.trim(), onclick: () => send(o) }, o)),
        h('div', { class: 'answer' }, input, h('button', { type: 'submit', class: `btn ${options.length ? '' : 'primary'}`.trim() }, 'Answer')))));
}

function capCard(c) {
  const input = h('input', { type: 'number', min: '0', step: '0.5', value: String((c.max_cost_usd ?? 0) * 2), 'aria-label': 'New cap in dollars' });
  return h('form', { class: 'ask', onsubmit: (e) => {
    e.preventDefault();
    act(`/api/members/${c.member_id}/resume`, { subtree: true, max_cost_usd: Number(input.value) }, 'Resumed');
  } },
    h('span', { class: 'av av-3', 'aria-hidden': 'true' }, '$'),
    h('div', { class: 'body' },
      h('div', { class: 'who-line' }, h('a', { href: `#/run/${c.run_id}` }, `Run #${c.run_id}`), ' paused at its spending cap'),
      h('p', { class: 'q' }, `Spent ${money(c.cost_usd) ?? '$0.00'} of ${money(c.max_cost_usd) ?? '$0.00'}.`),
      h('div', { class: 'row' }, h('div', { class: 'answer' }, h('span', { class: 'muted' }, 'New cap $'), input,
        h('button', { type: 'submit', class: 'btn primary' }, 'Raise and resume')))));
}

function greeting(now = new Date()) {
  const hr = now.getHours();
  return hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

function chartCard() {
  const bins = hourly(S.model.events);
  const max = Math.max(1, ...bins);
  const hour = new Date().getHours();
  const bars = bins.map((n, i) => {
    const bar = h('span', { class: i > hour ? 'later' : n ? '' : 'zero',
                            title: `${new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: 'numeric' })} · ${n} tool ${n === 1 ? 'call' : 'calls'}` });
    bar.style.setProperty('--h', String(Math.round((n / max) * 100)));
    return bar;
  });
  const total = todayCount(S.model.events);
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `Today · ${total} tool ${total === 1 ? 'call' : 'calls'}`)),
    h('div', { class: 'chart', role: 'img', 'aria-label': `Tool calls per hour today, ${total} in all` }, bars),
    h('div', { class: 'axis' }, ['12 AM', '6 AM', '12 PM', '6 PM'].map((t) => h('span', {}, t))));
}

// Threads between teams, grouped by the pair of teams. Humans read and post; accepting and
// declining stay with the teams.
const THREAD_PILL = { open: ['waiting', 'Open'], accepted: ['running', 'Accepted'], declined: ['bad', 'Declined'], done: ['ok', 'Done'] };
function threadPill(t) {
  const [cls, label] = THREAD_PILL[t.state] ?? ['', stateLabel(t.state)];
  return pill(t.state === 'done' && t.result?.status && t.result.status !== 'ok' ? 'bad' : cls, label);
}
// A long task's full text, folded under its headline. The element is kept per `key` on `holder`
// so a live re-render does not close it while someone reads.
function fullText(holder, key, text, label) {
  if (!hasMoreThanTitle(text)) return null;
  if (holder.full?.key !== key) {
    const body = h('div', { class: 'full-text' });
    holder.full = { key, body, el: h('details', { class: 'more-facts full' }, h('summary', {}, icon('chevron'), label), body) };
  }
  if (holder.full.body.textContent !== text) holder.full.body.textContent = text;
  return holder.full.el;
}

const threadTitle = (t) => taskTitle(t.task || (t.kind === 'question' ? 'A question' : 'A request'), 120);
const runLink = (id, label) => (id == null ? null : h('a', { href: `#/run/${id}` }, label));
const sides = (t) => `${t.from_member?.name ?? 'someone'} → ${t.owner?.name ?? 'waiting for a lead'}`;
function threadLinks(t) {
  const lead = t.owner?.run_id;
  const links = present(runLink(t.from_run, `Requester run #${t.from_run}`), runLink(t.run_id, `Thread run #${t.run_id}`),
    lead != null && lead !== t.run_id ? runLink(lead, `Lead run #${lead}`) : null);
  return links.length ? h('div', { class: 'thread-links' }, links.flatMap((l, i) => (i ? [' · ', l] : [l]))) : null;
}

function drawThreads() {
  if (S.route.thread != null) return drawThread();
  S.panel = null;
  const pairs = (S.threads ?? []).map((g) => ({ ...g, threads: g.threads.filter((t) => !S.query || matches(S.query, g.pair, t.task, t.from_member?.name, t.owner?.name)) }))
    .filter((g) => g.threads.length);
  $('view').replaceChildren(h('header', { class: 'run-head' }, h('h1', {}, 'Threads'),
    h('p', { class: 'muted' }, 'What teams are asking each other. Post to a thread to step in; the teams accept and decline for themselves.')),
    ...(S.threads == null ? [h('p', { class: 'loading' }, 'Loading…')]
      : pairs.length ? pairs.map((g) => h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, g.pair)),
        h('ul', { class: 'runs-list' }, g.threads.map((t) => h('li', { class: 'thread-item' },
          h('a', { class: 'run-card', href: `#/threads/${t.id}` },
            avatar(t.from_member?.name ?? g.pair, { size: 'sm' }),
            h('span', { class: 'body' }, h('div', { class: 'title' }, threadTitle(t)),
              h('div', { class: 'meta' }, present(`#${t.id} · ${sides(t)} · `, when(t.updated_at)))),
            h('span', { class: 'pill quiet' }, t.kind), threadPill(t)),
          threadLinks(t))))))
        : [h('div', { class: 'card empty' }, h('p', { class: 'big' }, S.query ? 'Nothing matches that search' : 'No threads yet'),
          h('p', {}, 'When one team asks another for something, the conversation shows up here.'))]));
}

function threadComposer(id) {
  const text = h('textarea', { rows: '1', placeholder: 'Post to this thread', 'aria-label': 'Post to this thread' });
  const send = h('button', { type: 'submit', class: 'send', 'aria-label': 'Post' }, icon('send'));
  const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 160)}px`; };
  const submit = () => {
    if (!text.value.trim() || text.disabled) return;
    act(`/api/threads/${id}/reply`, { text: text.value }, 'Posted').then((r) => { if (r) { text.value = ''; grow(); refreshThreads(); } });
  };
  text.addEventListener('input', grow);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  const el = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } }, text, send);
  return { el, text, send };
}

// A message bubble, clipped to its first lines when long. Which ones are open is kept in
// S.expanded by row key, so a live re-render does not close one someone is reading.
function bubble(key, text) {
  const el = h('div', { class: 'bubble' }, text);
  if (!isLongText(text)) return el;
  const label = () => (S.expanded.has(key) ? 'Show less' : 'Show more');
  el.classList.toggle('clamped', !S.expanded.has(key));
  const more = h('button', { type: 'button', class: 'show-more', onclick: () => {
    if (S.expanded.has(key)) S.expanded.delete(key); else S.expanded.add(key);
    el.classList.toggle('clamped', !S.expanded.has(key));
    more.textContent = label();
  } }, label());
  return [el, more];
}

function postRow(p) {
  const mine = p.side === 'human';
  return h('li', { class: `message${mine ? ' mine' : ''}` }, avatar(p.author, { human: mine }),
    h('div', { class: 'msg' },
      h('div', { class: 'who-line' }, present(h('b', {}, p.author), ` · ${p.side} · `, when(p.at),
        p.state ? [' ', pill(p.state === 'declined' ? 'bad' : p.state === 'accepted' ? 'running' : 'ok', stateLabel(p.state))] : null)),
      bubble(`p${p.id}`, p.text)));
}

function drawThread() {
  const id = S.route.thread;
  const crumbs = h('div', { class: 'crumbs' }, h('a', { href: '#/threads' }, 'Threads'), icon('chevron'), h('span', {}, `Thread #${id}`));
  if (S.thread?.error) {
    S.panel = null;
    return $('view').replaceChildren(h('div', { class: 'card empty' }, h('p', { class: 'big' }, `Thread #${id} is not available`), h('p', {}, S.thread.error),
      h('a', { class: 'btn', href: '#/threads' }, 'Back to threads')));
  }
  if (!S.thread) return $('view').replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
  const { thread: t, posts } = S.thread;
  if (S.panel?.thread !== id) {
    S.panel = { thread: id, head: h('header', { class: 'run-head' }), talk: h('ol', { class: 'talk posts' }), composer: threadComposer(id),
                note: h('p', { class: 'muted thread-note' }) };
    $('view').replaceChildren(S.panel.head, h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Conversation')), S.panel.talk, S.panel.note, S.panel.composer.el));
  }
  S.panel.head.replaceChildren(...present(crumbs, h('h1', {}, threadTitle(t)),
    h('div', { class: 'facts-row' }, present(threadPill(t), h('span', { class: 'pill quiet' }, t.kind), h('span', { class: 'pill quiet' }, t.pair),
      h('span', { class: 'pill quiet' }, sides(t)))),
    threadLinks(t),
    t.result?.summary ? h('div', { class: `banner ${t.result.status === 'ok' ? 'info' : ''}`.trim() }, icon(t.result.status === 'ok' ? 'spark' : 'x'),
      h('span', {}, `Finished${t.result.status === 'ok' ? '' : ` (${t.result.status})`}: ${t.result.summary}`)) : null));
  const atEnd = S.panel.talk.scrollHeight - S.panel.talk.scrollTop - S.panel.talk.clientHeight < 40;
  if (posts.length) keyed(S.panel.talk, posts, (p) => `p${p.id}`, postRow);
  else S.panel.talk.replaceChildren(h('li', { class: 'empty' }, 'Nothing has been posted yet.'));
  if (atEnd) S.panel.talk.scrollTop = S.panel.talk.scrollHeight;
  // Posting needs the serve process that owns a live run on one side of the thread.
  const closed = t.state === 'declined' || t.state === 'done';
  const canPost = canPostToThread(t, S.state?.runs ?? []);
  S.panel.composer.el.hidden = !canPost;
  S.panel.note.hidden = canPost;
  S.panel.note.textContent = closed ? `This thread is ${t.state}, so it takes no more posts.` : 'No run on either side is live under `agent-team serve`, so this page can read the thread but not post to it.';
}

function runRow(run) {
  const mates = (S.state?.live ?? []).filter((m) => m.run_id === run.id);
  return h('li', {}, h('a', { class: 'run-card', href: `#/run/${run.id}` },
    mates.length ? h('span', { class: 'stack' }, mates.slice(0, 4).map((m) => avatar(m.name, { agent: m.agent, size: 'sm' })))
      : avatar(run.root ?? run.task, { size: 'sm' }),
    h('span', { class: 'body' }, h('div', { class: 'title' }, runTitle(run) || `Run ${run.id}`),
      h('div', { class: 'meta' }, present(shortPath(run.project), ` · #${run.id}`, money(run.cost_usd) ? ` · ${money(run.cost_usd)}` : null, ' · ', when(run.created_at)))),
    pill(run.status)));
}

function drawActivity() {
  const entries = activity(S.model.events).reverse()
    .filter((e) => !S.query || matches(S.query, e.member, projectOf(e.run_id)));
  const runs = S.state?.runs ?? [];
  const running = runs.filter((r) => r.status === 'running');
  const recent = runs.filter((r) => r.status !== 'running').slice(0, 6);
  const history = entries.slice(0, 60).map((e) => {
    // report_progress is followed by its own progress line, so the call itself is noise here.
    const items = e.items.filter((it) => it.kind !== 'user' && !(it.kind === 'tool_call' && /^report_progress\b/.test(it.label ?? '')));
    const showAll = S.open.has(e.member_id);
    const shown = items.slice(showAll ? -20 : -4);
    const last = items.at(-1) ?? e.items.at(-1);
    return h('li', {},
      avatar(e.member),
      h('div', { class: 'body' },
        h('div', { class: 'who-line' }, mateLink(e.run_id, e.member_id, e.member), ` · ${shortPath(projectOf(e.run_id)) || `run #${e.run_id}`}`,
          last ? [' · ', when(last.at)] : null),
        h('ul', { class: 'actions' }, shown.map((it) => h('li', { class: it.kind === 'text' || it.kind === 'progress' ? 'say' : '' },
          it.kind === 'tool_call' || it.kind === 'command' ? h('span', { class: 'chip' }, it.kind === 'command' ? 'shell' : 'tool') : null,
          PHRASE[it.kind] && it.kind !== 'progress'
            ? h('span', { class: 'what note' }, PHRASE[it.kind](it.label === it.kind ? '' : it.label ?? ''))
            : h('span', { class: 'what' }, it.label || it.kind),
          it.count > 1 ? h('span', { class: 'count' }, countLabel(it.count, it.kind)) : null))),
        items.length > 4 ? h('button', { type: 'button', class: 'more', onclick: () => {
          if (S.open.has(e.member_id)) S.open.delete(e.member_id); else S.open.add(e.member_id);
          schedule();
        } }, showAll ? 'Show less' : `Show ${Math.min(items.length, 20) - 4} more`) : null));
  });
  $('view').replaceChildren(
    h('div', { class: 'hello' },
      h('h1', {}, icon('spark', 'spark'), greeting()),
      h('p', {}, S.state ? summary(S.state.live, S.state.needs) : 'Catching up with your teams…')),
    h('div', { class: 'grid' },
      h('div', { class: 'col' },
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'History')),
          history.length ? h('ol', { class: 'history' }, history)
            : h('div', { class: 'empty' }, h('p', { class: 'big' }, S.query ? 'Nothing matches that search' : 'Nothing has happened yet'),
                h('p', {}, S.query ? 'Try a teammate or project name.' : 'Start a team with agent-team run, and its work shows up here as it happens.')))),
      h('div', { class: 'col' },
        chartCard(),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Running now'), running.length ? h('span', { class: 'badge' }, String(running.length)) : null),
          running.length ? h('ul', { class: 'runs-list' }, running.map(runRow)) : h('p', { class: 'muted' }, 'No team is running.')),
        recent.length ? h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Recent')),
          h('ul', { class: 'runs-list' }, recent.map(runRow))) : null)));
}

// Team events read as sentences in the conversation.
const PHRASE = {
  started: () => 'joined the team', paused: () => 'was paused', resumed: () => 'picked back up', interrupted: () => 'was interrupted',
  stalled: (s) => `went ${s}`, timed_out: () => 'ran out of time', taken_over: () => 'was taken over in a terminal',
  handed_back: () => 'was handed back', cost_cap: (s) => `hit its ${s}`, finished: (s) => (s ? `finished · ${s}` : 'finished'),
  delegated: (s) => s.replace(/^delegated to /, 'handed a task to '), progress: (s) => s
};

function convoRow(r, run) {
  if (r.type === 'message') {
    const mine = r.from_kind === 'human';
    return h('li', { class: `message${mine ? ' mine' : ''}` },
      avatar(r.from, { human: mine }),
      h('div', { class: 'msg' },
        h('div', { class: 'who-line' }, h('b', {}, r.from), ` to ${r.to} · `, when(r.at)),
        bubble(r.key, r.text)));
  }
  const member = (S.detail?.members ?? []).find((m) => m.name === r.who);
  const say = (PHRASE[r.kind] ?? ((s) => s || r.kind.replace(/_/g, ' ')))(r.said ?? '');
  return h('li', { class: 'event' }, dot(r.kind === 'finished' ? 'done' : r.kind === 'paused' ? 'paused' : r.kind === 'stalled' ? 'taken_over' : 'running'),
    h('span', { class: 'what' }, member ? h('a', { href: memberHref(run.id, member.id) }, h('b', {}, r.who)) : h('b', {}, r.who),
      r.kind === 'progress' ? ': ' : ' ', say),
    when(r.at));
}

// A running task, as Claude shows a subagent: one status line that updates in place, with a
// spinner while the member works and the earlier updates folded behind a count.
function glyph(state) {
  if (state === 'running' || state === 'waiting') return h('span', { class: 'spin', role: 'img', 'aria-label': 'working' });
  if (state === 'done') return icon('check', 'ok');
  if (state === 'failed' || state === 'cancelled') return icon('x', 'bad');
  return dot(state);
}

function taskLine({ state, who, steps, open }) {
  const latest = steps.at(-1);
  const shown = S.open.has(open);
  return [glyph(state),
    h('div', { class: 'body' },
      h('div', { class: 'line' }, who ? [who, ' '] : null, h('span', { class: 'what' }, latest.text ?? describe(latest))),
      h('div', { class: 'meta' }, when(latest.at), steps.length > 1 ? [' · ', h('button', { type: 'button', class: 'more', 'aria-expanded': String(shown),
        onclick: () => { if (S.open.has(open)) S.open.delete(open); else S.open.add(open); schedule(); } },
        shown ? 'Hide earlier' : `${steps.length - 1} earlier ${steps.length === 2 ? 'update' : 'updates'}`)] : null),
      shown ? h('ol', { class: 'steps' }, steps.slice(0, -1).slice(-30).map((st) => h('li', {}, h('span', {}, st.text ?? describe(st)), ' ', when(st.at)))) : null)];
}

const DEPLOY_EVERY_MS = 2000;

// The project's deploy button, for a human only: it shows the command, asks before running it,
// then follows the deploy. Like the changes panel it looks again when a 'deploy' event arrives
// (the server writes one when a deploy starts, makes progress and ends); there is no polling.
function deployPanel(runId) {
  const el = h('section', { class: 'card deploy', hidden: true });
  const c = { cue: null, at: 0, timer: null, busy: false, dead: false, d: null, readOnly: false };
  const key = `deploy${runId}`;
  const label = { running: 'Deploying…', ok: 'Deployed', failed: 'Deploy failed', idle: '' };
  function draw() {
    const d = c.d;
    el.hidden = !d?.command;
    if (el.hidden) return;
    const running = d.state === 'running';
    const open = S.expanded.has(key);
    el.replaceChildren(
      h('div', { class: 'card-head' }, h('h2', {}, 'Deploy'),
        d.state !== 'idle' ? pill(d.state === 'ok' ? 'done' : d.state) : null),
      h('p', { class: 'deploy-cmd' }, h('code', {}, d.command)),
      ...present(c.readOnly ? h('p', { class: 'note' }, 'Read-only here; deploy from the serve that owns this run.') : null),
      h('div', { class: 'deploy-row' },
        h('button', { type: 'button', class: 'btn primary small', disabled: running || c.readOnly, onclick: start }, running ? 'Deploying…' : 'Deploy'),
        d.state !== 'idle' ? h('span', { class: 'muted' }, label[d.state], d.exit != null && d.state === 'failed' ? ` (exit ${d.exit})` : '',
          d.finished_at ? [' ', when(d.finished_at)] : null, d.by ? ` by ${d.by}` : '') : null),
      ...present(d.output ? [
        h('pre', { class: `deploy-out${open ? '' : ' clamped'}` }, d.output),
        isLongText(d.output) ? h('button', { type: 'button', class: 'show-more', onclick: () => {
          if (S.expanded.has(key)) S.expanded.delete(key); else S.expanded.add(key);
          draw();
        } }, open ? 'Show less' : 'Show more') : null] : null));
  }
  async function start() {
    const d = c.d;
    if (!confirm(`Run this in ${shortPath(S.state?.run?.project ?? S.detail?.run?.project ?? '')}?\n\n${d.command}`)) return;
    try { c.d = await api(`/api/runs/${runId}/deploy`, { command: d.command }); draw(); } catch (err) { flash(err.message); look(); }
  }
  async function look() {
    c.timer = null;
    if (c.busy || c.dead) return;
    c.busy = true;
    c.at = Date.now();
    try { c.d = await api(`/api/runs/${runId}/deploy`); draw(); } catch { /* the panel stays as it was */ } finally { c.busy = false; }
  }
  return {
    el,
    stop: () => { c.dead = true; clearTimeout(c.timer); },
    update(cue, readOnly) {
      if (readOnly !== c.readOnly) { c.readOnly = readOnly; if (c.d) draw(); }
      if (cue === c.cue || c.timer) return;
      c.cue = cue;
      c.timer = setTimeout(look, Math.max(0, c.at + DEPLOY_EVERY_MS - Date.now()));
    }
  };
}

function drawRun() {
  const run = S.state?.run?.id === S.route.run ? S.state.run : S.detail?.run;
  if (!run) return $('view').replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
  const members = S.state?.run?.id === S.route.run ? S.state.members : S.detail.members;
  if (!S.panel) {
    S.panel = { head: h('header', { class: 'run-head' }), tree: h('ul', { class: 'tree' }), talk: h('ol', { class: 'talk' }), tasks: h('ul', { class: 'tasks' }),
                member: h('aside', { class: 'card member' }), wrap: null, controls: null, deploy: deployPanel(run.id) };
    S.panel.wrap = h('div', { class: 'run' },
      h('div', { class: 'run-main' },
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Team')), S.panel.tree),
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Conversation')), S.panel.tasks, S.panel.talk)),
      h('div', { class: 'run-side' }, S.panel.member));
    $('view').replaceChildren(S.panel.head, S.panel.deploy.el, S.panel.wrap);
  }
  S.panel.deploy.update(S.model.events.findLast((e) => e.kind === 'deploy')?.id ?? 0, Boolean(run.read_only_note));
  S.panel.wrap.classList.toggle('has-member', S.route.member != null);
  S.panel.head.replaceChildren(...present(
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Activity'), icon('chevron'), h('span', { title: run.project }, shortPath(run.project)),
      icon('chevron'), h('span', {}, `Run #${run.id}`)),
    h('h1', {}, runTitle(run) || `Run ${run.id}`),
    fullText(S.panel, `run${run.id}`, run.task, 'Full brief'),
    h('div', { class: 'facts-row' }, present(pill(run.status), h('span', { class: 'pill quiet' }, `${members.length} ${members.length === 1 ? 'teammate' : 'teammates'}`),
      money(run.cost_usd) ? h('span', { class: 'pill quiet' }, money(run.cost_usd)) : null,
      tokens(run.tokens) ? h('span', { class: 'pill quiet' }, tokens(run.tokens)) : null,
      run.created_at ? h('span', { class: 'pill quiet' }, 'started ', when(run.created_at), run.status === 'running' ? null : '') : null)),
    run.read_only_note ? h('div', { class: 'banner' }, icon('lock'), h('span', {}, 'Read-only here. ', run.read_only_note)) : null));
  // A member below an entered one works in that member's project, so the project flows down the tree.
  const scope = new Map();
  const node = (m, inherited = null) => {
    const project = m.project ?? inherited;
    scope.set(m.id, project);
    return h('li', {},
      h('a', { href: memberHref(run.id, m.id), class: `mate${m.id === S.route.member ? ' current' : ''}` },
        avatar(m.name, { agent: m.agent }),
        h('span', { class: 'body' },
          h('div', { class: 'name' }, m.name,
            m.project ? [' ', h('span', { class: 'pill quiet', title: m.project }, `team ${shortPath(m.project)}`)] : null,
            m.alias ? [' ', h('span', { class: 'muted' }, `as ${m.alias}`)] : null),
          h('div', { class: 'task' }, taskTitle(m.task))),
        pill(m.state)),
      m.children.length ? h('ul', {}, m.children.map((c) => node(c, project))) : null);
  };
  S.panel.tree.replaceChildren(...memberTree(members).map((m) => node(m)));
  S.scope = scope;
  const states = new Map(members.map((x) => [x.id, x.state]));
  const running = tasks(S.model.events).filter((t) => states.has(t.member_id))
    .sort((a, b) => Number(TERMINAL.has(states.get(a.member_id))) - Number(TERMINAL.has(states.get(b.member_id))) || b.latest.at - a.latest.at);
  S.panel.tasks.hidden = !running.length;
  S.panel.tasks.replaceChildren(...running.map((t) => h('li', { class: `task${TERMINAL.has(states.get(t.member_id)) ? ' ended' : ''}` },
    taskLine({ state: states.get(t.member_id), who: h('a', { href: memberHref(run.id, t.member_id) }, h('b', {}, t.member)),
               steps: t.steps, open: `t${t.member_id}` }))));
  const talk = conversation(S.model).slice(-300);
  const atEnd = S.panel.talk.scrollHeight - S.panel.talk.scrollTop - S.panel.talk.clientHeight < 40;
  if (talk.length) keyed(S.panel.talk, talk, (r) => r.key, (r) => convoRow(r, run));
  else S.panel.talk.replaceChildren(h('li', { class: 'empty' }, 'The team has not said anything yet.'));
  if (atEnd) S.panel.talk.scrollTop = S.panel.talk.scrollHeight;
  const m = members.find((x) => x.id === S.route.member);
  if (m) drawMember(run, m);
  else {
    S.panel.controls = null;
    S.panel.member.replaceChildren(h('div', { class: 'empty' },
      h('p', { class: 'big' }, 'Pick a teammate'),
      h('p', {}, 'Read along as they work, send a message, or pause them.'),
      h('div', { class: 'stack' }, members.slice(0, 6).map((x) => avatar(x.name, { agent: x.agent })))));
  }
}

function drawMember(run, m) {
  const p = S.panel;
  if (p.controls?.id !== m.id) {
    p.controls = memberControls(m);
    p.changes?.stop();
    p.changes = changesPanel(m.id);
    p.mhead = h('div', { class: 'mhead' });
    p.mtask = h('p', { class: 'mtask' });
    p.mfull = h('div');
    p.result = h('div', { class: 'result' });
    p.facts = h('dl', { class: 'facts' });
    p.transcript = h('ol', { class: 'transcript' });
    p.task = h('div', { class: 'progress now' });
    p.member.replaceChildren(
      h('a', { class: 'back', href: `#/run/${run.id}` }, icon('back'), 'Team'),
      p.mhead, p.mtask, p.mfull, p.result, p.controls.el, p.changes.el,
      h('details', { class: 'more-facts' }, h('summary', {}, icon('chevron'), 'Details'), p.facts),
      ...extras(m), h('h3', { class: 'subhead' }, 'Transcript'), p.task, p.transcript);
  }
  const hn = harness(m.agent);
  p.mhead.replaceChildren(avatar(m.name, { agent: m.agent, size: 'lg' }),
    h('div', { class: 'body' }, h('h2', {}, m.name),
      h('div', { class: 'tags' }, present(pill(m.state), hn ? h('span', { class: `pill ${hn.cls}` }, hn.label) : null,
        m.model ? h('span', { class: 'pill quiet' }, m.model) : null, m.read_only ? h('span', { class: 'pill quiet' }, 'read-only') : null))));
  p.mtask.textContent = taskTitle(m.task);
  p.mfull.replaceChildren(...present(fullText(p, `m${m.id}`, m.task, 'Full task')));
  p.result.replaceChildren(...present(m.result
    ? h('div', { class: `banner ${m.result.status === 'ok' ? 'info' : ''}`.trim() }, icon(m.result.status === 'ok' ? 'spark' : 'x'),
      h('span', {}, `Finished${m.result.status === 'ok' ? '' : ` (${m.result.status})`}`, m.result.summary ? `: ${m.result.summary}` : ''))
    : null));
  const scopeProject = S.scope?.get(m.id) ?? null;
  const deny = scopeProject != null ? S.detail?.deny_paths_by_project?.[scopeProject] : S.detail?.deny_paths;
  const denyLabel = scopeProject != null ? `deny_paths (${shortPath(scopeProject)})` : 'deny_paths';
  p.facts.replaceChildren(...[
    ['harness', m.agent ?? '—'], ['model', m.model ?? '—'], ['workspace', m.workspace ?? 'project folder'],
    ['read-only', m.read_only == null ? '—' : m.read_only ? 'yes' : 'no'], [denyLabel, deny ? deny.join(', ') || 'none' : '—'],
    ['cost', money(m.cost_usd) ?? '—'], ['tokens', m.tokens ? String(m.tokens) : '—']
  ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  p.controls.update(run, m);
  // A new event for this member, or a state change, is the cue to look again; the panel throttles.
  p.changes.update(`${m.state}:${S.model.events.findLast((e) => e.member_id === m.id)?.id ?? 0}`);
  const mine = tasks(S.model.events.filter((e) => e.member_id === m.id))[0];
  p.task.hidden = !mine;
  if (mine) p.task.replaceChildren(...taskLine({ state: m.state, steps: mine.steps, open: `s${m.id}` }));
  const rows = [
    ...S.model.events.filter((e) => e.member_id === m.id && e.kind !== 'tool_result' && e.kind !== 'progress' && !isProgressEcho(e)
      && !(e.kind === 'tool_call' && /^report_progress\b/.test(describe(e)))).map((e) => ({ at: e.at, key: `e${e.id}`, e })),
    ...S.model.messages.filter((x) => x.to_member === m.id && !isProgressReport(x)).map((x) => ({ at: x.at, key: `m${x.id}`, x }))
  ].sort((a, b) => a.at - b.at).slice(-400);
  if (rows.length) keyed(p.transcript, rows, (r) => r.key, (r) => (r.e ? eventRow(r.e) : messageRow(r.x)));
  else p.transcript.replaceChildren(h('li', { class: 'sys' }, h('span', { class: 'what' }, 'Nothing yet.')));
}

const CHANGES_EVERY_MS = 4000;
const CHANGES_MAX_LINES = 300;

// The member's changes so far: a file list with +/- counts, and tapping a file folds its hunks
// open. It looks again when `update` is given a new cue (an event for this member arrived), at
// most once per CHANGES_EVERY_MS: the SSE stream is the clock, there is no polling loop here.
function changesPanel(memberId) {
  const el = h('section', { class: 'changes', hidden: true });
  const c = { el, cue: null, at: 0, timer: null, busy: false, sig: null, dead: false };
  const key = (path) => `chg${memberId}:${path}`;
  const line = (l) => h('div', { class: `dl ${l.kind}` }, l.text || ' ');
  function fileRow(f) {
    const open = () => S.expanded.has(key(f.path));
    const body = h('pre', { class: 'diff', hidden: !open() });
    const fill = () => {
      const all = S.expanded.has(`${key(f.path)}:all`);
      const lines = all ? f.lines : f.lines.slice(0, CHANGES_MAX_LINES);
      body.replaceChildren(...lines.map(line), ...present(lines.length < f.lines.length
        ? h('button', { type: 'button', class: 'show-more', onclick: () => { S.expanded.add(`${key(f.path)}:all`); fill(); } },
          `Show ${f.lines.length - lines.length} more lines`) : null));
    };
    const head = h('button', { type: 'button', class: 'file', 'aria-expanded': String(open()), onclick: () => {
      if (open()) S.expanded.delete(key(f.path)); else S.expanded.add(key(f.path));
      head.setAttribute('aria-expanded', String(open()));
      body.hidden = !open();
      if (open()) fill();
    } }, h('span', { class: 'path' }, f.path), h('span', { class: 'counts' }, changeCounts(f)));
    if (open()) fill();
    return h('li', {}, head, body);
  }
  function show(r) {
    const sig = `${r.diff.length}:${r.files.length}:${r.live}`;
    if (sig === c.sig) return;
    c.sig = sig;
    el.hidden = r.files.length === 0;
    const parsed = splitDiff(r.diff);
    const byPath = new Map(parsed.map((f) => [f.path, f]));
    const total = r.files.reduce((n, f) => [n[0] + f.added, n[1] + f.removed], [0, 0]);
    el.replaceChildren(
      h('h3', { class: 'subhead' }, r.live ? 'Changes so far' : 'Changes',
        h('span', { class: 'counts' }, `${r.files.length} ${r.files.length === 1 ? 'file' : 'files'} ${changeCounts({ added: total[0], removed: total[1] })}`)),
      h('ul', { class: 'files' }, r.files.map((f) => fileRow(byPath.get(f.path) ?? { ...f, lines: [] }))),
      ...present(r.truncated ? h('p', { class: 'note' }, 'The diff is cut here; later files are listed without their lines.') : null));
  }
  async function look() {
    c.timer = null;
    if (c.busy || c.dead) return;
    c.busy = true;
    c.at = Date.now();
    try { show(await api(`/api/members/${memberId}/changes`)); } catch { /* the section stays as it was */ } finally { c.busy = false; }
  }
  return {
    el,
    stop: () => { c.dead = true; clearTimeout(c.timer); },
    update(cue) {
      if (cue === c.cue || c.timer) return;
      c.cue = cue;
      const wait = Math.max(0, c.at + CHANGES_EVERY_MS - Date.now());
      c.timer = setTimeout(look, wait);
    }
  };
}

function eventRow(e) {
  const said = describe(e);
  if (e.kind === 'text' || e.kind === 'user') {
    return h('li', { class: 'say' }, h('span', { class: 'what' }, said), h('span', { class: 'stamp' }, when(e.at)));
  }
  if (e.kind === 'tool_call' || e.kind === 'command') {
    const full = h('pre', { hidden: true });
    const li = h('li', { class: 'tool', role: 'button', tabindex: '0', 'aria-expanded': 'false' },
      h('div', { class: 'line' }, icon(e.kind === 'command' ? 'term' : 'tool'), h('span', { class: 'what' }, said), h('span', { class: 'stamp' }, when(e.at))),
      full);
    const toggle = async () => {
      if (full.hidden && !full.textContent) {
        const body = e.body?.clipped ? (await api(`/api/events/${e.id}`).catch(() => e)).body : e.body;
        full.textContent = JSON.stringify(body, null, 2);
      }
      full.hidden = !full.hidden;
      li.setAttribute('aria-expanded', String(!full.hidden));
    };
    li.addEventListener('click', (ev) => { if (!full.contains(ev.target)) toggle(); });
    li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    return li;
  }
  const say = (PHRASE[e.kind] ?? ((s) => s || e.kind.replace(/_/g, ' ')))(said);
  return h('li', { class: 'sys' }, dot(e.kind === 'paused' ? 'paused' : e.kind === 'finished' ? 'done' : 'running'),
    h('span', { class: 'what' }, say), h('span', { class: 'stamp' }, when(e.at)));
}

const messageRow = (x) => h('li', { class: 'inbox' }, avatar(x.from_name, { human: x.from_kind === 'human', size: 'sm' }),
  h('div', { class: 'msg' }, h('div', { class: 'who-line' }, h('b', {}, x.from_name), ` · ${x.from_kind} · `, when(x.at)),
    bubble(`m${x.id}`, x.text)));

function memberControls(m) {
  const base = `/api/members/${m.id}`;
  const text = h('textarea', { rows: '1', placeholder: `Message ${m.name}`, 'aria-label': `Message ${m.name}` });
  const note = h('input', { type: 'text', class: 'note-input', placeholder: 'Add a note for when it resumes (optional)', 'aria-label': 'Resume note' });
  const subtree = h('input', { type: 'checkbox', 'aria-label': 'Include its reports' });
  const send = h('button', { type: 'submit', class: 'send', 'aria-label': 'Send' }, icon('send'));
  const b = {
    pause: button('Pause', `${base}/pause`, () => ({ subtree: subtree.checked }), { icon: 'pause', done: 'Pausing after this step' }),
    now: button('Pause now', `${base}/pause`, () => ({ now: true, subtree: subtree.checked }), { icon: 'now', done: 'Paused' }),
    resume: button('Resume', `${base}/resume`, () => ({ subtree: subtree.checked, note: note.value || null }), { icon: 'play', cls: 'primary', done: 'Resumed' }),
    cancel: button('Cancel', `${base}/cancel`, () => ({ subtree: subtree.checked }),
                   { icon: 'x', cls: 'danger', confirm: `Cancel ${m.name}? Its workspace is kept.`, done: 'Cancelled' })
  };
  const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 160)}px`; };
  const submit = () => {
    if (!text.value.trim() || text.disabled) return;
    act(`${base}/message`, { text: text.value }, `Sent to ${m.name}`).then((r) => { if (r) { text.value = ''; grow(); } });
  };
  text.addEventListener('input', grow);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  const form = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } }, text, send);
  const el = h('div', {}, form,
    h('div', { class: 'ctl' }, b.pause, b.now, b.resume, b.cancel, h('label', { class: 'switch' }, subtree, 'With its reports')), note,
    h('div', { class: 'takeover' }, icon('term'),
      h('div', { class: 'body' }, h('div', { class: 'label' }, 'Take over in a terminal'), h('code', {}, m.attach)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Copy command',
                    onclick: () => navigator.clipboard?.writeText(m.attach).then(() => flash('Copied'), () => flash('Could not copy')) }, icon('copy'))));
  return {
    id: m.id, el,
    update(run, cur) {
      const off = !run.steerable || TERMINAL.has(cur.state);
      for (const x of [text, send, b.cancel]) x.disabled = off;
      text.placeholder = !run.steerable ? 'This run is read-only here' : TERMINAL.has(cur.state) ? `${m.name} has finished` : `Message ${m.name}`;
      b.pause.disabled = b.now.disabled = off || cur.state === 'paused';
      b.resume.disabled = !run.steerable || cur.state !== 'paused';
      note.hidden = !run.steerable || cur.state !== 'paused';
      b.resume.hidden = cur.state !== 'paused';
      b.pause.hidden = b.now.hidden = cur.state === 'paused';
    }
  };
}

// Sections later tasks add to the member panel (devices, designs).
function extras(m) {
  return [devices(m), designs(m)];
}

function devices(m) {
  const section = h('section', { class: 'devices', hidden: true });
  api(`/api/members/${m.id}/devices`).then(({ enabled, targets }) => {
    if (!enabled) return;
    const pick = h('select', { 'aria-label': 'Loupe target' }, h('option', { value: '' }, 'Pick a device'));
    const shown = h('div');
    const show = (id) => {
      const img = h('img', { alt: `Screenshot of ${id}`, src: `/api/loupe/screenshot?target=${encodeURIComponent(id)}` });
      shown.replaceChildren(img, h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', onclick: () => { img.src = `/api/loupe/screenshot?target=${encodeURIComponent(id)}&t=${Date.now()}`; } }, 'Refresh'),
        h('a', { class: 'btn small', href: `/loupe/open?target=${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Open live view in loupe')));
    };
    pick.addEventListener('change', () => pick.value && show(pick.value));
    section.append(h('h3', { class: 'subhead' }, 'Devices'), pick, shown);
    section.hidden = false;
    targets.forEach((t, i) => { if (i === 0) show(t.id); });
    api('/api/loupe').then(({ targets: all }) => all.forEach((t) => pick.append(h('option', { value: t.id }, `${t.label} (${t.id})`))), () => {});
  }, () => {});
  return section;
}

function designs(m) {
  const section = h('section', { class: 'designs', hidden: true });
  api(`/api/members/${m.id}/designs`).then(({ enabled, refs }) => {
    if (!enabled || !refs.length) return;
    section.append(h('h3', { class: 'subhead' }, 'Designs'), ...refs.map((r) => h('figure', {},
      h('img', { loading: 'lazy', alt: `Figma node ${r.node_id}`,
                 src: `/api/figma/image?file=${encodeURIComponent(r.file_key)}&node=${encodeURIComponent(r.node_id)}` }),
      h('figcaption', {}, `node ${r.node_id} · file ${r.file_key}`))));
    section.hidden = false;
  }, () => {});
  return section;
}

// The sidebar is a drawer on narrow screens.
function setDrawer(on) {
  document.body.classList.toggle('drawer', on);
  $('menu').setAttribute('aria-expanded', String(on));
  $('scrim').hidden = !on;
}
$('menu').addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer')));
$('scrim').addEventListener('click', () => setDrawer(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });

// Relative times ("4m") age in place without a redraw.
setInterval(() => { for (const t of document.querySelectorAll('time[data-at]')) t.textContent = ago(Number(t.dataset.at)); }, 30_000);

$('search').addEventListener('input', (e) => { S.query = e.target.value; schedule(); });
addEventListener('hashchange', open);
open();

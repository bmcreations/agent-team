import { describe, memberTree, activity, countLabel, todayCount, mergeTimeline, conversation, matches, TERMINAL } from './feed.js';

// Member output is untrusted. Every node is built here with createElement and text nodes;
// nothing from the API is parsed as HTML.
const $ = (id) => document.getElementById(id);
const S = { gen: 0, failed: null, route: null, state: null, detail: null, model: { events: [], messages: [] }, source: null, query: '', panel: null };

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
const flash = (text) => { $('flash').textContent = text; };
const act = (path, body, done) => api(path, body).then((r) => { flash(done); return r; }, (err) => { flash(err.message); });
function button(label, path, body, confirmText = null) {
  return h('button', { type: 'button', onclick: () => {
    if (confirmText && !confirm(confirmText)) return;
    act(path, typeof body === 'function' ? body() : body, `${label}: sent`);
  } }, label);
}

const money = (usd) => (usd ? `$${usd.toFixed(2)}` : '—');
const clock = (at) => new Date(at).toLocaleTimeString();
const tag = (agent) => (agent ? h('span', { class: 'tag' }, agent) : null);
const state = (s) => h('span', { class: `state ${s}` }, s.replace('_', ' '));
const projectOf = (runId) => S.state?.runs.find((r) => r.id === runId)?.project ?? null;

function parseRoute() {
  const m = /^#\/run\/(\d+)(?:\/member\/(\d+))?$/.exec(location.hash);
  return m ? { run: Number(m[1]), member: m[2] ? Number(m[2]) : null } : { run: null, member: null };
}

// Each view loads a tail over HTTP, then streams from that tail's cursor.
async function open() {
  const route = parseRoute();
  if (S.route && route.run === S.route.run && route.run != null) {   // another member, same run
    S.route = route;
    return schedule();
  }
  S.source?.close();
  const gen = ++S.gen;
  Object.assign(S, { route, failed: null, panel: null, detail: null, model: { events: [], messages: [] } });
  try {
    const tl = await api(route.run ? `/api/runs/${route.run}/timeline?limit=500` : '/api/timeline?limit=500');
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
    on('timeline', (data) => { S.model = mergeTimeline(S.model, data); });
    src.onopen = () => { $('conn').textContent = 'live'; };
    src.onerror = () => { $('conn').textContent = 'reconnecting…'; };
    S.source = src;
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
  if (S.failed) $('view').replaceChildren(h('p', { class: 'note' }, S.failed));
  else if (S.route.run) drawRun(); else drawActivity();
}

function drawSidebar() {
  const live = S.state?.live ?? [];
  const byProject = new Map();
  for (const run of S.state?.runs ?? []) {
    const members = live.filter((m) => m.run_id === run.id);
    if (S.query && !matches(S.query, run.project, run.task, run.root, ...members.map((m) => m.name))) continue;
    byProject.set(run.project, [...(byProject.get(run.project) ?? []), { run, members }]);
  }
  $('projects').replaceChildren(...[...byProject].map(([project, items]) => h('div', { class: 'project' },
    h('h2', { title: project }, project.split('/').filter(Boolean).at(-1) ?? project),
    h('ul', {}, items.map(({ run, members }) => h('li', {},
      h('a', { href: `#/run/${run.id}` }, `#${run.id} ${run.root ?? ''}`), ' ', state(run.status),
      members.length ? h('ul', { class: 'members' }, members.map((m) => h('li', {},
        h('a', { href: `#/run/${m.run_id}/member/${m.id}` }, m.name), ' ', tag(m.agent), ' ', state(m.state)))) : null))))));
}

function drawNeeds() {
  const n = S.state?.needs ?? { questions: [], stalled: [], cost_capped: [] };
  const items = [
    ...n.questions.map((q) => ({ key: `q${q.id}`, build: () => questionCard(q) })),
    ...n.stalled.map((s) => ({ key: `s${s.member_id}.${s.at}`, build: () => h('div', { class: 'card' },
      h('a', { href: `#/run/${s.run_id}/member/${s.member_id}` }, s.member),
      ` has been quiet for ${Math.round((s.quiet_s ?? 0) / 60)} min`,
      button('Pause now', `/api/members/${s.member_id}/pause`, { now: true }),
      button('Cancel', `/api/members/${s.member_id}/cancel`, {}, `Cancel ${s.member}?`)) })),
    ...n.cost_capped.map((c) => ({ key: `c${c.run_id}.${c.max_cost_usd}`, build: () => capCard(c) }))
  ];
  const section = $('needs');
  section.hidden = items.length === 0;
  if (!section.firstChild) section.append(h('h2', {}, 'Needs you'), h('div', { class: 'cards' }));
  keyed(section.lastChild, items, (i) => i.key, (i) => i.build());
}

function questionCard(q) {
  const input = h('input', { type: 'text', placeholder: 'Your answer', 'aria-label': `Answer ${q.member}` });
  const send = (answer) => act(`/api/questions/${q.id}/answer`, { answer }, 'answered');
  return h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) send(input.value); } },
    h('div', {}, h('a', { href: `#/run/${q.run_id}/member/${q.member_id}` }, q.member), ' asks: ', h('q', {}, q.question)),
    (q.options ?? []).map((o) => h('button', { type: 'button', onclick: () => send(o) }, o)),
    input, h('button', { type: 'submit' }, 'Answer'));
}

function capCard(c) {
  const input = h('input', { type: 'number', min: '0', step: '0.5', value: String((c.max_cost_usd ?? 0) * 2), 'aria-label': 'New cap in dollars' });
  return h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    act(`/api/members/${c.member_id}/resume`, { subtree: true, max_cost_usd: Number(input.value) }, 'resumed');
  } },
    `Run #${c.run_id} paused at its cost cap: ${money(c.cost_usd)} of ${money(c.max_cost_usd)}. New cap $`,
    input, h('button', { type: 'submit' }, 'Raise and resume'));
}

function drawActivity() {
  const entries = activity(S.model.events).reverse()
    .filter((e) => !S.query || matches(S.query, e.member, projectOf(e.run_id)));
  $('view').replaceChildren(
    h('h1', {}, 'Activity'),
    h('p', { class: 'muted' }, `${todayCount(S.model.events)} tool calls today`),
    h('ol', { class: 'feed' }, entries.slice(0, 200).map((e) => h('li', { class: 'card' },
      h('div', {}, h('a', { href: `#/run/${e.run_id}/member/${e.member_id}` }, e.member), h('span', { class: 'muted' }, ` run #${e.run_id}`)),
      h('ul', {}, e.items.slice(-20).map((it) => h('li', {},
        h('span', { class: 'kind' }, it.kind), ' ', it.label, it.count > 1 ? h('span', { class: 'count' }, ` ${countLabel(it.count)}`) : null)))))));
}

function drawRun() {
  const run = S.state?.run?.id === S.route.run ? S.state.run : S.detail?.run;
  if (!run) return $('view').replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const members = S.state?.run?.id === S.route.run ? S.state.members : S.detail.members;
  if (!S.panel) {
    S.panel = { head: h('header'), tree: h('ul', { class: 'tree' }), talk: h('ol', { class: 'talk' }), member: h('aside'), controls: null };
    $('view').replaceChildren(S.panel.head, h('div', { class: 'run' },
      h('div', {}, h('h2', {}, 'Team'), S.panel.tree, h('h2', {}, 'Conversation'), S.panel.talk), S.panel.member));
  }
  S.panel.head.replaceChildren(...present(
    h('h1', {}, `Run #${run.id}: `, run.task),
    h('p', { class: 'muted' }, run.project, ' · ', run.status, ' · ', money(run.cost_usd), run.tokens ? ` · ${run.tokens} tokens` : ''),
    run.read_only_note ? h('p', { class: 'note' }, 'Read-only: ', run.read_only_note) : null));
  const node = (m) => h('li', {}, h('a', { href: `#/run/${run.id}/member/${m.id}`, class: m.id === S.route.member ? 'current' : null }, m.name),
    ' ', tag(m.agent), ' ', state(m.state), m.children.length ? h('ul', {}, m.children.map(node)) : null);
  S.panel.tree.replaceChildren(...memberTree(members).map(node));
  keyed(S.panel.talk, conversation(S.model).slice(-300), (r) => r.key,
    (r) => h('li', { class: r.type }, h('time', {}, clock(r.at)), ' ', h('b', {}, r.who), ' ', r.text));
  const m = members.find((x) => x.id === S.route.member);
  if (m) drawMember(run, m);
  else { S.panel.controls = null; S.panel.member.replaceChildren(h('p', { class: 'muted' }, 'Pick a member to read its transcript and steer it.')); }
}

function drawMember(run, m) {
  const p = S.panel;
  if (p.controls?.id !== m.id) {
    p.controls = memberControls(m);
    p.facts = h('dl', { class: 'facts' });
    p.transcript = h('ol', { class: 'transcript' });
    p.member.replaceChildren(h('h2', {}, m.name), p.facts, p.controls.el, ...extras(m), h('h3', {}, 'Transcript'), p.transcript);
  }
  const deny = S.detail?.deny_paths;
  p.facts.replaceChildren(...[
    ['state', m.state], ['harness', m.agent ?? '—'], ['model', m.model ?? '—'], ['workspace', m.workspace ?? 'project folder'],
    ['read-only', m.read_only == null ? '—' : m.read_only ? 'yes' : 'no'], ['deny_paths', deny ? deny.join(', ') || 'none' : '—'],
    ['cost', money(m.cost_usd)], ['tokens', m.tokens ? String(m.tokens) : '—'], ['task', m.task],
    ['result', m.result ? `${m.result.status}: ${m.result.summary ?? ''}` : '—']
  ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  p.controls.update(run, m);
  const rows = [
    ...S.model.events.filter((e) => e.member_id === m.id).map((e) => ({ at: e.at, key: `e${e.id}`, e })),
    ...S.model.messages.filter((x) => x.to_member === m.id).map((x) => ({ at: x.at, key: `m${x.id}`, x }))
  ].sort((a, b) => a.at - b.at).slice(-400);
  keyed(p.transcript, rows, (r) => r.key, (r) => (r.e ? eventRow(r.e) : messageRow(r.x)));
}

function eventRow(e) {
  const text = h('span', { class: 'text' }, describe(e));
  const full = h('pre', { hidden: true });
  const li = h('li', { class: `ev ${e.kind}` }, h('time', {}, clock(e.at)), ' ', h('span', { class: 'kind' }, e.kind), ' ', text, full);
  if (e.kind === 'tool_call' || e.kind === 'tool_result' || e.kind === 'command') {
    li.classList.add('collapsed');
    li.addEventListener('click', async () => {
      if (full.hidden && !full.textContent) {
        const body = e.body?.clipped ? (await api(`/api/events/${e.id}`).catch(() => e)).body : e.body;
        full.textContent = JSON.stringify(body, null, 2);
      }
      full.hidden = !full.hidden;
    });
  }
  return li;
}

const messageRow = (x) => h('li', { class: 'msg' }, h('time', {}, clock(x.at)), ' ',
  h('b', {}, `${x.from_name} (${x.from_kind})`), ' ', x.text);

function memberControls(m) {
  const base = `/api/members/${m.id}`;
  const text = h('textarea', { rows: '2', placeholder: `Message ${m.name}`, 'aria-label': `Message ${m.name}` });
  const note = h('input', { type: 'text', placeholder: 'Note for resume (optional)', 'aria-label': 'Resume note' });
  const subtree = h('input', { type: 'checkbox' });
  const send = h('button', { type: 'submit' }, 'Send');
  const b = {
    pause: button('Pause', `${base}/pause`, () => ({ subtree: subtree.checked })),
    now: button('Pause now', `${base}/pause`, () => ({ now: true, subtree: subtree.checked })),
    resume: button('Resume', `${base}/resume`, () => ({ subtree: subtree.checked, note: note.value || null })),
    cancel: button('Cancel', `${base}/cancel`, () => ({ subtree: subtree.checked }), `Cancel ${m.name}? Its workspace is kept.`)
  };
  const form = h('form', { onsubmit: (e) => {
    e.preventDefault();
    if (text.value.trim()) act(`${base}/message`, { text: text.value }, 'sent').then((r) => { if (r) text.value = ''; });
  } }, text, send);
  const el = h('div', { class: 'controls' }, form,
    h('div', { class: 'buttons' }, b.pause, b.now, b.resume, b.cancel, h('label', {}, subtree, ' with its reports')), note,
    h('p', { class: 'muted' }, 'Take over in a terminal: ', h('code', {}, m.attach), ' ',
      h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(m.attach).then(() => flash('copied')) }, 'Copy')));
  return {
    id: m.id, el,
    update(run, cur) {
      const off = !run.steerable || TERMINAL.has(cur.state);
      for (const x of [text, send, b.cancel]) x.disabled = off;
      b.pause.disabled = b.now.disabled = off || cur.state === 'paused';
      b.resume.disabled = note.disabled = !run.steerable || cur.state !== 'paused';
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
      shown.replaceChildren(img, h('p', {},
        h('button', { type: 'button', onclick: () => { img.src = `/api/loupe/screenshot?target=${encodeURIComponent(id)}&t=${Date.now()}`; } }, 'Refresh'),
        ' ', h('a', { href: `/loupe/open?target=${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open live view in loupe')));
    };
    pick.addEventListener('change', () => pick.value && show(pick.value));
    section.append(h('h3', {}, 'Devices'), pick, shown);
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
    section.append(h('h3', {}, 'Designs'), ...refs.map((r) => h('figure', {},
      h('img', { loading: 'lazy', alt: `Figma node ${r.node_id}`,
                 src: `/api/figma/image?file=${encodeURIComponent(r.file_key)}&node=${encodeURIComponent(r.node_id)}` }),
      h('figcaption', { class: 'muted' }, `node ${r.node_id} · file ${r.file_key}`))));
    section.hidden = false;
  }, () => {});
  return section;
}

$('search').addEventListener('input', (e) => { S.query = e.target.value; schedule(); });
addEventListener('hashchange', open);
open();

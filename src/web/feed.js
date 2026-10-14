// Pure helpers for the page. No DOM here, so node --test can import this file.

export const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const json = (v) => (v == null ? '' : JSON.stringify(v));

// One line for an event, as the transcript and the activity feed show it. The page puts it
// into the DOM as text, so markup in it stays markup.
export function describe(e) {
  const b = e.body ?? {};
  switch (e.kind) {
    case 'text': case 'user': case 'progress': return b.text ?? '';
    case 'tool_call': return `${b.name ?? 'tool'} ${clip(oneLine(json(b.args)))}`.trim();
    case 'tool_result': return `${b.name ?? 'tool'} → ${clip(oneLine(typeof b.text === 'string' ? b.text : json(b.result ?? b)))}`;
    case 'command': return clip(oneLine(b.command ?? json(b)));
    case 'titled': return b.title ? `named the run "${b.title}"` : 'cleared the run name';
    case 'delegated': return `delegated to ${b.to}`;
    case 'stalled': return `quiet for ${Math.round((b.quiet_s ?? 0) / 60)} min`;
    case 'cost_cap': return `cost cap: $${(b.cost_usd ?? 0).toFixed(2)} of $${(b.max_cost_usd ?? 0).toFixed(2)}`;
    case 'deploy': return `deploy ${b.state ?? ''}${b.by ? ` by ${b.by}` : ''}`.trim();
    case 'finished': return [b.state ?? b.status, b.summary].filter(Boolean).join(': ');
    default: return b.by ? `by ${b.by}` : '';
  }
}

export function memberTree(members) {
  const byId = new Map(members.map((m) => [m.id, { ...m, children: [] }]));
  const roots = [];
  for (const m of [...byId.values()].sort((a, b) => a.id - b.id)) {
    const parent = m.parent_id == null ? null : byId.get(m.parent_id);
    (parent ? parent.children : roots).push(m);
  }
  return roots;
}

// The Activity feed: one entry per member task, in order of its first event, with its tool
// calls nested under it and identical consecutive calls collapsed into a count.
export function activity(events) {
  const entries = new Map();
  for (const e of events) {
    if (e.kind === 'tool_result') continue;
    let entry = entries.get(e.member_id);
    if (!entry) {
      entry = { member_id: e.member_id, member: e.member, run_id: e.run_id, items: [] };
      entries.set(e.member_id, entry);
    }
    const label = describe(e);
    if (e.kind === 'progress') {
      // A member's progress is one status that updates in place, not a line per update.
      const i = entry.items.findIndex((it) => it.kind === 'progress');
      const count = i < 0 ? 1 : entry.items.splice(i, 1)[0].count + 1;
      entry.items.push({ id: e.id, kind: e.kind, label, count, at: e.at });
      continue;
    }
    const last = entry.items.at(-1);
    if (e.kind === 'tool_call' && last?.kind === 'tool_call' && last.label === label) {
      last.count++;
      last.at = e.at;
      continue;
    }
    entry.items.push({ id: e.id, kind: e.kind, label, count: 1, at: e.at });
  }
  return [...entries.values()];
}

export const countLabel = (n, kind) => (n > 1 ? (kind === 'progress' ? `${n} updates` : `${n} times`) : '');

// Each member's progress as one running task: the latest status, and the earlier ones behind it.
export function tasks(events) {
  const out = new Map();
  for (const e of events) {
    if (e.kind !== 'progress') continue;
    const text = describe(e);
    if (!text) continue;
    let t = out.get(e.member_id);
    if (!t) out.set(e.member_id, t = { member_id: e.member_id, member: e.member, run_id: e.run_id, steps: [] });
    t.steps.push({ id: e.id, text, at: e.at });
  }
  return [...out.values()].map((t) => ({ ...t, latest: t.steps.at(-1), count: t.steps.length }));
}

export function todayCount(events, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return events.filter((e) => e.kind === 'tool_call' && e.at >= start.getTime()).length;
}

// Tool calls in each hour of today, for the chart on the Activity page.
export function hourly(events, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const bins = new Array(24).fill(0);
  for (const e of events) {
    if (e.kind === 'tool_call' && e.at >= start.getTime() && e.at <= now) bins[new Date(e.at).getHours()]++;
  }
  return bins;
}

// "now", "4m", "2h", "3d": how long ago, as the page's rows show it.
export function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const list = (names) => (names.length <= 3 ? names : [...names.slice(0, 2), `${names.length - 2} others`])
  .reduce((out, n, i, all) => out + (i === 0 ? '' : i === all.length - 1 ? ' and ' : ', ') + n, '');

// One sentence for the top of the Activity page: who is working, who is paused, who needs you.
export function summary(live = [], needs = { questions: [] }) {
  const asking = [...new Set(needs.questions.map((q) => q.member))];
  const working = [...new Set(live.filter((m) => (m.state === 'running' || m.state === 'waiting') && !asking.includes(m.name)).map((m) => m.name))];
  const paused = live.filter((m) => m.state === 'paused').length;
  const parts = [];
  if (working.length) parts.push(`${list(working)} ${working.length === 1 ? 'is' : 'are'} working`);
  if (paused) parts.push(`${paused} ${paused === 1 ? 'teammate is' : 'teammates are'} paused`);
  if (asking.length) parts.push(`${list(asking)} ${asking.length === 1 ? 'needs' : 'need'} you`);
  if (!parts.length) return 'All quiet. No team is running right now.';
  const s = list(parts);
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

// What the page holds is bounded: the newest `cap` events and messages.
export function mergeTimeline(model, batch, cap = 2000) {
  const merge = (have, add = []) => {
    const seen = new Set(have.map((r) => r.id));
    const out = have.concat(add.filter((r) => !seen.has(r.id))).sort((a, b) => a.id - b.id);
    return out.length > cap ? out.slice(out.length - cap) : out;
  };
  return { events: merge(model.events, batch.events), messages: merge(model.messages, batch.messages), cursor: batch.cursor ?? model.cursor };
}

// The supervisor also passes each progress update up to the parent as a report message.
export const isProgressReport = (m) => m.from_kind === 'report' && /^progress: /.test(m.text ?? '');
// ...and the member's own transcript echoes it back when the parent reads it.
export const isProgressEcho = (e) => e.kind === 'user' && /^\[from: [^\]\n]* \(report\)\] progress: /.test(e.body?.text ?? '');

// Progress is left out: it shows as each member's running task above the conversation.
const TEAM_KINDS = new Set(['started', 'delegated', 'paused', 'resumed', 'interrupted', 'stalled',
                            'timed_out', 'cost_cap', 'taken_over', 'handed_back', 'finished']);

// The run as a team conversation: messages between members and humans, and the events the
// supervisor records, not tool calls.
export function conversation({ events, messages }) {
  const rows = [
    ...events.filter((e) => TEAM_KINDS.has(e.kind)).map((e) => {
      const said = describe(e);
      return { type: 'event', at: e.at, key: `e${e.id}`, who: e.member, text: said ? `${e.kind}: ${said}` : e.kind,
               kind: e.kind, said };
    }),
    ...messages.filter((m) => !isProgressReport(m)).map((m) => ({ type: 'message', at: m.at, key: `m${m.id}`, who: `${m.from_name} (${m.from_kind}) → ${m.to_name}`, text: m.text,
                              from: m.from_name, from_kind: m.from_kind, to: m.to_name }))
  ];
  return rows.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

export const matches = (query, ...fields) => {
  const q = query.toLowerCase();
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
};

// A single line of someone's text, cut to `max` characters.
export const snippet = (text, max = 120) => {
  const one = oneLine(text ?? '');
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

// A task's headline: its first non-empty line without Markdown heading marks, cut to `max`.
// A brief pasted as the task stays readable; the full text is shown on request.
export const taskTitle = (text, max = 120) => {
  const first = (text ?? '').split('\n').map((l) => l.replace(/^\s*#+\s*/, '').trim()).find(Boolean) ?? '';
  return snippet(first, max);
};

const LABEL = /^(?:brief|objective|goal|task|summary|context)\s*[:\-\u2013\u2014]\s*/i;
const DISCLAIMER = /^(?:exploration|research|investigation|analysis|design|planning|read-only)\b[^.!?]{0,60}?\b(?:only|no implementation|no code|no changes)\b[^.!?]{0,40}[.!?]\s+/i;

const stripLabels = (s) => {
  let out = s.trim();
  for (let prev = null; prev !== out;) { prev = out; out = out.replace(LABEL, '').trim(); }
  return out;
};

// A generic verb or "decide the design" phrase that opens a brief says what kind of work it is,
// not what it is about; the subject reads better first. Whatever follows, minus an article.
const LEAD_IN = /^(?:decide\s+(?:on\s+)?the\s+design\s+(?:for|of)|design|decide\s+(?:on|how\s+to)|render|implement|add(?:\s+support\s+for)?|build|create|investigate|explore|fix|support|make)\s+(?:(?:the\s+new|the|a|an)\s+)?/i;
// A trailing aside after the subject: ", on iOS ...", ", with ...", " — ...", "; ...", ": ...".
const TRAILING = /(?:,\s+on\s|\s+on\s+iOS\b|,\s+with\s|\s\u2014\s|;|:).*$/i;
const words = (s) => s.split(/\s+/).filter(Boolean).length;

function subjectFirst(pick) {
  let out = pick.replace(LEAD_IN, '').trim();
  if (words(out) < 2) return pick;
  const cut = out.replace(TRAILING, '').replace(/[\s,.\u2026]+$/, '');
  if (cut !== out && words(cut) >= 3) out = cut;
  return out;
}

// A readable run name from its brief, for when nobody named the run: the first Markdown
// heading, else the first sentence once any "Exploration only, ..." disclaimer and leading
// "Goal:"-style label are gone. Cut at a word boundary to about `max` characters.
export function deriveTitle(task, max = 60) {
  const text = String(task ?? '');
  let pick = '';
  const heading = /^\s*#+\s*(.+)$/m.exec(text);
  if (heading) pick = stripLabels(heading[1]);
  if (!pick) {
    let flat = stripLabels(oneLine(text.replace(/^\s*#+\s*/gm, '')));
    flat = stripLabels(flat.replace(DISCLAIMER, ''));
    const end = /[.!?](?:\s|$)/.exec(flat);
    pick = end ? flat.slice(0, end.index) : flat;
  }
  pick = oneLine(pick);
  if (!pick) return '';
  pick = subjectFirst(pick);
  if (pick.length > max) {
    const cut = pick.slice(0, max + 1);
    const space = cut.lastIndexOf(' ');
    pick = `${(space > max / 2 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[\s,;:(\-\u2013\u2014]+$/, '')}\u2026`;
  }
  return pick[0].toUpperCase() + pick.slice(1);
}

// What the page calls a run: the title it was given, else one derived from its brief.
export const runTitle = (run) => run.title?.trim() || deriveTitle(run.task);

// Whether a task has more to it than its headline.
export const hasMoreThanTitle = (text) => oneLine(text ?? '') !== taskTitle(text, Infinity);

// The sidebar badge: threads a team still has to answer or finish. `pairs` is the server's grouping.
export const openThreadCount = (pairs) => pairs.reduce((n, g) => n + g.threads.filter((t) => t.state === 'open' || t.state === 'accepted').length, 0);

// Whether a stream batch means the thread list (or thread `id`, when given) is stale.
export const threadTouched = (batch, id = null) =>
  (batch.messages ?? []).some((m) => m.thread_id != null && (id == null || m.thread_id === id))
  || (batch.events ?? []).some((e) => e.kind === 'thread_opened');

// The runs a thread involves: the requester's, the run started for it, and the run of the lead
// that owns it (the same as the second when it started one).
export const threadRunIds = (t) => [...new Set([t.from_run, t.run_id, t.owner?.run_id].filter((r) => r != null))];

// Humans post only to an open or accepted thread, and only through the serve process that owns a
// live run on one side; `runs` are the page's public run rows, any that are absent left out.
export const canPostToThread = (thread, runs) =>
  (thread.state === 'open' || thread.state === 'accepted') &&
  threadRunIds(thread).some((id) => runs.find((r) => r.id === id)?.steerable === true);

// A message too long to show whole in the conversation: a finished report or a delegated brief
// can run to thousands of lines, which made a phone scroll for tens of thousands of pixels.
export const CLAMP_LINES = 6;
export const isLongText = (text) => {
  const t = String(text ?? '');
  return t.length > 480 || t.split('\n').length > CLAMP_LINES;
};

// A unified diff as one entry per file, each line tagged with its kind so the page can tint it
// by class: 'meta' (file headers), 'hunk' (@@), 'add', 'del', 'ctx'. Counts exclude headers.
export function splitDiff(diff) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const raw of String(diff ?? '').split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (head) {
      cur = { path: head[2], added: 0, removed: 0, lines: [{ kind: 'meta', text: raw }] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('@@')) { inHunk = true; cur.lines.push({ kind: 'hunk', text: raw }); continue; }
    if (!inHunk) { cur.lines.push({ kind: 'meta', text: raw }); continue; }
    if (raw.startsWith('+')) { cur.added++; cur.lines.push({ kind: 'add', text: raw }); }
    else if (raw.startsWith('-')) { cur.removed++; cur.lines.push({ kind: 'del', text: raw }); }
    else cur.lines.push({ kind: 'ctx', text: raw });
  }
  for (const f of files) if (f.lines.at(-1)?.text === '') f.lines.pop();   // the split's trailing blank
  return files;
}

// The "+3 −1" label beside a file.
export const changeCounts = (f) => [f.added ? `+${f.added}` : '', f.removed ? `−${f.removed}` : ''].filter(Boolean).join(' ') || '0';

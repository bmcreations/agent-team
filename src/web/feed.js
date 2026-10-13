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
    case 'delegated': return `delegated to ${b.to}`;
    case 'stalled': return `quiet for ${Math.round((b.quiet_s ?? 0) / 60)} min`;
    case 'cost_cap': return `cost cap: $${(b.cost_usd ?? 0).toFixed(2)} of $${(b.max_cost_usd ?? 0).toFixed(2)}`;
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

export const countLabel = (n) => (n > 1 ? `${n} times` : '');

export function todayCount(events, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return events.filter((e) => e.kind === 'tool_call' && e.at >= start.getTime()).length;
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

const TEAM_KINDS = new Set(['started', 'delegated', 'progress', 'paused', 'resumed', 'interrupted', 'stalled',
                            'timed_out', 'cost_cap', 'taken_over', 'handed_back', 'finished']);

// The run as a team conversation: messages between members and humans, and the events the
// supervisor records, not tool calls.
export function conversation({ events, messages }) {
  const rows = [
    ...events.filter((e) => TEAM_KINDS.has(e.kind)).map((e) => {
      const said = describe(e);
      return { type: 'event', at: e.at, key: `e${e.id}`, who: e.member, text: said ? `${e.kind}: ${said}` : e.kind };
    }),
    ...messages.map((m) => ({ type: 'message', at: m.at, key: `m${m.id}`, who: `${m.from_name} (${m.from_kind}) → ${m.to_name}`, text: m.text }))
  ];
  return rows.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

export const matches = (query, ...fields) => {
  const q = query.toLowerCase();
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
};

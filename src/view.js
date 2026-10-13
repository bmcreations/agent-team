import { loadConfig } from './config.js';

// What leaves the server about the store. Member rows go out through an allowlist: a row's
// `token` is the member's MCP credential, and new columns stay private until listed here.
const MEMBER_FIELDS = ['id', 'run_id', 'parent_id', 'name', 'task', 'depth', 'state', 'agent', 'model',
                       'workspace', 'cost_usd', 'tokens', 'project', 'alias', 'created_at', 'updated_at'];

export const READ_ONLY_NOTE = 'started without `agent-team serve`, so this page can watch it but not steer it. ' +
  'Run the team while `agent-team serve` is up to steer it from here.';

export function publicMember(row) {
  const out = Object.fromEntries(MEMBER_FIELDS.map((k) => [k, row[k] ?? null]));
  out.read_only = row.read_only == null ? null : row.read_only === 1;
  out.result = row.result ? { status: row.result.status ?? null, summary: row.result.summary ?? null } : null;
  out.attach = `agent-team attach ${row.run_id} ${row.name}`;
  return out;
}

export function publicRun(store, row, ownSocket) {
  const steerable = row.status === 'running' && ownSocket != null && row.owner === ownSocket;
  return {
    id: row.id, project: row.project, task: row.task, status: row.status, created_at: row.created_at,
    cost_usd: row.cost_usd, tokens: row.tokens, max_cost_usd: row.max_cost_usd,
    root: row.root_member == null ? null : store.member(row.root_member)?.name ?? null,
    steerable,
    read_only_note: row.status === 'running' && !steerable ? READ_ONLY_NOTE : null
  };
}

export const publicMessage = (row) => ({
  id: row.id, run_id: row.run_id, to_member: row.to_member, to_name: row.to_name,
  from_kind: row.from_kind, from_name: row.from_name, report_id: row.report_id,
  text: row.text, state: row.state, at: row.at
});

// A tool result can be megabytes. Each long field is cut to `max` characters; the full event
// is GET /api/events/:id.
export function clipEvent(row, max = 4000) {
  const body = row.body ?? {};
  if (JSON.stringify(body).length <= max) return row;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string') out[k] = v.length > max ? `${v.slice(0, max)}…` : v;
    else if (v !== null && typeof v === 'object') {
      const s = JSON.stringify(v);
      out[k] = s.length > max ? `${s.slice(0, max)}…` : v;
    } else out[k] = v;
  }
  out.clipped = true;
  return { ...row, body: out };
}

export function runState(store, runId, ownSocket) {
  const run = store.run(runId);
  if (!run) return null;
  return { run: publicRun(store, run, ownSocket), members: store.members(runId).map(publicMember) };
}

// deny_paths come from the project's config as it is now; a config that no longer loads
// shows as null rather than failing the page.
export function runDetail(store, runId, ownSocket) {
  const state = runState(store, runId, ownSocket);
  if (!state) return null;
  let denyPaths = null;
  try { denyPaths = loadConfig(state.run.project).deny_paths; } catch { /* moved or broken */ }
  const byProject = {};
  for (const m of state.members) {
    if (m.project == null || Object.hasOwn(byProject, m.project)) continue;
    try { byProject[m.project] = loadConfig(m.project).deny_paths; } catch { byProject[m.project] = null; }
  }
  return { ...state, deny_paths: denyPaths, deny_paths_by_project: byProject };
}

// The "Needs you" section: open ask_human questions, working members gone quiet, and runs the
// cost cap paused (one entry per run, on its root).
export function needsYou(store) {
  const questions = store.openQuestions().map((q) => {
    const m = store.member(q.member_id);
    return { id: q.id, run_id: m.run_id, member_id: m.id, member: m.name,
             question: q.question, options: q.options, asked_at: q.at };
  });
  const stalled = [];
  const capped = [];
  for (const m of store.membersInStates(['running', 'paused'])) {
    const last = store.lastEvent(m.id);
    if (!last) continue;
    if (m.state === 'running' && last.kind === 'stalled') {
      stalled.push({ run_id: m.run_id, member_id: m.id, member: m.name, quiet_s: last.body.quiet_s ?? null, at: last.at });
    }
    const byCap = last.kind === 'cost_cap' || (last.kind === 'paused' && last.body.by === 'cost cap');
    if (m.state === 'paused' && m.parent_id == null && byCap) {
      const run = store.run(m.run_id);
      // The cost_cap event holds the figures at the moment of the pause; a paused-by-cost-cap
      // event does not, so fall back to the run's.
      const at = last.kind === 'cost_cap' ? last.body : {};
      capped.push({ run_id: m.run_id, member_id: m.id, member: m.name,
                    cost_usd: at.cost_usd ?? run.cost_usd, max_cost_usd: at.max_cost_usd ?? run.max_cost_usd });
    }
  }
  return { questions, stalled, cost_capped: capped };
}

// What every SSE stream sends as its `state` event: recent runs, the members of running
// runs (the sidebar), Needs you, and for a run-scoped stream that run in full.
export function streamState(store, runId, ownSocket) {
  const runs = store.listRuns({ limit: 50 });
  const live = runs.filter((r) => r.status === 'running').flatMap((r) => store.members(r.id).map((m) => ({
    id: m.id, run_id: m.run_id, parent_id: m.parent_id, name: m.name, agent: m.agent ?? null, state: m.state
  })));
  return {
    runs: runs.map((r) => publicRun(store, r, ownSocket)),
    live,
    needs: needsYou(store),
    ...(runId != null ? runState(store, runId, ownSocket) : {})
  };
}

// The text a member produced or was handed, newest last: what loupe and Figma mentions are
// read from.
export function memberTexts(store, memberId, limit = 500) {
  const { events, messages } = store.timeline({ memberId, beforeEvent: Number.MAX_SAFE_INTEGER, limit });
  const texts = [];
  for (const e of events) {
    const b = e.body ?? {};
    for (const v of [b.text, b.command, b.args && JSON.stringify(b.args)]) if (typeof v === 'string') texts.push(v);
  }
  for (const m of messages) texts.push(m.text);
  return texts;
}

#!/usr/bin/env node
// Checks the live-sessions spike's assumptions against the real Managed Agents API.
// See docs/spikes/live-sessions.md, "Verifying against a real session".
//
//   ANTHROPIC_API_KEY=... node scripts/verify-join.mjs --session sesn_... [options]
//
// Always: reads the session, sends one short message, and checks how its reply is found.
//   --repo <url> --ref <branch> [--sha <sha>]  also run joinRefusal() as the dispatcher would
//   --mid-turn                     post a second message while a turn runs (2 short turns)
//   --second-key                   read and post with ANTHROPIC_API_KEY_2 (same workspace)
//   --project <dir> --member <m>   delegate through agent-team to a member with session_id
//   --archive                      archive the session, then post to it (irreversible; runs last)
//   --out <dir>                    where raw responses go (default test/fixtures/live-session)
//   --timeout <s>                  per wait (default 300)
//
// Every step costs a model turn on the session's owner. Use a throwaway session with a budget.
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { joinRefusal, writeToolsOn } from '../src/cloud.js';

const { values: opt } = parseArgs({
  options: {
    session: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, sha: { type: 'string' },
    'mid-turn': { type: 'boolean' }, 'second-key': { type: 'boolean' }, archive: { type: 'boolean' },
    project: { type: 'string' }, member: { type: 'string' },
    out: { type: 'string', default: 'test/fixtures/live-session' }, timeout: { type: 'string', default: '300' }
  }
});

const env = process.env;
const BASE = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const BETA = 'managed-agents-2026-04-01';
const POLL_MS = Number(env.AGENT_TEAM_CLOUD_POLL_MS) > 0 ? Number(env.AGENT_TEAM_CLOUD_POLL_MS) : 2000;
const TIMEOUT_MS = Number(opt.timeout) * 1000;
const id = opt.session;

function usage(msg) {
  console.error(`verify-join: ${msg}\nsee the header of scripts/verify-join.mjs for usage`);
  process.exit(2);
}
if (!id || !/^sesn_\w+$/.test(id)) usage('--session sesn_... is required');
if (!env.ANTHROPIC_API_KEY) usage('ANTHROPIC_API_KEY is not set');
if (opt['second-key'] && !env.ANTHROPIC_API_KEY_2) usage('--second-key needs ANTHROPIC_API_KEY_2');
if (!!opt.project !== !!opt.member) usage('--project and --member go together');
if (opt.repo && !opt.ref) usage('--repo needs --ref');
// The adapter's probe requires it even though join mode never sends it (see the spike doc).
if (opt.project && !env.AGENT_TEAM_GITHUB_TOKEN) usage('--project needs AGENT_TEAM_GITHUB_TOKEN set (any value; join mode does not send it)');

const outDir = resolve(opt.out);
mkdirSync(outDir, { recursive: true });
const save = (name, obj) => writeFileSync(join(outDir, `${name}.json`), JSON.stringify(obj, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function report(level, name, detail = '') {
  results.push({ level, name, detail });
  console.log(`${level.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`);
}
const check = (name, ok, detail) => report(ok ? 'PASS' : 'FAIL', name, detail);

// Returns { status, body } instead of throwing, so a refusal is something we can record.
async function call(method, path, body, key = env.ANTHROPIC_API_KEY) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* keep the raw text */ }
  return { status: res.status, body: parsed };
}
async function api(method, path, body, key) {
  const r = await call(method, path, body, key);
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body;
}

async function events(key) {
  const all = [];
  let page = null;
  do {
    const q = new URLSearchParams({ limit: '100' });
    if (page) q.set('page', page);
    const r = await api('GET', `/v1/sessions/${id}/events?${q}`, undefined, key);
    all.push(...(r.data ?? []));
    page = r.next_page ?? null;
  } while (page);
  return all;
}

async function waitStatus(want, key) {
  const until = Date.now() + TIMEOUT_MS;
  for (;;) {
    const s = await api('GET', `/v1/sessions/${id}`, undefined, key);
    if (s.status === want) return s;
    if (s.status === 'terminated') throw new Error(`session ${id} terminated while waiting for ${want}`);
    if (Date.now() >= until) throw new Error(`session ${id} still ${s.status} after ${opt.timeout}s waiting for ${want}`);
    await sleep(POLL_MS);
  }
}

const text = (prompt) => ({ type: 'user.message', content: [{ type: 'text', text: prompt }] });
const textOf = (ev) => (ev?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
const isEnd = (e) => e.type === 'session.status_idle' || e.type === 'session.status_terminated';

async function send(prompt, key) {
  const r = await api('POST', `/v1/sessions/${id}/events`, { events: [text(prompt)] }, key);
  return { response: r, mine: r.data?.find((e) => e.type === 'user.message') };
}

// The same rule joinSession() uses: our event, once processed, up to the first idle after it.
// Also records whether processed_at was null on the first sight, which the rule depends on.
async function turnAfter(mineId, key) {
  const until = Date.now() + TIMEOUT_MS;
  let firstSeen;
  for (;;) {
    const all = await events(key);
    const at = all.findIndex((e) => e.id === mineId);
    if (at >= 0 && firstSeen === undefined) firstSeen = all[at].processed_at ?? null;
    if (at >= 0 && all[at].processed_at) {
      const after = all.slice(at + 1);
      const end = after.findIndex(isEnd);
      if (end >= 0) return { all, at, turn: after.slice(0, end), stop: after[end], firstSeen };
    }
    if (Date.now() >= until) throw new Error(`no idle after ${mineId} within ${opt.timeout}s`);
    await sleep(POLL_MS);
  }
}

const costOf = (ev) => (Number.isFinite(Number(ev?.list_cost?.amount)) ? Number(ev.list_cost.amount) : null);
const lastUsage = (list) => [...list].reverse().find((e) => e.type === 'session.usage');

// --- 1. The session object, and one message's round trip ---

async function stepSession() {
  console.log('\n# 1. Session shape and one round trip');
  const s = await api('GET', `/v1/sessions/${id}`);
  save('1-session', s);
  report('INFO', 'status', `${s.status}${s.archived_at ? `, archived_at ${s.archived_at}` : ''}`);

  const tools = s.agent?.tools;
  check('agent.tools is an array', Array.isArray(tools), JSON.stringify(tools)?.slice(0, 200));
  const toolsets = (tools ?? []).filter((t) => /^agent_toolset/.test(t.type ?? ''));
  check('agent.tools has an agent_toolset_* entry', toolsets.length > 0,
    `types: ${(tools ?? []).map((t) => t.type).join(', ') || 'none'}`);
  for (const t of toolsets) {
    const shaped = Array.isArray(t.configs) || (t.default_config && typeof t.default_config === 'object');
    check(`${t.type} carries configs[] or default_config`, shaped,
      'joinRefusal() reads these; without them every write tool reads as on');
    for (const c of t.configs ?? []) {
      if (typeof c.name !== 'string') check('every configs[] entry has a name', false, JSON.stringify(c));
    }
  }
  check('agent.mcp_servers is an array or absent', s.agent?.mcp_servers === undefined || Array.isArray(s.agent.mcp_servers));
  report('INFO', 'write tools as joinRefusal() sees them', writeToolsOn(s.agent).join(', ') || 'none');

  const repos = (s.resources ?? []).filter((r) => r.type === 'github_repository');
  report('INFO', 'github_repository resources', repos.map((r) => `${r.url} @ ${JSON.stringify(r.checkout)}`).join('; ') || 'none');
  for (const r of repos) {
    const co = r.checkout;
    const ok = co === null || co === undefined || (co.type === 'branch' && typeof co.name === 'string') ||
      (co.type === 'commit' && typeof co.sha === 'string');
    check(`checkout of ${r.url} is {type:"branch",name} or {type:"commit",sha}`, ok, JSON.stringify(co));
  }
  report('INFO', 'budget', s.budget ? JSON.stringify(s.budget) : 'none (no cap, and none can be added)');

  if (opt.repo) {
    const brief = { cloud: { repo_url: opt.repo, ref: opt.ref, sha: opt.sha ?? null, session_allow_tools: false } };
    report('INFO', 'joinRefusal() for --repo/--ref', joinRefusal(s, brief) ?? 'none, a member would send to this session');
  }

  if (s.status !== 'idle') {
    report('INFO', 'waiting for idle before posting');
    await waitStatus('idle');
  }
  const { response, mine } = await send('Reply with exactly the word pong and nothing else. Do not use any tools.');
  save('1-post-response', response);
  check('POST /events returns the user.message with an id', typeof mine?.id === 'string', JSON.stringify(response).slice(0, 200));
  if (!mine?.id) return;
  report('INFO', 'processed_at in the POST response', JSON.stringify(mine.processed_at ?? null));

  const t = await turnAfter(mine.id);
  save('1-events', t.all);
  report('INFO', 'processed_at on first sight in the event list', JSON.stringify(t.firstSeen));
  check('processed_at fills in once the turn runs', !!t.all[t.at].processed_at, t.all[t.at].processed_at);
  // joinSession() takes the turn by list position, so it needs the documented processed_at order.
  const stamped = t.all.filter((e) => e.processed_at);
  const outOfOrder = stamped.findIndex((e, i) => i > 0 && String(e.processed_at) < String(stamped[i - 1].processed_at));
  check('the event list is in processed_at order', outOfOrder < 0,
    outOfOrder < 0 ? `${stamped.length} stamped events` : `${stamped[outOfOrder - 1].id} then ${stamped[outOfOrder].id}`);
  const answer = [...t.turn].reverse().find((e) => e.type === 'agent.message');
  check('the agent.message after our event is the answer', /pong/i.test(textOf(answer)), JSON.stringify(textOf(answer)).slice(0, 120));
  check('the turn ends on end_turn', t.stop.stop_reason?.type === 'end_turn', JSON.stringify(t.stop.stop_reason));
  const before = costOf(lastUsage(t.all.slice(0, t.at)));
  const after = costOf(lastUsage(t.turn));
  report('INFO', 'session.usage list_cost before / after our turn', `${before} / ${after}${after !== null ? ` (delta ${after - (before ?? 0)})` : ''}`);
  check('a session.usage event precedes the idle', after !== null);
}

// --- 2a. A message posted while a turn is running ---

async function stepMidTurn() {
  console.log('\n# 2a. Posting while the session is running');
  await waitStatus('idle');
  const a = await send('Without using any tools, write the whole numbers from 1 to 400 separated by single spaces.');
  if (!a.mine?.id) return check('first message posted', false);
  // Post B as soon as A's turn is visibly running, not before.
  const until = Date.now() + TIMEOUT_MS;
  let s;
  do {
    s = await api('GET', `/v1/sessions/${id}`);
    if (s.status === 'running') break;
    await sleep(Math.min(POLL_MS, 500));
  } while (Date.now() < until);
  const postedWhile = s.status;
  const b = await send('Reply with exactly the word second and nothing else.');
  if (!b.mine?.id) return check('second message posted', false);
  const listed = await events();
  save('2a-events-while-queued', listed);
  const queuedAt = listed.findIndex((e) => e.id === b.mine.id);
  if (queuedAt >= 0 && !listed[queuedAt].processed_at) {
    const laterStamped = listed.slice(queuedAt + 1).some((e) => e.processed_at);
    report('INFO', 'where a queued event sits in the list', laterStamped
      ? 'before events already processed; position is only meaningful once processed_at is set'
      : 'after every processed event');
  }
  report('INFO', 'session status when the second message was posted', postedWhile);

  const t = await turnAfter(b.mine.id);
  save('2a-events', t.all);
  const atA = t.all.findIndex((e) => e.id === a.mine.id);
  const between = t.all.slice(atA + 1, t.at);
  const idlesBetween = between.filter(isEnd).length;
  if (postedWhile !== 'running') {
    report('INFO', 'inconclusive', `the session was ${postedWhile}, not running, when B was posted; rerun`);
  } else if (idlesBetween === 0) {
    report('INFO', 'a mid-turn message JOINS the running turn',
      'B was processed before A\'s turn went idle; joinSession()\'s idle wait is required');
  } else {
    report('INFO', 'a mid-turn message QUEUES as its own turn',
      `${idlesBetween} idle(s) between A and B; position-based correlation holds without the idle wait`);
  }
  report('INFO', 'answer the rule picks for B', JSON.stringify(textOf([...t.turn].reverse().find((e) => e.type === 'agent.message'))).slice(0, 120));
}

// --- 2b. A second key in the same workspace ---

async function stepSecondKey() {
  console.log('\n# 2b. A second API key');
  const key = env.ANTHROPIC_API_KEY_2;
  const g = await call('GET', `/v1/sessions/${id}`, undefined, key);
  save('2b-get', { status: g.status, body: g.body });
  check('a second key can read the session', g.status === 200, `HTTP ${g.status}`);
  if (g.status !== 200) return;
  await waitStatus('idle', key);
  const p = await call('POST', `/v1/sessions/${id}/events`, { events: [text('Reply with exactly the word pong2 and nothing else.')] }, key);
  save('2b-post', { status: p.status, body: p.body });
  check('a second key can post to the session', p.status >= 200 && p.status < 300, `HTTP ${p.status}`);
  const mine = p.body?.data?.find?.((e) => e.type === 'user.message');
  if (mine?.id) {
    const t = await turnAfter(mine.id, key);
    check('the second key reads its own answer', /pong2/i.test(textOf([...t.turn].reverse().find((e) => e.type === 'agent.message'))));
  }
}

// --- 3. Through agent-team ---

async function stepDispatch() {
  console.log('\n# 3. Delegating through agent-team');
  const { dispatch } = await import('../src/dispatch.js');
  const { parseConfig } = await import('../src/config.js');
  const root = resolve(opt.project);
  const config = parseConfig(JSON.parse(readFileSync(join(root, '.claude', 'agent-team.json'), 'utf8')), 'agent-team.json');
  const member = config.members[opt.member];
  check(`member "${opt.member}" has session_id ${id}`, member?.session_id === id, `found ${member?.session_id}`);
  if (member?.session_id !== id) return;
  let version = null;
  try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null; } catch { /* no package.json */ }
  const task = version
    ? 'What is the "version" field in package.json at the repository root? Answer with the value only.'
    : 'Name one file at the repository root. Answer with the file name only.';

  const before = await api('GET', `/v1/sessions/${id}`);
  const r = await dispatch({ projectRoot: root, member: opt.member, task, adapterDir: new URL('../adapters/', import.meta.url).pathname, env: {} });
  const after = await api('GET', `/v1/sessions/${id}`);
  save('3-dispatch', { result: r, session_before: { status: before.status, usage: before.usage }, session_after: { status: after.status, archived_at: after.archived_at, usage: after.usage } });

  // A failed probe falls back per on_unavailable, which can answer from another adapter.
  check('the claude-cloud adapter ran, not a fallback', r.agent === 'claude-cloud', `agent ${r.agent}`);
  check('dispatch returns ok', r.status === 'ok', r.summary?.slice(0, 200));
  if (version) check('the answer is the version in package.json', r.summary?.includes(version), `want ${version}, got ${JSON.stringify(r.summary).slice(0, 120)}`);
  check('the session was not archived', !after.archived_at);
  check('the result names the joined session', r.usage?.session_id === id, r.usage?.session_id);
  report('INFO', 'cost_usd agent-team reported', String(r.usage?.cost_usd));
  report('INFO', 'GET usage before / after', `${JSON.stringify(before.usage)} / ${JSON.stringify(after.usage)} (compare by hand)`);
}

// --- 2c. An archived session (last: it cannot be undone) ---

async function stepArchive() {
  console.log('\n# 2c. Posting to an archived session');
  await waitStatus('idle');
  const a = await call('POST', `/v1/sessions/${id}/archive`);
  save('2c-archive', { status: a.status, body: a.body });
  check('the session archives', a.status >= 200 && a.status < 300, `HTTP ${a.status}`);
  const p = await call('POST', `/v1/sessions/${id}/events`, { events: [text('Reply with exactly the word pong.')] });
  save('2c-post', { status: p.status, body: p.body });
  check('posting to an archived session is refused', p.status >= 400, `HTTP ${p.status}`);
  report('INFO', 'the refusal', `HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 200)}`);
}

try {
  await stepSession();
  if (opt['mid-turn']) await stepMidTurn();
  if (opt['second-key']) await stepSecondKey();
  if (opt.project) await stepDispatch();
  if (opt.archive) await stepArchive();
} catch (err) {
  report('FAIL', 'aborted', err.message);
}

const failed = results.filter((r) => r.level === 'FAIL').length;
console.log(`\n${results.filter((r) => r.level === 'PASS').length} passed, ${failed} failed. Raw responses in ${outDir}`);
console.log('Review them before committing: they hold the session\'s metadata, repo URLs and model output.');
process.exit(failed ? 1 : 0);

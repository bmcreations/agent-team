// Spike: a claude-cloud member with "session_id" joins a session someone else created.
// See docs/spikes/live-sessions.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { parseConfig } from '../src/config.js';

process.env.AGENT_TEAM_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-live-wsroot-'));

const adapterDir = new URL('../adapters/', import.meta.url).pathname;
const REPO = 'https://github.com/acme/app';
const SID = 'sesn_shared';

function project(member) {
  const root = mkdtempSync(join(tmpdir(), 'at-live-'));
  const bare = mkdtempSync(join(tmpdir(), 'at-live-bare-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', REPO);
  git('config', `url.file://${bare}.insteadOf`, REPO);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, 'app.js'), 'ok\n');
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members: { scout: { agent: 'claude-cloud', session_id: SID, ...member } },
    deny_paths: ['credentials/**'], defaults: { on_unavailable: 'mock' }
  }));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('push', '-q', 'origin', 'main');
  return root;
}

const readOnlyAgent = { tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: false },
  configs: [{ name: 'read', enabled: true }, { name: 'grep', enabled: true }] }], mcp_servers: [] };

const sessionObj = (over = {}) => ({
  id: SID, status: 'idle', archived_at: null, budget: { max_list_cost: { amount: '500', currency: 'USD' } },
  agent: readOnlyAgent,
  resources: [{ type: 'github_repository', url: REPO, mount_path: '/workspace/app', checkout: { type: 'branch', name: 'main' } }],
  ...over
});

// The session already holds someone else's finished turn. After our POST, `next(state)` decides
// what the event list grows to. `statuses` is the status GET returns on successive calls.
async function fakeSession({ session = sessionObj(), statuses = null, next }) {
  const prior = [
    { id: 'p1', type: 'user.message', processed_at: 't1', content: [{ type: 'text', text: 'owner task' }] },
    { id: 'p2', type: 'agent.message', processed_at: 't2', content: [{ type: 'text', text: 'OWNER ANSWER' }] },
    { id: 'p3', type: 'session.usage', processed_at: 't3', usage: { list_cost: { amount: '100', currency: 'USD' } } },
    { id: 'p4', type: 'session.status_idle', processed_at: 't4', stop_reason: { type: 'end_turn' } }
  ];
  const state = { sent: [], archived: [], gets: 0, created: [], events: prior, posted: false };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      const reply = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && /^\/v1\/(agents|environments|sessions)$/.test(req.url)) { state.created.push(req.url); return reply({ id: 'x' }); }
      if (req.method === 'GET' && req.url === `/v1/sessions/${SID}`) {
        const status = statuses ? statuses[Math.min(state.gets, statuses.length - 1)] : session.status;
        state.gets += 1;
        return reply({ ...session, status });
      }
      if (req.method === 'GET' && req.url.startsWith(`/v1/sessions/${SID}/events`)) {
        if (state.posted) state.events = next(state);
        return reply({ data: state.events, next_page: null });
      }
      if (req.method === 'POST' && req.url === `/v1/sessions/${SID}/events`) {
        state.sent.push(...json.events);
        state.posted = true;
        return reply({ data: [{ id: 'mine', type: 'user.message', processed_at: null, content: json.events[0].content }] });
      }
      if (req.method === 'POST' && req.url.endsWith('/archive')) { state.archived.push(req.url); return reply({}); }
      reply({ error: `unexpected ${req.method} ${req.url}` }, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

const env = (api) => ({ ANTHROPIC_API_KEY: 'test-key', AGENT_TEAM_GITHUB_TOKEN: 'test-gh', ANTHROPIC_BASE_URL: api.url, AGENT_TEAM_CLOUD_POLL_MS: '10' });
const run = (api, member = {}, extra = {}) =>
  dispatch({ projectRoot: project(member), member: 'scout', task: 'find the build number', adapterDir, env: env(api), ...extra });

const ourTurn = (s, text = 'build 272', cents = '142') => [
  ...s.events.filter((e) => e.id !== 'mine'),
  { id: 'mine', type: 'user.message', processed_at: 't5' },
  { id: 'm1', type: 'session.status_running', processed_at: 't6' },
  { id: 'm2', type: 'agent.message', processed_at: 't7', content: [{ type: 'text', text }] },
  { id: 'm3', type: 'session.usage', processed_at: 't8', usage: { list_cost: { amount: cents, currency: 'USD' } } },
  { id: 'm4', type: 'session.status_idle', processed_at: 't9', stop_reason: { type: 'end_turn' } }
];

test('config: session_id needs claude-cloud, a sesn_ id, and read-only isolation', () => {
  const base = { deny_paths: ['x'] };
  assert.equal(parseConfig({ ...base, members: { a: { agent: 'claude-cloud', session_id: SID } } }, 'c').members.a.session_id, SID);
  assert.throws(() => parseConfig({ ...base, members: { a: { agent: 'claude', session_id: SID } } }, 'c'), /needs "agent": "claude-cloud"/);
  assert.throws(() => parseConfig({ ...base, members: { a: { agent: 'claude-cloud', session_id: 'abc' } } }, 'c'), /sesn_ id/);
  assert.throws(() => parseConfig({ ...base, members: { a: { agent: 'claude-cloud', session_id: SID, isolation: 'workspace' } } }, 'c'), /must be "read-only"/);
});

test('joining: the answer is the turn after our event, not the owner\'s earlier turn, and cost is the delta', async () => {
  const api = await fakeSession({ next: (s) => ourTurn(s) });
  try {
    const r = await run(api);
    assert.equal(r.status, 'ok', r.summary);
    assert.equal(r.summary, 'build 272');
    assert.equal(r.usage.cost_usd, 0.42);
    assert.deepEqual(api.created, [], 'no agent, environment or session is created');
    assert.deepEqual(api.archived, [], 'a joined session is never archived');
    assert.deepEqual(api.sent.map((e) => e.type), ['user.message']);
    assert.match(api.sent[0].content[0].text, /find the build number/);
  } finally { await api.close(); }
});

test('joining: while our event is still queued, the owner\'s idle is not taken as ours', async () => {
  let polls = 0;
  const api = await fakeSession({
    next: (s) => {
      polls += 1;
      // First polls: our event exists but has not been processed yet.
      if (polls < 3) return [...s.events.filter((e) => e.id !== 'mine'), { id: 'mine', type: 'user.message', processed_at: null }];
      return ourTurn(s);
    }
  });
  try {
    const r = await run(api);
    assert.equal(r.summary, 'build 272');
    assert.ok(polls >= 3);
  } finally { await api.close(); }
});

test('joining: a busy session is waited on before the task is sent', async () => {
  const api = await fakeSession({ statuses: ['running', 'running', 'idle'], next: (s) => ourTurn(s) });
  try {
    const r = await run(api);
    assert.equal(r.status, 'ok', r.summary);
    assert.equal(api.gets, 3);
  } finally { await api.close(); }
});

test('joining: a session that never goes idle gets no task', async () => {
  const api = await fakeSession({ statuses: ['running'], next: (s) => ourTurn(s) });
  try {
    const r = await run(api, {}, { timeoutMs: 4000 });
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /stayed running; the task was not sent/);
    assert.deepEqual(api.sent, []);
  } finally { await api.close(); }
});

test('joining: timing out leaves the session running — no interrupt, no archive', async () => {
  const api = await fakeSession({ next: (s) => [...s.events.filter((e) => e.id !== 'mine'), { id: 'mine', type: 'user.message', processed_at: 't5' }] });
  try {
    const r = await run(api, {}, { timeoutMs: 4000 });
    assert.equal(r.status, 'timeout');
    assert.match(r.summary, /still working on the task/);
    assert.deepEqual(api.sent.map((e) => e.type), ['user.message']);
    assert.deepEqual(api.archived, []);
  } finally { await api.close(); }
});

for (const [name, over, pattern] of [
  ['another repository', { resources: [{ type: 'github_repository', url: 'https://github.com/acme/other', checkout: { type: 'branch', name: 'main' } }] }, /does not mount/],
  ['another branch', { resources: [{ type: 'github_repository', url: REPO, checkout: { type: 'branch', name: 'dev' } }] }, /branch "dev" checked out/],
  ['a second repository', { resources: [
    { type: 'github_repository', url: REPO, checkout: { type: 'branch', name: 'main' } },
    { type: 'github_repository', url: 'https://github.com/acme/secrets', checkout: { type: 'branch', name: 'main' } }] }, /mounts 2 repositories/],
  ['write tools', { agent: { tools: [{ type: 'agent_toolset_20260401' }], mcp_servers: [] } }, /has bash, write, edit enabled/],
  ['an MCP server', { agent: { ...readOnlyAgent, mcp_servers: [{ name: 'gh' }] } }, /has mcp enabled/],
  ['archived', { archived_at: '2026-10-01T00:00:00Z' }, /is archived/]
]) {
  test(`joining: a session with ${name} is refused before anything is sent`, async () => {
    const api = await fakeSession({ session: sessionObj(over), next: (s) => ourTurn(s) });
    try {
      const r = await run(api);
      assert.equal(r.status, 'failed');
      assert.match(r.summary, pattern);
      assert.deepEqual(api.sent, []);
    } finally { await api.close(); }
  });
}

test('joining: session_allow_tools sends to a session with write tools anyway', async () => {
  const api = await fakeSession({ session: sessionObj({ agent: { tools: [{ type: 'agent_toolset_20260401' }], mcp_servers: [] } }), next: (s) => ourTurn(s) });
  try {
    const r = await run(api, { session_allow_tools: true });
    assert.equal(r.status, 'ok', r.summary);
  } finally { await api.close(); }
});

test('joining: a turn that hits the owner\'s spend cap or needs confirmation is a failure', async () => {
  for (const [stop, pattern] of [['budget_reached', /spend cap/], ['requires_action', /tool confirmation/]]) {
    const api = await fakeSession({ next: (s) => ourTurn(s).map((e) => (e.id === 'm4' ? { ...e, stop_reason: { type: stop } } : e)) });
    try {
      const r = await run(api);
      assert.equal(r.status, 'failed');
      assert.match(r.summary, pattern);
    } finally { await api.close(); }
  }
});

test('joining: a second client\'s message inside our turn is flagged', async () => {
  const api = await fakeSession({ next: (s) => {
    const t = ourTurn(s);
    t.splice(t.findIndex((e) => e.id === 'm2'), 0, { id: 'x1', type: 'user.message', processed_at: 't6b' });
    return t;
  } });
  try {
    const r = await run(api);
    assert.match(r.summary, /1 other user\.message event\(s\) landed in this turn/);
  } finally { await api.close(); }
});

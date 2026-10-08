import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { parseConfig } from '../src/config.js';
import { cloudTarget, parseGithubRepo } from '../src/cloud.js';

process.env.AGENT_TEAM_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-cloud-wsroot-'));

const adapterDir = new URL('../adapters/', import.meta.url).pathname;
const REPO = 'https://github.com/acme/app';

// A project whose origin reads as GitHub but resolves, through a repo-local insteadOf, to a
// bare repository on disk — so ls-remote and push behave for real without a network.
function project({ members, denyPaths = ['credentials/**'], defaults = {}, push = true, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'at-cloud-'));
  const bare = mkdtempSync(join(tmpdir(), 'at-cloud-bare-'));
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
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members, deny_paths: denyPaths, defaults: { on_unavailable: 'mock', ...defaults }
  }));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  if (push) git('push', '-q', 'origin', 'main');
  return { root, bare, git };
}

// A stand-in for the Managed Agents API. `events(n, state)` returns the session's whole event
// list on its nth poll; everything the adapter sends is recorded on `state`.
async function fakeApi(events) {
  const state = { sessions: [], sent: [], archived: [], polls: 0, created: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      const reply = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      state.headers = req.headers;
      if (req.method === 'POST' && req.url === '/v1/agents') { state.created.push(['agent', json]); return reply({ id: 'agent_1' }); }
      if (req.method === 'POST' && req.url === '/v1/environments') { state.created.push(['environment', json]); return reply({ id: 'env_1' }); }
      if (req.method === 'POST' && req.url === '/v1/sessions') { state.sessions.push(json); return reply({ id: 'sesn_1', status: 'running' }); }
      if (req.method === 'GET' && req.url.startsWith('/v1/sessions/sesn_1/events')) {
        state.polls += 1;
        return reply({ data: events(state.polls, state), next_page: null });
      }
      if (req.method === 'POST' && req.url === '/v1/sessions/sesn_1/events') { state.sent.push(...json.events); return reply({}); }
      if (req.method === 'POST' && req.url === '/v1/sessions/sesn_1/archive') { state.archived.push('sesn_1'); return reply({}); }
      reply({ error: `unexpected ${req.method} ${req.url}` }, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

const finished = (text, cents = '42') => [
  { id: 'e1', type: 'session.status_running' },
  { id: 'e2', type: 'agent.message', content: [{ type: 'text', text }] },
  { id: 'e3', type: 'session.usage', list_cost: { amount: cents, currency: 'USD' } },
  { id: 'e4', type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
];

const cloudEnv = (api, extra = {}) => ({
  ANTHROPIC_API_KEY: 'test-key', AGENT_TEAM_GITHUB_TOKEN: 'test-gh', ANTHROPIC_BASE_URL: api.url,
  AGENT_TEAM_CLOUD_POLL_MS: '10', ...extra
});

test('parseGithubRepo reads every way a GitHub remote is written', () => {
  for (const s of ['github:acme/app', 'https://github.com/acme/app', 'https://github.com/acme/app.git',
    'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git']) {
    assert.equal(parseGithubRepo(s)?.key, 'github.com/acme/app', s);
  }
  assert.equal(parseGithubRepo('https://gitlab.com/acme/app'), null);
  assert.equal(parseGithubRepo('../app'), null);
});

test('config: a GitHub team is accepted, ref is only for one, and cloud fields are checked', () => {
  const base = { deny_paths: ['x'] };
  const ok = parseConfig({ ...base, members: { lead: { agent: 'claude' }, ios: { team: 'github:acme/ios', ref: 'dev', reports_to: 'lead' } } }, 'c');
  assert.equal(ok.members.ios.ref, 'dev');
  assert.equal(ok.defaults.cloud_max_cost_usd, 5);
  assert.throws(() => parseConfig({ ...base, members: { ios: { team: '../ios', ref: 'dev' } } }, 'c'), /"ref" only applies/);
  assert.throws(() => parseConfig({ ...base, members: { ios: { team: 'https://gitlab.com/a/b' } } }, 'c'), /not a GitHub repository/);
  assert.throws(() => parseConfig({ ...base, members: { a: { agent: 'claude-cloud', isolation: 'none' } } }, 'c'), /isolation "none" has no meaning/);
  assert.throws(() => parseConfig({ ...base, members: { a: { agent: 'claude-cloud', cloud_allow_denied: 'yes' } } }, 'c'), /must be true or false/);
  assert.throws(() => parseConfig({ ...base, members: { a: { agent: 'claude' } }, defaults: { cloud_max_cost_usd: 0 } }, 'c'), /positive number/);
});

test('cloudTarget refuses a branch that is not on origin, or not at the same commit', () => {
  const unpushed = project({ members: { a: { agent: 'mock' } }, push: false });
  assert.throws(() => cloudTarget(unpushed.root), /not on origin — push it first/);

  const ahead = project({ members: { a: { agent: 'mock' } } });
  writeFileSync(join(ahead.root, 'more.js'), 'x\n');
  ahead.git('add', '-A');
  ahead.git('commit', '-q', '-m', 'more');
  assert.throws(() => cloudTarget(ahead.root), /but origin has .* push or pull first/);

  const synced = project({ members: { a: { agent: 'mock' } } });
  const t = cloudTarget(synced.root);
  assert.equal(t.repo.url, REPO);
  assert.equal(t.ref, 'main');
  assert.match(t.tracked.toString(), /app\.js/);
});

test('a read-only cloud member runs one session against origin and returns its answer', async () => {
  const api = await fakeApi(() => finished('the build number is 272'));
  try {
    const { root } = project({ members: { scout: { agent: 'claude-cloud', model: 'sonnet' } }, defaults: { cloud_max_cost_usd: 2.5 } });
    const r = await dispatch({ projectRoot: root, member: 'scout', task: 'find it', adapterDir, env: cloudEnv(api) });
    assert.equal(r.status, 'ok', r.summary);
    assert.equal(r.agent, 'claude-cloud');
    assert.equal(r.summary, 'the build number is 272');
    assert.equal(r.usage.cost_usd, 0.42);
    assert.equal(r.cloud.repo_url, REPO);

    const [session] = api.sessions;
    assert.deepEqual(session.resources[0].checkout, { type: 'branch', name: 'main' });
    assert.equal(session.resources[0].url, REPO);
    assert.equal(session.resources[0].authorization_token, 'test-gh');
    assert.equal(session.budget.max_list_cost.amount, '250');
    assert.match(session.initial_events[0].content[0].text, /read-only work.*find it/s);
    const agent = api.created.find(([k]) => k === 'agent')[1];
    assert.equal(agent.model, 'claude-sonnet-5-5');
    assert.deepEqual(agent.tools[0].configs.map((c) => c.name), ['read', 'glob', 'grep']);
    assert.equal(api.headers['anthropic-beta'], 'managed-agents-2026-04-01');
    assert.deepEqual(api.archived, ['sesn_1']);
  } finally { await api.close(); }
});

test('deny_paths matching a file the cloud would clone refuses the run before any request', async () => {
  const api = await fakeApi(() => finished('x'));
  try {
    const { root } = project({ members: { scout: { agent: 'claude-cloud' } }, files: { 'credentials/key.p8': 'SECRET\n' } });
    await assert.rejects(
      dispatch({ projectRoot: root, member: 'scout', task: 'go', adapterDir, env: cloudEnv(api) }),
      /deny_paths matches 1 file\(s\) in https:\/\/github\.com\/acme\/app \(main\).*credentials\/key\.p8.*cloud_allow_denied/
    );
    assert.equal(api.sessions.length, 0);
    assert.equal(api.created.length, 0);
  } finally { await api.close(); }
});

test('cloud_allow_denied sends the clone anyway, with a warning', async () => {
  const api = await fakeApi(() => finished('done'));
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const { root } = project({ members: { scout: { agent: 'claude-cloud', cloud_allow_denied: true } }, files: { 'credentials/key.p8': 'SECRET\n' } });
    const r = await dispatch({ projectRoot: root, member: 'scout', task: 'go', adapterDir, env: cloudEnv(api) });
    assert.equal(r.status, 'ok');
    assert.equal(r.cloud.denied_files_sent, 1);
    assert.ok(warnings.some((w) => /cloud_allow_denied is set.*credentials\/key\.p8/.test(w)), warnings.join('\n'));
  } finally { console.warn = warn; await api.close(); }
});

test('a workspace cloud member reports the branch it pushed', async () => {
  let bareDir;
  const api = await fakeApi((n, state) => {
    if (n === 1) {
      // Play the part of the session pushing its work.
      const branch = state.sessions[0].initial_events[0].content[0].text.match(/branch named "([^"]+)"/)[1];
      execFileSync('git', ['-C', bareDir, 'branch', branch, 'main']);
    }
    return finished('changed it');
  });
  try {
    const p = project({ members: { dev: { agent: 'claude-cloud', isolation: 'workspace' } } });
    bareDir = p.bare;
    const r = await dispatch({
      projectRoot: p.root, member: 'dev', task: 'change it', adapterDir,
      env: cloudEnv(api, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${p.bare}.insteadOf`, GIT_CONFIG_VALUE_0: REPO })
    });
    assert.equal(r.status, 'ok', r.summary);
    assert.match(r.artifacts.branch, /^agent-team\/dev-[0-9a-f]{6}$/);
    assert.equal(r.artifacts.branch, r.cloud.push_branch);
    assert.match(r.artifacts.branch_sha, /^[0-9a-f]{40}$/);
    const agent = api.created.find(([k]) => k === 'agent')[1];
    assert.ok(agent.tools[0].configs.some((c) => c.name === 'bash'));
  } finally { await api.close(); }
});

test('a session that runs past the timeout is interrupted and archived', async () => {
  const api = await fakeApi((n, state) => (state.sent.some((e) => e.type === 'user.interrupt')
    ? finished('partial')
    : [{ id: 'e1', type: 'session.status_running' }]));
  try {
    const { root } = project({ members: { scout: { agent: 'claude-cloud' } } });
    const r = await dispatch({ projectRoot: root, member: 'scout', task: 'go', adapterDir, env: cloudEnv(api), timeoutMs: 4000 });
    assert.equal(r.status, 'timeout');
    assert.equal(r.summary, 'partial');
    assert.ok(api.sent.some((e) => e.type === 'user.interrupt'));
    assert.deepEqual(api.archived, ['sesn_1']);
  } finally { await api.close(); }
});

test('reaching the cost cap is a failure that names the cap', async () => {
  const api = await fakeApi(() => [
    { id: 'e1', type: 'session.status_running' },
    { id: 'e2', type: 'session.status_idle', stop_reason: { type: 'budget_reached' } }
  ]);
  try {
    const { root } = project({ members: { scout: { agent: 'claude-cloud' } } });
    const r = await dispatch({ projectRoot: root, member: 'scout', task: 'go', adapterDir, env: cloudEnv(api) });
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /cost cap of \$5/);
  } finally { await api.close(); }
});

test('without an API key a cloud member falls back to on_unavailable', async () => {
  const { root } = project({ members: { scout: { agent: 'claude-cloud' } } });
  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify({ status: 'ok', summary: 'ran locally' }));
  const r = await dispatch({
    projectRoot: root, member: 'scout', task: 'go', adapterDir,
    env: { ANTHROPIC_API_KEY: '', AGENT_TEAM_GITHUB_TOKEN: '', AGENT_TEAM_MOCK_SCRIPT: script }
  });
  assert.equal(r.agent, 'mock');
  assert.match(r.warning, /"claude-cloud" unavailable/);
  assert.equal(r.summary, 'ran locally');
});

// A gh stand-in serving one repository's default branch, file list and agent-team.json.
function fakeGh(config, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'at-cloud-gh-'));
  const bin = join(dir, 'gh');
  const content = Buffer.from(JSON.stringify(config)).toString('base64');
  writeFileSync(bin, `#!/usr/bin/env node
const p = process.argv[3];
const out = (o) => process.stdout.write(JSON.stringify(o));
if (p === 'repos/acme/ios') out({ default_branch: 'main' });
else if (p.startsWith('repos/acme/ios/git/trees/main')) out({ sha: 't', truncated: false, tree: ${JSON.stringify(paths.map((path) => ({ path, type: 'blob' })))} });
else if (p.startsWith('repos/acme/ios/contents/.claude/agent-team.json')) out({ encoding: 'base64', content: '${content}' });
else { process.stderr.write('not found ' + p); process.exit(1); }
`);
  chmodSync(bin, 0o755);
  return bin;
}

const IOS_CONFIG = {
  members: {
    'ios-lead': { agent: 'codex', model: 'opus', charter: 'iOS' },
    explorer: { agent: 'claude', reports_to: 'ios-lead' }
  },
  deny_paths: ['Configurations/secrets.xcconfig']
};

test('a team named by GitHub repository runs its entry member as one cloud session', async () => {
  const api = await fakeApi(() => finished('iOS is at 2026.10.2 (272)'));
  const prevGh = process.env.AGENT_TEAM_GH_BIN;
  process.env.AGENT_TEAM_GH_BIN = fakeGh(IOS_CONFIG, ['App.swift', 'Configurations/base.xcconfig']);
  try {
    const { root } = project({
      members: { lead: { agent: 'mock' }, ios: { team: 'github:acme/ios', reports_to: 'lead' } },
      defaults: { cloud_max_cost_usd: 1 }
    });
    const script = join(root, 'script.json');
    writeFileSync(script, JSON.stringify({ by_member: { lead: [
      { status: 'delegating', delegations: [{ to: 'ios', task: 'versions?' }] },
      { status: 'ok', summary: 'combined' }
    ] } }));
    const r = await dispatch({ projectRoot: root, member: 'lead', task: 'go', adapterDir, env: cloudEnv(api, { AGENT_TEAM_MOCK_SCRIPT: script }) });
    assert.equal(r.status, 'ok', r.summary);
    const [team] = r.delegated;
    assert.deepEqual(team.team, { repo: 'https://github.com/acme/ios', ref: 'main', member: 'ios-lead' });
    const [entry] = team.delegated;
    assert.equal(entry.agent, 'claude-cloud');
    assert.equal(entry.summary, 'iOS is at 2026.10.2 (272)');
    const [session] = api.sessions;
    assert.equal(session.resources[0].url, 'https://github.com/acme/ios');
    assert.equal(session.budget.max_list_cost.amount, '100');   // the caller's lower cap wins
    assert.doesNotMatch(session.initial_events[0].content[0].text, /delegating/);   // a leaf: no delegation section
  } finally {
    process.env.AGENT_TEAM_GH_BIN = prevGh ?? '';
    if (prevGh === undefined) delete process.env.AGENT_TEAM_GH_BIN;
    await api.close();
  }
});

test('a GitHub team whose files match its own deny_paths is refused', async () => {
  const prevGh = process.env.AGENT_TEAM_GH_BIN;
  process.env.AGENT_TEAM_GH_BIN = fakeGh(IOS_CONFIG, ['App.swift', 'Configurations/secrets.xcconfig']);
  try {
    const { root } = project({ members: { lead: { agent: 'mock' }, ios: { team: 'github:acme/ios', reports_to: 'lead' } } });
    const script = join(root, 'script.json');
    writeFileSync(script, JSON.stringify({ by_member: { lead: { status: 'delegating', delegations: [{ to: 'ios', task: 'x' }] } } }));
    await assert.rejects(
      dispatch({ projectRoot: root, member: 'lead', task: 'go', adapterDir, env: { AGENT_TEAM_MOCK_SCRIPT: script, ANTHROPIC_API_KEY: 'k', AGENT_TEAM_GITHUB_TOKEN: 't' } }),
      /deny_paths matches 1 file\(s\) in https:\/\/github\.com\/acme\/ios \(main\).*secrets\.xcconfig/
    );
  } finally {
    if (prevGh === undefined) delete process.env.AGENT_TEAM_GH_BIN; else process.env.AGENT_TEAM_GH_BIN = prevGh;
  }
});

test('a project cannot reach itself again through its own GitHub name', async () => {
  const { root } = project({ members: { lead: { agent: 'mock' }, self: { team: 'github:acme/app', reports_to: 'lead' } } });
  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify({ by_member: { lead: { status: 'delegating', delegations: [{ to: 'self', task: 'x' }] } } }));
  await assert.rejects(
    dispatch({ projectRoot: root, member: 'lead', task: 'go', adapterDir, env: { AGENT_TEAM_MOCK_SCRIPT: script } }),
    /team "github:acme\/app" is already in this delegation/
  );
});

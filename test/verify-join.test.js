// Runs scripts/verify-join.mjs against a simulated session, so the script's own logic is
// checked before anyone points it at the real API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/verify-join.mjs', import.meta.url).pathname;
const REPO = 'https://github.com/acme/app';
const SID = 'sesn_verify';

// A session that moves one step per GET. A turn takes `steps` reads to finish. A message
// posted while running either queues as its own turn or, with joinMidTurn, joins the current one.
// The list is ordered by processed_at as the docs state, with still-queued events last.
async function simulatedSession({ joinMidTurn = false, steps = 3, agent, otherWorkspaceKey = 'other-ws' } = {}) {
  const s = {
    status: 'idle', archived_at: null, events: [], queue: [], left: 0, reply: null, cost: 0, n: 0,
    agent: agent ?? { tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: false },
      configs: [{ name: 'read', enabled: true }] }], mcp_servers: [] }
  };
  const id = () => `sevt_${++s.n}`;
  const at = () => `t${String(s.n).padStart(4, '0')}`;
  const replyTo = (msg) => {
    const t = msg.content[0].text;
    if (/version/.test(t)) return '1.2.3';
    const word = t.match(/the word (\w+)/);
    return word ? word[1] : '1 2 3';
  };
  const start = (msg) => {
    s.events.push({ id: id(), type: 'session.status_running', processed_at: at() });
    msg.processed_at = at();
    s.status = 'running';
    s.left = steps;
    s.reply = replyTo(msg);
  };
  const tick = () => {
    if (s.status === 'idle' && s.queue.length) return start(s.queue.shift());
    if (s.status !== 'running') return;
    if (joinMidTurn && s.queue.length) {
      const msg = s.queue.shift();
      s.n++;
      msg.processed_at = at();
      s.reply = replyTo(msg);
    }
    if (--s.left > 0) return;
    s.cost += 50;
    s.events.push({ id: id(), type: 'agent.message', processed_at: at(), content: [{ type: 'text', text: s.reply }] });
    s.events.push({ id: id(), type: 'session.usage', processed_at: at(), list_cost: { amount: String(s.cost), currency: 'USD' } });
    s.events.push({ id: id(), type: 'session.status_idle', processed_at: at(), stop_reason: { type: 'end_turn' } });
    s.status = 'idle';
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reply = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers['x-api-key'] === otherWorkspaceKey) return reply({ error: { type: 'not_found_error' } }, 404);
      if (req.method === 'GET' && req.url === `/v1/sessions/${SID}`) {
        tick();
        return reply({ id: SID, status: s.status, archived_at: s.archived_at, budget: null, agent: s.agent, usage: { cost: s.cost },
          resources: [{ type: 'github_repository', url: REPO, checkout: { type: 'branch', name: 'main' } }] });
      }
      if (req.method === 'GET' && req.url.startsWith(`/v1/sessions/${SID}/events`)) {
        tick();
        const key = (e) => e.processed_at ?? '\uffff';
        return reply({ data: [...s.events].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)), next_page: null });
      }
      if (req.method === 'POST' && req.url === `/v1/sessions/${SID}/events`) {
        if (s.archived_at) return reply({ error: { type: 'invalid_request_error', message: 'session is archived' } }, 400);
        const msg = { id: id(), ...JSON.parse(body).events[0], processed_at: null };
        s.events.push(msg);
        s.queue.push(msg);
        return reply({ data: [{ ...msg }] });
      }
      if (req.method === 'POST' && req.url === `/v1/sessions/${SID}/archive`) { s.archived_at = 'now'; return reply({}); }
      reply({ error: `unexpected ${req.method} ${req.url}` }, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${server.address().port}`;
  s.close = () => new Promise((r) => server.close(r));
  return s;
}

function runScript(api, args, extraEnv = {}) {
  const out = mkdtempSync(join(tmpdir(), 'at-verify-out-'));
  return new Promise((resolve) => {
    execFile(process.execPath, [script, '--session', SID, '--out', out, '--timeout', '20', ...args], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: api.url, AGENT_TEAM_CLOUD_POLL_MS: '5', ...extraEnv }
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr, out }));
  });
}

test('verify-join: the round trip passes and leaves raw responses behind', async () => {
  const api = await simulatedSession();
  try {
    const r = await runScript(api, ['--repo', REPO, '--ref', 'main']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS  the agent\.message after our event is the answer/);
    assert.match(r.stdout, /PASS  processed_at fills in once the turn runs/);
    assert.match(r.stdout, /PASS  the event list is in processed_at order/);
    assert.match(r.stdout, /processed_at in the POST response — null/);
    assert.match(r.stdout, /joinRefusal\(\) for --repo\/--ref — none/);
    assert.match(r.stdout, /delta 50/);
    assert.deepEqual(readdirSync(r.out).sort(), ['1-events.json', '1-post-response.json', '1-session.json']);
  } finally { await api.close(); }
});

test('verify-join: a tool list without configs or default_config fails the shape check', async () => {
  const api = await simulatedSession({ agent: { tools: [{ type: 'agent_toolset_20260401' , enabled_tools: ['read'] }] } });
  try {
    const r = await runScript(api, []);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAIL  agent_toolset_20260401 carries configs\[\] or default_config/);
  } finally { await api.close(); }
});

test('verify-join: --mid-turn tells a queued message from one that joins the running turn', async () => {
  for (const [joinMidTurn, pattern] of [[false, /QUEUES as its own turn/], [true, /JOINS the running turn/]]) {
    const api = await simulatedSession({ joinMidTurn, steps: 8 });
    try {
      const r = await runScript(api, ['--mid-turn']);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, pattern);
      assert.match(r.stdout, /answer the rule picks for B — "second"/);
    } finally { await api.close(); }
  }
});

test('verify-join: --second-key reports a key that cannot see the session', async () => {
  const api = await simulatedSession();
  try {
    const ok = await runScript(api, ['--second-key'], { ANTHROPIC_API_KEY_2: 'same-ws' });
    assert.match(ok.stdout, /PASS  a second key can post to the session/);
    const no = await runScript(api, ['--second-key'], { ANTHROPIC_API_KEY_2: 'other-ws' });
    assert.equal(no.code, 1);
    assert.match(no.stdout, /FAIL  a second key can read the session — HTTP 404/);
  } finally { await api.close(); }
});

test('verify-join: --archive records the refusal to post', async () => {
  const api = await simulatedSession();
  try {
    const r = await runScript(api, ['--archive']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS  posting to an archived session is refused — HTTP 400/);
  } finally { await api.close(); }
});

test('verify-join: --project delegates through agent-team and checks the answer', async () => {
  const api = await simulatedSession();
  const root = mkdtempSync(join(tmpdir(), 'at-verify-proj-'));
  const bare = mkdtempSync(join(tmpdir(), 'at-verify-bare-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', REPO);
  git('config', `url.file://${bare}.insteadOf`, REPO);
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members: { scout: { agent: 'claude-cloud', session_id: SID } }, deny_paths: ['credentials/**'], defaults: { on_unavailable: 'fail' }
  }));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('push', '-q', 'origin', 'main');
  try {
    const missing = await runScript(api, ['--project', root, '--member', 'scout']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /needs AGENT_TEAM_GITHUB_TOKEN/);

    const r = await runScript(api, ['--project', root, '--member', 'scout'],
      { AGENT_TEAM_GITHUB_TOKEN: 'x', AGENT_TEAM_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'at-verify-ws-')) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS  the claude-cloud adapter ran, not a fallback/);
    assert.match(r.stdout, /PASS  the answer is the version in package\.json/);
    assert.match(r.stdout, /PASS  the session was not archived/);
  } finally { await api.close(); }
});

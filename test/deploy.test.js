import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { parseConfig } from '../src/config.js';
import { project, LIVE } from './helpers/live.js';
import { call, get, post, until } from './helpers/http.js';

const SOCK = '/tmp/deploy-test.sock';

// A run in a real project whose config carries `deploy`, served with a stand-in supervisor
// that only names the socket (deploy never asks it to do anything).
async function served(deploy, { owner = SOCK, http = {} } = {}) {
  const { root } = project({ solo: LIVE() }, { by_member: {} });
  const cfg = join(root, '.claude', 'agent-team.json');
  const raw = JSON.parse(readFileSync(cfg, 'utf8'));
  if (deploy !== undefined) raw.deploy = deploy;
  writeFileSync(cfg, JSON.stringify(raw));
  const store = openStore(':memory:');
  const runId = store.createRun({ project: root, task: 't', owner });
  const lead = store.addMember({ runId, parentId: null, name: 'solo', task: 't', depth: 0 });
  store.setRunRoot(runId, lead.id);
  store.setState(lead.id, 'done');
  const web = await startHttp({ store, sup: { socketPath: SOCK }, port: 0, by: 'tester', ...http });
  return { root, store, runId, lead, web, path: `/api/runs/${runId}/deploy`, close: () => web.close() };
}

const MINIMAL = { members: { a: { agent: 'claude', isolation: 'read-only' } }, deny_paths: ['**/.env*'] };

test('config: deploy is an optional non-empty string', () => {
  assert.equal(parseConfig(MINIMAL, 'x').deploy, null);
  assert.equal(parseConfig({ ...MINIMAL, deploy: 'make build' }, 'x').deploy, 'make build');
  for (const bad of ['', '   ', 5, true, ['make'], {}]) {
    assert.throws(() => parseConfig({ ...MINIMAL, deploy: bad }, 'x'), /"deploy" must be a non-empty shell command string/);
  }
});

test('deploy runs the configured command in the project root and reports its output', async () => {
  const s = await served('pwd > where.txt; echo built; echo oops >&2');
  try {
    const before = await get(s.web.url, s.path);
    assert.equal(before.json.command, 'pwd > where.txt; echo built; echo oops >&2');
    assert.equal(before.json.state, 'idle');

    const r = await post(s.web.url, s.path, { command: before.json.command });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, 'running');
    await until(async () => (await get(s.web.url, s.path)).json.state !== 'running');
    const done = (await get(s.web.url, s.path)).json;
    assert.equal(done.state, 'ok');
    assert.equal(done.exit, 0);
    assert.equal(done.by, 'tester');
    assert.match(done.output, /built/);
    assert.match(done.output, /oops/);
    assert.equal(readFileSync(join(s.root, 'where.txt'), 'utf8').trim(), realpathSync(s.root));
    const kinds = s.store.events(s.lead.id).filter((e) => e.kind === 'deploy').map((e) => e.body.state);
    assert.deepEqual(kinds, ['running', 'ok']);   // what the page's event stream wakes on
  } finally { await s.close(); }
});

test('a failing deploy is reported as failed with its exit code', async () => {
  const s = await served('echo nope; exit 3');
  try {
    await post(s.web.url, s.path, { command: 'echo nope; exit 3' });
    await until(async () => (await get(s.web.url, s.path)).json.state === 'failed');
    const d = (await get(s.web.url, s.path)).json;
    assert.equal(d.exit, 3);
    assert.match(d.output, /nope/);
  } finally { await s.close(); }
});

test('a second deploy while one runs is 409, and a timeout kills the command', async () => {
  const s = await served('sleep 30', { http: { deployTimeoutMs: 300 } });
  try {
    assert.equal((await post(s.web.url, s.path, { command: 'sleep 30' })).status, 200);
    const again = await post(s.web.url, s.path, { command: 'sleep 30' });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /already running/);
    await until(async () => (await get(s.web.url, s.path)).json.state === 'failed');
    const d = (await get(s.web.url, s.path)).json;
    assert.equal(d.timed_out, true);
    assert.equal((await post(s.web.url, s.path, { command: 'sleep 30' })).status, 200);   // free again
  } finally { await s.close(); }
});

test('deploy refuses a cross-origin request, a non-JSON body, a changed command, a missing deploy and a run serve does not own', async () => {
  const s = await served('touch ran.txt');
  try {
    const body = { command: 'touch ran.txt' };
    assert.equal((await post(s.web.url, s.path, body, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(s.web.url, s.path, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call(s.web.url, 'POST', s.path, { body: 'command=touch', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await post(s.web.url, s.path, { command: 'rm -rf /' })).status, 409);
    assert.equal((await post(s.web.url, s.path, {})).status, 409);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!existsSync(join(s.root, 'ran.txt')), 'no refused request may run the command');
  } finally { await s.close(); }

  const none = await served(undefined);
  try {
    assert.equal((await get(none.web.url, none.path)).json.command, null);
    assert.equal((await post(none.web.url, none.path, { command: 'x' })).status, 404);
  } finally { await none.close(); }

  const other = await served('touch ran.txt', { owner: '/someone-else.sock' });
  try {
    assert.equal((await post(other.web.url, other.path, { command: 'touch ran.txt' })).status, 409);
    assert.ok(!existsSync(join(other.root, 'ran.txt')));
  } finally { await other.close(); }
});

test('without a supervisor the page can watch deploys but not start one', async () => {
  const { root } = project({ solo: LIVE() }, { by_member: {} });
  const store = openStore(':memory:');
  const runId = store.createRun({ project: root, task: 't', owner: null });
  const web = await startHttp({ store, port: 0 });
  try {
    assert.equal((await post(web.url, `/api/runs/${runId}/deploy`, { command: 'x' })).status, 503);
    assert.equal((await get(web.url, `/api/runs/${runId}/deploy`)).json.state, 'idle');
    assert.equal((await get(web.url, '/api/runs/999/deploy')).status, 404);
  } finally { await web.close(); }
});

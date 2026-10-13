import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { resolveTeam, knownTeams } from '../src/teams.js';
import { teamStatus } from '../src/view.js';

const base = () => realpathSync(mkdtempSync(join(tmpdir(), 'at-teams-')));

function repoIn(parent, name, extra = {}) {
  const root = join(parent, name);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members: { lead: { agent: 'mock-live' } }, deny_paths: ['**/.env*'], ...extra
  }));
  return root;
}
const repo = (name, extra) => repoIn(base(), name, extra);

function ctx(root) {
  return { store: openStore(':memory:'), projectRoot: root, config: loadConfig(root) };
}

test("known teams are the supervisor's projects plus the caller's peers, sorted", () => {
  const parent = base();
  const loupe = repoIn(parent, 'loupe');
  const zed = repoIn(parent, 'zed');
  const android = repoIn(parent, 'android', { peers: ['../loupe'] });
  const c = ctx(android);
  c.store.createRun({ project: zed, task: 't' });
  c.store.createRun({ project: loupe, task: 't' });
  assert.deepEqual(knownTeams(c), [
    { name: 'loupe', root: loupe, source: 'peer' },
    { name: 'zed', root: zed, source: 'supervisor' }
  ]);
});

test('a relative peer resolves against the project root', () => {
  const parent = base();
  const loupe = repoIn(parent, 'loupe');
  const android = repoIn(parent, 'android', { peers: ['../loupe'] });
  assert.deepEqual(knownTeams(ctx(android)), [{ name: 'loupe', root: loupe, source: 'peer' }]);
});

test('a ~/ peer expands to the home directory; a missing one is listed missing', () => {
  const name = `at-no-such-team-${process.pid}`;
  const android = repo('android', { peers: [`~/${name}`] });
  assert.deepEqual(knownTeams(ctx(android)),
    [{ name, root: join(homedir(), name), source: 'peer', missing: true }]);
});

test('a missing peer cannot be resolved', () => {
  const android = repo('android', { peers: ['../gone'] });
  assert.throws(() => resolveTeam({ ...ctx(android), team: '../gone' }),
    /team "\.\.\/gone" not found: no agent-team config at .*\.claude\/agent-team\.json/);
});

test('resolveTeam finds a supervisor project by name and any configured directory by path', () => {
  const parent = base();
  const loupe = repoIn(parent, 'loupe');
  const stray = repoIn(parent, 'stray');
  const android = repoIn(parent, 'android');
  const c = ctx(android);
  c.store.createRun({ project: loupe, task: 't' });
  const byName = resolveTeam({ ...c, team: 'loupe' });
  assert.equal(byName.root, loupe);
  assert.equal(byName.name, 'loupe');
  assert.equal(byName.source, 'supervisor');
  assert.ok(byName.config.members.lead);
  assert.ok(byName.keys.includes(loupe));
  assert.equal(resolveTeam({ ...c, team: stray }).root, stray);
});

test('two known teams with one name are ambiguous by name, fine by path', () => {
  const a = repo('loupe');
  const b = repo('loupe');
  const android = repo('android');
  const c = ctx(android);
  c.store.createRun({ project: a, task: 't' });
  c.store.createRun({ project: b, task: 't' });
  assert.throws(() => resolveTeam({ ...c, team: 'loupe' }), /ambiguous/);
  assert.equal(resolveTeam({ ...c, team: b }).root, b);
});

test('a GitHub name is refused', () => {
  const c = ctx(repo('android'));
  assert.throws(() => resolveTeam({ ...c, team: 'github:me/loupe' }), /is a GitHub repository/);
});

test('a config that exists but is broken carries the team name', () => {
  const parent = base();
  const loupe = repoIn(parent, 'loupe', { deny_paths: [] });
  const android = repoIn(parent, 'android');
  const c = ctx(android);
  c.store.createRun({ project: loupe, task: 't' });
  assert.throws(() => resolveTeam({ ...c, team: 'loupe' }), /^Error: team "loupe": /);
});

test('teamStatus lists running work in the team\'s scope, with checkpoints and nothing else', () => {
  const store = openStore(':memory:');
  const b = repo('loupe');
  const own = store.createRun({ project: b, task: 'own run '.repeat(50) });
  const lead = store.addMember({ runId: own, parentId: null, name: 'lead', task: 'secret task text', depth: 0 });
  store.setWorkspace(lead.id, '/secret/workspace');
  store.setResult(lead.id, { status: 'ok', summary: 'secret summary' });
  store.addEvent(lead.id, 'text', { text: 'secret transcript' });
  store.addEvent(lead.id, 'progress', { text: 'half way' });
  const other = store.createRun({ project: '/a', task: 't' });
  const mgr = store.addMember({ runId: other, parentId: null, name: 'manager', task: 't', depth: 0 });
  const entry = store.addMember({ runId: other, parentId: mgr.id, name: 'lead', task: 't', depth: 0, project: b, alias: 'loupe' });
  store.addMember({ runId: other, parentId: entry.id, name: 'dev', task: 't', depth: 1 });
  const done = store.createRun({ project: b, task: 'old' });
  store.finishRun(done, 'done');

  const s = teamStatus(store, { name: 'loupe', root: b, source: 'peer' });
  assert.deepEqual(s.team, { name: 'loupe', root: b, source: 'peer' });
  assert.deepEqual(s.runs.map((r) => r.id), [other, own]);
  assert.deepEqual(s.runs[0].members.map((m) => m.name), ['lead', 'dev']);   // not the manager
  assert.equal(s.runs[1].task.length, 200);
  assert.deepEqual(s.runs[1].members[0].checkpoint.text, 'half way');
  const json = JSON.stringify(s);
  for (const secret of ['secret task text', '/secret/workspace', 'secret summary', 'secret transcript', 'token']) {
    assert.ok(!json.includes(secret), secret);
  }
});

test('teamStatus leaves out finished members and members under a differently scoped entry', () => {
  const store = openStore(':memory:');
  const a = repo('a');
  const b = repo('b');
  const c = repo('c');
  const run = store.createRun({ project: a, task: 't' });
  const mgr = store.addMember({ runId: run, parentId: null, name: 'manager', task: 't', depth: 0 });
  const doneM = store.addMember({ runId: run, parentId: mgr.id, name: 'finished', task: 't', depth: 1 });
  store.setState(doneM.id, 'done');
  const failedM = store.addMember({ runId: run, parentId: mgr.id, name: 'broke', task: 't', depth: 1 });
  store.setState(failedM.id, 'failed');
  const live = store.addMember({ runId: run, parentId: mgr.id, name: 'worker', task: 't', depth: 1 });
  store.setState(live.id, 'running');
  const entry = store.addMember({ runId: run, parentId: mgr.id, name: 'b-lead', task: 't', depth: 0, project: b, alias: 'b' });
  store.setState(entry.id, 'running');
  const nested = store.addMember({ runId: run, parentId: entry.id, name: 'b-dev', task: 't', depth: 1 });
  store.setState(nested.id, 'running');

  const inA = teamStatus(store, { name: 'a', root: a, source: 'supervisor' });
  assert.deepEqual(inA.runs[0].members.map((m) => m.name), ['manager', 'worker']);   // not b's, not done/failed
  const inB = teamStatus(store, { name: 'b', root: b, source: 'supervisor' });
  assert.deepEqual(inB.runs[0].members.map((m) => m.name), ['b-lead', 'b-dev']);
  assert.deepEqual(teamStatus(store, { name: 'c', root: c, source: 'supervisor' }).runs, []);
});

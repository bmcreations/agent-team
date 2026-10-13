import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';

const execFileAsync = promisify(execFile);
const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'at-cli-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify(config));
  return root;
}

const GOOD = {
  members: {
    coo: { agent: 'mock', isolation: 'none' },
    marketer: { agent: 'mock', reports_to: 'coo', isolation: 'none' }
  },
  deny_paths: ['credentials/**'],
  defaults: { on_unavailable: 'mock' }
};

// A broken config that fails loadConfig's validation (no deny_paths) rather than one that
// crashes for some unrelated reason — this is what "org on a broken config" means here.
const BROKEN = {
  members: { coo: { agent: 'mock' } }
};

// Runs the real CLI as a subprocess (not an in-process import) so a raw, unhandled stack
// trace on stdout/stderr is actually observable the way an operator would see it.
function runCli(args, env = process.env) {
  return execFileAsync(process.execPath, [BIN, ...args], { env }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' })
  );
}

test('an unknown --member gives exit 1 and parseable JSON on stdout naming the member', async () => {
  const root = project(GOOD);
  const { code, stdout, stderr } = await runCli([
    '--member', 'ghost', '--task', 'go', '--project', root
  ]);
  assert.equal(code, 1);
  assert.doesNotMatch(stdout, /at Object|at async|\.js:\d+:\d+/, 'stdout must not carry a raw stack trace');
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, 'failed');
  assert.match(parsed.summary, /ghost/);
  assert.equal(stderr, '');
});

test('a missing --member gives exit 2 and the usage string on stderr', async () => {
  const root = project(GOOD);
  const { code, stdout, stderr } = await runCli(['--task', 'go', '--project', root]);
  assert.equal(code, 2);
  assert.match(stderr, /^usage: agent-team/);
  assert.equal(stdout, '');
});

test('"org" on a good config gives exit 0 and prints the tree', async () => {
  const root = project(GOOD);
  const { code, stdout, stderr } = await runCli(['org', '--project', root]);
  assert.equal(code, 0);
  assert.match(stdout, /coo/);
  assert.match(stdout, /marketer/);
  assert.equal(stderr, '');
});

test('"org" on a broken config gives exit 1 and parseable JSON, not a stack trace', async () => {
  const root = project(BROKEN);
  const { code, stdout, stderr } = await runCli(['org', '--project', root]);
  assert.equal(code, 1);
  assert.doesNotMatch(stdout, /at Object|at async|\.js:\d+:\d+/, 'stdout must not carry a raw stack trace');
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, 'failed');
  assert.match(parsed.summary, /deny_paths/);
  assert.equal(stderr, '');
});

test('`agent-team report` prints a plain message, not JSON, when nothing has been logged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-cli-report-'));
  const env = {
    ...process.env,
    AGENT_TEAM_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'at-cli-report-ws-')),
    AGENT_TEAM_SUPERVISOR_DB: join(mkdtempSync(join(tmpdir(), 'at-cli-report-db-')), 'supervisor.db')
  };
  const text = await runCli(['report', '--project', dir], env);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /No delegations recorded/);
  const json = await runCli(['report', '--json', '--project', dir], env);
  assert.deepEqual(JSON.parse(json.stdout), []);
  assert.equal(existsSync(env.AGENT_TEAM_SUPERVISOR_DB), false);   // report never creates a store
});

test('`agent-team report` includes a finished run from the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-cli-report-'));
  const dbPath = join(mkdtempSync(join(tmpdir(), 'at-cli-report-db-')), 'supervisor.db');
  const store = openStore(dbPath);
  const runId = store.createRun({ project: dir, task: 'live task' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 'go', depth: 0 });
  store.setRunRoot(runId, lead.id);
  store.setResult(lead.id, { status: 'ok', summary: 'done' });
  store.setState(lead.id, 'done');
  store.finishRun(runId, 'done');
  store.close();
  const env = {
    ...process.env,
    AGENT_TEAM_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'at-cli-report-ws-')),
    AGENT_TEAM_SUPERVISOR_DB: dbPath
  };
  const text = await runCli(['report', '--project', dir], env);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /live task/);
  assert.equal(JSON.parse((await runCli(['report', '--json', '--project', dir], env)).stdout)[0].v, 2);
});

test('a v1 member whose agent cannot be resolved is still recorded in the run log', async () => {
  const root = project({ members: { old: { agent: 'nope', isolation: 'none' } }, deny_paths: ['x/**'],
    defaults: { on_unavailable: 'nope' } });
  const ws = mkdtempSync(join(tmpdir(), 'at-cli-log-'));
  const { code, stdout } = await runCli(['--member', 'old', '--task', 'go', '--project', root],
    { ...process.env, AGENT_TEAM_WORKSPACE_ROOT: ws });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).status, 'failed');
  const runs = join(ws, 'agent-team', 'runs');
  const [file] = readdirSync(runs);
  const entry = JSON.parse(readFileSync(join(runs, file), 'utf8').trim());
  assert.equal(entry.tree.member, 'old');
  assert.equal(entry.tree.status, 'failed');
  assert.match(entry.tree.summary, /unavailable/);
});

// A temp store with threads in it; the CLI reads it through AGENT_TEAM_SUPERVISOR_DB.
function threadStore() {
  const dir = mkdtempSync(join(tmpdir(), 'at-thr-'));
  const dbPath = join(dir, 's.db');
  const store = openStore(dbPath);
  const run = store.createRun({ project: '/a', task: 't', owner: '/elsewhere.sock' });
  const m = store.addMember({ runId: run, parentId: null, name: 'mgr', task: 't', depth: 0 });
  const lead = store.addMember({ runId: run, parentId: m.id, name: 'lead', task: 't', depth: 1 });
  const t1 = store.addThread({ kind: 'task', fromProject: '/a', fromRun: run, fromMember: m.id,
    toProject: '/b', toMember: 'lead', chain: ['/a'], text: 'x\x1b[2Jy opening', task: 'fix\x07 it' });
  store.setThreadOwner(t1, lead.id);
  store.addThreadPost({ threadId: t1, side: 'receiver', author: 'lead', text: 'ok' });
  store.addThread({ kind: 'question', fromProject: '/a', fromRun: run, fromMember: m.id,
    toProject: '/c', toMember: 'lead', chain: ['/a'], text: 'why\x1b]0;pwned\x07 so slow?' });
  store.close();
  return { dir, dbPath, env: { ...process.env, AGENT_TEAM_SUPERVISOR_DB: dbPath, XDG_CACHE_HOME: dir } };
}

test('threads lists one line per thread under a header per pair, with control characters stripped', async () => {
  const { env } = threadStore();
  const { code, stdout } = await runCli(['threads'], env);
  assert.equal(code, 0);
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(stdout), false, 'no control characters');
  const lines = stdout.trimEnd().split('\n');
  assert.deepEqual(lines.filter((l) => !l.startsWith(' ')), ['a → c', 'a → b']);
  assert.match(stdout, /#1 open task mgr -> lead: fix it/);
  assert.match(stdout, /#2 open question mgr -> -: why\]0;pwned so slow\?/);
});

test('threads falls back to the first post when a thread has no task, and clips to 80 characters', async () => {
  const { env, dbPath } = threadStore();
  const store = openStore(dbPath);
  const run = store.createRun({ project: '/a', task: 't', owner: '/e.sock' });
  const m = store.addMember({ runId: run, parentId: null, name: 'mgr', task: 't', depth: 0 });
  store.addThread({ kind: 'question', fromProject: '/a', fromRun: run, fromMember: m.id, toProject: '/b',
    toMember: 'lead', chain: [], text: 'q'.repeat(200) });
  store.close();
  const { stdout } = await runCli(['threads'], env);
  const line = stdout.split('\n').find((l) => l.trim().startsWith('#3 '));
  assert.ok(line.endsWith(': ' + 'q'.repeat(80)), line);
});

test('threads --json prints the threadsView object; --project narrows it', async () => {
  const { env } = threadStore();
  const all = JSON.parse((await runCli(['threads', '--json'], env)).stdout);
  assert.deepEqual(all.pairs.map((p) => p.pair), ['a → c', 'a → b']);
  assert.equal('chain' in all.pairs[0].threads[0], false);
  const one = JSON.parse((await runCli(['threads', '--json', '--project', '/c'], env)).stdout);
  assert.deepEqual(one.pairs.map((p) => p.pair), ['a → c']);
});

test('threads never creates a store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-thr-none-'));
  const env = { ...process.env, AGENT_TEAM_SUPERVISOR_DB: join(dir, 'none.db'), XDG_CACHE_HOME: dir };
  const r = await runCli(['threads'], env);
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(dir, 'none.db')), false);
});

test('reply with no supervisor listening says to start serve; bad usage is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-rep-'));
  const env = { ...process.env, AGENT_TEAM_SUPERVISOR_SOCK: join(dir, 'none.sock') };
  const r = await runCli(['reply', '1', 'hi'], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^agent-team: no agent-team supervisor is listening on .*none\.sock\. Start one with `agent-team serve`/);
  assert.match((await runCli(['reply', '1'], env)).stderr, /^agent-team: usage: agent-team reply <thread> <text>/);
  assert.match((await runCli(['reply', 'x', 'hi'], env)).stderr, /usage: agent-team reply/);
});

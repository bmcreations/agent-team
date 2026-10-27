import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, utimesSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, pruneSnapshots, snapshotRoot } from '../src/workspace.js';
import { diffBase } from '../src/diffbase.js';

const DENY = ['credentials/**', '**/.env*'];

// Forced on so these run the snapshot path on any filesystem; where the filesystem can't
// clone, each clone is a full copy, which changes disk use but nothing tested here.
const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-snaproot-'));
process.env.AGENT_TEAM_WORKSPACE_ROOT = WORKSPACE_ROOT;
process.env.AGENT_TEAM_WORKSPACE_SNAPSHOTS = 'on';

function repoWithSecrets() {
  const root = mkdtempSync(join(tmpdir(), 'at-snap-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'ok\n');
  writeFileSync(join(root, 'credentials', 'signing.p8'), 'PRIVATE KEY\n');
  writeFileSync(join(root, '.env.production'), 'TOKEN=hunter2\n');
  // Two fixtures committed in the same second would otherwise be the same commit, and so
  // share a snapshot, which is right but breaks the counts below.
  writeFileSync(join(root, 'fixture-id'), `${randomUUID()}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

const out = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const snapshots = () => existsSync(snapshotRoot())
  ? readdirSync(snapshotRoot()).filter((n) => !n.startsWith('.'))
  : [];

test('a second workspace of the same commit and deny set reuses the snapshot', () => {
  const before = snapshots().length;
  const root = repoWithSecrets();
  const a = createWorkspace(root, 'ios', DENY, 'workspace');
  const b = createWorkspace(root, 'android', DENY, 'workspace');
  assert.equal(snapshots().length, before + 1);

  for (const [ws, member] of [[a, 'ios'], [b, 'android']]) {
    assert.equal(out(ws.dir, 'rev-list', '--count', '--all'), '1', 'the member root is the only commit');
    assert.equal(out(ws.dir, 'log', '-1', '--format=%s'), `workspace: ${member}`);
    assert.equal(out(ws.dir, 'symbolic-ref', 'HEAD'), `refs/heads/${ws.branch}`);
    assert.equal(diffBase(ws.dir), out(ws.dir, 'rev-parse', 'HEAD'));
    assert.equal(out(ws.dir, 'status', '--porcelain'), '');
    assert.equal(out(ws.dir, 'for-each-ref', 'refs/agent-team/'), '', 'the snapshot tree ref is gone');
    const fsck = spawnSync('git', ['-C', ws.dir, 'fsck', '--full'], { encoding: 'utf8' });
    assert.equal(fsck.status, 0, fsck.stderr);
    assert.equal(fsck.stdout.trim(), '');
  }
  assert.equal(out(a.dir, 'rev-parse', 'HEAD^{tree}'), out(b.dir, 'rev-parse', 'HEAD^{tree}'));
  assert.deepEqual(a.unmatchedDenyPaths, []);
  assert.deepEqual(b.unmatchedDenyPaths, a.unmatchedDenyPaths);
});

test('a new commit or a different deny set builds a new snapshot', () => {
  const root = repoWithSecrets();
  createWorkspace(root, 'qa', DENY, 'workspace');
  const before = snapshots().length;
  createWorkspace(root, 'qa', [...DENY, 'docs/**'], 'workspace');
  assert.equal(snapshots().length, before + 1);
  writeFileSync(join(root, 'src', 'app.js'), 'changed\n');
  execFileSync('git', ['-C', root, 'commit', '-q', '-am', 'next']);
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.equal(snapshots().length, before + 2);
  assert.equal(readFileSync(join(ws.dir, 'src', 'app.js'), 'utf8'), 'changed\n');
});

test('a denied file is in neither the clone nor any object it carries', () => {
  const root = repoWithSecrets();
  createWorkspace(root, 'first', DENY, 'workspace');
  const ws = createWorkspace(root, 'second', DENY, 'workspace');
  assert.ok(!existsSync(join(ws.dir, 'credentials')));
  assert.ok(!existsSync(join(ws.dir, '.env.production')));
  const objects = execFileSync('git', ['-C', ws.dir, 'cat-file', '--batch-all-objects', '--batch'], { encoding: 'utf8' });
  assert.ok(!objects.includes('PRIVATE KEY'));
  assert.ok(!objects.includes('hunter2'));
  assert.ok(!existsSync(join(ws.dir, '.git', 'objects', 'info', 'alternates')));
});

test('the shared pack is kept, so a repack in a workspace leaves it alone', () => {
  const ws = createWorkspace(repoWithSecrets(), 'qa', DENY, 'workspace');
  const packs = readdirSync(join(ws.dir, '.git', 'objects', 'pack'));
  const keeps = packs.filter((n) => n.endsWith('.keep'));
  assert.ok(keeps.length > 0);
  execFileSync('git', ['-C', ws.dir, 'gc', '-q']);
  const after = readdirSync(join(ws.dir, '.git', 'objects', 'pack'));
  for (const keep of keeps) assert.ok(after.includes(keep.replace(/\.keep$/, '.pack')));
});

test('a write in one workspace changes neither the snapshot nor a sibling', () => {
  const root = repoWithSecrets();
  const a = createWorkspace(root, 'a', DENY, 'workspace');
  const b = createWorkspace(root, 'b', DENY, 'workspace');
  writeFileSync(join(a.dir, 'src', 'app.js'), 'edited by a\n');
  execFileSync('git', ['-C', a.dir, 'commit', '-q', '-am', 'a edits']);
  assert.equal(readFileSync(join(b.dir, 'src', 'app.js'), 'utf8'), 'ok\n');
  const snap = snapshots().map((n) => join(snapshotRoot(), n, 'tree', 'src', 'app.js'))
    .filter((p) => existsSync(p) && readFileSync(p, 'utf8') !== 'ok\n' && readFileSync(p, 'utf8') !== 'changed\n');
  assert.deepEqual(snap, []);
});

test('when the clone fails, the workspace is built from scratch', () => {
  const root = repoWithSecrets();
  createWorkspace(root, 'first', DENY, 'workspace');
  const bin = mkdtempSync(join(tmpdir(), 'at-snapbin-'));
  writeFileSync(join(bin, 'cp'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'cp'), 0o755);
  const path = process.env.PATH;
  const warn = console.warn;
  const warnings = [];
  process.env.PATH = `${bin}:${path}`;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const ws = createWorkspace(root, 'second', DENY, 'workspace');
    assert.equal(out(ws.dir, 'log', '-1', '--format=%s'), 'workspace: second');
    assert.ok(!existsSync(join(ws.dir, 'credentials')));
    assert.ok(!readdirSync(join(ws.dir, '.git', 'objects', 'pack')).some((n) => n.endsWith('.keep')));
    assert.ok(warnings.some((w) => w.includes('building from scratch')));
  } finally {
    process.env.PATH = path;
    console.warn = warn;
  }
});

test('two processes building the same snapshot at once both get a workspace, and one snapshot survives', async () => {
  const root = repoWithSecrets();
  const before = snapshots().length;
  const module = fileURLToPath(new URL('../src/workspace.js', import.meta.url));
  const script = `
    const { createWorkspace } = await import(${JSON.stringify(module)});
    const ws = createWorkspace(process.argv[1], process.argv[2], ${JSON.stringify(DENY)}, 'workspace');
    process.stdout.write(ws.dir);
  `;
  const run = (member) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, member], { env: process.env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`))));
  });
  const dirs = await Promise.all([run('one'), run('two')]);
  assert.equal(snapshots().length, before + 1);
  for (const dir of dirs) assert.equal(out(dir, 'status', '--porcelain'), '');
  assert.deepEqual(readdirSync(snapshotRoot()).filter((n) => n.startsWith('.build-')), []);
});

test('pruneSnapshots removes idle snapshots and leaves workspaces alone', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const head = out(root, 'rev-parse', 'HEAD');
  const mine = snapshots().filter((n) => n.startsWith(head));
  assert.equal(mine.length, 1);
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(join(snapshotRoot(), mine[0]), old, old);
  const removed = pruneSnapshots();
  assert.ok(removed.includes(join(snapshotRoot(), mine[0])));
  assert.equal(out(ws.dir, 'status', '--porcelain'), '');
  assert.equal(out(ws.dir, 'log', '-1', '--format=%s'), 'workspace: qa');
});

test('with snapshots off, no snapshot is built', () => {
  process.env.AGENT_TEAM_WORKSPACE_SNAPSHOTS = 'off';
  try {
    const root = repoWithSecrets();
    const head = out(root, 'rev-parse', 'HEAD');
    const ws = createWorkspace(root, 'qa', DENY, 'workspace');
    assert.ok(!snapshots().some((n) => n.startsWith(head)));
    assert.equal(out(ws.dir, 'log', '-1', '--format=%s'), 'workspace: qa');
  } finally {
    process.env.AGENT_TEAM_WORKSPACE_SNAPSHOTS = 'on';
  }
});

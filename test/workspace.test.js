import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createWorkspace, pruneWorkspace, cloneArgs } from '../src/workspace.js';

const DENY = ['credentials/**', '**/.env*'];

// createWorkspace resolves its cache root from AGENT_TEAM_WORKSPACE_ROOT (falling back to
// XDG_CACHE_HOME, then ~/.cache). Every test in this file that builds a workspace- or
// read-only-isolation workspace must run against a throwaway root, never the developer's
// real cache directory.
const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-wsroot-'));
process.env.AGENT_TEAM_WORKSPACE_ROOT = WORKSPACE_ROOT;

function listWorkspaceDirs(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = join(dir, entry.name);
        found.push(full);
        walk(full);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

function repoWithSecrets() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');   // global commit.gpgsign=true would break the fixture
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'credentials'), { recursive: true });
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'ok\n');
  writeFileSync(join(root, 'credentials', 'signing.p8'), 'PRIVATE KEY\n');
  writeFileSync(join(root, '.env.production'), 'TOKEN=hunter2\n');
  writeFileSync(join(root, 'a', 'b', '.env'), 'NESTED=1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

// Run a git command in the workspace and report exit status rather than throwing.
const tryGit = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

test('ordinary source is present in the workspace', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.equal(existsSync(join(ws.dir, 'src', 'app.js')), true);
});

test('denied paths are absent from the working tree, at every depth', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'signing.p8')), false);
  assert.equal(existsSync(join(ws.dir, '.env.production')), false);
  assert.equal(existsSync(join(ws.dir, 'a', 'b', '.env')), false);
});

test('denied paths are not even enumerable — git ls-files does not list them', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const listed = tryGit(ws.dir, 'ls-files').stdout;
  assert.match(listed, /src\/app\.js/);
  assert.doesNotMatch(listed, /credentials/);
  assert.doesNotMatch(listed, /\.env/);
});

test('git show cannot recover a denied file — the regression Task 4 shipped', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const shown = tryGit(ws.dir, 'show', 'HEAD:credentials/signing.p8');
  assert.notEqual(shown.status, 0, 'git show must fail, not print the key');
  assert.doesNotMatch(shown.stdout, /PRIVATE KEY/);
});

test('git archive does not carry a denied file out of the workspace', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const archived = spawnSync('git', ['-C', ws.dir, 'archive', 'HEAD'], { encoding: 'buffer' });
  assert.equal(archived.status, 0);
  assert.doesNotMatch(archived.stdout.toString('latin1'), /signing\.p8/);
});

test('the denied blob is gone from the object database, not merely unreferenced', () => {
  const root = repoWithSecrets();
  const blob = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD:credentials/signing.p8'],
    { encoding: 'utf8' }).trim();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const read = tryGit(ws.dir, 'cat-file', '-p', blob);
  assert.notEqual(read.status, 0, `blob ${blob} is still readable in the workspace`);
});

test('no remote survives, so the secrets cannot be fetched back', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.equal(tryGit(ws.dir, 'remote').stdout.trim(), '');
});

test('the workspace is on its own branch and two for one member do not collide', () => {
  const root = repoWithSecrets();
  const a = createWorkspace(root, 'qa', DENY, 'workspace');
  const b = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.match(a.branch, /^agent-team\/qa-[0-9a-f]{6}$/);
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(a.branch, b.branch);
});

test('isolation none gives a scratch directory with no repository at all', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'marketer', DENY, 'none');
  assert.equal(existsSync(ws.dir), true);
  assert.equal(existsSync(join(ws.dir, '.git')), false);
  assert.equal(ws.branch, null);
  assert.equal(ws.kind, 'none');
  pruneWorkspace(ws); // isolation:'none' workspaces live under os.tmpdir(), not WORKSPACE_ROOT — prune or leak
});

test('pruning removes the workspace directory', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  pruneWorkspace(ws);
  assert.equal(existsSync(ws.dir), false);
});

test('a denylist matching every tracked file fails clearly, not with a raw git error', () => {
  const root = repoWithSecrets();
  assert.throws(() => createWorkspace(root, 'qa', ['**'], 'workspace'), (err) => {
    assert.match(err.message, /deny_paths/);
    assert.match(err.message, /qa/);
    return true;
  });
});

// --- B1: a partial build must not strand a readable, unredacted clone ---

test('a failure partway through building leaves no readable clone behind', () => {
  const root = repoWithSecrets();
  assert.throws(() => createWorkspace(root, 'failmemberone', ['**'], 'workspace'));
  // The repo-key parent directory created by mkdirSync(dirname(dir)) before the clone is
  // harmless litter (empty, no repo content) — what matters is that no cloned git
  // repository for this member survives under the workspaces root.
  const leftover = listWorkspaceDirs(WORKSPACE_ROOT).filter((d) => d.includes('failmemberone'));
  assert.deepEqual(leftover, []);
});

test('after a partial-build throw, no directory anywhere under the workspaces root mentions the failed member', () => {
  const root = repoWithSecrets();
  assert.throws(() => createWorkspace(root, 'failmembertwo', ['**'], 'workspace'));
  const leftover = listWorkspaceDirs(WORKSPACE_ROOT).filter((d) => d.includes('failmembertwo'));
  assert.deepEqual(leftover, []);
});

// --- B2: workspaces must not live inside the repository ---

test('the workspace lives outside the repository, under the workspaces root env override', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.ok(ws.dir.startsWith(WORKSPACE_ROOT + '/'), ws.dir);
  assert.ok(!ws.dir.startsWith(root), 'workspace must not be nested inside the repo it protects');
  assert.equal(existsSync(join(root, '.claude', 'workspaces')), false);
});

test('read-only isolation also lands outside the repository', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'read-only');
  assert.ok(ws.dir.startsWith(WORKSPACE_ROOT + '/'), ws.dir);
});

test('two different repos get workspaces filed under different repo-key directories', () => {
  const rootA = repoWithSecrets();
  const rootB = repoWithSecrets();
  const wsA = createWorkspace(rootA, 'qa', DENY, 'workspace');
  const wsB = createWorkspace(rootB, 'qa', DENY, 'workspace');
  assert.notEqual(dirname(wsA.dir), dirname(wsB.dir));
});

test('the repo cannot be derived as a relative path from the workspace cwd', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  // Nested under the repo, `../../..` from the workspace dir would land back at repoRoot.
  // Outside it, walking up from the workspace dir must never reach repoRoot.
  let cur = ws.dir;
  for (let i = 0; i < 6; i += 1) {
    assert.notEqual(cur, root);
    cur = dirname(cur);
  }
});

// --- B3: submodules are a hole in deny_paths ---

function repoWithSubmodule() {
  const subRoot = mkdtempSync(join(tmpdir(), 'at-sub-'));
  execFileSync('git', ['init', '-q', '-b', 'main', subRoot]);
  const subGit = (...a) => execFileSync('git', ['-C', subRoot, ...a], { stdio: 'pipe' });
  subGit('config', 'user.email', 't@e.com');
  subGit('config', 'user.name', 'T');
  subGit('config', 'commit.gpgsign', 'false');
  mkdirSync(join(subRoot, 'credentials'), { recursive: true });
  writeFileSync(join(subRoot, 'credentials', 'sub-secret.p8'), 'SUBMODULE SECRET\n');
  subGit('add', '-A');
  subGit('commit', '-q', '-m', 'sub init');

  const root = repoWithSecrets();
  execFileSync('git', [
    '-C', root, '-c', 'protocol.file.allow=always',
    'submodule', 'add', '-q', subRoot, 'vendor/sub'
  ], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'add submodule'], { stdio: 'pipe' });
  return root;
}

test('the workspace has no .gitmodules and no gitlink for the submodule', () => {
  const root = repoWithSubmodule();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.equal(existsSync(join(ws.dir, '.gitmodules')), false);
  const shown = tryGit(ws.dir, 'show', 'HEAD:.gitmodules');
  assert.notEqual(shown.status, 0, '.gitmodules must not survive in the workspace commit');
  const listed = tryGit(ws.dir, 'ls-files').stdout;
  assert.doesNotMatch(listed, /vendor\/sub/);
});

test('git submodule update --init cannot recover the submodule content from the workspace', () => {
  const root = repoWithSubmodule();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  spawnSync('git', ['-C', ws.dir, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'],
    { encoding: 'utf8' });
  assert.equal(existsSync(join(ws.dir, 'vendor', 'sub', 'credentials', 'sub-secret.p8')), false);
});

// --- C1: deniedFiles must key off the exclude file it wrote, not the repo's own .gitignore ---

function repoWithTrackedGitignore() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  writeFileSync(join(root, 'keep-me.log'), 'not a secret, just noisy\n');
  writeFileSync(join(root, 'credentials', 'signing.p8'), 'PRIVATE KEY\n');
  // -f: keep-me.log matches the tracked .gitignore's *.log pattern, but we force-add it
  // anyway — a real project can track a file its own .gitignore would otherwise exclude.
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'init');
  return root;
}

test('a tracked .gitignore does not make deniedFiles remove files deny_paths never mentioned', () => {
  const root = repoWithTrackedGitignore();
  // deny_paths says nothing about *.log or keep-me.log — only the repo's own tracked
  // .gitignore matches it. `check-ignore --no-index --stdin` can't tell that apart from
  // an actual deny_paths hit; -v's per-match source is what makes the distinction.
  const ws = createWorkspace(root, 'qa', ['credentials/**'], 'workspace');
  assert.equal(existsSync(join(ws.dir, 'keep-me.log')), true,
    'a file only matched by a tracked .gitignore must survive — deny_paths never named it');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'signing.p8')), false,
    'the actually denied secret must still be removed');
});

// --- C2: a deny_paths entry matching nothing is reported, not fatal ---

test('deny_paths entries that match no tracked file are returned, not thrown', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', ['credentials/**', 'nope/never/matches/**'], 'workspace');
  assert.deepEqual(ws.unmatchedDenyPaths, ['nope/never/matches/**']);
});

test('a deny_paths list that matches everything reports no unmatched entries', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.deepEqual(ws.unmatchedDenyPaths, []);
});

// --- C3: clone args, white-box — dropping file:// or --depth 1 is invisible black-box ---

test('cloneArgs clones over file:// with a shallow depth', () => {
  const args = cloneArgs('/some/repo', '/some/dir');
  // file:// forces the transport codepath: without it, a same-machine clone silently
  // hardlinks objects (or points objects/info/alternates back at the source repo) and
  // ignores --depth entirely — the clone would carry the source's full object database.
  assert.ok(args.includes('file:///some/repo'), args.join(' '));
  // --depth 1 keeps the clone shallow. Dropping it still produces a working clone, just
  // one that carries full history — including any commit deny_paths ever meant to hide.
  const depthIdx = args.indexOf('--depth');
  assert.notEqual(depthIdx, -1, args.join(' '));
  assert.equal(args[depthIdx + 1], '1');
});

// --- C4: git remote remove leaves a dangling refs/remotes/origin/HEAD symref ---

test('a fresh workspace passes git fsck --full cleanly', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const fsck = spawnSync('git', ['-C', ws.dir, 'fsck', '--full'], { encoding: 'utf8' });
  assert.equal(fsck.stdout.trim(), '', fsck.stdout);
  assert.equal(fsck.stderr.trim(), '', fsck.stderr);
  assert.equal(fsck.status, 0);
});

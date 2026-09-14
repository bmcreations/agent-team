import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createWorkspace, pruneWorkspace, cloneArgs, deniedFiles } from '../src/workspace.js';

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

// --- C1b: a tracked ignore file naming the same path must not shadow a real deny hit ---
//
// check-ignore -v reports the source of whichever rule *wins arbitration*. When the
// repo's own tracked .gitignore mentions the same path as a deny_paths entry, .gitignore
// wins and the reported source becomes `.gitignore`, not `.git/info/exclude` — the
// opposite failure from C1: a real deny_paths hit gets silently dropped, the file ships
// to the workspace, and the entry is reported as unmatched even though it was named.

function repoWithShadowingGitignoreSamePattern() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'credentials/staging.env\n');
  writeFileSync(join(root, 'credentials', 'staging.env'), 'PLANTED_SECRET_SAME_PATTERN\n');
  // -f: force-add the file even though the repo's own .gitignore also matches it —
  // an operator can legitimately deny a path their .gitignore separately mentions.
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'init');
  return root;
}

function repoWithShadowingGitignoreNegation() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '!credentials/secret.env\n');
  writeFileSync(join(root, 'credentials', 'secret.env'), 'PLANTED_SECRET_NEGATION\n');
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'init');
  return root;
}

test('a tracked .gitignore naming the same path as a deny_paths entry does not shadow the deny', () => {
  const root = repoWithShadowingGitignoreSamePattern();
  const ws = createWorkspace(root, 'qa', ['credentials/staging.env'], 'workspace');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'staging.env')), false,
    'the denied file must not survive just because the tracked .gitignore names it too');
  assert.deepEqual(ws.unmatchedDenyPaths, [],
    'the deny entry actually matched a file — it must not be reported as unmatched');
});

test('a negated pattern in a tracked .gitignore does not shadow the deny', () => {
  const root = repoWithShadowingGitignoreNegation();
  const ws = createWorkspace(root, 'qa', ['credentials/secret.env'], 'workspace');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'secret.env')), false,
    'the denied file must not survive just because a tracked .gitignore negates it');
  assert.deepEqual(ws.unmatchedDenyPaths, []);
});

test('the shadowed deny hit is gone from the object database, not merely absent from the tree', () => {
  const root = repoWithShadowingGitignoreSamePattern();
  const blob = execFileSync(
    'git', ['-C', root, 'rev-parse', 'HEAD:credentials/staging.env'], { encoding: 'utf8' }
  ).trim();
  const ws = createWorkspace(root, 'qa', ['credentials/staging.env'], 'workspace');
  const read = tryGit(ws.dir, 'cat-file', '-p', blob);
  assert.notEqual(read.status, 0, `blob ${blob} is still readable in the workspace`);
});

test('a file matched only by the environment global excludesFile is not deleted', () => {
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const globalDir = mkdtempSync(join(tmpdir(), 'at-ws-global-'));
  const excludesFile = join(globalDir, 'excludes');
  writeFileSync(excludesFile, 'globally-ignored.txt\n');
  const globalConfig = join(globalDir, 'gitconfig');
  writeFileSync(globalConfig, `[core]\n\texcludesFile = ${excludesFile}\n`);
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    const root = mkdtempSync(join(tmpdir(), 'at-ws-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
    git('config', 'user.email', 't@e.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, 'credentials'), { recursive: true });
    writeFileSync(join(root, 'credentials', 'signing.p8'), 'PRIVATE KEY\n');
    // Force-add: this file is only reachable via the global excludesFile above, not via
    // deny_paths and not via anything tracked in this repo.
    writeFileSync(join(root, 'globally-ignored.txt'), 'not a secret, just noisy\n');
    git('add', '-A', '-f');
    git('commit', '-q', '-m', 'init');

    const ws = createWorkspace(root, 'qa', ['credentials/**'], 'workspace');
    assert.equal(existsSync(join(ws.dir, 'globally-ignored.txt')), true,
      'a file matched only by a global excludesFile must survive — deny_paths never named it');
    assert.equal(existsSync(join(ws.dir, 'credentials', 'signing.p8')), false,
      'the actually denied secret must still be removed');
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
  }
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

// --- C5: a cleanup failure must not mask the original error ---
//
// force: true on the cleanup rmSync only swallows ENOENT — a real removal failure (a
// read-only parent, an immutable file) throws too, and that throw used to replace
// whatever error caused the build to fail in the first place. macOS/BSD's append-only
// (uappnd) flag on a directory blocks *deleting* entries within it while still allowing
// *new* ones — set on the workspace's repo-key parent directory before createWorkspace
// runs, the clone can still create the workspace dir, but the cleanup rmSync in the
// catch block cannot remove it afterwards. No timing race: the flag is in place for the
// whole call, so there is nothing to land badly. Only runs on Darwin, where chflags and
// this flag's semantics are available; skipped elsewhere rather than approximated.
test(
  'a cleanup failure does not mask the original error, and is reported instead',
  { skip: platform() !== 'darwin' && 'chflags uappnd semantics are Darwin/BSD-specific' },
  () => {
    const root = repoWithSecrets();
    const repoKey = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
    const repoKeyDir = join(WORKSPACE_ROOT, 'agent-team', 'workspaces', repoKey);
    mkdirSync(repoKeyDir, { recursive: true });
    execFileSync('chflags', ['uappnd', repoKeyDir]);

    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      assert.throws(
        () => createWorkspace(root, 'lockedparent', ['**'], 'workspace'),
        (err) => {
          // The original error must survive — not an rmSync/EPERM error from the
          // masked cleanup failure.
          assert.match(err.message, /deny_paths excluded every tracked file/);
          return true;
        }
      );
      assert.ok(
        warnings.some((w) => w.includes('lockedparent') || w.includes(repoKeyDir)),
        `expected a console.warn naming the undeletable directory, got: ${JSON.stringify(warnings)}`
      );
    } finally {
      console.warn = originalWarn;
      // Undo the flag so this directory (and its undeleted workspace) can be reclaimed —
      // by this cleanup and, failing that, by the OS reaping WORKSPACE_ROOT's parent tmpdir.
      execFileSync('chflags', ['nouappnd', repoKeyDir]);
    }
  }
);

// --- R11-1: arbitration must key off the clone's core.ignorecase, not tmpdir's ---
//
// On this machine both the workspace root and os.tmpdir() land on the same
// case-insensitive APFS volume, so they can never be forced to disagree without a second,
// deliberately-differently-cased volume (hdiutil). Driving deniedFiles directly on a
// fabricated clone dir sidesteps that: forcing the CLONE's core.ignorecase to each value in
// turn and asserting the outcome tracks it, regardless of what tmpdir's scratch dir would
// auto-detect on its own, is what actually exercises the fix (the scratch dir's own
// auto-detected setting is left alone — the fix is that it gets overridden by -c).

function repoWithCasedTrackedFile() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-case-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, 'credentials', 'secret.txt'), 'PRIVATE KEY\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

test('deniedFiles arbitrates using the clone\'s core.ignorecase, not tmpdir\'s auto-detected value', () => {
  const dir = repoWithCasedTrackedFile();
  const setClone = (v) => execFileSync('git', ['-C', dir, 'config', 'core.ignorecase', v], { stdio: 'pipe' });

  // deny pattern 'Credentials/' only matches the tracked 'credentials/secret.txt' when
  // arbitration is case-insensitive.
  setClone('true');
  const insensitive = deniedFiles(dir, ['Credentials/']);
  assert.deepEqual(insensitive.denied, ['credentials/secret.txt']);
  assert.ok(insensitive.matchedDenyPaths.has('Credentials/'));

  setClone('false');
  const sensitive = deniedFiles(dir, ['Credentials/']);
  assert.deepEqual(sensitive.denied, []);
  assert.ok(!sensitive.matchedDenyPaths.has('Credentials/'));
});

// --- R11-2: a tracked symlink makes name and content different things, which a
// name-based deny_paths boundary cannot bound ---

function readAllObjectIds(dir) {
  // --batch-all-objects --batch dumps every object git can find in this repo, reachable or
  // not, by id — the standard R9 was held to (see the C1b tests above): a plain
  // working-tree check ("the file is gone") does not prove the blob it pointed at is gone
  // too. `git rm` alone (no orphan commit + gc) would leave the blob reachable from a
  // parent commit; this is what actually proves it is not.
  const out = execFileSync('git', ['-C', dir, 'cat-file', '--batch-all-objects', '--batch'],
    { encoding: 'buffer' });
  return out.toString('latin1'); // latin1: a lossless byte-for-byte view, not a decode
}

function repoWithEscapingSymlink() {
  const outsideDir = mkdtempSync(join(tmpdir(), 'at-ws-outside-'));
  const outsideFile = join(outsideDir, 'outside-secret.txt');
  writeFileSync(outsideFile, 'LEAKED_VIA_ESCAPE_LINK\n');

  const root = mkdtempSync(join(tmpdir(), 'at-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'app.js'), 'ok\n');
  // Not itself named in deny_paths — that is exactly the hole: no name-based rule could
  // ever catch a symlink whose target is what deny_paths would need to name.
  symlinkSync(outsideFile, join(root, 'escape-link'));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, outsideDir, outsideFile };
}

test('a tracked symlink that escapes the repo is dropped, unreadable, and gone from the object store', () => {
  const { root, outsideFile } = repoWithEscapingSymlink();
  const linkBlob = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD:escape-link'], { encoding: 'utf8' }).trim();

  const ws = createWorkspace(root, 'qa', DENY, 'workspace');

  assert.deepEqual(ws.droppedSymlinks, ['escape-link']);
  assert.throws(() => lstatSync(join(ws.dir, 'escape-link')), /ENOENT/,
    'the link itself must be gone from the working tree, not merely broken');
  assert.equal(existsSync(join(ws.dir, 'escape-link')), false);
  assert.doesNotMatch(readAllObjectIds(ws.dir), new RegExp(linkBlob),
    `the symlink's own blob (${linkBlob}) must not be reachable in the workspace's object store`);
  // rmSync on the link must never touch what it points at.
  assert.equal(existsSync(outsideFile), true, 'the real file outside the repo must be untouched');
});

function repoWithSymlinkedCredentialsDir() {
  const realDir = mkdtempSync(join(tmpdir(), 'at-ws-real-'));
  writeFileSync(join(realDir, 'key.pem'), 'TOP_SECRET_XYZ\n');

  const root = mkdtempSync(join(tmpdir(), 'at-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'app.js'), 'ok\n');
  // 'credentials' IS a deny_paths name below, but as a trailing-slash directory-only
  // pattern it does not match a symlink entry — the entry survives, unmatched.
  symlinkSync(realDir, join(root, 'credentials'));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, realDir };
}

test('a tracked symlink named for a deny_paths entry is dropped even though the directory-only pattern does not match it', () => {
  const { root, realDir } = repoWithSymlinkedCredentialsDir();
  const linkBlob = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD:credentials'], { encoding: 'utf8' }).trim();

  const ws = createWorkspace(root, 'qa', ['credentials/'], 'workspace');

  assert.deepEqual(ws.droppedSymlinks, ['credentials']);
  assert.deepEqual(ws.unmatchedDenyPaths, ['credentials/'],
    'the directory-only pattern still does not match a symlink entry — this fix does not change that arbitration');
  assert.throws(() => lstatSync(join(ws.dir, 'credentials')), /ENOENT/);
  assert.equal(existsSync(join(ws.dir, 'credentials', 'key.pem')), false);
  assert.doesNotMatch(readAllObjectIds(ws.dir), new RegExp(linkBlob),
    `the symlink's own blob (${linkBlob}) must not be reachable in the workspace's object store`);
  // rmSync on a symlink-to-a-directory must remove only the link, never recurse into and
  // delete what it points at.
  assert.equal(existsSync(realDir), true, 'the target directory must survive');
  assert.equal(existsSync(join(realDir, 'key.pem')), true, 'the target directory\'s content must survive');
});

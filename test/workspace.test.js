import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync, lstatSync, chmodSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  createWorkspace, pruneWorkspace, cloneArgs, deniedFiles, parseCheckIgnoreOutput, gitFailure,
  normalisationAliases, resolveDeniedPaths, parseLsFilesStage
} from '../src/workspace.js';

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

// --- A2-0: a git clone that dies partway through must not strand a partial, unredacted
// clone on disk. The cleanup `try` below is written to cover exactly this ("everything past
// this point can throw"), but the clone call itself used to sit above that block, so a clone
// interrupted by a disk-full, a signal, or a network drop on a large repo left its partial,
// unfiltered working tree behind with no removal and no warning. There is no real way to
// interrupt a clone mid-flight from a test without touching the disk or the network, so this
// shadows `git` on PATH with a stub that only intercepts `clone`: it does what a real
// interrupted clone does — creates the destination directory and drops unfiltered content
// into it — then fails, the way disk-full/SIGTERM/a network hiccup would. Every other git
// subcommand createWorkspace needs passes straight through to the real binary.

function createFailingCloneGitStub(realGitPath) {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-git-clonestub-'));
  const stubPath = join(stubDir, 'git');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const REAL_GIT = ${JSON.stringify(realGitPath)};`,
    'const args = process.argv.slice(2);',
    "if (args[0] === 'clone') {",
    '  // Stand in for what a real interrupted clone leaves: the destination directory,',
    '  // created, holding unfiltered content — before failing the way disk-full, a signal,',
    '  // or a network drop would.',
    '  const dest = args[args.length - 1];',
    '  fs.mkdirSync(dest, { recursive: true });',
    "  fs.writeFileSync(path.join(dest, 'UNREDACTED_PARTIAL_CLONE'), 'should never survive on disk\\n');",
    "  process.stderr.write('fatal: simulated clone failure\\n');",
    '  process.exit(128);',
    '}',
    '// Every other invocation (config, ls-files, commit, ...) passes straight through to',
    "// the real git, inheriting this process's own stdio.",
    'const res = spawnSync(REAL_GIT, args, { stdio: "inherit" });',
    'process.exit(res.status === null ? 1 : res.status);',
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return stubDir;
}

test('a git clone that dies partway through leaves no partial, unredacted clone behind', () => {
  const root = repoWithSecrets();
  const realGitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const stubDir = createFailingCloneGitStub(realGitPath);
  const originalPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${originalPath}`;
  try {
    assert.throws(() => createWorkspace(root, 'clonefailsmember', DENY, 'workspace'));
    // The repo-key parent directory created by mkdirSync(dirname(dir)) before the clone is
    // harmless litter (empty, no repo content) — what matters is that the partial clone
    // itself, and the unfiltered content the stub dropped into it, do not survive.
    const leftover = listWorkspaceDirs(WORKSPACE_ROOT).filter((d) => d.includes('clonefailsmember'));
    assert.deepEqual(leftover, []);
  } finally {
    process.env.PATH = originalPath;
  }
});

// --- A2-2: "!" does not negate a deny_paths entry, and the entry is booked as matched ---
//
// check-ignore -v -z reports a match record for a pattern that negates a match too, and
// parseCheckIgnoreOutput books every record as a deny hit regardless of the pattern's
// leading "!" — so a "!"-prefixed deny_paths entry does not exempt anything, it deletes.
// src/config.js rejects this shape at load (see test/config.test.js); this proves the git
// behavior that rejection depends on, directly, at the layer that actually asks git to
// arbitrate. createWorkspace takes deny_paths as a raw array, unvalidated — reachable here
// exactly as dispatch.js reaches it once config.js has already validated upstream.

test('a "!"-prefixed deny_paths entry deletes the file rather than exempting it, and is booked as matched', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', ['credentials/**', '!credentials/signing.p8'], 'workspace');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'signing.p8')), false,
    'the "!" entry must not exempt the file — it is booked as an ordinary deny hit');
  // The overlapping, broader `credentials/**` entry can legitimately land in
  // unmatchedDenyPaths here too — check-ignore -v reports only the winning pattern per
  // path, and the more specific `!credentials/signing.p8` wins arbitration for the one
  // file under `credentials/` (see finding 4). What matters for THIS finding is narrower:
  // the "!" entry itself must not be reported as unmatched — that would be the actual
  // danger, since it is the one signal that could tell an operator the negation silently
  // failed to negate.
  assert.ok(!ws.unmatchedDenyPaths.includes('!credentials/signing.p8'),
    `the "!" entry matched a file — it must not be reported as unmatched, got: ${JSON.stringify(ws.unmatchedDenyPaths)}`);
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

// --- A2-1: an escaped leading "\#" actually denies a file named with a literal "#" ---
//
// src/config.js rejects an unescaped leading "#" at load (it is an inert gitignore
// comment once written into the exclude file below), and tells the operator to write it
// as "\#" instead. deniedFiles/createWorkspace never re-validate deny_paths — config
// validation is the only gate — so this proves directly, at the layer that actually writes
// the exclude file and asks git to arbitrate it, that the suggested escape really works and
// is not just a plausible-looking string in an error message.

test('an escaped leading \\# in a deny_paths entry denies a file whose name starts with #', () => {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-hash-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, 'credentials', '#k.pem'), 'PRIVATE KEY\n');
  writeFileSync(join(root, 'app.js'), 'ok\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  const ws = createWorkspace(root, 'qa', ['\\#k.pem'], 'workspace');

  assert.equal(existsSync(join(ws.dir, 'credentials', '#k.pem')), false,
    'the escaped pattern must actually deny the literal "#"-named file');
  assert.equal(existsSync(join(ws.dir, 'app.js')), true, 'an undenied file must survive');
  assert.deepEqual(ws.unmatchedDenyPaths, [],
    'the escaped entry actually matched a file — it must not be reported as unmatched');
});

// --- A2-3: the denied directory skeleton must not survive on disk ---
//
// rmSync(..., { force: true }) on a denied file removes only the file — the directories
// that held it are left behind, empty. They are not in the commit (git never tracked an
// empty directory), but they are on disk where the vendor CLI runs, disclosing the shape
// of the secret tree (`credentials/prod/`, `credentials/staging/`) even once its contents
// are gone. Names, not content — real, but small, which is why this is one of the six
// findings that leak no file content.

function repoWithNestedDeniedTree() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-nested-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'app.js'), 'ok\n');
  mkdirSync(join(root, 'credentials', 'prod'), { recursive: true });
  mkdirSync(join(root, 'credentials', 'staging'), { recursive: true });
  writeFileSync(join(root, 'credentials', 'prod', 'secret.pem'), 'PROD KEY\n');
  writeFileSync(join(root, 'credentials', 'staging', 'secret.pem'), 'STAGING KEY\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

test('deleting every file under a denied directory tree also removes the now-empty directories', () => {
  const root = repoWithNestedDeniedTree();
  const ws = createWorkspace(root, 'qa', ['credentials/**'], 'workspace');
  assert.equal(existsSync(join(ws.dir, 'app.js')), true, 'an undenied file must survive');
  // Not just "credentials/prod/secret.pem is gone" — the directory names themselves,
  // which deny_paths never explicitly enumerated (prod, staging), must not be left on
  // disk for the vendor CLI to enumerate.
  assert.equal(existsSync(join(ws.dir, 'credentials', 'prod')), false,
    'the now-empty "prod" directory must be removed, not just its file');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'staging')), false,
    'the now-empty "staging" directory must be removed, not just its file');
  assert.equal(existsSync(join(ws.dir, 'credentials')), false,
    'the now-empty "credentials" directory must be removed too, bottom-up');
});

function repoWithMixedDeniedAndKeptSiblings() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-mixed-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'app.js'), 'ok\n');
  mkdirSync(join(root, 'credentials', 'prod'), { recursive: true });
  writeFileSync(join(root, 'credentials', 'prod', 'secret.pem'), 'PROD KEY\n');
  writeFileSync(join(root, 'credentials', 'keep.txt'), 'not a secret\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

test('a directory that still holds an undenied sibling file is left in place, only the emptied one goes', () => {
  const root = repoWithMixedDeniedAndKeptSiblings();
  const ws = createWorkspace(root, 'qa', ['credentials/prod/**'], 'workspace');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'prod')), false,
    'the now-empty "prod" directory must be removed');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'keep.txt')), true,
    'an undenied sibling file must survive');
  assert.equal(existsSync(join(ws.dir, 'credentials')), true,
    '"credentials" is not empty (keep.txt is still there) — it must not be removed');
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
  // `denied` entries are raw Buffers as of R11-3 — decode for comparison here, since
  // these fixture paths are plain ASCII and round-trip losslessly.
  assert.deepEqual(insensitive.denied.map((b) => b.toString('utf8')), ['credentials/secret.txt']);
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

// --- R11-3: check-ignore -v -z output must be parsed as bytes, not decoded as UTF-8 ---
//
// `git check-ignore -v -z` emits <source>\0<linenum>\0<pattern>\0<pathname>\0 records. A NUL
// byte cannot occur inside a filename, so slicing on NUL is exact regardless of what other
// bytes a pathname holds — but the previous implementation ran the whole buffer through
// `.toString()` (an implicit, lossy UTF-8 decode) before splitting, which corrupts any
// pathname containing invalid UTF-8. A corrupted pathname makes the later rmSync target a
// path that does not exist; with `force: true` the resulting ENOENT is swallowed and the
// real, still-denied file ships. These tests cover both halves: pathnames that are valid
// UTF-8 but awkward for naive string handling (round-trip on this filesystem), and a
// pathname that is not valid UTF-8 at all (cannot be built on APFS, so exercised white-box
// against the exported parser directly).

function repoWithTrickyFilenames() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-tricky-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'credentials'), { recursive: true });
  const names = [
    'line\nbreak.txt',      // embedded newline
    'quo"te.txt',           // embedded double quote
    'back\\slash.txt',      // embedded backslash
    '--leading-dashdash.txt' // leading "--", which looks like an option/separator
  ];
  for (const name of names) {
    writeFileSync(join(root, 'credentials', name), 'PRIVATE KEY\n');
  }
  writeFileSync(join(root, 'README.md'), 'keep me\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, names };
}

test('deniedFiles correctly removes tracked files whose names hold characters that are awkward for naive string parsing', () => {
  const { root, names } = repoWithTrickyFilenames();

  const ws = createWorkspace(root, 'qa', ['credentials/**'], 'workspace');

  for (const name of names) {
    assert.equal(existsSync(join(ws.dir, 'credentials', name)), false,
      `"${name}" must be removed from the workspace's working tree`);
  }
  assert.deepEqual(ws.unmatchedDenyPaths, []);
  const tracked = execFileSync('git', ['-C', ws.dir, 'ls-files'], { encoding: 'utf8' });
  for (const name of names) {
    assert.doesNotMatch(tracked, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `"${name}" must not be tracked in the workspace's commit either`);
  }
  assert.equal(existsSync(join(ws.dir, 'README.md')), true, 'an undenied file must survive');
});

test('parseCheckIgnoreOutput keeps a pathname that is not valid UTF-8 byte-exact, rather than corrupting it via decode', () => {
  // A tracked filename with invalid-UTF-8 bytes is ordinary on Linux (filenames there are
  // opaque bytes) but cannot be created on this machine — APFS rejects it outright. This
  // fabricates the raw check-ignore -v -z record directly to exercise the parser the same
  // way a real invalid-UTF-8 pathname would, without needing such a filesystem.
  const source = Buffer.from('.git/info/exclude', 'utf8');
  const linenum = Buffer.from('1', 'utf8');
  const pattern = Buffer.from('credentials/**', 'utf8');
  // 0xFF can never appear in valid UTF-8. Embed it between two ASCII segments so a
  // corrupting decode (which maps it to the 3-byte replacement character U+FFFD) would
  // change both the byte content and the byte length of the field.
  const pathname = Buffer.concat([
    Buffer.from('credentials/', 'utf8'), Buffer.from([0xff]), Buffer.from('secret.bin', 'utf8')
  ]);
  const nul = Buffer.from([0]);
  const raw = Buffer.concat([
    source, nul, linenum, nul, pattern, nul, pathname, nul
  ]);

  const { denied, matchedDenyPaths } = parseCheckIgnoreOutput(raw);

  assert.equal(denied.length, 1);
  assert.ok(Buffer.isBuffer(denied[0]), 'pathname must be returned as a raw Buffer, not a decoded string');
  assert.equal(Buffer.compare(denied[0], pathname), 0,
    'the invalid-UTF-8 pathname must survive byte-for-byte — a lossy decode would replace 0xff with U+FFFD (0xef 0xbf 0xbd), changing both content and length');
  assert.ok(matchedDenyPaths.has('credentials/**'));
});

// --- R11-4: cover the "unexpected check-ignore source" guard end to end ---
//
// The scratch dir deniedFiles builds contains nothing but the exclude file it just wrote,
// so a real check-ignore run there can never legitimately report any source other than
// EXCLUDE_SOURCE. Reaching the guard's `throw` for real would require check-ignore itself
// to misbehave, which isn't something a fixture can provoke — so this shadows `git` on
// PATH with a stub that intercepts only the `check-ignore` invocation and forges a quad
// with a bogus source, while every other git subcommand createWorkspace needs (clone,
// config, ls-files, commit, ...) passes straight through to the real binary.

function createUnexpectedSourceGitStub(realGitPath) {
  const stubDir = mkdtempSync(join(tmpdir(), 'agent-team-git-stub-'));
  const stubPath = join(stubDir, 'git');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('node:child_process');",
    `const REAL_GIT = ${JSON.stringify(realGitPath)};`,
    'const args = process.argv.slice(2);',
    "if (args.includes('check-ignore')) {",
    '  // Forge a single -v -z match record whose source is not the scratch dir\'s own',
    '  // exclude file — exactly what deniedFiles\'s isolation guard exists to catch.',
    "  const fields = ['credentials/.gitignore', '1', 'credentials/**', 'credentials/secret.txt'];",
    "  process.stdout.write(Buffer.from(fields.join('\\0') + '\\0', 'utf8'));",
    '  process.exit(0);',
    '}',
    '// Every other invocation (clone, config, ls-files, commit, ...) passes straight',
    '// through to the real git, inheriting this process\'s own stdio so the caller sees',
    '// exactly what a direct call to the real binary would have produced.',
    'const res = spawnSync(REAL_GIT, args, { stdio: "inherit" });',
    'process.exit(res.status === null ? 1 : res.status);',
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return stubDir;
}

function repoWithOneTrackedFile() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-stubsrc-'));
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

test('an unexpected check-ignore source in the scratch dir throws instead of silently dropping the hit', () => {
  const root = repoWithOneTrackedFile();
  const realGitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const stubDir = createUnexpectedSourceGitStub(realGitPath);
  const originalPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${originalPath}`;
  try {
    assert.throws(
      () => createWorkspace(root, 'qa', ['credentials/**'], 'workspace'),
      /unexpected check-ignore source "credentials\/\.gitignore".*expected only "\.git\/info\/exclude"/
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

// --- A1-1: a truncated check-ignore stream must never be parsed as if it were complete ---
//
// spawnSync captures a child's stdout through a pipe bounded by Node's `maxBuffer` (1 MiB
// by default) and — unlike execFileSync — does NOT throw when that bound is crossed. It
// SIGTERMs the child, sets `error.code = 'ENOBUFS'`, and returns a *truncated* stdout.
// deniedFiles used to parse that buffer without ever inspecting `matched.error` or
// `matched.status`, so on a repo with more than ~1 MiB of check-ignore output every denied
// file past the cut was never seen: it shipped into the workspace and into the orphan
// commit. And because the records *before* the cut still booked the deny entry as matched,
// `unmatchedDenyPaths` stayed empty — the failure was open, with both operator signals clean.
//
// The suite had no size-shaped fixture at all, so nothing here could ever have crossed that
// boundary. This one does. The deny directory's name is long on purpose: -v -z emits
// "<source>\0<linenum>\0<pattern>\0<pathname>\0" per file, so long paths reach 1 MiB in a
// few thousand files rather than tens of thousands, which keeps this to a couple of seconds
// instead of a minute. It is still the slowest test in this file; that is what a
// size-shaped test costs, and the cost is worth paying exactly once.

function repoWithOversizedDenyOutput() {
  // Paths are long on purpose, and nested on purpose. Every stream the boundary captures is
  // sized per tracked path, so one fixture with 413-byte paths pushes all three of them past
  // the 1 MiB pipe bound at only 3000 files: check-ignore -v -z ~1.9 MiB, ls-files -z
  // ~1.2 MiB, ls-files --stage -z ~1.3 MiB (--stage adds ~51 bytes of mode/sha/stage per
  // entry, which is why it overflows first on a repo of ordinary path lengths). Reaching the
  // same bound with 45-character paths would take ~14,000 files and a much slower fixture.
  const denyDir = `denied-${'x'.repeat(193)}`;       // 200 chars
  const subDir = `sub-${'y'.repeat(196)}`;           // 200 chars
  const fileCount = 3000;
  const root = mkdtempSync(join(tmpdir(), 'at-ws-big-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'app.js'), 'ok\n');
  mkdirSync(join(root, denyDir, subDir), { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(root, denyDir, subDir, `f${String(i).padStart(5, '0')}.txt`), `SECRET-${i}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, denyDir, fileCount };
}

test('no denied file survives a repo whose check-ignore output exceeds the 1 MiB pipe bound', () => {
  const { root, denyDir, fileCount } = repoWithOversizedDenyOutput();

  const ws = createWorkspace(root, 'qa', [`${denyDir}/**`], 'workspace');

  const tracked = execFileSync('git', ['-C', ws.dir, 'ls-files', '-z'], { maxBuffer: 1 << 28 })
    .toString().split('\0').filter(Boolean);
  const leaked = tracked.filter((p) => p.startsWith(denyDir));
  assert.deepEqual(leaked, [],
    `${leaked.length} of ${fileCount} denied files were still tracked in the workspace commit`);
  // Denied-file removal also removes any directory the deletion leaves empty (see
  // removeEmptyAncestors in workspace.js), so the (now empty) denied directory itself should
  // be gone from disk too, not just its content — the `if (existsSync(...))` guard below
  // means this walk simply finds nothing to do when that holds. What this assertion actually
  // pins is narrower and holds either way: no file under the denied directory may be left for
  // the CLI to read.
  const leftOnDisk = [];
  const walkFiles = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walkFiles(join(d, entry.name));
      else leftOnDisk.push(entry.name);
    }
  };
  if (existsSync(join(ws.dir, denyDir))) walkFiles(join(ws.dir, denyDir));
  assert.deepEqual(leftOnDisk, [], 'no denied file may be left in the workspace working tree');
  assert.equal(existsSync(join(ws.dir, 'app.js')), true, 'an undenied file must survive');

  // Absent from the tree is not enough — the blobs must be gone from the object database
  // too, or `git cat-file` in the workspace still hands the CLI the content.
  const lastBlob = execFileSync('git', ['-C', root, 'hash-object', '--stdin'],
    { input: `SECRET-${fileCount - 1}\n`, encoding: 'utf8' }).trim();
  assert.notEqual(tryGit(ws.dir, 'cat-file', '-e', lastBlob).status, 0,
    'the last denied file\'s blob must not be reachable in the workspace object store');
});

test('parseCheckIgnoreOutput rejects a truncated stream instead of parsing the records before the cut', () => {
  // The guarantee must not depend on generating megabytes: this is the same truncation the
  // size-shaped test above provokes for real, cut directly. `-v -z` always emits complete
  // NUL-terminated quads, so a stream that does not end on a NUL, or that does not hold a
  // whole number of four-field records, was cut short — and an unknown number of denied
  // pathnames is missing from it.
  const nul = Buffer.from([0]);
  const record = (path) => Buffer.concat([
    Buffer.from('.git/info/exclude'), nul, Buffer.from('1'), nul,
    Buffer.from('credentials/**'), nul, Buffer.from(path), nul
  ]);
  const whole = Buffer.concat([record('credentials/a.pem'), record('credentials/b.pem')]);

  // Sanity: the untruncated stream still parses, so the guard is not rejecting everything.
  assert.equal(parseCheckIgnoreOutput(whole).denied.length, 2);

  // Cut mid-pathname: the first record is complete and would previously have been returned
  // on its own, silently losing the second denied file.
  const midField = whole.subarray(0, whole.length - 6);
  assert.throws(() => parseCheckIgnoreOutput(midField), /truncat/i);

  // Cut exactly on a field boundary: three of the second record's four fields survive, so
  // the old `i + 3 < parts.length` bound discarded the remainder without a word.
  const midRecord = whole.subarray(0, whole.length - 'credentials/b.pem'.length - 1);
  assert.throws(() => parseCheckIgnoreOutput(midRecord), /truncat/i);

  // Empty output (check-ignore matched nothing, exit 1) is complete, not truncated.
  assert.deepEqual(parseCheckIgnoreOutput(Buffer.alloc(0)).denied, []);
});

// --- A1-2: the failure that remains must say what happened, in words ---
//
// The same 1 MiB pipe bound used to hard-fail any repo over ~12,900 tracked files at
// 30-character paths: ls-files --stage -z adds ~51 bytes of mode/sha/stage per entry, so it
// crossed the bound long before ls-files -z did. That direction failed closed and cleaned up
// correctly — it was never a leak — but it surfaced as `ENOBUFS | spawnSync git ENOBUFS`
// with a megabyte-long buffer dump attached and nothing naming the actual cause, on a repo
// the plugin simply could not build a workspace for at all.
//
// The capture sites no longer have a ceiling (see the size-shaped test above, whose fixture
// now crosses the bound on all three streams). This covers the residual case — stderr is
// still piped and still bounded — and pins the wording, white-box, so no 14,000-file fixture
// is needed to assert it.

test('an overflowing git capture reports the real cause, not a raw ENOBUFS dump', () => {
  const err = gitFailure('git ls-files --stage (submodule scan)', {
    error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }),
    status: null,
    signal: 'SIGTERM',
    stdout: null,
    stderr: null
  });

  assert.ok(err instanceof Error);
  assert.match(err.message, /repository is larger than/i,
    'the message must name the cause — a repo bigger than the boundary can process');
  assert.match(err.message, /git ls-files --stage \(submodule scan\)/,
    'and say which step hit it');
  assert.match(err.message, /no workspace was built/i,
    'and say what the operator is left with');
});

test('a git capture that fails for an ordinary reason still reports git\'s own stderr', () => {
  const err = gitFailure('git check-ignore (deny_paths arbitration)', {
    error: undefined,
    status: 128,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from('fatal: not a git repository\n')
  });

  assert.match(err.message, /status 128/);
  assert.match(err.message, /fatal: not a git repository/,
    'an ordinary git failure must not be flattened into the size message');
  assert.doesNotMatch(err.message, /repository is larger than/i);
});

// --- A1-3: a path differing only by Unicode normalisation must not ship, and must not be
// the thing that makes the deny entry look satisfied ---
//
// check-ignore matches pathname *bytes*. "crédentials" written NFC (é as U+00E9) and the
// same visible name written NFD (e + U+0301) are different byte strings, so a deny entry
// spelled one way does not match a tracked path spelled the other. On its own that at least
// raises the entry in unmatchedDenyPaths. The dangerous shape is a repo holding *both*
// spellings — ordinary when contributors are on mixed platforms, since macOS hands NFD to
// the filesystem and Linux and Windows do not, or when files come out of an archive. Then
// the NFC sibling satisfies the entry, the entry is booked as matched, unmatchedDenyPaths
// comes back empty, and the NFD file ships with no signal at all.
//
// APFS folds the two spellings to one name on disk, so the second spelling is put into the
// index through plumbing rather than through the filesystem. That is not a workaround for
// the test's sake: it is exactly the state a clone from a Linux contributor arrives in, and
// `git ls-files` — the list deniedFiles arbitrates over — reports the index, byte for byte.

const NFC_DIR = 'crédentials';       // é precomposed
const NFD_DIR = 'crédentials';      // e + combining acute

function repoWithBothUnicodeSpellings() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-nfd-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  // Without this, git precomposes paths it reads back off this filesystem and the two
  // spellings collapse before they ever reach the index.
  git('config', 'core.precomposeunicode', 'false');
  writeFileSync(join(root, 'app.js'), 'ok\n');
  git('add', '-A');
  const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'],
    { input: 'PRIVATE KEY\n', encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', root, 'update-index', '--index-info'], {
    input: `100644 ${blob} 0\t${NFC_DIR}/a.pem\n100644 ${blob} 0\t${NFD_DIR}/b.pem\n`,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  git('commit', '-q', '-m', 'init');
  return { root, blob };
}

test('a tracked path that differs from a deny_paths entry only by Unicode normalisation does not ship', () => {
  const { root, blob } = repoWithBothUnicodeSpellings();

  // Precondition: the fixture really does hold both spellings, or this test proves nothing.
  const sourceTracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean);
  assert.equal(sourceTracked.length, 3, 'source repo must track app.js plus both spellings');
  assert.ok(sourceTracked.includes(`${NFC_DIR}/a.pem`) && sourceTracked.includes(`${NFD_DIR}/b.pem`));

  // Only the NFC spelling is named in deny_paths — the NFD sibling is never mentioned.
  const ws = createWorkspace(root, 'qa', [`${NFC_DIR}/**`], 'workspace');

  const tracked = execFileSync('git', ['-C', ws.dir, 'ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean);
  assert.deepEqual(tracked, ['app.js'],
    'neither spelling may survive into the workspace commit — the NFD one is the leak');
  assert.notEqual(tryGit(ws.dir, 'cat-file', '-e', blob).status, 0,
    'the secret blob must be gone from the workspace object store, not merely untracked');
  // The signal was empty before this fix too, which is why the leak was silent: the NFC
  // sibling booked the entry as matched. It must stay empty for the right reason now.
  assert.deepEqual(ws.unmatchedDenyPaths, []);
});

test('normalisationAliases offers both spellings to check-ignore and maps matches back byte-exact', () => {
  const nul = Buffer.from([0]);
  const nfcPath = Buffer.from(`${NFC_DIR}/a.pem`, 'utf8');
  const nfdPath = Buffer.from(`${NFD_DIR}/b.pem`, 'utf8');
  const plain = Buffer.from('app.js', 'utf8');
  const tracked = Buffer.concat([plain, nul, nfcPath, nul, nfdPath, nul]);

  const { stdin, byPathname } = normalisationAliases(tracked);
  const offered = stdin.toString('utf8').split('\0').filter(Boolean);

  // app.js and the NFC path are already their own NFC form, so they are offered once each.
  // The NFD path is offered twice: its own bytes, plus the NFC spelling the deny pattern is
  // written in. Offering the alias is what lets `crédentials/**` match it at all.
  assert.deepEqual(offered, [
    'app.js', `${NFC_DIR}/a.pem`, `${NFD_DIR}/b.pem`, `${NFC_DIR}/b.pem`
  ]);

  // A hit on the alias must resolve to the tracked path's ORIGINAL bytes — the alias is a
  // matching aid, never something rmSync is pointed at.
  const aliasHit = Buffer.from(`${NFC_DIR}/b.pem`, 'utf8');
  const resolved = resolveDeniedPaths([aliasHit], byPathname);
  assert.equal(resolved.length, 1);
  assert.equal(Buffer.compare(resolved[0], nfdPath), 0,
    'the NFC alias must resolve back to the NFD bytes actually on disk');

  // A hit on a path that was never aliased passes straight through, unchanged.
  assert.equal(Buffer.compare(resolveDeniedPaths([plain], byPathname)[0], plain), 0);

  // Reported under both its own spelling and an alias, a path is still listed once.
  assert.equal(resolveDeniedPaths([nfdPath, aliasHit], byPathname).length, 1);

  // A repo with no normalisation variance offers exactly the tracked list and nothing more,
  // so this is a no-op everywhere it is not needed.
  const plainOnly = normalisationAliases(Buffer.concat([plain, nul]));
  assert.equal(Buffer.compare(plainOnly.stdin, Buffer.concat([plain, nul])), 0);
});

// --- A1-4: dropSymlinks and dropSubmodules must not decode paths through a lossy codec ---
//
// Both read `ls-files --stage -z` and ended in `.toString()` — the exact bug already fixed in
// deniedFiles and documented at length above, left in place in the two functions that run
// immediately after it. A tracked symlink or gitlink whose name holds bytes that are not
// valid UTF-8 decodes to a different path: rmSync(..., { force: true }) swallows the ENOENT
// and `git rm --cached --ignore-unmatch` no-ops, so the entry survives into the commit — and
// droppedSymlinks reports the mangled name as dropped, so the signal actively lies.
//
// An end-to-end fixture is not buildable here (APFS rejects such a filename), which is the
// same reason the parseCheckIgnoreOutput test above goes white-box. The record format differs
// from check-ignore's — "<mode> <sha> <stage>\t<path>" — so the tab has to be found by byte
// index, not by String.indexOf on a decoded string.

test('parseLsFilesStage keeps a path that is not valid UTF-8 byte-exact', () => {
  const nul = Buffer.from([0]);
  const sha = 'a'.repeat(40);
  // 0xFF can never appear in valid UTF-8; a lossy decode maps it to U+FFFD (ef bf bd),
  // changing both the content and the length of the field.
  const linkPath = Buffer.concat([
    Buffer.from('creds/', 'utf8'), Buffer.from([0xff]), Buffer.from('link', 'utf8')
  ]);
  const record = (mode, path) => Buffer.concat([
    Buffer.from(`${mode} ${sha} 0\t`, 'utf8'), path, nul
  ]);
  const raw = Buffer.concat([
    record('100644', Buffer.from('app.js', 'utf8')),
    record('120000', linkPath),
    record('160000', Buffer.from('vendor/sub', 'utf8'))
  ]);

  const entries = parseLsFilesStage(raw);

  assert.deepEqual(entries.map((e) => e.mode), ['100644', '120000', '160000']);
  assert.ok(Buffer.isBuffer(entries[1].path), 'path must stay a raw Buffer, not a decoded string');
  assert.equal(Buffer.compare(entries[1].path, linkPath), 0,
    'the invalid-UTF-8 path must survive byte for byte — decoding it would point rmSync at a path that does not exist, and force:true would swallow the miss');
  assert.equal(entries[2].path.toString('utf8'), 'vendor/sub');

  // A path containing a tab is still split at the FIRST tab, which is the record separator.
  const tabbed = Buffer.from('dir/we\tird', 'utf8');
  assert.equal(Buffer.compare(parseLsFilesStage(record('100644', tabbed))[0].path, tabbed), 0);
});

test('parseLsFilesStage rejects a truncated stream rather than parsing what arrived', () => {
  const sha = 'a'.repeat(40);
  const whole = Buffer.concat([
    Buffer.from(`100644 ${sha} 0\tapp.js`, 'utf8'), Buffer.from([0]),
    Buffer.from(`120000 ${sha} 0\tcreds/link`, 'utf8'), Buffer.from([0])
  ]);
  assert.equal(parseLsFilesStage(whole).length, 2);
  assert.deepEqual(parseLsFilesStage(Buffer.alloc(0)), []);

  // Cut mid-path: the symlink record is incomplete, so its real name is unknown. Returning
  // the first record alone would drop a symlink from droppedSymlinks and from the deletion.
  assert.throws(() => parseLsFilesStage(whole.subarray(0, whole.length - 4)), /truncat/i);
  // A record with no tab at all is malformed, not a path.
  assert.throws(
    () => parseLsFilesStage(Buffer.concat([Buffer.from('100644 nonsense', 'utf8'), Buffer.from([0])])),
    /tab|malformed/i
  );
});

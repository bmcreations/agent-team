import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();

// Let git's own ignore engine decide what matches, so deny_paths keep gitignore
// semantics (a bare `credentials` matches the directory at any depth). --no-index
// is required: without it, check-ignore reports tracked files as not ignored.
function deniedFiles(dir, denyPaths) {
  writeFileSync(join(dir, '.git', 'info', 'exclude'), `${denyPaths.join('\n')}\n`);
  const tracked = execFileSync('git', ['-C', dir, 'ls-files', '-z']);
  const trackedCount = tracked.length === 0
    ? 0
    : tracked.toString().split('\0').filter(Boolean).length;
  if (trackedCount === 0) return { denied: [], trackedCount };
  const matched = spawnSync(
    'git', ['-C', dir, 'check-ignore', '--no-index', '--stdin', '-z'],
    { input: tracked }
  );
  // exit 1 means nothing matched, which is not an error
  const denied = matched.stdout.toString().split('\0').filter(Boolean);
  return { denied, trackedCount };
}

function otherBranches(dir, keep) {
  return git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .map((s) => s.trim())
    .filter((b) => b && b !== keep);
}

// Submodules are a hole in deny_paths: deniedFiles only ever inspects the superproject's
// `git ls-files`, so a denied path living inside a submodule is invisible to it, and
// .gitmodules survives the clone with real URLs — `git submodule update --init` can
// re-fetch content deny_paths tried to exclude. Drop both by default. A member that
// genuinely needs submodule content is a feature request, not something granted here.
function dropSubmodules(dir) {
  const staged = execFileSync('git', ['-C', dir, 'ls-files', '--stage', '-z']).toString();
  const gitlinks = staged.split('\0').filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    const mode = entry.slice(0, tab).split(' ')[0];
    const path = entry.slice(tab + 1);
    return mode === '160000' ? [path] : [];
  });
  for (const rel of gitlinks) {
    rmSync(join(dir, rel), { recursive: true, force: true });
    execFileSync('git', ['-C', dir, 'rm', '-q', '-r', '-f', '--cached', '--ignore-unmatch', rel],
      { stdio: 'pipe' });
  }
  rmSync(join(dir, '.gitmodules'), { force: true });
  execFileSync('git', ['-C', dir, 'rm', '-q', '-f', '--cached', '--ignore-unmatch', '.gitmodules'],
    { stdio: 'pipe' });
}

// Where workspaces live. AGENT_TEAM_WORKSPACE_ROOT overrides for tests and for anyone who
// wants workspaces somewhere specific; XDG_CACHE_HOME and ~/.cache are the ordinary
// fallbacks. A stable cache location (not os.tmpdir()) matters because a workspace kept
// after a failed adapter run is evidence the user inspects later, and tmpdir gets reaped.
function cacheRoot() {
  return process.env.AGENT_TEAM_WORKSPACE_ROOT || process.env.XDG_CACHE_HOME
    || join(homedir(), '.cache');
}

// A short, stable key per repo so two different projects' workspaces never collide once
// workspaces move out of the repository they protect and into a shared cache directory.
function repoKey(repoRoot) {
  return createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 12);
}

// Workspaces must not live inside the repository they are protecting. The brief hands a
// member its cwd and relative deny_paths, and never discloses repoRoot — nesting the
// workspace inside the repo made repoRoot trivially derivable as `../../..` (or reachable
// with a bare `cat ../../../<secret>`), and let a stray `git add -A` in the real repo
// sweep up an entire workspace. This only keeps the brief from disclosing where the repo
// is; it does not stop a CLI that already knows repoRoot from reading it directly.
function workspacePath(repoRoot, member, id) {
  return join(cacheRoot(), 'agent-team', 'workspaces', repoKey(repoRoot), `${member}-${id}`);
}

export function createWorkspace(repoRoot, member, denyPaths, isolation) {
  const id = randomBytes(3).toString('hex');

  if (isolation === 'none') {
    return {
      dir: mkdtempSync(join(tmpdir(), `agent-team-${member}-`)),
      branch: null, id, kind: 'none'
    };
  }

  const dir = workspacePath(repoRoot, member, id);
  const branch = `agent-team/${member}-${id}`;
  mkdirSync(dirname(dir), { recursive: true });

  // file:// forces the transport path: no hardlinked objects and no
  // objects/info/alternates pointing back at the parent repository.
  execFileSync('git', [
    'clone', '-q', '--depth', '1', '--single-branch', '--no-hardlinks',
    `file://${repoRoot}`, dir
  ], { stdio: 'pipe' });

  // Everything past this point can throw (including the every-file-denied guard right
  // below). A partial build is an unredacted clone of the repo, not evidence worth
  // keeping — remove it before propagating the failure so nothing readable is left behind.
  try {
    git(dir, 'config', 'user.email', 'agent-team@localhost');
    git(dir, 'config', 'user.name', 'agent-team');
    git(dir, 'config', 'commit.gpgsign', 'false');

    const { denied, trackedCount } = deniedFiles(dir, denyPaths);
    if (trackedCount > 0 && denied.length === trackedCount) {
      throw new Error(
        `workspace for member "${member}": deny_paths excluded every tracked file ` +
        `(${trackedCount} of ${trackedCount}) — nothing left to commit`
      );
    }
    for (const rel of denied) {
      rmSync(join(dir, rel), { force: true });
    }

    dropSubmodules(dir);

    // The orphan commit is what does the work. A plain `git rm` commit leaves the
    // secret readable at HEAD~1; an orphan root commit makes the cloned commit
    // unreachable so gc can prune its blobs.
    git(dir, 'checkout', '-q', '--orphan', branch);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `workspace: ${member}`);
    for (const stale of otherBranches(dir, branch)) git(dir, 'branch', '-q', '-D', stale);
    git(dir, 'remote', 'remove', 'origin');
    git(dir, 'reflog', 'expire', '--expire=now', '--all');
    git(dir, 'gc', '-q', '--prune=now');
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  return { dir, branch, id, kind: isolation };
}

export function pruneWorkspace(workspace) {
  rmSync(workspace.dir, { recursive: true, force: true });
}

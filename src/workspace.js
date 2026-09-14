import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

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

export function createWorkspace(repoRoot, member, denyPaths, isolation) {
  const id = randomBytes(3).toString('hex');

  if (isolation === 'none') {
    return {
      dir: mkdtempSync(join(tmpdir(), `agent-team-${member}-`)),
      branch: null, id, kind: 'none'
    };
  }

  const dir = join(repoRoot, '.claude', 'workspaces', `${member}-${id}`);
  const branch = `agent-team/${member}-${id}`;
  mkdirSync(dirname(dir), { recursive: true });

  // file:// forces the transport path: no hardlinked objects and no
  // objects/info/alternates pointing back at the parent repository.
  execFileSync('git', [
    'clone', '-q', '--depth', '1', '--single-branch', '--no-hardlinks',
    `file://${repoRoot}`, dir
  ], { stdio: 'pipe' });

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

  return { dir, branch, id, kind: isolation };
}

export function pruneWorkspace(workspace) {
  rmSync(workspace.dir, { recursive: true, force: true });
}

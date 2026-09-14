import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();

// check-ignore -v reports the source of whichever rule *wins arbitration* across every
// ignore source present in the tree being checked — it is not limited to the exclude
// file we wrote. Running it against the workspace clone itself (which carries the
// source repo's own tracked ignore files) means a tracked `.gitignore` naming the same
// path as a deny_paths entry — or negating it with `!` — can out-arbitrate our exclude
// file, so the reported source comes back as `.gitignore`, not this one. Filtering on
// source alone in that tree silently drops a real deny_paths hit: the file survives
// into the clone and the entry is reported as unmatched, which is the dangerous
// direction (see docs/superpowers/plans — R9).
//
// So arbitration must not happen anywhere the repo's own ignore files can be present.
// deniedFiles instead builds a throwaway scratch git directory containing *only* the
// deny patterns — never the workspace clone, never the source repo — and asks
// check-ignore to arbitrate there. In that tree the only ignore source that can exist
// is the one this function just wrote, so a match's source is either EXCLUDE_SOURCE or
// proof the isolation this function relies on has broken.
//
// --no-index is still required: without it, check-ignore reports tracked files (which
// the workspace clone's files are) as not ignored. -v -z still reports each match as a
// NUL-separated "<source>\0<linenum>\0<pattern>\0<pathname>\0" quad. Gitignore semantics
// (a bare `credentials` matches the directory at any depth, `*.pem` globs, `!` negates)
// are what deny_paths deliberately inherits by going through git's own ignore engine
// instead of reimplementing pattern matching.
const EXCLUDE_SOURCE = '.git/info/exclude';

// core.ignorecase is auto-detected per-filesystem at `git init`/`git clone` time, and
// nothing keeps the scratch dir (under os.tmpdir()) on the same filesystem as the
// workspace clone (under the workspace root, which can be repointed anywhere). When the
// two disagree, a deny pattern that would match against the clone's files does not match
// in the scratch dir that arbitrates for it, the hit is silently dropped, and the file
// ships — the same shadow-drop failure the scratch-dir isolation above exists to prevent,
// reopened through a different mechanism. The deletion happens on the CLONE's filesystem,
// so the clone's setting is the one that must govern arbitration; git sets it explicitly
// at clone time, so reading it back here is exact, not a heuristic.
function cloneIgnoreCase(dir) {
  const result = spawnSync('git', ['-C', dir, 'config', '--type=bool', '--get', 'core.ignorecase']);
  const value = result.status === 0 ? result.stdout.toString().trim() : '';
  // Unset or unparseable defaults to 'true': over-deletion (treating more names as the
  // same name) is the safe direction here — never default to 'false'.
  return value === 'false' ? 'false' : 'true';
}

// Exported and unit-tested white-box, same reasoning as cloneArgs below: the
// core.ignorecase divergence this function guards against cannot be forced on this
// machine without a second, deliberately-differently-cased filesystem (see the test).
// Calling this directly on a fabricated clone dir instead lets the test force the clone's
// core.ignorecase to each value and assert that value — not tmpdir's — governs.
export function deniedFiles(dir, denyPaths) {
  const tracked = execFileSync('git', ['-C', dir, 'ls-files', '-z']);
  const trackedCount = tracked.length === 0
    ? 0
    : tracked.toString().split('\0').filter(Boolean).length;
  if (trackedCount === 0) return { denied: [], trackedCount, matchedDenyPaths: new Set() };

  const scratch = mkdtempSync(join(tmpdir(), 'agent-team-denyscratch-'));
  try {
    execFileSync('git', ['init', '-q', scratch], { stdio: 'pipe' });
    // Truncating write: this also means a global init.templateDir that seeds a fresh
    // repo's info/exclude cannot leak an extra pattern in here.
    writeFileSync(join(scratch, '.git', 'info', 'exclude'), `${denyPaths.join('\n')}\n`);

    // core.excludesFile=/dev/null is required, not decoration: without it, a user's
    // global excludes file (set via $HOME/.config/git/ignore or GIT_CONFIG_GLOBAL) is
    // still consulted by check-ignore in the scratch dir and can report matches sourced
    // from it — deleting files deny_paths never named.
    //
    // core.ignorecase=<clone's value> is equally load-bearing: without it the scratch dir
    // auto-detects case sensitivity from whatever filesystem os.tmpdir() lands on, which
    // has no relationship to the clone's filesystem — see cloneIgnoreCase above.
    const matched = spawnSync(
      'git', ['-C', scratch,
        '-c', 'core.excludesFile=/dev/null',
        '-c', `core.ignorecase=${cloneIgnoreCase(dir)}`,
        'check-ignore', '--no-index', '-v', '-z', '--stdin'],
      { input: tracked }
    );
    // exit 1 means nothing matched, which is not an error
    const raw = matched.stdout.toString();
    const parts = raw.length === 0 ? [] : raw.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();

    const denied = [];
    const matchedDenyPaths = new Set();
    for (let i = 0; i + 3 < parts.length; i += 4) {
      const source = parts[i];
      const pattern = parts[i + 2];
      const pathname = parts[i + 3];
      if (source !== EXCLUDE_SOURCE) {
        // The scratch dir contains nothing but the exclude file written above — there
        // is no other ignore source it could legitimately report. An unexpected source
        // means the isolation this function depends on has broken; silently dropping
        // the match here would reproduce the exact shadowing bug the scratch dir exists
        // to prevent, one layer down.
        throw new Error(
          `deniedFiles: unexpected check-ignore source "${source}" for "${pathname}" ` +
          `in scratch dir — expected only "${EXCLUDE_SOURCE}"`
        );
      }
      denied.push(pathname);
      matchedDenyPaths.add(pattern);
    }
    return { denied, trackedCount, matchedDenyPaths };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

// Exported and unit-tested white-box: dropping either flag still produces a clone that
// looks fine to every black-box test in this file, but silently loses the isolation
// property it exists for.
//
// file:// forces the transport path: no hardlinked objects and no
// objects/info/alternates pointing back at the parent repository.
// --depth 1 keeps history out of the clone — without it the clone carries the whole
// history, including any commit deny_paths ever removed a secret from.
export function cloneArgs(repoRoot, dir) {
  return [
    'clone', '-q', '--depth', '1', '--single-branch', '--no-hardlinks',
    `file://${repoRoot}`, dir
  ];
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

  execFileSync('git', cloneArgs(repoRoot, dir), { stdio: 'pipe' });

  // Everything past this point can throw (including the every-file-denied guard right
  // below). A partial build is an unredacted clone of the repo, not evidence worth
  // keeping — remove it before propagating the failure so nothing readable is left behind.
  let unmatchedDenyPaths;
  try {
    git(dir, 'config', 'user.email', 'agent-team@localhost');
    git(dir, 'config', 'user.name', 'agent-team');
    git(dir, 'config', 'commit.gpgsign', 'false');

    const { denied, trackedCount, matchedDenyPaths } = deniedFiles(dir, denyPaths);
    if (trackedCount > 0 && denied.length === trackedCount) {
      throw new Error(
        `workspace for member "${member}": deny_paths excluded every tracked file ` +
        `(${trackedCount} of ${trackedCount}) — nothing left to commit`
      );
    }
    for (const rel of denied) {
      rmSync(join(dir, rel), { force: true });
    }
    // A config's deny_paths commonly outlives the specific repo it's used on (the same
    // config is reused across projects); an entry matching nothing here is expected, not
    // an error. Report it on the workspace instead of throwing.
    unmatchedDenyPaths = denyPaths.filter((p) => !matchedDenyPaths.has(p));

    dropSubmodules(dir);

    // The orphan commit is what does the work. A plain `git rm` commit leaves the
    // secret readable at HEAD~1; an orphan root commit makes the cloned commit
    // unreachable so gc can prune its blobs.
    git(dir, 'checkout', '-q', '--orphan', branch);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `workspace: ${member}`);
    for (const stale of otherBranches(dir, branch)) git(dir, 'branch', '-q', '-D', stale);
    git(dir, 'remote', 'remove', 'origin');
    // `remote remove` deletes the origin remote's config but leaves refs/remotes/origin/HEAD
    // behind as a symref with nothing to point at (git never wrote it as a real ref,
    // just a pointer into a remote that no longer exists) — reflog expire and gc both
    // leave it alone, and `git fsck --full` reports it as an invalid sha1 pointer.
    rmSync(join(dir, '.git', 'refs', 'remotes'), { recursive: true, force: true });
    rmSync(join(dir, '.git', 'logs', 'refs', 'remotes'), { recursive: true, force: true });
    git(dir, 'reflog', 'expire', '--expire=now', '--all');
    git(dir, 'gc', '-q', '--prune=now');
  } catch (err) {
    // force: true only suppresses ENOENT — a real removal failure (a read-only parent,
    // an immutable file) throws here too. That must never replace the original error:
    // losing "deny_paths excluded every tracked file" behind an unrelated ENOTEMPTY
    // would leave the operator with no idea what actually went wrong. Swallow the
    // cleanup failure, but not silently — a leftover directory is an unredacted clone,
    // and silence about it is worse than the extra noise.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(
        `agent-team: could not remove workspace directory "${dir}" after a build failure ` +
        `(${cleanupErr.message}) — remove it manually`
      );
    }
    throw err;
  }

  return { dir, branch, id, kind: isolation, unmatchedDenyPaths };
}

export function pruneWorkspace(workspace) {
  rmSync(workspace.dir, { recursive: true, force: true });
}

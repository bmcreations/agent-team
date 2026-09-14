import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync, readFileSync
} from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();

// Every child_process call that captures output through a pipe is bounded by Node's
// `maxBuffer`, 1 MiB by default. The two failure modes differ, and only one of them is loud:
//
//   execFileSync — throws ENOBUFS. Fails closed (no workspace is built), which is the safe
//                  direction, but the ceiling still makes the boundary unusable on any repo
//                  big enough to cross it.
//   spawnSync    — does NOT throw. It SIGTERMs the child, sets `error.code = 'ENOBUFS'`, and
//                  returns a *truncated* stdout. That is how denied files shipped: the
//                  check-ignore stream below was cut mid-record, every match past the cut was
//                  lost, the deny entry was still booked as matched by the records before the
//                  cut, and `unmatchedDenyPaths` stayed empty. Fails open, silently.
//
// Raising `maxBuffer` is not a fix. Any fixed ceiling is crossed by a big enough repo, so a
// bigger number only widens the window in which the silent variant happens. Redirecting the
// child's stdout to a file removes the ceiling instead of moving it: `stdio: ['pipe', fd,
// 'pipe']` keeps `input:` working for stdin and keeps stderr piped for diagnostics, and the
// output is read back as a Buffer so pathname bytes stay exact (see parseCheckIgnoreOutput).
//
// The result object is then checked, always. An unchecked spawnSync result is the actual
// root cause here — `matched.error` and `matched.status` were both sitting there unread.
// stderr is still piped and so still bounded, but a git command whose *stderr* overflows has
// failed anyway, and that now throws rather than being parsed.
//
// `okStatus` lists the exit codes that are not failures: check-ignore exits 1 to mean
// "nothing matched", which is an ordinary answer rather than an error.
function gitCapture(label, args, { input, okStatus = [0] } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-team-gitout-'));
  let fd;
  try {
    const outPath = join(scratch, 'stdout');
    fd = openSync(outPath, 'w');
    const result = spawnSync('git', args, { input, stdio: ['pipe', fd, 'pipe'] });
    closeSync(fd);
    fd = undefined;
    if (result.error || result.signal || !okStatus.includes(result.status)) {
      throw gitFailure(label, result);
    }
    return readFileSync(outPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Exported and unit-tested white-box: the residual overflow this translates can only be
// provoked for real by a repo large enough to blow the *stderr* pipe, which is not something
// worth building a fixture for. Calling it directly on a fabricated spawnSync result pins the
// wording instead.
//
// ENOBUFS used to reach the operator verbatim — `ENOBUFS | spawnSync git ENOBUFS`, with a
// megabyte-long buffer dump attached and nothing in it naming the cause. It was raised from
// `ls-files --stage -z`, which adds ~51 bytes of mode/sha/stage per entry and so crossed the
// 1 MiB bound at roughly `N * (51 + avg path length) < 1048576` — about 12,900 tracked files
// at 30-character paths. That is an ordinary app repo, and the only signal it produced was a
// buffer dump. The capture sites no longer have that ceiling; what is left must at least say
// what happened.
export function gitFailure(label, result) {
  if (result.error && result.error.code === 'ENOBUFS') {
    return new Error(
      `agent-team: ${label} produced more output than it could buffer — this repository is ` +
      'larger than the isolation boundary can currently process, so no workspace was built ' +
      'and no files were released to the CLI'
    );
  }
  if (result.error) {
    return new Error(`agent-team: ${label} could not be run (${result.error.message})`);
  }
  if (result.signal) {
    return new Error(`agent-team: ${label} was killed by ${result.signal} before it finished`);
  }
  const stderr = (result.stderr ? result.stderr.toString('utf8') : '').trim();
  return new Error(
    `agent-team: ${label} exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`
  );
}

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

// Splits a Buffer on NUL bytes, mirroring `string.split('\0')` but without ever decoding
// through a text codec first. A NUL byte cannot occur inside a POSIX filename, so slicing
// on it is exact for -v -z's "<source>\0<linenum>\0<pattern>\0<pathname>\0" records
// regardless of what bytes the surrounding fields hold.
function splitNulBuffer(buf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

// Exported and unit-tested white-box: a tracked filename with bytes that are not valid
// UTF-8 is ordinary on Linux ext4/xfs (filenames there are opaque bytes) but cannot be
// created on this machine — APFS rejects it outright. Calling this directly with a
// fabricated Buffer lets the test prove the pathname field survives such bytes untouched,
// which an end-to-end fixture on this filesystem never could.
//
// `raw` must be the check-ignore -v -z output as a Buffer, not a decoded string: decoding
// first (the previous `matched.stdout.toString()`) uses the lossy default 'utf8' codec,
// which replaces any invalid byte sequence with U+FFFD before this function ever sees it.
// A corrupted pathname means the later `rmSync(joinBuffer(dir, rel), { force: true })`
// targets a path that does not exist; `force: true` swallows the resulting ENOENT, and the
// real file silently survives into the commit and ships. `source` and `pattern` are decoded as text
// because they are always git-internal, ASCII-safe strings (a config source path and a
// deny_paths pattern) — `pathname` is kept as a raw Buffer end to end, because it is the
// one field that isn't guaranteed to be valid UTF-8, and it's the one used to build a
// filesystem path afterwards.
export function parseCheckIgnoreOutput(raw) {
  // A truncated stream must never be parsed as if it were complete. `-v -z` emits whole
  // NUL-terminated quads and nothing else, so a stream that does not end on a NUL, or that
  // does not hold a multiple of four fields, was cut short — and what is missing from it is
  // an unknown number of *denied* pathnames, every one of which would otherwise ship. The
  // old `i + 3 < parts.length` bound did the opposite: it discarded the incomplete trailing
  // record and returned the rest, so the caller could not tell a complete answer from a
  // partial one. gitCapture above removes the ceiling that produced the truncation in the
  // first place; these two checks are the second layer, and the one a unit test can reach
  // without generating megabytes.
  if (raw.length > 0 && raw[raw.length - 1] !== 0) {
    throw new Error(
      'deniedFiles: check-ignore output ends mid-field (no trailing NUL) — the stream was ' +
      'truncated, so an unknown number of denied paths is missing from it; refusing to ' +
      'treat a partial answer as a complete one'
    );
  }
  const parts = splitNulBuffer(raw);
  if (parts.length % 4 !== 0) {
    throw new Error(
      `deniedFiles: check-ignore output holds ${parts.length} NUL-separated fields, which ` +
      'is not a whole number of "<source> <linenum> <pattern> <pathname>" records — the ' +
      'stream was truncated; refusing to treat a partial answer as a complete one'
    );
  }

  const denied = [];
  const matchedDenyPaths = new Set();
  for (let i = 0; i < parts.length; i += 4) {
    const source = parts[i].toString('utf8');
    const pattern = parts[i + 2].toString('utf8');
    const pathname = parts[i + 3]; // raw bytes — see comment above
    if (source !== EXCLUDE_SOURCE) {
      // The scratch dir contains nothing but the exclude file written above — there
      // is no other ignore source it could legitimately report. An unexpected source
      // means the isolation this function depends on has broken; silently dropping
      // the match here would reproduce the exact shadowing bug the scratch dir exists
      // to prevent, one layer down.
      throw new Error(
        `deniedFiles: unexpected check-ignore source "${source}" for ` +
        `"${pathname.toString('utf8')}" in scratch dir — expected only "${EXCLUDE_SOURCE}"`
      );
    }
    denied.push(pathname);
    matchedDenyPaths.add(pattern);
  }
  return { denied, matchedDenyPaths };
}

// Joins a directory (a plain string this module controls) with a relative path that may
// hold bytes which are not valid UTF-8, without ever routing that relative path through a
// string codec. node:path's `join` is string-only, so this concatenates Buffers instead.
function joinBuffer(dir, rel) {
  const relBuf = Buffer.isBuffer(rel) ? rel : Buffer.from(rel);
  return Buffer.concat([Buffer.from(dir), Buffer.from('/'), relBuf]);
}

// Exported and unit-tested white-box, same reasoning as cloneArgs below: the
// core.ignorecase divergence this function guards against cannot be forced on this
// machine without a second, deliberately-differently-cased filesystem (see the test).
// Calling this directly on a fabricated clone dir instead lets the test force the clone's
// core.ignorecase to each value and assert that value — not tmpdir's — governs.
export function deniedFiles(dir, denyPaths) {
  // Through gitCapture, not execFileSync: this list is what gets offered to check-ignore, so
  // a tracked path that falls off the end of a truncated buffer is never arbitrated and so
  // can never be denied. execFileSync threw on overflow rather than truncating, so this end
  // failed closed — but it failed closed at 1 MiB, which is a repo of only ~12k files.
  const tracked = gitCapture('git ls-files (tracked-file scan)', ['-C', dir, 'ls-files', '-z']);
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
    //
    // This is the call that shipped denied files. It ran through a bare `spawnSync` whose
    // result object was never inspected, so a stdout over `maxBuffer` came back silently
    // truncated (see gitCapture) and every match past the cut was lost. gitCapture writes
    // the stream to a file instead of a pipe, so there is no ceiling to cross, and checks
    // `error`/`signal`/`status` so a failure throws instead of returning a partial answer.
    // exit 1 means nothing matched, which is not an error.
    //
    // The captured stream stays a Buffer: decoding it first (the older
    // `matched.stdout.toString()`) uses the lossy default 'utf8' codec, which mangles a
    // pathname that isn't valid UTF-8. Parsing the Buffer directly keeps every pathname
    // byte-exact through to the rmSync call below.
    const matched = gitCapture('git check-ignore (deny_paths arbitration)',
      ['-C', scratch,
        '-c', 'core.excludesFile=/dev/null',
        '-c', `core.ignorecase=${cloneIgnoreCase(dir)}`,
        'check-ignore', '--no-index', '-v', '-z', '--stdin'],
      { input: tracked, okStatus: [0, 1] });
    const { denied, matchedDenyPaths } = parseCheckIgnoreOutput(matched);
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
  // Through gitCapture for the same reason as deniedFiles' ls-files: `--stage` adds ~51 bytes
  // of mode/sha/stage to every entry, so this is the stream that crosses the 1 MiB pipe bound
  // first — at roughly 12,900 tracked files at 30-character paths. execFileSync threw there,
  // so it failed closed, but it failed closed on an ordinary app repo and said only ENOBUFS.
  const staged = gitCapture('git ls-files --stage (submodule scan)',
    ['-C', dir, 'ls-files', '--stage', '-z']).toString();
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

// A symlink is a hole in deny_paths for the same reason a submodule is: deniedFiles
// matches a tracked path's own *name* against the deny patterns and never looks at what
// the entry actually resolves to, so a name-based boundary cannot bound it. Two distinct
// confirmed shapes: (1) a symlink whose name deny_paths never mentions can point anywhere
// the process can read — an arbitrary-file-read primitive with no name for deny_paths to
// ever catch, and no warning, since unmatchedDenyPaths only reports entries that were
// *expected* to match something; (2) a symlink whose name IS a deny_paths entry can still
// survive: a trailing-slash directory-only pattern (`credentials/`) does not match a
// symlink entry, because git's directory-only glob semantics require the entry to actually
// be a directory in the tracked tree, which a symlink is not. Resolving targets and
// matching the resolved path is racy and still misses shape (1), whose target is not named
// in deny_paths at all; dropping only symlinks that escape the workspace root closes (1)
// but not (2). Drop every tracked symlink, unconditionally — same policy as
// dropSubmodules, and for the same reason: a member that genuinely needs one is a feature
// request, not something granted here.
function dropSymlinks(dir) {
  const staged = gitCapture('git ls-files --stage (symlink scan)',
    ['-C', dir, 'ls-files', '--stage', '-z']).toString();
  const links = staged.split('\0').filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    const mode = entry.slice(0, tab).split(' ')[0];
    const path = entry.slice(tab + 1);
    return mode === '120000' ? [path] : [];
  });
  for (const rel of links) {
    // rmSync on a symlink path removes the link itself, never what it points to — even
    // when the link targets a directory (fs never follows the symlink to decide what to
    // remove), so this cannot reach outside the workspace clone.
    rmSync(join(dir, rel), { force: true });
    execFileSync('git', ['-C', dir, 'rm', '-q', '-f', '--cached', '--ignore-unmatch', rel],
      { stdio: 'pipe' });
  }
  return links;
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
  let droppedSymlinks;
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
      // `rel` is a raw Buffer (see parseCheckIgnoreOutput) — path.join is string-only and
      // would force a lossy decode right back in here, so the path is built by
      // concatenating Buffers instead. rmSync accepts a Buffer path directly.
      rmSync(joinBuffer(dir, rel), { force: true });
    }
    // A config's deny_paths commonly outlives the specific repo it's used on (the same
    // config is reused across projects); an entry matching nothing here is expected, not
    // an error. Report it on the workspace instead of throwing.
    unmatchedDenyPaths = denyPaths.filter((p) => !matchedDenyPaths.has(p));

    dropSubmodules(dir);
    droppedSymlinks = dropSymlinks(dir);

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

  return { dir, branch, id, kind: isolation, unmatchedDenyPaths, droppedSymlinks };
}

export function pruneWorkspace(workspace) {
  rmSync(workspace.dir, { recursive: true, force: true });
}

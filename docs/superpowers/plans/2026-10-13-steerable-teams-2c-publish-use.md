# Steerable teams 2c: `publish` and `use`, and the two-team demo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member can snapshot a file or directory from its workspace as a new read-only version (`publish(name, path)`), any member can copy a published version into its own workspace (`use(team, name, version?)`), members using an older version hear about a newer one through `wait_for`, and a scripted two-team demo (an `android` repo and a `loupe` repo, mock-live members, temp store) shows the Android team opening a task thread with loupe, loupe's lead accepting and fixing, the thread closing, and Android picking up the fix — visible in the web view.

**Architecture:** Migration 8 adds `publications` (one metadata row per version) and `uses` (which member copied which version). Snapshot content lives on disk in a `published/` directory beside the store, passed to the `Supervisor` as `publishDir`; a new `src/publish.js` owns the bounded, symlink-free, deny-path-aware walk and the copy. The supervisor's `publish`/`use` tools call it. `scripts/demo-threads.mjs` wires a temp store, a shared supervisor, and `startHttp` on a port from the environment (default `0`).

**Tech Stack:** Node >= 22.13, ES modules, `node:sqlite`, `node:http`, `node --test`. No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-10-12-steerable-teams-design.md`: the `publish`/`use` rows and the "newer version" clause of "Peer teams talk in threads" (lines 273–302), and the loupe/Android half of "The demo this spec ends at" (lines 32–43). Builds on plans 2a (`docs/superpowers/plans/2026-10-13-steerable-teams-2a-cross-team-live.md`) and 2b (`docs/superpowers/plans/2026-10-13-steerable-teams-2b-peer-threads.md`), which must have landed.

**Size:** 4 tasks.

## Global Constraints

These hold for plans 2a, 2b and 2c alike; each plan repeats them.

- Stdlib only: the plugin has no install step. `package.json` `engines.node` stays `>=22.13`. The store is `node:sqlite`. Every store change is a new entry in `MIGRATIONS` in `src/store.js`, applied through `PRAGMA user_version`. The database is at version 5 before 2a; **2a adds migration 6, 2b migration 7, 2c migration 8.** (The brief suggested threads as migration 6; live cross-team delegation needs member columns first, so the numbers follow the plan order.) Every migration task also updates the rewind tests in `test/store.test.js` so they drop the new columns and tables before setting an older `user_version`.
- Every new member tool (`team_status`, `request`, `reply`, `publish`, `use`) is in `TOOL_SCHEMAS` with `annotations: RO` (`readOnlyHint: true`), so plan-mode (read-only) members can call it. None of them lets the *member* write its workspace; where a tool writes (`use`), the supervisor does it.
- Threads and live cross-team delegation need `agent-team serve`. A `Supervisor` gets `shared: true` only in `serve`; in-process supervisors (a CLI with no `serve`) keep `team:` members one-shot (`runTeam`) and refuse `request` with "threads need `agent-team serve`". In-process runs stay read-only in the web view (1c's ruling, unchanged).
- A thread-run is a separate run owned by the receiving team, under the receiving team's config, `max_delegations`, `max_cost_usd`, and `deny_paths`. GitHub-named (cloud) teams stay one-shot: they are never live members and cannot be sent threads.
- Tests never reach real `claude` or `codex`: `test/helpers/guard.js` is preloaded (`npm test`, and every `Run:` line below). Members in tests use the `mock-live` adapter through `test/helpers/live.js` (`project`, `supervise`, `LIVE`). Tests never touch the user's real store: they use `:memory:` or temp stores, temp `XDG_CACHE_HOME`, and temp sockets. No test or script binds port 4747; HTTP tests use port `0`.
- The page stays `textContent`-only under the strict CSP; `src/web/` never uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` (`test/web.test.js` scans for them). Text that reaches a terminal goes through `plain` from `src/watch.js`. Every field sent to a client goes through an allowlist in `src/view.js`; new columns stay private until listed there.
- Commits are conventional commits with no attribution trailers. No figma.com URLs anywhere.
- Baseline: `npm test` reports 647 tests, 645 pass, 2 skipped, 0 fail at a21c42e (before 2a).

**Rulings on the seven open questions (binding for 2a–2c):**

1. **Loop guard is on the chain of requests.** A thread row stores `parent_thread` (the thread whose run the requester belongs to, or null) and `chain`, a JSON array of team keys (`teamKeys(root)`: real path, plus the GitHub key when the repo has one) in the order the teams joined. A run started by a thread carries it in `runs.thread_id`. A new request's chain is: the parent thread's chain if the requester's run has a `thread_id`, else the run project's keys; then the keys of every live cross-team scope between the requester and its run's root (2a's `#scope(m).teams`). The request is refused with `request refused: team "<t>" is already in this chain (A -> B -> A)` if any of the target's keys is in that chain. A team never requests itself.
2. **`publish`/`use`.** Snapshots go to `join(dirname(storePath), 'published', <sha256(project) first 16 hex>, <name>, <version>)`, never into the database (the DB holds one metadata row per version). The walk uses `lstat`: symlinks are never followed and are listed in `skipped`; the source's `realpath` must be inside the member's workspace `realpath`; the publisher's scope `deny_paths` are applied with `arbitrateDenyPaths` from `src/workspace.js` and matching files are skipped and listed; at most 1,000 files and 50 MiB total (over either bound refuses and writes nothing). Content is written to a temp directory beside the target and renamed into place; files are made `0444`, directories `0555`. Versions are integers per `(project, name)`, starting at 1, assigned inside `BEGIN IMMEDIATE`. `use` copies to `<workspace>/.agent-team/used/<team>/<name>@<version>/` and never overwrites: if that path exists it returns `{ path, version, already: true }` and copies nothing.
3. **`team_status` returns no transcripts.** Its shape is built only by `teamStatus` in `src/view.js` from three allowlists: `TEAM_FIELDS` (`name`, `root`, `source`), `TEAM_RUN_FIELDS` (`id`, `status`, `task` clipped to 200 characters, `created_at`, `cost_usd`), and `TEAM_MEMBER_FIELDS` (`id`, `run_id`, `parent_id`, `name`, `alias`, `agent`, `state`, `depth`, `updated_at`), plus each member's latest checkpoint `{ text, at }` (its newest `progress` event, text clipped to 500 characters). Events, messages, results, workspaces, and tokens are never included. `GET /api/teams/status?root=` returns the same object.
4. **`peers`.** An optional top-level array in `.claude/agent-team.json` of at most 50 non-empty strings, validated by shape only when the config loads (a peer that does not exist yet must not break the config). A peer is resolved like a `team:` path (`teamRoot` in `src/dispatch.js`: `~` and `~/…` expand to the home directory, a relative path is relative to the project root with the main-checkout fallback for linked worktrees, an absolute path is used as is). A peer is valid when it is a directory containing `.claude/agent-team.json` that `loadConfig` accepts. URL-like or GitHub peers are refused at load. At request time a missing or broken peer fails the tool call with `team "<arg>" not found: no agent-team config at <abs>/.claude/agent-team.json`; `team_status()` with no argument lists it with `missing: true`.
5. **Human side of threads (RULING NEEDED FROM USER on the scope).** The spec names no thread CLI verbs. 2b adds the minimum: `agent-team threads [--project <dir>] [--json]` (lists threads, newest first, grouped by team pair) and `agent-team reply <thread> <text>` (a human post on the thread, signed `whoAmI()`, no state change). The web view gets one `#/threads` page grouping threads by team pair, each thread showing its posts and linking its runs, with the same human reply box. Whether humans may also accept or decline a thread on a team's behalf is left open: 2b does **not** implement it.
6. **Starting the receiving lead.** A thread goes to the receiving team's entry member (its only root; a team with several roots is refused with the `teamEntry` error). If that member is live in this supervisor at scope depth 0 in that project (a run root or a live cross-team entry), the thread is delivered to its inbox and it owns the thread. Otherwise `serve` starts a new run in the receiving project (its config, `max_delegations`, `max_cost_usd`, owner `serve`'s socket, `runs.thread_id` set) with the entry member as root and a brief that carries the thread. In that run `delegate` is refused until the thread is `accepted`. A run that finishes while its thread is still `open` declines it ("the lead finished without accepting"); one that finishes after accepting closes it `done` with `{ status, summary }`. A live lead in another run that accepts a task thread gets the same new run started for it. `recover()` restarts triage for open threads whose owner is gone.
7. **Budgets.** A thread-run spends only the receiving team's budgets: its run's `max_delegations` and `max_cost_usd` come from the receiving config, and its cost is charged to its own run. The requester's cost cap is not charged. `request` itself spends one of the requester's `max_delegations` (and every enclosing scope counter), as `delegate` does, so a member cannot open threads without bound.

## Rulings this plan makes

- **`publishDir` is a constructor option.** The `Supervisor` does not know its store's path. `serve` and the in-process client pass `join(dirname(defaultStorePath()), 'published')`; tests pass a temp directory. A supervisor without one refuses `publish` and `use` with "publishing needs a publish directory". Unlike threads, `publish`/`use` do not need `serve`: they touch no other run.
- **Names.** `name` matches `^[a-z0-9][a-z0-9._-]{0,63}$`, so it is a safe single path segment. `path` is relative to the member's workspace; absolute paths and any path whose `realpath` leaves the workspace are refused (`publish refused: "<path>" is outside your workspace`).
- **What a version holds.** A directory publish snapshots its tree; a file publish snapshots one file under its basename. Each version records `files`, `bytes`, `skipped` (symlinks and denied files, as relative paths, at most 100 listed plus a count), and the publishing member and run. The publisher's scope project is the team the version belongs to, so a member of a live cross-team scope (2a) publishes for that team, under that team's `deny_paths`.
- **Deny paths without git.** A workspace may not be a git checkout (`isolation: 'none'`), so the walk builds a NUL-separated list of the files it found and passes it to `arbitrateDenyPaths(list, denyPaths, false)` — the same matcher `deniedFiles` uses, without `git ls-files`. `.git/` and `.agent-team/` are always skipped.
- **Where `use` puts it, and conflict.** `<workspace>/.agent-team/used/<team basename>/<name>@<version>/`. The version path is unique, so two versions never collide; an existing path is reported `already: true` and left as is (the member may have edited its copy). Copies are made writable (`0644`/`0755`) so the member can work on them. A read-only (plan-mode) member's workspace is still written: the supervisor writes it, the member only asked. `.agent-team/` is added to the workspace's `.git/info/exclude` when the workspace is a git checkout, so a used copy never shows up in the member's diff.
- **Newer versions.** `use` records a `uses` row. When a new version of `(project, name)` is published, every live member with a `uses` row for an older version gets an inbox message `newer version: <team>/<name>@<n> (you use @<m>)` with `from_kind: 'team'`, which `wait_for` returns.
- **The demo is a script, not a test fixture.** `scripts/demo-threads.mjs` builds everything in temp directories, never reads or writes the user's store, and listens on `AGENT_TEAM_DEMO_PORT` (default `0`). A test runs it on port 0. It does not drive loupe or a real device: loupe here is a repository name in the story, played by mock-live members.

## Review Focus

1. **Escaping the workspace.** A symlink to `/etc`, a symlinked parent directory, `..` in `path`, and a file under a denied path must all stay out of a snapshot. Pinned in Task 2.
2. **Bounds.** 1,001 files or 50 MiB + 1 byte refuses and leaves no partial version (no row, no directory). Pinned in Task 2.
3. **Version races.** Two publishes of one name at once get distinct versions and both land. Pinned in Task 1 (store) and Task 2 (temp-then-rename).
4. **`use` never clobbers.** Pinned in Task 3.

## Files

| File | Task | Responsibility |
|---|---|---|
| `src/store.js` | 1, 2 | Migration 8; `addPublication`, `publication`, `publications`, `addUse`, `staleUses`, `deletePublication` |
| `src/publish.js` | 2, 3 | `snapshot`, `writeSnapshot`, `removeTree`, `copyOut`, `excludeUsed`, `publishPath` |
| `src/supervisor.js` | 2, 3 | `publishDir` option; `publish` and `use` tools; newer-version notices |
| `src/team-tools.js` | 2, 3 | `publish` and `use` schemas; `TEAM_NOTE` |
| `bin/agent-team.js`, `src/client.js` | 2 | Pass `publishDir` |
| `adapters/mock-live` | 2 | A `write` step |
| `scripts/demo-threads.mjs` | 4 | The two-team demo |
| `test/store.test.js`, `test/publish.test.js`, `test/mcp.test.js`, `test/demo.test.js` | 1–4 | Tests |
| `docs/how-it-works.md`, `README.md` | 2–4 | Each task documents what it changes |

---

### Task 1: Migration 8, publications and uses

**Files:**
- Modify: `src/store.js` (`MIGRATIONS`; new methods)
- Modify: `test/store.test.js` (every rewind test; new tests at the end)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `addPublication({ project, name, memberId, runId, files, bytes, skipped }): { id, version }` — inside `BEGIN IMMEDIATE`: `version = 1 + max(version)` for `(project, name)`, then insert. Unique index on `(project, name, version)`.
  - `publication(project, name, version = null)` — that version, or the latest when `version` is null; `skipped` parsed.
  - `publications(project): { name, version, files, bytes, at }[]` — the latest version of each name.
  - `addUse({ memberId, project, name, version })`.
  - `staleUses(project, name, version): { member_id, version }[]` — uses of an older version by members not in a terminal state, latest use per member.

- [ ] **Step 1: Make every rewind test drop migration 8's tables, and write the store tests**

Every rewind test in `test/store.test.js` prepends `'DROP TABLE uses; DROP TABLE publications; ' +` to its drops. Then append:

```js
test('a version 7 database gains publications and uses', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig8-')), 's.db');
  openStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE uses; DROP TABLE publications; PRAGMA user_version = 7');
  raw.close();
  const store = openStore(path);
  assert.deepEqual(store.publications('/b'), []);
  store.close();
});

test('versions count up per project and name', () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/b', task: 't' });
  const m = store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  const pub = (project, name) => store.addPublication({ project, name, memberId: m.id, runId, files: 1, bytes: 3, skipped: [] });
  assert.equal(pub('/b', 'fix').version, 1);
  assert.equal(pub('/b', 'fix').version, 2);
  assert.equal(pub('/b', 'other').version, 1);
  assert.equal(pub('/c', 'fix').version, 1);
  assert.equal(store.publication('/b', 'fix').version, 2);
  assert.equal(store.publication('/b', 'fix', 1).version, 1);
  assert.equal(store.publication('/b', 'fix', 9), undefined);
  assert.deepEqual(store.publications('/b').map((p) => [p.name, p.version]), [['fix', 2], ['other', 1]]);
  store.close();
});

test('two stores on one file never hand out the same version', () => {
  // Two openStore() handles on one temp file, interleaved addPublication calls: versions 1..20, no duplicates.
});

test('staleUses lists live members on an older version', () => { /* ... */ });
```

Fill in the stubs: the race test opens two handles on one file and alternates 20 publishes, asserting the sorted versions are `1..20`; the stale-uses test records uses of v1 by a running member and a finished member and of v2 by a third, and asserts `staleUses('/b', 'fix', 2)` returns only the running v1 member.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js`
Expected: FAIL — `no such table: uses`.

- [ ] **Step 3: Add migration 8 and the methods**

```js
  // publish/use: one row per published version (the content is on disk beside the store),
  // and who copied which version, so a newer one can be announced.
  `CREATE TABLE publications (
     id INTEGER PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
     member_id INTEGER NOT NULL REFERENCES members(id), run_id INTEGER NOT NULL REFERENCES runs(id),
     files INTEGER NOT NULL, bytes INTEGER NOT NULL, skipped TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE UNIQUE INDEX publications_version ON publications(project, name, version);
   CREATE TABLE uses (
     id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
     project TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX uses_name ON uses(project, name);`
```

Write the methods under **Produces**; `addPublication` wraps the `SELECT max(version)` and `INSERT` in `BEGIN IMMEDIATE … COMMIT` with `ROLLBACK` on error.

- [ ] **Step 4: Run the store tests**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat(store): migration 8 records published versions and their uses"
```

---

### Task 2: `publish`: a bounded, symlink-free snapshot

**Files:**
- Create: `src/publish.js`
- Modify: `src/supervisor.js` (constructor `publishDir`; tools map; `#publish`)
- Modify: `src/team-tools.js` (`publish` schema)
- Modify: `src/store.js` (`deletePublication`)
- Modify: `bin/agent-team.js` (the `serve` block), `src/client.js` (the in-process supervisor)
- Modify: `adapters/mock-live` (`write` step)
- Create: `test/publish.test.js`
- Modify: `test/helpers/live.js` (`supervise` passes `publishDir`), `test/mcp.test.js` (tool list)
- Modify: `docs/how-it-works.md` (new "Sharing files between teams" section after "Threads between teams")

**Interfaces:**
- Consumes: Task 1; `arbitrateDenyPaths` from `src/workspace.js`; 2a's `#scope`.
- Produces:
  - `src/publish.js`:
    - `export const LIMITS = { files: 1000, bytes: 50 * 1024 * 1024, listed: 100 }`.
    - `export function publishPath(publishDir, project, name, version)` → `join(publishDir, sha256(project).slice(0, 16), name, String(version))`.
    - `export function snapshot({ workspace, path, denyPaths, limits = LIMITS }): { entries: [{ rel, size, mode }], skipped: string[], skippedCount, bytes, kind: 'file' | 'dir', base }` — walks only; throws on any refusal. Copies nothing.
    - `export function writeSnapshot({ workspace, snap, target })` — copies `snap.entries` into `target + '.tmp-<random>'`, sets modes `0444`/`0555`, renames to `target`; removes the temp directory on any error.
  - tool `publish({ name, path })` → `{ team, name, version, files, bytes, skipped }`.
  - `Supervisor` option `publishDir = null`.
  - mock-live step `write: { path, text }` writes `text` to `path` relative to its cwd (creating parent directories).

- [ ] **Step 1: Write the failing walk tests**

Create `test/publish.test.js`. Unit tests on `snapshot`/`writeSnapshot` with temp directories (no supervisor):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, writeSnapshot, publishPath, LIMITS } from '../src/publish.js';

function ws(files) {
  const dir = mkdtempSync(join(tmpdir(), 'at-pub-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('a directory snapshot takes its files and nothing else', () => {
  const w = ws({ 'fix/a.kt': 'a', 'fix/sub/b.kt': 'bb', 'other.txt': 'x' });
  const s = snapshot({ workspace: w, path: 'fix', denyPaths: ['**/.env*'] });
  assert.equal(s.kind, 'dir');
  assert.deepEqual(s.entries.map((e) => e.rel).sort(), ['a.kt', 'sub/b.kt']);
  assert.equal(s.bytes, 3);
});

test('symlinks are never followed, and are reported', () => {
  const w = ws({ 'fix/a.kt': 'a' });
  symlinkSync('/etc', join(w, 'fix', 'etc'));
  symlinkSync(join(w, 'fix', 'a.kt'), join(w, 'fix', 'alias.kt'));
  const s = snapshot({ workspace: w, path: 'fix', denyPaths: ['**/.env*'] });
  assert.deepEqual(s.entries.map((e) => e.rel), ['a.kt']);
  assert.deepEqual(s.skipped.sort(), ['alias.kt', 'etc']);
});

test('a path that leaves the workspace is refused', () => {
  const w = ws({ 'a.txt': 'a' });
  const outside = ws({ 'secret.txt': 's' });
  symlinkSync(outside, join(w, 'link'));
  assert.throws(() => snapshot({ workspace: w, path: '../', denyPaths: ['x'] }), /outside your workspace/);
  assert.throws(() => snapshot({ workspace: w, path: '/etc', denyPaths: ['x'] }), /outside your workspace/);
  assert.throws(() => snapshot({ workspace: w, path: 'link', denyPaths: ['x'] }), /outside your workspace/);
});

test('deny_paths, .git and .agent-team are left out', () => {
  const w = ws({ 'fix/a.kt': 'a', 'fix/.env.local': 'TOKEN', 'fix/keys/id.pem': 'k',
                 'fix/.git/config': 'c', 'fix/.agent-team/used/x': 'u' });
  const s = snapshot({ workspace: w, path: 'fix', denyPaths: ['**/.env*', '**/*.pem'] });
  assert.deepEqual(s.entries.map((e) => e.rel), ['a.kt']);
  assert.deepEqual(s.skipped.sort(), ['.env.local', 'keys/id.pem']);
});

test('over the file or byte bound refuses', () => {
  const w = ws({ 'fix/a': 'aa', 'fix/b': 'bb' });
  assert.throws(() => snapshot({ workspace: w, path: 'fix', denyPaths: ['x'], limits: { ...LIMITS, files: 1 } }), /more than 1 files/);
  assert.throws(() => snapshot({ workspace: w, path: 'fix', denyPaths: ['x'], limits: { ...LIMITS, bytes: 3 } }), /more than 3 bytes/);
});

test('a written snapshot is read-only and lands whole', () => {
  const w = ws({ 'fix/a.kt': 'a', 'fix/sub/b.kt': 'bb' });
  const s = snapshot({ workspace: w, path: 'fix', denyPaths: ['x'] });
  const target = publishPath(mkdtempSync(join(tmpdir(), 'at-pubdir-')), '/b', 'fix', 1);
  writeSnapshot({ workspace: w, snap: s, target });
  assert.equal(readFileSync(join(target, 'sub', 'b.kt'), 'utf8'), 'bb');
  assert.equal(statSync(join(target, 'a.kt')).mode & 0o777, 0o444);
  assert.equal(statSync(join(target, 'sub')).mode & 0o777, 0o555);
  assert.deepEqual(readdirSync(join(target, '..')).filter((n) => n.includes('.tmp-')), []);
});

test('a single file publishes under its basename', () => { /* kind 'file', entries [{ rel: 'a.kt' }] */ });
```

- [ ] **Step 2: Write the failing tool tests**

In the same file, live tests with `supervise(script, { shared: true, publishDir })` (add `publishDir: opts.publishDir ?? mkdtempSync(...)` to `supervise` in `test/helpers/live.js`):

- A member `write`s `fix/rotate.kt`, then `publish({ name: 'rotate-fix', path: 'fix' })` → `{ team: <real root>, name: 'rotate-fix', version: 1, files: 1, bytes: n, skipped: [] }`; a second publish → `version: 2`; the directory `publishPath(publishDir, root, 'rotate-fix', 2)` exists.
- `publish({ name: '../x', path: 'fix' })` → `{ error: /name must match/ }`.
- A member inside a live cross-team scope (2a) publishes for that team: `team` is B's root, and B's `deny_paths` (not A's) are applied (B denies `**/*.secret`; the member writes `fix/a.secret`; it is in `skipped`).
- A refused publish leaves no `publications` row and no directory.
- `supervise` without `publishDir` (pass `publishDir: null`) → `{ error: /publishing needs a publish directory/ }`.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/publish.test.js`
Expected: FAIL — `Cannot find module '../src/publish.js'`.

- [ ] **Step 4: Write `src/publish.js`**

```js
import { lstatSync, realpathSync, readdirSync, mkdirSync, copyFileSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, basename, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { arbitrateDenyPaths } from './workspace.js';

export const LIMITS = { files: 1000, bytes: 50 * 1024 * 1024, listed: 100 };
const ALWAYS_SKIP = new Set(['.git', '.agent-team']);

export function publishPath(publishDir, project, name, version) {
  return join(publishDir, createHash('sha256').update(project).digest('hex').slice(0, 16), name, String(version));
}

const inside = (root, p) => p === root || p.startsWith(root + sep);

export function snapshot({ workspace, path, denyPaths, limits = LIMITS }) {
  const root = realpathSync(workspace);
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error(`publish refused: "${path}" is outside your workspace`);
  let src;
  try { src = realpathSync(resolve(root, path)); } catch { throw new Error(`publish refused: no file or directory "${path}" in your workspace`); }
  if (!inside(root, src) || src === root && path !== '.') throw new Error(`publish refused: "${path}" is outside your workspace`);
  const top = lstatSync(src);
  const found = [];   // { rel, abs, size, mode }
  const skipped = [];
  let bytes = 0;
  const add = (rel, abs, st) => {
    found.push({ rel, abs, size: st.size, mode: st.mode });
    bytes += st.size;
    if (found.length > limits.files) throw new Error(`publish refused: more than ${limits.files} files`);
    if (bytes > limits.bytes) throw new Error(`publish refused: more than ${limits.bytes} bytes`);
  };
  if (top.isFile()) add(basename(src), src, top);
  else if (top.isDirectory()) {
    const walk = (dir, prefix) => {
      for (const name of readdirSync(dir).sort()) {
        if (ALWAYS_SKIP.has(name)) continue;
        const abs = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) skipped.push(rel);
        else if (st.isDirectory()) walk(abs, rel);
        else if (st.isFile()) add(rel, abs, st);
        else skipped.push(rel);   // sockets, fifos, devices
      }
    };
    walk(src, '');
  } else throw new Error(`publish refused: "${path}" is not a file or directory`);
  // The same matcher deniedFiles uses, over the files found (no git needed). Paths are
  // relative to the workspace so patterns anchor the way they do in the repository.
  const wsRel = (e) => relative(root, e.abs).split(sep).join('/');
  const list = Buffer.from(found.map(wsRel).join('\0') + (found.length ? '\0' : ''));
  const { denied } = arbitrateDenyPaths(list, denyPaths, false);
  const deniedSet = new Set(denied);
  const entries = found.filter((e) => !deniedSet.has(wsRel(e)));
  for (const e of found) if (deniedSet.has(wsRel(e))) skipped.push(e.rel);
  return { entries, skipped: skipped.slice(0, limits.listed), skippedCount: skipped.length,
           bytes: entries.reduce((n, e) => n + e.size, 0), kind: top.isFile() ? 'file' : 'dir' };
}
```

Check `arbitrateDenyPaths`'s return shape before relying on `denied` being workspace-relative strings: `grep -n "return {" src/workspace.js | sed -n 1,20p` and read the lines around its `return`; adapt the mapping if it returns another form. `writeSnapshot` creates `target + '.tmp-' + randomBytes(4).toString('hex')`, copies each entry (`copyFileSync(e.abs, …)`, creating parents), chmods files `0444` and then directories `0555` deepest first, and `renameSync`s to `target` (after `mkdirSync(dirname(target), { recursive: true })`); on error it `rmSync`s the temp dir (chmod it writable first) and rethrows.

- [ ] **Step 5: Wire the tool**

In `src/supervisor.js`, add `publishDir = null` to the constructor options and `Object.assign`. Add `publish: (id, p) => this.#publish(id, p)` to the tools map:

```js
  #publish(id, { name, path } = {}) {
    if (!this.publishDir) throw new Error('publishing needs a publish directory (agent-team serve sets one)');
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
      throw new Error('name must match [a-z0-9][a-z0-9._-]{0,63}');
    }
    const m = this.store.member(id);
    if (!m.workspace) throw new Error('publish refused: you have no workspace');
    const { projectRoot, config } = this.#scope(m);
    const snap = snapshot({ workspace: m.workspace, path, denyPaths: config.deny_paths });
    // Content lands in a staging directory first; the row is written only once it has, and the
    // rename into the versioned path is the last step, so a failure leaves neither row nor directory.
    const staging = publishPath(this.publishDir, projectRoot, name, `staging-${randomBytes(4).toString('hex')}`);
    writeSnapshot({ workspace: m.workspace, snap, target: staging });
    let pub;
    try {
      pub = this.store.addPublication({ project: projectRoot, name, memberId: id, runId: m.run_id,
                                        files: snap.entries.length, bytes: snap.bytes, skipped: snap.skipped });
      renameSync(staging, publishPath(this.publishDir, projectRoot, name, pub.version));
    } catch (e) {
      if (pub) this.store.deletePublication(pub.id);
      removeTree(staging);   // from src/publish.js: chmod writable, then rmSync
      throw e;
    }
    // Task 3 adds the newer-version notice here.
    return { team: projectRoot, name, version: pub.version, files: snap.entries.length,
             bytes: snap.bytes, skipped: snap.skipped };
  }
```

Add `deletePublication(id)` to the store and export `removeTree(dir)` from `src/publish.js` (it makes the tree writable, then `rmSync(dir, { recursive: true, force: true })`; `writeSnapshot` uses it too).

`bin/agent-team.js` `serve` and `src/client.js` pass `publishDir: join(dirname(defaultStorePath()), 'published')` (import `dirname`/`join` where missing).

Add to `TOOL_SCHEMAS`:

```js
  {
    name: 'publish',
    description: 'Snapshot a file or directory from your workspace as a new read-only version that other teams can use(). Symlinks and files your team\'s deny_paths cover are left out. Returns the version number.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'path'] },
    annotations: RO
  },
```

In `adapters/mock-live`, in the step loop before `step.tool`:

```js
      if (step.write) {
        mkdirSync(dirname(join(process.cwd(), step.write.path)), { recursive: true });
        writeFileSync(join(process.cwd(), step.write.path), step.write.text ?? '');
      }
```

(adding the imports). Update `test/mcp.test.js`'s list with `'publish'`.

- [ ] **Step 6: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/publish.test.js test/mcp.test.js test/store.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 7: Document `publish`**

In `docs/how-it-works.md`, after "Threads between teams":

```markdown
## Sharing files between teams

`publish(name, path)` snapshots a file or directory from the member's workspace as a new
version of `name` for its team: 1, 2, 3, and so on. Snapshots are read-only copies kept in a
`published/` directory beside the supervisor's store. Symlinks are never followed, files the
team's `deny_paths` cover are left out (the result lists what was skipped), and a snapshot is
refused past 1,000 files or 50 MiB.
```

- [ ] **Step 8: Commit**

```bash
git add src/publish.js src/supervisor.js src/team-tools.js src/store.js bin/agent-team.js src/client.js adapters/mock-live test/publish.test.js test/helpers/live.js test/mcp.test.js docs/how-it-works.md
git commit -m "feat(publish): snapshot workspace files as read-only team versions"
```

---

### Task 3: `use`, and telling users about a newer version

**Files:**
- Modify: `src/publish.js` (`copyOut`)
- Modify: `src/supervisor.js` (tools map; `#use`; notice in `#publish`)
- Modify: `src/team-tools.js` (`use` schema; `TEAM_NOTE`)
- Modify: `test/publish.test.js`, `test/mcp.test.js`
- Modify: `docs/how-it-works.md` ("Sharing files between teams")

**Interfaces:**
- Consumes: Tasks 1–2; 2a's `resolveTeam`.
- Produces:
  - `copyOut({ from, to }): { already: boolean }` — copies a published version into `to` with modes `0644`/`0755`; if `to` exists, copies nothing and returns `{ already: true }`; writes to `to + '.tmp-<random>'` and renames.
  - tool `use({ team, name, version? })` → `{ path, version, files, already? }`; `path` is relative to the caller's workspace.
  - Notice to stale users: inbox message `newer version: <team basename>/<name>@<n> (you use @<m>)`, `from_kind: 'team'`, `from_name: '<team basename>'`.

- [ ] **Step 1: Write the failing tests**

In `test/publish.test.js`:

- *use the latest*: team B's member publishes `rotate-fix` twice (writing different content); team A's member calls `use({ team: bRoot, name: 'rotate-fix' })` → `{ path: '.agent-team/used/<b basename>/rotate-fix@2', version: 2, files: 1 }`; the file exists in A's workspace with v2's content and mode `0644`.
- *use a version*: `version: 1` → `rotate-fix@1` with v1's content.
- *never overwrites*: A edits its copy, calls `use` again → `{ already: true }` and the edit is still there.
- *unknown name or version*: `{ error: /team ".*" has not published "nope"/ }`, `{ error: /has no version 9 of "rotate-fix"/ }`.
- *unknown team*: `{ error: /not found: no agent-team config/ }` (from `resolveTeam`).
- *git exclude*: A's member with `isolation: 'workspace'` uses a version; `.git/info/exclude` in its workspace contains `.agent-team/`, and the member's result `diff_stat` does not mention it.
- *newer version notice*: A's member uses v1, then `wait_for`s; B's member publishes v2; A's `wait_for` returns `newer version: <b>/rotate-fix@2 (you use @1)`. A finished member that used v1 gets nothing.
- *read-only member*: a member with `isolation: 'none'` and the plan-mode flag `read_only: true` (as 1b sets it) can still `use`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/publish.test.js`
Expected: FAIL — `unknown tool "use"`.

- [ ] **Step 3: Write `copyOut` and `#use`**

```js
  #use(id, { team, name, version } = {}) {
    if (!this.publishDir) throw new Error('publishing needs a publish directory (agent-team serve sets one)');
    const m = this.store.member(id);
    if (!m.workspace) throw new Error('use refused: you have no workspace');
    const { projectRoot, config } = this.#scope(m);
    const t = resolveTeam({ store: this.store, projectRoot, config, team });
    const v = version == null ? null : Number(version);
    if (v != null && !(Number.isInteger(v) && v > 0)) throw new Error('"version" must be a positive integer');
    const pub = this.store.publication(t.root, name, v);
    if (!pub) {
      throw new Error(v == null ? `team "${team}" has not published "${name}"` : `team "${team}" has no version ${v} of "${name}"`);
    }
    const rel = join('.agent-team', 'used', t.name, `${name}@${pub.version}`);
    const { already } = copyOut({ from: publishPath(this.publishDir, t.root, name, pub.version), to: join(m.workspace, rel) });
    excludeUsed(m.workspace);   // appends ".agent-team/" to .git/info/exclude once, if a git checkout
    this.store.addUse({ memberId: id, project: t.root, name, version: pub.version });
    return { path: rel, version: pub.version, files: pub.files, ...(already ? { already: true } : {}) };
  }
```

`excludeUsed` lives in `src/publish.js`: if `join(ws, '.git')` is a directory, read `info/exclude` (missing is empty) and append `.agent-team/\n` when no line equals it. A workspace whose `.git` is a file (a worktree) gets the same treatment through `git rev-parse --git-path info/exclude` — check how `src/workspace.js` builds workspaces first (`grep -n "worktree\|clone" src/workspace.js | head`); 1a's workspaces are clones, so the directory case is the one that occurs.

In `#publish`, after the row is written:

```js
    for (const u of this.store.staleUses(projectRoot, name, version)) {
      this.store.enqueue({ to: u.member_id, fromKind: 'team', fromName: basename(projectRoot),
                           text: `newer version: ${basename(projectRoot)}/${name}@${version} (you use @${u.version})` });
      this.#pump(u.member_id);
    }
```

Add the `use` schema:

```js
  {
    name: 'use',
    description: 'Copy a version another team published into your workspace, under .agent-team/used/. Defaults to the latest version; never overwrites a copy you already have. You hear about newer versions through wait_for.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, name: { type: 'string' }, version: { type: 'integer' } }, required: ['team', 'name'] },
    annotations: RO
  }
```

Extend `TEAM_NOTE`: "Use publish to share files with other teams, and use to pick up what they shared." Update `test/mcp.test.js`'s list to end `'publish', 'use'`.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/publish.test.js test/mcp.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 5: Document `use`**

Extend "Sharing files between teams":

```markdown
`use(team, name, version?)` copies a published version (the latest unless one is named) into
the caller's workspace at `.agent-team/used/<team>/<name>@<version>/` and returns that path.
It never overwrites: if that version is already there, it says so and leaves the copy alone.
`.agent-team/` is excluded from the workspace's git status. When a newer version is published,
every running member that uses an older one hears about it through `wait_for`.
```

- [ ] **Step 6: Commit**

```bash
git add src/publish.js src/supervisor.js src/team-tools.js test/publish.test.js test/mcp.test.js docs/how-it-works.md
git commit -m "feat(publish): use copies a team's version and announces newer ones"
```

---

### Task 4: The two-team demo

**Files:**
- Create: `scripts/demo-threads.mjs`
- Create: `test/demo.test.js`
- Modify: `README.md` (a "Try the two-team demo" paragraph where the README describes the web view; `grep -n "serve" README.md` to place it)

**Interfaces:**
- Consumes: everything in 2a–2c; `startHttp` from `src/http.js` (returns `{ port, url, close, clients }`); `Supervisor`, `openStore`.
- Produces: `node scripts/demo-threads.mjs` prints `agent-team demo: <url>` on stdout, then one line per thread state change, then `agent-team demo: done — thread #1 <state>; press Ctrl-C to exit` and keeps serving until SIGINT/SIGTERM (`AGENT_TEAM_DEMO_EXIT=1` makes it exit as soon as the thread closes, for the test). Environment:
  - `AGENT_TEAM_DEMO_PORT` (default `0`, a random free port; never 4747 by default).
  - `AGENT_TEAM_DEMO_STEP_MS` (default `1500`; the pause mock members take between steps, so a human can watch; the test sets `50`).

- [ ] **Step 1: Write the failing test**

Create `test/demo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('the two-team demo runs a thread from request to done and serves it', async () => {
  const child = spawn(process.execPath, ['scripts/demo-threads.mjs'], {
    env: { ...process.env, AGENT_TEAM_DEMO_PORT: '0', AGENT_TEAM_DEMO_STEP_MS: '50', AGENT_TEAM_DEMO_EXIT: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  let err = '';
  child.stderr.on('data', (b) => { err += b; });
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no url: ${out}${err}`)), 20_000);
    child.stdout.on('data', () => {
      const m = /agent-team demo: (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(out);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
  });
  assert.notEqual(new URL(url).port, '4747');
  // Poll the API while the demo runs (it exits once the thread closes).
  let threads;
  for (let i = 0; i < 200; i++) {
    try { threads = await (await fetch(new URL('api/threads', url))).json(); } catch { break; }
    if (threads.pairs?.[0]?.threads[0]?.state === 'done') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, err);
  assert.equal(threads.pairs[0].pair, 'android → loupe');
  assert.equal(threads.pairs[0].threads[0].state, 'done');
  assert.match(out, /thread #1 accepted/);
  assert.match(out, /thread #1 done ok/);
  assert.match(out, /android picked up loupe\/rotate-fix@1/);
});
```

The guard (`test/helpers/guard.js`) is preloaded in the test process; the demo is a child process and only ever spawns `mock-live`, which the script enforces by passing an `adapterDir` that contains nothing but `mock-live` (Step 3).

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import ./test/helpers/guard.js --test test/demo.test.js`
Expected: FAIL — `Cannot find module …/scripts/demo-threads.mjs`.

- [ ] **Step 3: Write the demo**

`scripts/demo-threads.mjs`:

1. Isolation first, before importing anything that reads the environment: a temp root from `mkdtempSync(join(tmpdir(), 'at-demo-'))`; set `XDG_CACHE_HOME`, `AGENT_TEAM_WORKSPACE_ROOT` under it; the socket under a short `mkdtempSync(join(tmpdir(), 'at-s-'))` path (macOS caps socket paths at 104 bytes); the store at `<root>/supervisor.db`; `publishDir` at `<root>/published`. Never call `defaultStorePath()`.
2. An adapter directory under the temp root holding one symlink, `mock-live` → the repo's `adapters/mock-live`, so no other harness can be launched.
3. Two git repos under the temp root, `android` and `loupe`, built as `test/helpers/live.js`'s `project()` builds them (copy the few lines; scripts do not import test helpers). Configs: `android` has `{ manager: mock-live }` and `peers: ['../loupe']`; `loupe` has `{ lead: mock-live, dev: mock-live reports_to lead }`. All members `isolation: 'none'`.
4. One mock-live script (`by_member`), with `sleep_ms: STEP` between steps:
   - `manager`: `say 'rotating the screen crashes loupe'`; `team_status({ team: 'loupe' })`; `request({ team: 'loupe', text: 'Rotating the device crashes the loupe stream.', task: 'Fix the rotate crash and publish the fix as rotate-fix.' })` save `t`; `report_progress({ text: 'asked loupe; carrying on with the settings screen' })`; `say 'working on settings'` (it keeps working); `wait_for` with `until_threads: ['$t.thread_id']`; `use({ team: 'loupe', name: 'rotate-fix' })` save `u`; result `{ status: 'ok', summary: 'settings done; picked up the rotate fix' }`.
   - `lead`: `reply({ thread: '$brief.thread.id', text: 'Taking it.', state: 'accepted' })`; `delegate({ to: 'dev', task: 'fix the rotate crash' })` save `d`; `wait_for({})` with `until_finished: ['$d.report_id']`; `write { path: 'fix/RotateFix.kt', text: '// keep the surface on rotate\n' }`; `publish({ name: 'rotate-fix', path: 'fix' })`; result `{ status: 'ok', summary: 'rotate crash fixed; published rotate-fix@1' }`.
   - `dev`: `say 'patched the surface lifecycle'`.
   The `mock-live` step `sleep_ms` already exists; prepend `{ sleep_ms: STEP }` to each step list where pacing helps.
5. `openStore(dbPath)`, `new Supervisor({ store, adapterDir, socketPath, env: { AGENT_TEAM_MOCK_SCRIPT: scriptPath }, shared: true, publishDir })`, `await sup.start()`, then `const web = await startHttp({ store, sup, port: Number(process.env.AGENT_TEAM_DEMO_PORT ?? 0) })`; print `agent-team demo: ${web.url}`.
6. `sup.submit({ projectRoot: androidRoot, member: 'manager', task: 'Ship the settings screen.' })`.
7. Poll `store.threads({})` every 100 ms and print each new state as `thread #<id> <state>` (`done` prints `thread #1 done <result.status>`); when android's run finishes, read the manager's `use` tool result from its events and print `android picked up loupe/rotate-fix@<version>`; then print the done line. With `AGENT_TEAM_DEMO_EXIT=1`, close `web`, `sup`, and the store and exit 0; otherwise wait for SIGINT/SIGTERM, then close and `rmSync` the temp root.
8. Any error: print it to stderr, close what was opened, exit 1.

Every line printed passes through `plain` from `src/watch.js`.

- [ ] **Step 4: Run the test, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/demo.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 5: Look at it in the browser**

Run: `AGENT_TEAM_DEMO_PORT=0 node scripts/demo-threads.mjs` and open the printed URL. Expected: the Threads page lists `android → loupe` with thread #1 moving `open → accepted → done`; its posts show `Taking it.` and the close; the links open android's run (manager, waiting then done) and loupe's run (lead and dev). Stop it with Ctrl-C. Do not set the port to 4747.

- [ ] **Step 6: Document the demo**

In `README.md`, beside the web view's description:

```markdown
To see two teams work together without any real agent, run
`node scripts/demo-threads.mjs`. It builds two throwaway repositories, `android` and `loupe`,
in a temp directory with scripted members, starts a private supervisor and web view on a free
port, and prints the address. The Android team asks loupe's team to fix a crash, keeps
working, and picks up the published fix when the thread closes. Set `AGENT_TEAM_DEMO_PORT` to
choose the port.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/demo-threads.mjs test/demo.test.js README.md
git commit -m "feat(demo): a scripted two-team thread, served on a free port"
```

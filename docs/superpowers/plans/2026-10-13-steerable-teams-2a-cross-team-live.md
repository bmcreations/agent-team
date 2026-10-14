# Steerable teams 2a: live cross-team delegation, known teams, and `team_status` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `agent-team serve`, a `team:` member that points at another local repo becomes a live part of the delegating run: that repo's entry member starts as a report, its tree shows in the web view and can be steered, and it works under that repo's `deny_paths`, `max_depth`, and `max_delegations` (capped by the run's). Members can ask `team_status(team)` about any team the supervisor knows: its projects plus the `peers` a config lists.

**Architecture:** A run stops having one config. Each member belongs to a *scope*: the project of its nearest ancestor (itself included) that was entered through a `team:` member, else the run's project. Migration 6 stores that project on the entry member's row (`members.project`), the name the manager knows it by (`members.alias`), and the entry's own delegation counter (`members.scope_budget`). One private helper, `Supervisor#scope(m)`, returns `{ projectRoot, config, entries, teams }` for any member, and every place that read `this.#runs.get(runId).config` reads the scope instead. In-process supervisors (a CLI with no `serve`) keep today's one-shot `runTeam`. Known teams and `team_status` live in a new `src/teams.js`; `team_status` reads the store only, through an allowlist in `src/view.js` that the web view reuses.

**Tech Stack:** Node >= 22.13, ES modules, `node:sqlite`, `node:http`, `node --test`. No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-10-12-steerable-teams-design.md`: "One supervisor across projects, and live cross-team delegation" (lines 232–248), the `team_status` row and the "Known teams" paragraph of "Peer teams talk in threads" (lines 273–302), and the loupe/Android half of "The demo this spec ends at" (lines 32–43), which plans 2b and 2c finish. Earlier plans: `docs/superpowers/plans/2026-10-13-steerable-teams-1c-web-view.md` ("Live cross-team delegation is not in 1c … moves it to the plan after 1c").

**Size:** 5 tasks. Plans 2b (threads) and 2c (`publish`/`use`, and the demo) build on this one and assume it has landed.

## Global Constraints

These hold for plans 2a, 2b and 2c alike; each plan repeats them.

- Stdlib only: the plugin has no install step. `package.json` `engines.node` stays `>=22.13`. The store is `node:sqlite`. Every store change is a new entry in `MIGRATIONS` in `src/store.js`, applied through `PRAGMA user_version`. The database is at version 5 today; **2a adds migration 6, 2b migration 7, 2c migration 8.** (The brief suggested threads as migration 6; live cross-team delegation needs member columns first, so the numbers follow the plan order.) Every migration task also updates the rewind tests in `test/store.test.js` so they drop the new columns and tables before setting an older `user_version`.
- Every new member tool (`team_status`, `request`, `reply`, `publish`, `use`) is in `TOOL_SCHEMAS` with `annotations: RO` (`readOnlyHint: true`), so plan-mode (read-only) members can call it. None of them lets the *member* write its workspace; where a tool writes (`use`), the supervisor does it.
- Threads and live cross-team delegation need `agent-team serve`. A `Supervisor` gets `shared: true` only in `serve`; in-process supervisors (a CLI with no `serve`) keep `team:` members one-shot (`runTeam`) and refuse `request` with "threads need `agent-team serve`". In-process runs stay read-only in the web view (1c's ruling, unchanged).
- A thread-run is a separate run owned by the receiving team, under the receiving team's config, `max_delegations`, `max_cost_usd`, and `deny_paths`. GitHub-named (cloud) teams stay one-shot: they are never live members and cannot be sent threads.
- Tests never reach real `claude` or `codex`: `test/helpers/guard.js` is preloaded (`npm test`, and every `Run:` line below). Members in tests use the `mock-live` adapter through `test/helpers/live.js` (`project`, `supervise`, `LIVE`). Tests never touch the user's real store: they use `:memory:` or temp stores, temp `XDG_CACHE_HOME`, and temp sockets. No test or script binds port 4747; HTTP tests use port `0`.
- The page stays `textContent`-only under the strict CSP; `src/web/` never uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` (`test/web.test.js` scans for them). Text that reaches a terminal goes through `plain` from `src/watch.js`. Every field sent to a client goes through an allowlist in `src/view.js`; new columns stay private until listed there.
- Commits are conventional commits with no attribution trailers. No figma.com URLs anywhere.
- Baseline: `npm test` reports 647 tests, 645 pass, 2 skipped, 0 fail at a21c42e.

**Rulings on the seven open questions (binding for 2a–2c):**

1. **Loop guard is on the chain of requests.** A thread row stores `parent_thread` (the thread whose run the requester belongs to, or null) and `chain`, a JSON array of team keys (`teamKeys(root)`: real path, plus the GitHub key when the repo has one) in the order the teams joined. A run started by a thread carries it in `runs.thread_id`. A new request's chain is: the parent thread's chain if the requester's run has a `thread_id`, else the run project's keys; then the keys of every live cross-team scope between the requester and its run's root (2a's `#scope(m).teams`). The request is refused with `request refused: team "<t>" is already in this chain (A -> B -> A)` if any of the target's keys is in that chain. A team never requests itself.
2. **`publish`/`use`.** Snapshots go to `join(dirname(storePath), 'published', <sha256(project) first 16 hex>, <name>, <version>)`, never into the database (the DB holds one metadata row per version). The walk uses `lstat`: symlinks are never followed and are listed in `skipped`; the source's `realpath` must be inside the member's workspace `realpath`; the publisher's scope `deny_paths` are applied with `arbitrateDenyPaths` from `src/workspace.js` and matching files are skipped and listed; at most 1,000 files and 50 MiB total (over either bound refuses and writes nothing). Content is written to a temp directory beside the target and renamed into place; files are made `0444`, directories `0555`. Versions are integers per `(project, name)`, starting at 1, assigned inside `BEGIN IMMEDIATE`. `use` copies to `<workspace>/.agent-team/used/<team>/<name>@<version>/` and never overwrites: if that path exists it returns `{ path, version, already: true }` and copies nothing.
3. **`team_status` returns no transcripts.** Its shape is built only by `teamStatus` in `src/view.js` from three allowlists: `TEAM_FIELDS` (`name`, `root`, `source`), `TEAM_RUN_FIELDS` (`id`, `status`, `task` clipped to 200 characters, `created_at`, `cost_usd`), and `TEAM_MEMBER_FIELDS` (`id`, `run_id`, `parent_id`, `name`, `alias`, `agent`, `state`, `depth`, `updated_at`), plus each member's latest checkpoint `{ text, at }` (its newest `progress` event, text clipped to 500 characters). Events, messages, results, workspaces, and tokens are never included. `GET /api/teams/status?root=` returns the same object.
4. **`peers`.** An optional top-level array in `.claude/agent-team.json` of at most 50 non-empty strings, validated by shape only when the config loads (a peer that does not exist yet must not break the config). A peer is resolved like a `team:` path (`teamRoot` in `src/dispatch.js`: `~` and `~/…` expand to the home directory, a relative path is relative to the project root with the main-checkout fallback for linked worktrees, an absolute path is used as is). A peer is valid when it is a directory containing `.claude/agent-team.json` that `loadConfig` accepts. URL-like or GitHub peers are refused at load. At request time a missing or broken peer fails the tool call with `team "<arg>" not found: no agent-team config at <abs>/.claude/agent-team.json`; `team_status()` with no argument lists it with `missing: true`.
5. **Human side of threads (RULING NEEDED FROM USER on the scope).** The spec names no thread CLI verbs. 2b adds the minimum: `agent-team threads [--project <dir>] [--json]` (lists threads, newest first, grouped by team pair) and `agent-team reply <thread> <text>` (a human post on the thread, signed `whoAmI()`, no state change). The web view gets one `#/threads` page grouping threads by team pair, each thread showing its posts and linking its runs, with the same human reply box. Whether humans may also accept or decline a thread on a team's behalf is left open: 2b does **not** implement it.
6. **Starting the receiving lead.** A thread goes to the receiving team's entry member (its only root; a team with several roots is refused with the `teamEntry` error). If that member is live in this supervisor at scope depth 0 in that project (a run root or a live cross-team entry), the thread is delivered to its inbox and it owns the thread. Otherwise `serve` starts a new run in the receiving project (its config, `max_delegations`, `max_cost_usd`, owner `serve`'s socket, `runs.thread_id` set) with the entry member as root and a brief that carries the thread. In that run `delegate` is refused until the thread is `accepted`. A run that finishes while its thread is still `open` declines it ("the lead finished without accepting"); one that finishes after accepting closes it `done` with `{ status, summary }`. A live lead in another run that accepts a task thread gets the same new run started for it. `recover()` restarts triage for open threads whose owner is gone.
7. **Budgets.** A thread-run spends only the receiving team's budgets: its run's `max_delegations` and `max_cost_usd` come from the receiving config, and its cost is charged to its own run. The requester's cost cap is not charged. `request` itself spends one of the requester's `max_delegations` (and every enclosing scope counter), as `delegate` does, so a member cannot open threads without bound.

## Rulings this plan makes

- **The entry member's row keeps the other team's member name.** `config.members[m.name]` must resolve in the scope's config, so the row is named after the entry member (`lead`), and the name the manager delegated to (`loupe`) goes in `members.alias`. `send_to` and the tree accept either. Two projects can both have a `lead`; they are different rows with different `project`.
- **Depth restarts at the entry member.** `members.depth` is depth within the scope: the entry member is 0, as `runTeam` passes `depth: 0` today, so the other repo's `max_depth` bounds the tree below it. The view draws the tree from `parent_id`, not `depth`.
- **One counter per entered team, persisted.** A delegation inside a scope checks and decrements the run's counter and the `scope_budget` of every enclosing entry member. The entry's counter starts at the team's own `max_delegations`. This is `runTeam`'s `Math.min(budget.runs, config.defaults.max_delegations)` with the spending made explicit, and it survives a restart because it is a column.
- **Recovery fails a run whose entered team no longer loads**, with `#failRun`'s wording, as it does today when the run's own config no longer loads.
- **`team_status(team)` with no argument lists the known teams.** The spec gives only `team_status(team)`; a member needs some way to learn names. With `team` omitted it returns `{ teams: [{ name, root, source, missing? }] }`.
- **Live session members stay home.** `#ctx` keeps `originRoot: run.projectRoot`, so `prepareSession` still refuses a `claude-session` member reached from another project.

## Review Focus

1. **A member reaching a file another repo denies.** The entry member's workspace must be built from the other repo with the other repo's `deny_paths`, and every report under it too. Pinned in Task 2 (brief and workspace use the scope config) and Task 3 (`deny_paths` shown per project).
2. **Budgets that leak across the boundary.** A team's tree must stop at its own `max_delegations` while also spending the run's, and a restart must not refill either. Pinned in Task 2 (nested budgets, recovery).
3. **A cycle through live teams.** A delegating to B delegating back to A must be refused, with the same wording `runTeam` uses. Pinned in Task 2.
4. **Allowlists.** `team_status` and the page must not show transcripts, workspaces, or tokens of another team. Pinned in Task 5 (a test that seeds secrets in every excluded column and checks they are absent).

## Files

| File | Task | Responsibility |
|---|---|---|
| `src/store.js` | 1 | Migration 6 (`members.project`, `alias`, `scope_budget`); `addMember` takes them; `setScopeBudget`; `projects`; `liveMembersIn` |
| `src/supervisor.js` | 2, 3, 5 | `shared` option; `#scope`; scope-aware `#ctx`, `#resolve`, `#launch`, `#drain`, `#tick`, `#delegate`, `#sendTo`, `recover`; `team_status` tool |
| `src/dispatch.js` | 2, 4 | Export `teamRoot`, `teamEntry`, `refuseCycle` |
| `bin/agent-team.js` | 3 | `serve` passes `shared: true` |
| `src/view.js` | 3, 5 | `project`, `alias` in `MEMBER_FIELDS`; per-project `deny_paths` in `runDetail`; `teamStatus` and its allowlists |
| `src/http.js` | 5 | `GET /api/teams`, `GET /api/teams/status` |
| `src/web/app.js` | 3 | Team tag and per-project reach in the tree and member panel |
| `src/config.js` | 4 | `peers` |
| `src/teams.js` | 4, 5 | `resolveTeam`, `knownTeams` |
| `src/team-tools.js` | 5 | `team_status` schema; `TEAM_NOTE` |
| `test/store.test.js`, `test/cross-team.test.js`, `test/teams.test.js`, `test/config.test.js`, `test/http.test.js`, `test/mcp.test.js`, `test/web.test.js` | 1–5 | Tests |
| `docs/how-it-works.md`, `docs/configuration.md` | 2–5 | Each task documents what it changes |

---

### Task 1: Migration 6 and the store's scope columns

**Files:**
- Modify: `src/store.js` (`MIGRATIONS`, `addMember`, new methods after `setResult`)
- Modify: `test/store.test.js` (both rewind tests: the "version 3 database" test and the "version 4 database" test; new tests at the end)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - store: `addMember({ runId, parentId, name, task, depth, project = null, alias = null, scopeBudget = null })`; `setScopeBudget(id, n)`; `projects(): string[]` (every distinct `runs.project` and non-null `members.project`, sorted); `liveMembersIn(project): MemberRow[]` (members whose scope project is `project` — `members.project = project`, or `project IS NULL` and their run's project is `project` — in runs with status `running`, ordered by id).

- [ ] **Step 1: Make the rewind tests drop migration 6's columns, and write the store tests**

Both existing rewind tests set an older `user_version` and reopen; reapplying migration 6 then fails with "duplicate column name" unless the columns are dropped first. In `test/store.test.js`, in the "version 3 database" test, prepend to the `raw.exec(...)` string:

```js
'ALTER TABLE members DROP COLUMN project; ALTER TABLE members DROP COLUMN alias; ' +
'ALTER TABLE members DROP COLUMN scope_budget; ' +
```

and do the same in the "version 4 database gains agent, model and read_only" test. Then append:

```js
test('a version 5 database gains project, alias and scope_budget, unset', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig6-')), 's.db');
  const first = openStore(path);
  const runId = first.createRun({ project: '/a', task: 't' });
  const lead = first.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec('ALTER TABLE members DROP COLUMN project; ALTER TABLE members DROP COLUMN alias; ' +
           'ALTER TABLE members DROP COLUMN scope_budget; PRAGMA user_version = 5');
  raw.close();
  const store = openStore(path);
  const m = store.member(lead.id);
  assert.deepEqual([m.project, m.alias, m.scope_budget], [null, null, null]);
  store.close();
});

test('an entry member records its project, alias and budget; projects and liveMembersIn see it', () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/a', task: 't' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  const entry = store.addMember({ runId, parentId: lead.id, name: 'lead', task: 'fix', depth: 0,
                                  project: '/b', alias: 'loupe', scopeBudget: 3 });
  const below = store.addMember({ runId, parentId: entry.id, name: 'dev', task: 'x', depth: 1 });
  store.setScopeBudget(entry.id, 2);
  const e = store.member(entry.id);
  assert.deepEqual([e.project, e.alias, e.scope_budget], ['/b', 'loupe', 2]);
  assert.deepEqual(store.projects(), ['/a', '/b']);
  // `dev` has no project of its own: liveMembersIn('/b') matches members by their own column
  // only, so a scope's descendants are found by walking parent_id (the supervisor does that).
  assert.deepEqual(store.liveMembersIn('/b').map((m) => m.id), [entry.id]);
  assert.deepEqual(store.liveMembersIn('/a').map((m) => m.id), [lead.id, below.id]);
  store.finishRun(runId, 'done');
  assert.deepEqual(store.liveMembersIn('/a'), []);
  store.close();
});
```

Note the second assertion on `/a`: `below` has `project IS NULL` and its run's project is `/a`, so the plain-SQL rule lists it under `/a` even though its scope is `/b`. That is why `liveMembersIn` is documented as a candidate list: Task 5 filters it through `Supervisor#scope`-equivalent logic in `src/teams.js` (`scopeProject`).

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js`
Expected: FAIL — `no such column: project` (or the new methods are not functions).

- [ ] **Step 3: Add migration 6 and the methods**

Append to `MIGRATIONS`:

```js
  // Live cross-team delegation: the project a member was entered into (null: its run's),
  // the name its manager delegated to, and the entered team's own delegation counter.
  `ALTER TABLE members ADD COLUMN project TEXT;
   ALTER TABLE members ADD COLUMN alias TEXT;
   ALTER TABLE members ADD COLUMN scope_budget INTEGER;`
```

Change `addMember` to accept `project = null, alias = null, scopeBudget = null` and insert them (extend the column list and the `VALUES` placeholders; keep returning `{ id, token }`).

Add after `setResult`:

```js
    setScopeBudget: (id, n) => q('UPDATE members SET scope_budget = ? WHERE id = ?').run(n, id),
    projects: () => q('SELECT project FROM runs UNION SELECT project FROM members WHERE project IS NOT NULL ORDER BY 1')
      .all().map((r) => r.project),
    liveMembersIn: (project) => q(
      "SELECT m.* FROM members m JOIN runs r ON r.id = m.run_id WHERE r.status = 'running' " +
      'AND (m.project = ?1 OR (m.project IS NULL AND r.project = ?1)) ORDER BY m.id'
    ).all(project).map(memberRow),
```

- [ ] **Step 4: Run the store tests**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat(store): migration 6 records a member's team scope"
```

---

### Task 2: Scopes in the supervisor, and live `team:` members under `serve`

**Files:**
- Modify: `src/dispatch.js` (`teamRoot`, `teamEntry`, `refuseCycle` become exports; no behaviour change)
- Modify: `src/supervisor.js` (constructor, `#runs` entries, new `#scope` and `#teamConfig`, `#ctx`, `#resolve`, `#launch`, `#drain`, `#tick`, `#delegate`, `#sendTo`, `recover`)
- Create: `test/cross-team.test.js`
- Modify: `docs/how-it-works.md` ("Other teams" under "Delegation")

**Interfaces:**
- Consumes: store `addMember({ project, alias, scopeBudget })`, `setScopeBudget` (Task 1); `teamKeys`, `parseGithubRepo` (from `src/cloud.js`), `loadConfig`, `CONFIG_RELPATH`.
- Produces:
  - `src/dispatch.js`: `export function teamRoot(projectRoot, team)`, `export function teamEntry(teamConfig, entry, root, member)`, `export function refuseCycle(member, team, keys, teams)`.
  - `Supervisor` constructor option `shared = false`.
  - `#scope(m): { projectRoot, config, entries: MemberRow[], teams: string[] }` — `entries` are the entry members enclosing `m`, innermost first (empty in the run's own project); `teams` is every team key on the path from the run's project to `m`'s scope, outermost first.
  - `delegate` to a local `team:` report under `shared` returns `{ report_id, team: { root, member } }`.

- [ ] **Step 1: Write the failing tests**

Create `test/cross-team.test.js`. Two projects from `project()`, one script for both (member names are distinct across the two teams so `by_member` can tell them apart):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { project, supervise, LIVE } from './helpers/live.js';

// Team B (the "loupe" repo): a lead with one report. Team A: a manager whose report "loupe"
// is team B.
function teams({ aDefaults = {}, bDefaults = {}, script }) {
  const b = project({ 'b-lead': LIVE(), 'b-dev': LIVE({ reports_to: 'b-lead' }) }, {}, bDefaults);
  const a = project({ manager: LIVE(), loupe: { team: b.root, reports_to: 'manager' } }, script, aDefaults);
  writeFileSync(b.script, JSON.stringify(script));
  return { a, b };
}

test('under serve, delegating to a team member starts that repo\'s entry member as a live report', async () => {
  const script = { by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'loupe', task: 'fix the crash' }, save: 'd' },
      { tool: 'wait_for', args: { report_ids: ['$d.report_id'] }, until_finished: ['$d.report_id'] }
    ] },
    'b-lead': { steps: [
      { tool: 'delegate', args: { to: 'b-dev', task: 'patch it' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ], result: { status: 'ok', summary: 'fixed in loupe' } },
    'b-dev': { steps: [{ say: 'patched' }] }
  } };
  const { a, b } = teams({ script });
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const rows = store.members(runId);
    const entry = rows.find((m) => m.name === 'b-lead');
    assert.equal(entry.project, realpathSync(b.root));
    assert.equal(entry.alias, 'loupe');
    assert.equal(entry.depth, 0);
    assert.equal(entry.agent, 'mock-live');            // a live member, not a one-shot "team"
    const dev = rows.find((m) => m.name === 'b-dev');
    assert.equal(dev.parent_id, entry.id);
    assert.equal(dev.depth, 1);
    assert.match(store.events(rows[0].id).filter((e) => e.kind === 'tool_result')[1].body.result.messages.at(-1).text,
                 /finished ok: fixed in loupe/);
  } finally { await sup.close(); store.close(); }
});

test('without serve, a team member stays one-shot', async () => {
  const script = { by_member: { manager: { steps: [
    { tool: 'delegate', args: { to: 'loupe', task: 'fix' }, save: 'd' },
    { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
  ] }, 'b-lead': { steps: [] } } };
  const { a } = teams({ script });
  const { sup, store } = await supervise(a.script);   // shared defaults to false
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const rows = store.members(runId);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].name, 'loupe');
    assert.equal(rows[1].agent, 'team');
  } finally { await sup.close(); store.close(); }
});

test('the entered team builds workspaces and briefs from its own deny_paths and max_depth', async () => { /* ... */ });
test('a team stops at its own max_delegations and spends the run\'s too', async () => { /* ... */ });
test('a team that leads back to a team already in the run is refused', async () => { /* ... */ });
test('the manager can message the entry member by its alias, and the entry member its manager', async () => { /* ... */ });
test('a restart recovers a run with an entered team, budgets and all', async () => { /* ... */ });
test('a run whose entered team no longer loads fails on recovery', async () => { /* ... */ });
```

Fill in the six stubs, each with a scripted `by_member` and assertions on the store, as follows:

- *deny_paths and max_depth*: B's config has `deny_paths: ['secret/**']` (write it with `writeFileSync` after `project()`, then `git add`/`commit` in B) and `defaults.max_depth: 0`; give `b-lead` `isolation: 'workspace'` via the member spec. Assert `b-lead`'s `start` brief (the mock records nothing of the brief, so read the `members.workspace` directory instead) does not contain `secret/`, and that `b-lead`'s `delegate` to `b-dev` comes back `{ error: /already at max_depth 0/ }` in its `tool_result` event.
- *budgets*: A `defaults.max_delegations: 5`, B `defaults.max_delegations: 1`. `b-lead` delegates twice: the first succeeds, the second returns `{ error: /delegation budget exhausted/ }`. After the run: `store.run(runId).budget === 3` (5 − the manager's delegation to `loupe` − `b-lead`'s one) and the entry row's `scope_budget === 0`.
- *cycle*: B's config also has `{ back: { team: a.root, reports_to: 'b-lead' } }`; `b-lead` delegates to `back`. Its `tool_result` is `{ error: /team ".*" is already in this delegation/ }`.
- *messaging*: `manager` does `send_to({ to: 'loupe', text: 'use the v2 API' })` after delegating; `b-lead` sleeps 200 ms, then `send_to({ to: 'manager', text: 'on it' })`. Assert `b-lead`'s result `received` contains `[from: manager (manager)] use the v2 API` and that the manager's `wait_for` messages include `on it`.
- *recovery*: as `test/recovery.test.js` does (shared file store, first supervisor closed while `b-dev` sleeps), with `shared: true` on both. After `recover()` the run finishes `done`; the entry row's `scope_budget` is what it was before the restart (B `max_delegations: 2`, one spent → 1).
- *config gone*: same setup, but rename B's `.claude/agent-team.json` before `recover()`. `recover()` returns `{ failed: [runId] }`; every unfinished member is `failed` with a summary matching `/could not recover after a supervisor restart: no agent-team config/`.

Add `shared` to `supervise` in `test/helpers/live.js`: pass `shared: opts.shared ?? false` to the `Supervisor` constructor.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/cross-team.test.js`
Expected: FAIL — the first test sees a one-shot `loupe` row (`agent: 'team'`), not `b-lead`.

- [ ] **Step 3: Export the team helpers from dispatch**

In `src/dispatch.js`, add `export` to `function teamRoot`, `function refuseCycle`, and `function teamEntry`. No other change.

- [ ] **Step 4: Add `#scope` and route every config read through it**

In `src/supervisor.js`:

1. Constructor: add `shared = false` to the destructured options and to `Object.assign`.
2. `#runs` entries gain `configs: new Map()` (project root → config, for entered teams) and `keys: new Map()` (project root → `teamKeys`). Set them in `submit` and in `recover`.
3. Add:

```js
  // An entered team's config, loaded once per run. Throws if it no longer loads.
  #teamConfig(run, root) {
    if (!run.configs.has(root)) run.configs.set(root, loadConfig(root));
    return run.configs.get(root);
  }

  #keys(run, root) {
    if (!run.keys.has(root)) run.keys.set(root, teamKeys(root));
    return run.keys.get(root);
  }

  // The project a member works in and what bounds it there: the nearest entry member at or
  // above it (members.project set), else the run's own project. Every config read goes
  // through here, so a team entered live keeps its own deny_paths, max_depth, max_parallel,
  // stall_minutes and members.
  #scope(m) {
    const run = this.#runs.get(m.run_id);
    const entries = [];
    for (let cur = m; cur; cur = cur.parent_id == null ? null : this.store.member(cur.parent_id)) {
      if (cur.project != null) entries.push(cur);
    }
    const top = entries[0];
    const projectRoot = top ? top.project : run.projectRoot;
    const config = top ? this.#teamConfig(run, top.project) : run.config;
    const teams = [run.projectRoot, ...entries.map((e) => e.project).reverse()]
      .flatMap((root) => this.#keys(run, root));
    return { projectRoot, config, entries, teams };
  }
```

4. `#ctx(m)`: use `const { projectRoot, config, teams } = this.#scope(m)`; pass `config`, `projectRoot`, `teams`, and keep `originRoot: run.projectRoot`.
5. `#resolve(m)`: read `config` from `this.#scope(m)`. A member whose spec is a local `team:` and `this.shared` is true never reaches `#resolve` as a `team` row (Step 5 creates the entry row instead); GitHub teams and in-process supervisors keep `{ team: true }`.
6. `#launch`: build the brief with `denyPaths: scope.config.deny_paths` and `maxDepth: scope.config.defaults.max_depth`, where `scope = this.#scope(m)`.
7. `#drain`: `max_parallel` comes from `this.#scope(this.store.member(m.parent_id)).config` (the manager's scope decides how many of its reports run).
8. `#tick`: `stall_minutes` from `this.#scope(rt.member).config`; `timeoutMs` stays per run.

- [ ] **Step 5: Enter a team live from `#delegate`**

Rewrite `#delegate` so the budget check covers enclosing scopes and a local `team:` report becomes an entry member:

```js
  #delegate(id, { to, task } = {}) {
    const rt = this.#live.get(id);
    const m = this.store.member(id);
    const run = this.#runs.get(m.run_id);
    const scope = this.#scope(m);
    const { config } = scope;
    if (rt.halt) throw new Error(`delegation refused: ${this.#haltNote(rt)}`);
    if (typeof to !== 'string' || typeof task !== 'string' || !task.trim()) {
      throw new Error('delegate needs "to" (a report\'s name) and "task"');
    }
    if (!rt.resolved.reports.includes(to)) throw new Error(`"${to}" is not a direct report of "${m.name}"`);
    if (m.depth >= config.defaults.max_depth) {
      throw new Error(`delegation refused: already at max_depth ${config.defaults.max_depth}`);
    }
    if (run.budget.runs <= 0) throw new Error('delegation budget exhausted (max_delegations)');
    for (const e of scope.entries) {
      if (this.store.member(e.id).scope_budget <= 0) {
        throw new Error(`delegation budget exhausted (max_delegations of the team at ${e.project})`);
      }
    }
    const spec = config.members[to];
    const entered = spec.team && this.shared && !parseGithubRepo(spec.team)
      ? this.#enterTeam(m, scope, to, spec) : null;   // throws before anything is spent
    this.#spendDelegation(run, m.run_id, scope);
    const child = entered
      ? this.store.addMember({ runId: m.run_id, parentId: id, name: entered.entry, task, depth: 0,
                               project: entered.root, alias: to, scopeBudget: entered.budget })
      : this.store.addMember({ runId: m.run_id, parentId: id, name: to, task, depth: m.depth + 1 });
    this.store.addEvent(id, 'delegated', { to, report_id: child.id, ...(entered ? { team: entered.root } : {}) });
    this.#resolve(this.store.member(child.id));
    this.#schedule(child.id);
    return { report_id: child.id, ...(entered ? { team: { root: entered.root, member: entered.entry } } : {}) };
  }

  #spendDelegation(run, runId, scope) {
    run.budget.runs -= 1;
    this.store.setBudget(runId, run.budget.runs);
    for (const e of scope.entries) this.store.setScopeBudget(e.id, this.store.member(e.id).scope_budget - 1);
  }

  // Checks a local team can be entered from here and returns where and as whom.
  #enterTeam(m, scope, to, spec) {
    const root = teamRoot(scope.projectRoot, spec.team);
    if (!existsSync(join(root, CONFIG_RELPATH))) {
      throw new Error(`member "${to}": no agent-team config for team "${spec.team}" at ${join(root, CONFIG_RELPATH)}`);
    }
    const real = realpathSync(root);
    refuseCycle(to, spec.team, teamKeys(real), scope.teams);
    const run = this.#runs.get(m.run_id);
    const teamConfig = this.#teamConfig(run, real);
    const entry = teamEntry(teamConfig, spec.member, real, to);
    if (teamConfig.members[entry].team) {
      throw new Error(`member "${to}": entry member "${entry}" of ${real} is itself a team — set "member" to a member that runs an agent`);
    }
    return { root: real, entry, budget: teamConfig.defaults.max_delegations };
  }
```

Imports to add at the top of `src/supervisor.js`: `existsSync`, `realpathSync` from `node:fs`; `teamRoot`, `teamEntry`, `refuseCycle` from `./dispatch.js`; `parseGithubRepo` from `./cloud.js`; `CONFIG_RELPATH` from `./config.js`.

`refuseCycle` checks against `scope.teams`, which starts with the run's own project, so A → B → A is refused with `runTeam`'s wording.

- [ ] **Step 6: Let `send_to` find an entry member by its alias**

In `#sendTo`, the report match becomes `c.id === to || c.name === to || c.alias === to`. The manager match is unchanged: an entry member's manager is its `parent_id` row, in the other project.

- [ ] **Step 7: Recover entered teams**

In `recover()`, after building the run entry (now with `configs` and `keys`), load every entered team's config before recovering members:

```js
      try {
        for (const m of this.store.members(run.id)) if (m.project != null) this.#teamConfig(entry, m.project);
      } catch (err) {
        this.#runs.delete(run.id);
        this.#failRun(run, `could not recover after a supervisor restart: ${err.message}`);
        out.failed.push(run.id);
        continue;
      }
```

`scope_budget` needs no rebuild: it is read from the row each time.

- [ ] **Step 8: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/cross-team.test.js test/supervisor.test.js test/recovery.test.js test/limits.test.js test/dispatch.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 9: Document live teams**

In `docs/how-it-works.md`, "Other teams" under "Delegation", add after the first paragraph:

```markdown
Under `agent-team serve`, a `team:` member that names a local repository joins the run live.
Delegating to it starts that repository's entry member as a report of the manager: it shows in
the run's tree, can be messaged (by the name the manager knows, or its own), paused, resumed,
cancelled and taken over like any member, and its own reports work under that repository's
config — its `deny_paths` build their workspaces and its `max_depth` bounds the tree below the
entry member. Every delegation inside it spends the run's `max_delegations` and the entered
team's own, whichever runs out first. A team the run has already passed through is refused.
Without `serve` (a CLI run with its own in-process supervisor), a team member still runs
one-shot, as below. Teams named by GitHub repository always run one-shot.
```

- [ ] **Step 10: Commit**

```bash
git add src/dispatch.js src/supervisor.js test/helpers/live.js test/cross-team.test.js docs/how-it-works.md
git commit -m "feat(supervisor): enter local team members live under serve"
```

---

### Task 3: `serve` turns it on, and the view shows whose project a member is in

**Files:**
- Modify: `bin/agent-team.js` (the `serve` block's `new Supervisor({...})`)
- Modify: `src/view.js` (`MEMBER_FIELDS`, `runDetail`)
- Modify: `src/web/app.js` (`drawRun`'s `node`, `drawMember`'s reach section)
- Modify: `test/http.test.js`, `test/web.test.js`
- Modify: `docs/how-it-works.md` ("Live runs" web-view paragraph)

**Interfaces:**
- Consumes: Task 2's `shared` option and member columns.
- Produces:
  - `publicMember(row)` gains `project` (string or null) and `alias` (string or null). `scope_budget` stays private.
  - `runDetail(store, runId, ownSocket)` returns `{ run, members, deny_paths, deny_paths_by_project }`, where `deny_paths_by_project` maps every distinct non-null `members.project` in the run to that project's `deny_paths` (or `null` if its config no longer loads). `deny_paths` stays the run project's, as in 1c.

- [ ] **Step 1: Write the failing tests**

In `test/http.test.js`, add a test that seeds a store directly (no supervisor needed): a run in `/a` with root `manager`, a member `b-lead` with `project: <temp B root with a config whose deny_paths is ['secret/**']>`, `alias: 'loupe'`, `scopeBudget: 3`; `GET /api/runs/:id` returns that member with `project` and `alias` set and no `scope_budget` key, and `deny_paths_by_project[<B root>]` equal to `['secret/**']`.

In `test/web.test.js`, extend the `memberTree` test data (or add one) so a member with `project` and `alias` is present; this test only checks `feed.js` helpers, so add an assertion to the existing source scan instead: `src/web/app.js` mentions `deny_paths_by_project`. (The page itself has no unit harness; 1c's Task 4 relied on the scan and the API tests.)

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/http.test.js test/web.test.js`
Expected: FAIL — `project` is missing from the member.

- [ ] **Step 3: Pass `shared: true` in serve, and extend the read model**

In `bin/agent-team.js`, the `serve` block: `new Supervisor({ store, adapterDir, skillsDir, socketPath: defaultSocketPath(), maxRunning, shared: true })`. `src/client.js`'s in-process supervisor is unchanged (it does not pass `shared`).

In `src/view.js`, add `'project', 'alias'` to `MEMBER_FIELDS`. In `runDetail`, after `denyPaths`:

```js
  const byProject = {};
  for (const m of state.members) {
    if (m.project == null || Object.hasOwn(byProject, m.project)) continue;
    try { byProject[m.project] = loadConfig(m.project).deny_paths; } catch { byProject[m.project] = null; }
  }
  return { ...state, deny_paths: denyPaths, deny_paths_by_project: byProject };
```

- [ ] **Step 4: Show it on the page**

In `src/web/app.js`:

- Tree node (`drawRun`'s `node`): after the name link, when `m.project` is set, append `' ', tag('team ' + basename(m.project))` and, when `m.alias` is set, `h('span', { class: 'muted' }, ` as ${m.alias}`)`. `basename` is `(p) => p.split('/').filter(Boolean).at(-1) ?? p`, already used inline in `drawSidebar`; lift it to a helper.
- A member below an entry member inherits its project: compute each member's scope project while building the tree (`memberTree` gives children; pass the nearest ancestor's `project` down) and use it in the member panel.
- Member panel reach (`drawMember`): show `deny_paths` from `S.detail.deny_paths_by_project[scopeProject]` when the member's scope project is set, else `S.detail.deny_paths`, and label it with the project's basename.

Text only, through `h` and `textContent`, as the rest of the page.

- [ ] **Step 5: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/http.test.js test/web.test.js test/sse.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 6: Document it**

In `docs/how-it-works.md` "Live runs", in the web-view paragraph, add: "A member another repository's team runs is tagged with that team, and its panel shows that repository's `deny_paths`."

- [ ] **Step 7: Commit**

```bash
git add bin/agent-team.js src/view.js src/web/app.js test/http.test.js test/web.test.js docs/how-it-works.md
git commit -m "feat(web): show entered teams in the run tree and their deny_paths"
```

---

### Task 4: `peers` and the known teams

**Files:**
- Modify: `src/config.js` (`parseConfig`: validate `peers`, return it)
- Create: `src/teams.js`
- Create: `test/teams.test.js`
- Modify: `test/config.test.js`
- Modify: `docs/configuration.md` (new "`peers`" section after "`deny_paths`")

**Interfaces:**
- Consumes: `teamRoot` (exported in Task 2), `teamKeys`, `loadConfig`, `CONFIG_RELPATH`, `parseGithubRepo`, store `projects()` (Task 1).
- Produces:
  - config: `parseConfig(...)` returns `peers: string[]` (`[]` when absent).
  - `src/teams.js`:
    - `resolveTeam({ store, projectRoot, config, team }): { name, root, config, keys, source }` — `team` is a known team's name or a path; throws `team "<team>" not found: no agent-team config at <abs>/.claude/agent-team.json` when the resolved directory has no config, `team "<team>" is a GitHub repository — threads and team_status are for local teams` for GitHub names, and `team "<team>" is ambiguous: <root1>, <root2> — name it by path` when two known teams share a name. A config that exists but fails to load throws its own `loadConfig` error, prefixed `team "<team>": `.
    - `knownTeams({ store, projectRoot, config }): { name, root, source, missing? }[]` — every `store.projects()` entry (`source: 'supervisor'`) plus every peer of `config` (`source: 'peer'`), deduplicated by real path (a peer that is also a supervisor project is listed once, as `'peer'`), sorted by name. `name` is the root's basename. A peer whose directory or config is missing is listed with `missing: true` and its resolved (not real) path.

- [ ] **Step 1: Write the failing config tests**

In `test/config.test.js`, following the file's existing style (it builds raw objects and calls `parseConfig`):

```js
test('peers defaults to an empty list', () => {
  assert.deepEqual(parseConfig(minimal(), 'x').peers, []);
});

test('peers takes non-empty strings, at most 50', () => {
  assert.deepEqual(parseConfig({ ...minimal(), peers: ['../loupe', '~/dev/app', '/abs'] }, 'x').peers,
                   ['../loupe', '~/dev/app', '/abs']);
  assert.throws(() => parseConfig({ ...minimal(), peers: 'loupe' }, 'x'), /"peers" must be an array/);
  assert.throws(() => parseConfig({ ...minimal(), peers: [''] }, 'x'), /"peers" entries must be non-empty strings/);
  assert.throws(() => parseConfig({ ...minimal(), peers: Array(51).fill('a') }, 'x'), /at most 50/);
  assert.throws(() => parseConfig({ ...minimal(), peers: ['github:me/loupe'] }, 'x'), /local directory/);
  assert.throws(() => parseConfig({ ...minimal(), peers: ['https://github.com/me/loupe'] }, 'x'), /local directory/);
});

test('a peer that does not exist does not stop the config loading', () => {
  assert.deepEqual(parseConfig({ ...minimal(), peers: ['../nowhere'] }, 'x').peers, ['../nowhere']);
});
```

`minimal()` is whatever helper the file already uses to build a valid raw config; if there is none, define `const minimal = () => ({ members: { a: { agent: 'claude' } }, deny_paths: ['**/.env*'] })` at the top of the new tests.

- [ ] **Step 2: Write the failing known-teams tests**

Create `test/teams.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename, relative } from 'node:path';
import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { resolveTeam, knownTeams } from '../src/teams.js';

function repo(name, extra = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'at-teams-')), name);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members: { lead: { agent: 'mock-live' } }, deny_paths: ['**/.env*'], ...extra
  }));
  return realpathSync(root);
}

test('known teams are the supervisor\'s projects plus the caller\'s peers', () => {
  const loupe = repo('loupe');
  const other = repo('other');
  const android = repo('android', { peers: [relative(join(mkdtempSync(join(tmpdir(), 'x-')), '..'), loupe)] });
  // ... (write android's peers as a path relative to android's root instead; see below)
});
```

Write the test bodies so they cover, each as its own `test(...)`:

- known teams = `store.projects()` (seed two runs with `createRun({ project })`) plus peers; a peer that is also a project appears once with `source: 'peer'`; sorted by name.
- a relative peer resolves against the project root (`peers: ['../loupe']` with both repos made as siblings under one temp dir).
- a `~/` peer expands to `homedir()` (assert on the resolved `root` only; do not create anything in the real home: use a name that does not exist, and assert it is listed with `missing: true` and `root === join(homedir(), '<name>')`).
- a missing peer is listed `missing: true`; `resolveTeam` on it throws `/team "\.\.\/gone" not found: no agent-team config at .*\.claude\/agent-team\.json/`.
- `resolveTeam` by name finds a supervisor project; by absolute path finds an unknown repo too (any path with a config is valid, open by default).
- two known teams with the same basename make `resolveTeam` by name throw `/ambiguous/`, and by path succeed.
- a GitHub name throws `/is a GitHub repository/`.
- a config that exists but is broken throws `/^team "loupe": /`.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/config.test.js test/teams.test.js`
Expected: FAIL — `peers` is undefined; `src/teams.js` does not exist.

- [ ] **Step 4: Validate `peers` in `parseConfig`**

In `src/config.js`, before the `return` of `parseConfig`:

```js
  const peers = raw.peers ?? [];
  if (!Array.isArray(peers)) throw new Error(`${path}: "peers" must be an array of project directories — got ${JSON.stringify(raw.peers)}`);
  if (peers.length > 50) throw new Error(`${path}: "peers" lists ${peers.length} teams; at most 50`);
  for (const p of peers) {
    if (typeof p !== 'string' || p === '') throw new Error(`${path}: "peers" entries must be non-empty strings — got ${JSON.stringify(p)}`);
    if (parseGithubRepo(p) || /^(github:|https?:\/\/|git@)/.test(p)) {
      throw new Error(`${path}: "peers" entry ${JSON.stringify(p)} must be a local directory — a GitHub team runs only as a "team" member`);
    }
  }
```

and add `peers` to the returned object. (`parseGithubRepo` is already imported in `src/config.js` for team members.)

- [ ] **Step 5: Write `src/teams.js`**

```js
import { existsSync, realpathSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { loadConfig, CONFIG_RELPATH } from './config.js';
import { teamRoot, teamKeys } from './dispatch.js';
import { parseGithubRepo } from './cloud.js';

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const hasConfig = (root) => existsSync(join(root, CONFIG_RELPATH));
const looksLikePath = (s) => s.startsWith('~') || s.startsWith('.') || isAbsolute(s) || s.includes('/');

// The teams a member can name: every project the supervisor has run, and the caller's peers.
// Open by default: any directory with a config can also be named by path.
export function knownTeams({ store, projectRoot, config }) {
  const out = new Map();   // real root -> entry
  for (const p of store.projects()) out.set(real(p), { name: basename(p), root: real(p), source: 'supervisor' });
  for (const peer of config.peers ?? []) {
    const root = teamRoot(projectRoot, peer);
    const ok = hasConfig(root);
    const key = ok ? real(root) : root;
    out.set(key, { name: basename(root), root: key, source: 'peer', ...(ok ? {} : { missing: true }) });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}

export function resolveTeam({ store, projectRoot, config, team }) {
  if (typeof team !== 'string' || !team.trim()) throw new Error('name a team: a known team\'s name or a path');
  if (parseGithubRepo(team) || /^(github:|https?:\/\/|git@)/.test(team)) {
    throw new Error(`team "${team}" is a GitHub repository — threads and team_status are for local teams`);
  }
  let root;
  if (looksLikePath(team)) {
    root = teamRoot(projectRoot, team);
  } else {
    const hits = knownTeams({ store, projectRoot, config }).filter((t) => t.name === team);
    if (hits.length > 1) throw new Error(`team "${team}" is ambiguous: ${hits.map((t) => t.root).join(', ')} — name it by path`);
    root = hits[0]?.root ?? teamRoot(projectRoot, team);
  }
  if (!hasConfig(root)) throw new Error(`team "${team}" not found: no agent-team config at ${join(root, CONFIG_RELPATH)}`);
  const r = real(root);
  let teamConfig;
  try { teamConfig = loadConfig(r); } catch (err) { throw new Error(`team "${team}": ${err.message}`); }
  return { name: basename(r), root: r, config: teamConfig, keys: teamKeys(r),
           source: (config.peers ?? []).some((p) => real(teamRoot(projectRoot, p)) === r) ? 'peer' : 'supervisor' };
}
```

- [ ] **Step 6: Run the tests**

Run: `node --import ./test/helpers/guard.js --test test/config.test.js test/teams.test.js`
Expected: PASS.

- [ ] **Step 7: Document `peers`**

In `docs/configuration.md`, after the "`deny_paths`" section:

```markdown
## `peers`

Teams this one may want to talk to before anyone has run a job there. Each entry is a
directory: absolute, under `~/`, or relative to this project (from a linked worktree, relative
to the main checkout). A peer counts once it has its own `.claude/agent-team.json`; until then
it is listed as missing and naming it fails with "not found". Teams named by GitHub repository
cannot be peers.

    "peers": ["../loupe", "~/dev/design-system"]

Members can also name any team the supervisor has already run, or any directory with a config,
by path. `peers` only makes a team known by name in advance.
```

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/teams.js test/config.test.js test/teams.test.js docs/configuration.md
git commit -m "feat(config): peers, and the teams a member can name"
```

---

### Task 5: `team_status`, its allowlist, and the read API

**Files:**
- Modify: `src/view.js` (new `TEAM_FIELDS`, `TEAM_RUN_FIELDS`, `TEAM_MEMBER_FIELDS`, `teamStatus`)
- Modify: `src/teams.js` (`scopeProject`)
- Modify: `src/team-tools.js` (`team_status` schema; `TEAM_NOTE`)
- Modify: `src/supervisor.js` (`#handle` tools map; `#teamStatus`)
- Modify: `src/http.js` (`GET /api/teams`, `GET /api/teams/status`)
- Modify: `test/mcp.test.js` (the tool-list assertion at line 38)
- Modify: `test/teams.test.js`, `test/cross-team.test.js`, `test/http.test.js`
- Modify: `docs/how-it-works.md` ("Delegation": the tool list)

**Interfaces:**
- Consumes: `knownTeams`, `resolveTeam` (Task 4); store `liveMembersIn`, `lastEvent`-style reads.
- Produces:
  - `src/teams.js`: `scopeProject(store, member): string` — the member's own `project`, else its nearest ancestor's, else its run's project.
  - `src/view.js`: `teamStatus(store, { name, root, source }): { team, runs: [{ ...TEAM_RUN_FIELDS, members: [{ ...TEAM_MEMBER_FIELDS, checkpoint: { text, at } | null }] }] }` — `runs` are the running runs that have at least one member whose `scopeProject` is `root`, newest first; each lists only those members.
  - tool `team_status({ team? })` → `teamStatus(...)`, or `{ teams: knownTeams(...) }` when `team` is omitted.
  - `GET /api/teams?project=<abs>` → `{ teams }` (known teams from that project's config; `project` must be a store project, else 404); `GET /api/teams/status?root=<abs>` → `teamStatus` for a store project or a peer of any store project (else 404).

- [ ] **Step 1: Write the failing tests**

In `test/teams.test.js`, add `teamStatus` tests against a seeded `:memory:` store:

```js
test('teamStatus lists running work in the team\'s scope, with checkpoints and nothing else', () => {
  const store = openStore(':memory:');
  const b = repo('loupe');
  const own = store.createRun({ project: b, task: 'own run '.repeat(50) });
  const lead = store.addMember({ runId: own, parentId: null, name: 'lead', task: 'secret task text', depth: 0 });
  store.setWorkspace(lead.id, '/secret/workspace');
  store.setResult(lead.id, { status: 'ok', summary: 'secret summary' });
  store.addEvent(lead.id, 'text', { text: 'secret transcript' });
  store.addEvent(lead.id, 'progress', { text: 'half way' });
  const other = store.createRun({ project: '/a', task: 't' });
  const mgr = store.addMember({ runId: other, parentId: null, name: 'manager', task: 't', depth: 0 });
  const entry = store.addMember({ runId: other, parentId: mgr.id, name: 'lead', task: 't', depth: 0, project: b, alias: 'loupe' });
  store.addMember({ runId: other, parentId: entry.id, name: 'dev', task: 't', depth: 1 });
  const done = store.createRun({ project: b, task: 'old' });
  store.finishRun(done, 'done');

  const s = teamStatus(store, { name: 'loupe', root: b, source: 'peer' });
  assert.deepEqual(s.team, { name: 'loupe', root: b, source: 'peer' });
  assert.deepEqual(s.runs.map((r) => r.id), [other, own]);
  assert.deepEqual(s.runs[0].members.map((m) => m.name), ['lead', 'dev']);   // not the manager
  assert.equal(s.runs[1].task.length, 200);
  assert.deepEqual(s.runs[1].members[0].checkpoint.text, 'half way');
  const json = JSON.stringify(s);
  for (const secret of ['secret task text', '/secret/workspace', 'secret summary', 'secret transcript', 'token']) {
    assert.ok(!json.includes(secret), secret);
  }
});
```

In `test/cross-team.test.js`, add a live test: `manager` calls `team_status({})` and `team_status({ team: '<b root>' })`; its `tool_result` events show `teams` including B, and B's status. Also a test that `team_status({ team: '../nowhere' })` returns `{ error: /not found: no agent-team config/ }`.

In `test/mcp.test.js`, change the tool-list assertion to `['delegate', 'send_to', 'wait_for', 'report_progress', 'ask_human', 'team_status']` and add `assert.ok(result.tools.every((t) => t.annotations?.readOnlyHint === true))`.

In `test/http.test.js`, add: `GET /api/teams?project=<a>` lists B (a peer of A); `GET /api/teams/status?root=<b>` returns the same shape as `teamStatus`; `GET /api/teams/status?root=/not/known` is 404.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/teams.test.js test/cross-team.test.js test/mcp.test.js test/http.test.js`
Expected: FAIL — `teamStatus` is not exported; `unknown tool "team_status"`.

- [ ] **Step 3: Write `scopeProject` and `teamStatus`**

In `src/teams.js`:

```js
export function scopeProject(store, m) {
  for (let cur = m; cur; cur = cur.parent_id == null ? null : store.member(cur.parent_id)) {
    if (cur.project != null) return cur.project;
  }
  return store.run(m.run_id).project;
}
```

In `src/view.js` (import `scopeProject` from `./teams.js`):

```js
// team_status and the web view's team panel: running work in a team, no transcripts.
const TEAM_FIELDS = ['name', 'root', 'source'];
const TEAM_RUN_FIELDS = ['id', 'status', 'task', 'created_at', 'cost_usd'];
const TEAM_MEMBER_FIELDS = ['id', 'run_id', 'parent_id', 'name', 'alias', 'agent', 'state', 'depth', 'updated_at'];
const pick = (row, fields) => Object.fromEntries(fields.map((k) => [k, row[k] ?? null]));
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);

export function teamStatus(store, team) {
  const runs = [];
  for (const run of store.listRuns({ limit: -1 }).filter((r) => r.status === 'running')) {
    const members = store.members(run.id).filter((m) => scopeProject(store, m) === team.root);
    if (!members.length) continue;
    runs.push({
      ...pick({ ...run, task: clip(run.task, 200) }, TEAM_RUN_FIELDS),
      members: members.map((m) => {
        const ev = store.lastEventOfKind(m.id, 'progress');
        return { ...pick(m, TEAM_MEMBER_FIELDS),
                 checkpoint: ev ? { text: clip(ev.text, 500), at: ev.at } : null };
      })
    });
  }
  runs.sort((a, b) => b.created_at - a.created_at);
  return { ...pick(team, TEAM_FIELDS), runs };
}
```

Add `lastEventOfKind(memberId, kind)` to the store: `SELECT * FROM events WHERE member_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`. Check the event row's text column name before relying on `ev.text` (`grep -n "CREATE TABLE events" -A6 src/store.js`); progress events may keep their text in a JSON `data` column, in which case parse it. Do not use `liveMembersIn` for the scope decision (Task 1 explains why).

- [ ] **Step 4: Add the tool**

In `src/team-tools.js`, append to `TOOL_SCHEMAS`:

```js
  {
    name: 'team_status',
    description: 'What another team is doing: its running runs, member states, and latest checkpoints (no transcripts). Name the team by a known name or a path; leave "team" out to list the teams you can name.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
    annotations: RO
  }
```

Add a sentence to `TEAM_NOTE`: "Call team_status to see what another team is working on, or with no team to list the teams you can name."

In `src/supervisor.js`, add `team_status: (id, p) => this.#teamStatus(id, p)` to the tools map, and:

```js
  #teamStatus(id, { team } = {}) {
    const m = this.store.member(id);
    const { projectRoot, config } = this.#scope(m);
    if (team == null || team === '') return { teams: knownTeams({ store: this.store, projectRoot, config }) };
    const t = resolveTeam({ store: this.store, projectRoot, config, team });
    return teamStatus(this.store, t);
  }
```

`team_status` reads the store only, so it works in in-process supervisors too.

- [ ] **Step 5: Add the read routes**

In `src/http.js` `routes`:

```js
    ['GET', /^\/api\/teams$/, ({ url }) => {
      const project = url.searchParams.get('project') ?? '';
      if (!store.projects().includes(project)) throw new HttpError(404, `unknown project ${project}`);
      let config;
      try { config = loadConfig(project); } catch (err) { throw new HttpError(409, err.message); }
      return { teams: knownTeams({ store, projectRoot: project, config }) };
    }],
    ['GET', /^\/api\/teams\/status$/, ({ url }) => {
      const root = url.searchParams.get('root') ?? '';
      const known = new Map();
      for (const p of store.projects()) {
        let config = null;
        try { config = loadConfig(p); } catch { /* moved or broken */ }
        for (const t of config ? knownTeams({ store, projectRoot: p, config }) : [{ name: basename(p), root: p, source: 'supervisor' }]) {
          if (!t.missing) known.set(t.root, t);
        }
      }
      const t = known.get(root);
      if (!t) throw new HttpError(404, `unknown team ${root}`);
      return teamStatus(store, t);
    }],
```

Only teams already known to the supervisor are served: the page never resolves arbitrary paths.

- [ ] **Step 6: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/teams.test.js test/cross-team.test.js test/mcp.test.js test/http.test.js test/team-tools.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 7: Document the tool**

In `docs/how-it-works.md` "Delegation", where the team tools are listed, add `team_status(team?)`: "what another team is doing — its running runs, member states, and latest checkpoints, never transcripts; with no team, the teams you can name (the supervisor's projects and this project's `peers`)."

- [ ] **Step 8: Commit**

```bash
git add src/view.js src/teams.js src/team-tools.js src/supervisor.js src/http.js src/store.js test/teams.test.js test/cross-team.test.js test/mcp.test.js test/http.test.js docs/how-it-works.md
git commit -m "feat(team-tools): team_status, with known teams and an allowlisted view"
```

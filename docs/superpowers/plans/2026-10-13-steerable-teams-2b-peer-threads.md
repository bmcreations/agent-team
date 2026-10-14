# Steerable teams 2b: peer threads, `request` and `reply`, and the loop guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `agent-team serve`, any member can open a thread with any team the supervisor knows (`request(team, text, task?)`), the receiving team's lead triages it (`reply(thread, text, state?)`: accept, decline with a reason, ask a question, answer), a task thread runs as a separate run owned by the receiving team, and the requester picks up the outcome through `wait_for` when the thread closes. Threads move `open → accepted | declined → done`, a chain that returns to a team already in it is refused, and humans can read every thread (CLI and web view, grouped by team pair) and post to one.

**Architecture:** Migration 7 adds `threads` and `thread_posts`, `runs.thread_id` (the thread a run serves), and `messages.thread_id`. Thread traffic reaches members as ordinary inbox messages tagged with `thread_id`, so `wait_for`, the adapter path, and the SSE stream carry them with no new blocking path. The supervisor owns the state machine in a new `#threads` section of `src/supervisor.js`; the store owns the rows. A task thread with no live lead starts a run in the receiving project through `submit` with a `threadId`; that run's lead sees the thread in its brief. `src/view.js` gets `THREAD_FIELDS`/`THREAD_POST_FIELDS` and the page gets a `#/threads` view.

**Tech Stack:** Node >= 22.13, ES modules, `node:sqlite`, `node:http`, `node --test`. No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-10-12-steerable-teams-design.md`: "Peer teams talk in threads" (lines 273–302) and the loupe/Android half of "The demo this spec ends at" (lines 32–43). Builds on `docs/superpowers/plans/2026-10-13-steerable-teams-2a-cross-team-live.md` (migration 6, `Supervisor#scope`, `shared`, `src/teams.js`), which must have landed.

**Size:** 6 tasks.

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

- **`request(team, text, task?)` follows the spec's signature.** `task` present (a non-empty string) makes a *task* thread; absent makes a *question* thread. `text` is the opening post in both.
- **`reply(thread, text, state?)` extends the spec.** The spec gives `reply(thread, text)` and says the lead "uses it to accept, decline with a reason, or ask a question". A state change needs to be explicit, so `reply` takes an optional `state`: `accepted`, `declined`, or `done`. Only the receiving side's owner may change state. Legal moves: task `open → accepted | declined`, `accepted → done`; question `open → done | declined`. `declined` needs non-empty `text` (the reason). A reply without `state` is a plain post (a question back, an update).
- **Who may post.** On the requesting side: the requesting member, or, once it has finished, its nearest unfinished ancestor in the same run. On the receiving side: the owner (`owner_member`: the live lead it was delivered to, or the thread-run's root). Any other member gets `reply refused: member "<m>" is not on thread #<n>`. Humans post through `agent-team reply` and the web view.
- **Thread traffic is inbox messages.** Every post and state change becomes a `messages` row with `thread_id` set, `report_id` null, `from_kind: 'team'`, and `from_name: '<team basename>/<member>'` (or the human's name with `from_kind: 'human'`), addressed to the other side's current holder. `render()` adds `thread_id`. Consequences: `wait_for` returns thread traffic (it is not filtered by `report_ids`, since `report_id` is null); a thread post does **not** cut an `ask_human` short (`claimForQuestion` takes only `human`/`manager`), but a human's post on a thread does, as any human message does.
- **Open threads keep the requester working.** A member with a thread it opened in state `open` or `accepted` counts that thread as open work: `#pump` does not stop it when idle, and `wait_for` with no `report_ids` blocks instead of returning `no open reports`. This is what lets the demo's requester "keep working" and still "pick up the fix when the thread closes".
- **The close notice reads like a report's.** When a thread closes, the requester gets `thread #<n> <state>: <summary or reason>` (state `done ok`, `done failed`, `declined`). `mock-live` waits on it with a new `until_threads` step option, as `until_finished` waits on reports.
- **A requester that finishes first hands the thread up.** If the requesting member finishes while the thread is open, later traffic goes to its nearest unfinished ancestor in the same run; if the whole run has finished, it stays on the thread (visible to humans) and nothing is delivered.
- **A question thread with no live lead also starts a run.** Its run's lead answers with `reply(state: 'done')`; if that run finishes while the question is still open, its final summary is posted as the answer and the thread closes `done`. A task thread's run finishing while `open` declines it.
- **"At the start of its next run."** A run started in the receiving project whose root is the entry member (the triage run, or any run a human starts there) lists the project's threads that are `open` and unowned in its brief's `# Threads` section, and becomes their owner.

## Review Focus

1. **The state machine.** Every transition is guarded in one function (`#moveThread`) inside `BEGIN IMMEDIATE`; a second `accepted` or a `done` before `accepted` fails. Pinned in Task 3.
2. **The loop guard.** A → B → A refused through both paths: a thread-run's member requesting, and a live cross-team member requesting. Pinned in Task 2.
3. **Budgets.** The thread-run's cost and delegations never touch the requester's run. Pinned in Task 3 (assert both runs' `budget` and `cost_usd`).
4. **Delivery to the right holder** when the requester or the lead has finished, and after a restart. Pinned in Tasks 3 and 4.
5. **Allowlists and the page.** Thread rows carry member ids and run ids; only `THREAD_FIELDS` reach the client, and post text is rendered as text. Pinned in Tasks 5 and 6.

## Files

| File | Task | Responsibility |
|---|---|---|
| `src/store.js` | 1 | Migration 7; thread and post methods; `createRun({ threadId })`; `enqueue({ threadId })` |
| `src/supervisor.js` | 2, 3, 4, 5 | `request`, `reply` tools; `#threads` section; triage runs; delegate gate; close on run finish; open-work counting; recovery; `thread_reply` admin RPC |
| `src/brief.js` | 2 | `thread` and `threads` parameters; `# Threads` section; `brief.thread` field |
| `src/team-tools.js` | 2, 3 | `request` and `reply` schemas; `TEAM_NOTE` |
| `adapters/mock-live` | 2, 3 | `$brief.…` and deeper `$var.a.b` substitution; `until_threads` |
| `src/view.js` | 5 | `THREAD_FIELDS`, `THREAD_POST_FIELDS`, `threadsView`, `threadDetail` |
| `src/http.js` | 5 | `GET /api/threads`, `GET /api/threads/:id`, `POST /api/threads/:id/reply` |
| `bin/agent-team.js` | 5 | `threads [--project] [--json]`, `reply <thread> <text>` |
| `src/web/app.js`, `src/web/style.css` | 6 | `#/threads` page |
| `test/store.test.js`, `test/threads.test.js`, `test/mcp.test.js`, `test/brief.test.js`, `test/http.test.js`, `test/cli.test.js`, `test/web.test.js`, `test/recovery.test.js` | 1–6 | Tests |
| `docs/how-it-works.md`, `docs/cli.md` (or the README's CLI section if there is no `docs/cli.md`; `grep -rn "agent-team questions" docs README.md` to find it) | 2–6 | Each task documents what it changes |

---

### Task 1: Migration 7, the thread store

**Files:**
- Modify: `src/store.js` (`MIGRATIONS`, `createRun`, `enqueue`, new thread methods after the question methods)
- Modify: `test/store.test.js` (every rewind test; new tests at the end)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `createRun({ ..., threadId = null })` stores `runs.thread_id`.
  - `enqueue({ ..., threadId = null })` stores `messages.thread_id`.
  - `addThread({ kind, fromProject, fromRun, fromMember, toProject, toMember, parentThread, chain, text, task }): id` — inserts state `open`, `chain` as JSON, and the opening post (`side: 'requester'`, `author: <from member name>`); one transaction.
  - `thread(id): ThreadRow | undefined` — `chain` and `result` parsed.
  - `threads({ project = null, state = null, limit = 200 }): ThreadRow[]` — newest first; `project` matches either side.
  - `moveThread(id, from, to, { result = null } = {}): boolean` — `UPDATE … WHERE id = ? AND state = ?`, true when it changed a row; sets `updated_at`.
  - `setThreadOwner(id, memberId)`, `setThreadRun(id, runId)`.
  - `addThreadPost({ threadId, side, author, text, state = null }): id` — `side` is `requester`, `receiver`, or `human`.
  - `threadPosts(threadId): PostRow[]` — oldest first.
  - `openThreadsFrom(memberId): ThreadRow[]` — state `open` or `accepted` and `from_member = memberId`.
  - `unownedThreadsTo(project, member): ThreadRow[]` — state `open`, `owner_member IS NULL`, `to_project = project`, `to_member = member`, oldest first.
  - `threadsInState(states: string[]): ThreadRow[]`.

- [ ] **Step 1: Make every rewind test drop migration 7's tables and columns, and write the store tests**

Every rewind test in `test/store.test.js` (the version 3, 4, and 5 tests after 2a) must prepend:

```js
'DROP TABLE thread_posts; DROP TABLE threads; ALTER TABLE runs DROP COLUMN thread_id; ' +
'ALTER TABLE messages DROP COLUMN thread_id; ' +
```

before its existing drops. Then append:

```js
test('a version 6 database gains threads, posts, and the thread columns', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig7-')), 's.db');
  openStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE thread_posts; DROP TABLE threads; ALTER TABLE runs DROP COLUMN thread_id; ' +
           'ALTER TABLE messages DROP COLUMN thread_id; PRAGMA user_version = 6');
  raw.close();
  const store = openStore(path);
  assert.deepEqual(store.threads({}), []);
  const runId = store.createRun({ project: '/b', task: 't', threadId: 7 });
  assert.equal(store.run(runId).thread_id, 7);
  store.close();
});

test('a thread opens with its first post and moves only from the state it is in', () => {
  const store = openStore(':memory:');
  const run = store.createRun({ project: '/a', task: 't' });
  const m = store.addMember({ runId: run, parentId: null, name: 'android', task: 't', depth: 0 });
  const id = store.addThread({ kind: 'task', fromProject: '/a', fromRun: run, fromMember: m.id,
                               toProject: '/b', toMember: 'lead', parentThread: null,
                               chain: ['/a'], text: 'loupe crashes on rotate', task: 'fix the rotate crash' });
  const t = store.thread(id);
  assert.equal(t.state, 'open');
  assert.deepEqual(t.chain, ['/a']);
  assert.equal(t.task, 'fix the rotate crash');
  assert.deepEqual(store.threadPosts(id).map((p) => [p.side, p.author, p.text]),
                   [['requester', 'android', 'loupe crashes on rotate']]);
  assert.equal(store.moveThread(id, 'accepted', 'done'), false);
  assert.equal(store.moveThread(id, 'open', 'accepted'), true);
  assert.equal(store.moveThread(id, 'open', 'declined'), false);
  assert.equal(store.moveThread(id, 'accepted', 'done', { result: { status: 'ok', summary: 'fixed' } }), true);
  assert.deepEqual(store.thread(id).result, { status: 'ok', summary: 'fixed' });
  assert.deepEqual(store.openThreadsFrom(m.id), []);
  store.close();
});

test('threads are listed newest first, by project on either side; unowned threads by target', () => { /* ... */ });
test('a message can carry its thread', () => { /* enqueue({ threadId }) then takeQueued shows thread_id */ });
```

Fill in the two stubs with three threads across `/a`, `/b`, `/c`, checking `threads({ project: '/b' })` returns those with `/b` on either side newest first, `threads({ state: 'open' })`, `unownedThreadsTo('/b', 'lead')` before and after `setThreadOwner`, and that `takeQueued` returns `thread_id`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js`
Expected: FAIL — `no such table: thread_posts` in the rewind tests, then `store.addThread is not a function`.

- [ ] **Step 3: Add migration 7 and the methods**

Append to `MIGRATIONS`:

```js
  // Peer threads. A thread has an owner on each side: from_member asked, owner_member (the
  // receiving lead) answers. run_id is the run that works a task thread; runs.thread_id
  // points back. chain is the JSON list of team keys the request passed through.
  `CREATE TABLE threads (
     id INTEGER PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
     from_project TEXT NOT NULL, from_run INTEGER NOT NULL REFERENCES runs(id),
     from_member INTEGER NOT NULL REFERENCES members(id),
     to_project TEXT NOT NULL, to_member TEXT NOT NULL, owner_member INTEGER REFERENCES members(id),
     run_id INTEGER REFERENCES runs(id), parent_thread INTEGER REFERENCES threads(id),
     chain TEXT NOT NULL, task TEXT, result TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX threads_to ON threads(to_project, state);
   CREATE INDEX threads_from ON threads(from_member, state);
   CREATE TABLE thread_posts (
     id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id),
     side TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, state TEXT, at INTEGER NOT NULL);
   CREATE INDEX thread_posts_thread ON thread_posts(thread_id, id);
   ALTER TABLE runs ADD COLUMN thread_id INTEGER;
   ALTER TABLE messages ADD COLUMN thread_id INTEGER;`
```

Add the methods listed under **Produces**. `addThread` runs the two inserts in `BEGIN IMMEDIATE … COMMIT` (with `ROLLBACK` in a `catch`), as `claimRun`-style writes elsewhere in the file do; `moveThread` is a single conditional `UPDATE` and needs no transaction. `threadRow` parses `chain` and `result` the way `memberRow` parses `result`.

- [ ] **Step 4: Run the store tests**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat(store): migration 7 adds peer threads and their posts"
```

---

### Task 2: `request`: open a thread, guard the chain, and reach the receiving lead

**Files:**
- Modify: `src/supervisor.js` (`submit` takes `threadId`; tools map; new `#request`, `#threadChain`, `#liveLead`, `#startThreadRun`, `#deliver`)
- Modify: `src/brief.js` (`buildBrief` takes `thread` and `threads`)
- Modify: `src/team-tools.js` (`request` schema; `TEAM_NOTE`)
- Modify: `adapters/mock-live` (`brief` variable; deeper `$var.a.b` paths)
- Create: `test/threads.test.js`
- Modify: `test/brief.test.js`, `test/mcp.test.js` (tool list), `test/mock-adapter.test.js` only if it asserts the substitution regex (`grep -n "subst\|\\$" test/mock-adapter.test.js` first)
- Modify: `docs/how-it-works.md` (new "Threads between teams" section after "Delegation")

**Interfaces:**
- Consumes: Task 1's store methods; 2a's `#scope`, `#spendDelegation`, `resolveTeam`, `teamEntry`, `teamKeys`, `shared`.
- Produces:
  - tool `request({ team, text, task? })` → `{ thread_id, state: 'open', team: { name, root }, run_id? }` (`run_id` when a run was started for it).
  - `submit({ projectRoot, member, task, timeoutMs, maxCostUsd, threadId = null })`.
  - `buildBrief({ ..., thread = null, threads = [] })`: when `thread` is set the brief gains `thread: { id, kind, from, text, task }` and a `# Thread #<id>` section before `# Task`; `threads` (other open threads listed for this lead) adds a `# Threads waiting for you` section. Both sections tell the lead to answer with `reply`.
  - mock-live: a step's string `$name.a.b.0` reads a nested path from saved results; `$brief.thread.id` reads the brief.

- [ ] **Step 1: Teach mock-live nested paths and the brief**

In `adapters/mock-live`, replace the `subst` string branch:

```js
      if (typeof v === 'string') {
        const m = /^\$(\w+)((?:\.\w+)+)$/.exec(v);
        if (!m) return v;
        const root = m[1] === 'brief' ? brief : vars[m[1]];
        return m[2].slice(1).split('.').reduce((o, k) => o?.[k], root);
      }
```

`$d.report_id` still resolves as before. Run the existing live tests to check nothing changed:

Run: `node --import ./test/helpers/guard.js --test test/supervisor.test.js test/intervention.test.js`
Expected: PASS.

- [ ] **Step 2: Write the failing brief test**

In `test/brief.test.js`:

```js
test('a brief for a thread carries the thread and tells the lead how to answer', () => {
  const b = buildBrief({ resolved: resolvedFixture(), task: 'triage', cwd: '/w', denyPaths: ['**/.env*'],
    thread: { id: 4, kind: 'task', from: 'android/manager', text: 'crash on rotate', task: 'fix it' } });
  assert.deepEqual(b.thread, { id: 4, kind: 'task', from: 'android/manager', text: 'crash on rotate', task: 'fix it' });
  assert.match(b.task, /# Thread #4/);
  assert.match(b.task, /reply\(\{ thread: 4, state: "accepted" \}\)/);
  assert.ok(b.task.indexOf('# Thread #4') < b.task.indexOf('# Task'));
});
```

(`resolvedFixture` is whatever the file already uses to build a `resolved`; reuse it.)

- [ ] **Step 3: Write the failing request tests**

Create `test/threads.test.js`. Shared setup (two repos from `project()`, one script; the store is a temp file so Task 4 can restart it):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { project, supervise, LIVE } from './helpers/live.js';

export function twoTeams(script, { aMembers, bMembers, bDefaults = {} } = {}) {
  const b = project(bMembers ?? { 'b-lead': LIVE(), 'b-dev': LIVE({ reports_to: 'b-lead' }) }, {}, bDefaults);
  const a = project(aMembers ?? { manager: LIVE() }, script);
  writeFileSync(b.script, JSON.stringify(script));
  return { a, b, bReal: realpathSync(b.root) };
}

const threadEvents = (store, memberId, tool) =>
  store.events(memberId).filter((e) => e.kind === 'tool_result' && e.body.name === tool).map((e) => e.body.result);
```

Tests:

```js
test('a request with no live lead starts a run in the receiving project that carries the thread', async () => {
  const script = { by_member: {
    manager: { steps: [{ tool: 'request', args: { team: '$brief.peer', text: 'crash on rotate', task: 'fix it' }, save: 't' }] },
    'b-lead': { steps: [{ say: 'looking' }] }
  } };
  // ...
});
```

`$brief.peer` does not exist; write the B root into the script instead: build the script after `twoTeams` returns, with `args: { team: bReal, … }`, and rewrite `a.script`. Assert:

- `request`'s result is `{ thread_id: 1, state: 'open', team: { name: basename(bReal), root: bReal }, run_id: <n> }`.
- `store.run(run_id)` has `project === bReal`, `thread_id === 1`, and its root member is `b-lead`.
- `store.thread(1)` has `kind: 'task'`, `owner_member` = that root's id, `run_id` = that run, `chain` = `[realpath(a.root)]` (plus a GitHub key only if the temp repo has a remote; it has none).
- The B run's `budget` starts at B's `max_delegations` (set B `defaults.max_delegations: 3`, A's left at the default) and A's run `budget` has gone down by one (Ruling 7).

And:

- *question thread*: `request` without `task` gives `kind: 'question'`.
- *live lead*: B's `b-lead` is already a run root (submit a B run first whose `b-lead` sleeps 2 s); A's request is delivered to it: no new run (`run_id` absent), `owner_member` is the live `b-lead`, and `b-lead`'s `wait_for` (a step after the sleep) returns a message with `thread_id: 1`, `from: '<a basename>/manager (team)'`, and the post text.
- *unknown team*: `request({ team: '/nowhere', text: 'x' })` → `{ error: /not found: no agent-team config/ }`.
- *self*: `request({ team: a.root, … })` → `{ error: /already in this chain/ }`.
- *loop through a thread-run*: B's `b-lead`, in the run started by A's thread, requests A: `{ error: /request refused: team ".*" is already in this chain/ }`.
- *loop through a live cross-team member*: A's manager delegates live to B (2a), and B's `b-lead` requests A: refused the same way.
- *multi-root receiving team*: B with two roots → `{ error: /set "member"|several roots/ }` (match `teamEntry`'s wording; read it first with `grep -n "teamEntry" -A15 src/dispatch.js`).
- *in-process*: `supervise(..., { shared: false })` → `{ error: /threads need `agent-team serve`/ }`.
- *budget exhausted*: A `max_delegations: 0` → `{ error: /delegation budget exhausted/ }`.
- *cloud team*: `request({ team: 'github:me/loupe', … })` → `{ error: /is a GitHub repository/ }`.

Change `test/mcp.test.js`'s tool list to include `'request', 'reply'` after `'team_status'` (Task 3 adds `reply`; add both names now and let the assertion fail until then, or add `reply` to the list in Task 3 — pick the latter so this task's run is green).

- [ ] **Step 4: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/brief.test.js test/threads.test.js`
Expected: FAIL — `b.thread` is undefined; `unknown tool "request"`.

- [ ] **Step 5: Add the thread section to the brief**

In `src/brief.js`, add `thread = null, threads = []` to `buildBrief`'s parameters. Before `sections.push(`# Task…`)`:

```js
  if (thread) sections.push(threadSection(thread));
  if (threads.length) sections.push(waitingSection(threads));
```

with

```js
function threadSection(t) {
  const how = t.kind === 'task'
    ? `Accept with reply({ thread: ${t.id}, state: "accepted" }) before you delegate anything; decline with reply({ thread: ${t.id}, text: "<why>", state: "declined" }). When you finish, the thread closes with your result.`
    : `Answer with reply({ thread: ${t.id}, text: "<answer>", state: "done" }), or decline with a reason.`;
  return [`# Thread #${t.id}`, '',
          `Team member ${t.from} opened this ${t.kind} thread with your team.`, '',
          t.text, ...(t.task ? ['', `Task: ${t.task}`] : []), '', how,
          'Ask them something with reply({ thread, text }) and wait_for their answer.'].join('\n');
}
```

and a short `waitingSection` listing `#id kind from: text` per thread. Return `thread` in the brief object (`thread: thread ? { id, kind, from, text, task } : null`).

- [ ] **Step 6: Write `#request` and its helpers**

In `src/supervisor.js`, add `request: (id, p) => this.#request(id, p)` to the tools map, and a `// ---- threads ----` section:

```js
  #request(id, { team, text, task } = {}) {
    if (!this.shared) throw new Error('threads need `agent-team serve`');
    if (typeof text !== 'string' || !text.trim()) throw new Error('request needs "text"');
    if (task != null && (typeof task !== 'string' || !task.trim())) throw new Error('"task" must be a non-empty string when given');
    const m = this.store.member(id);
    const run = this.#runs.get(m.run_id);
    const scope = this.#scope(m);
    const target = resolveTeam({ store: this.store, projectRoot: scope.projectRoot, config: scope.config, team });
    const chain = this.#threadChain(m, scope);
    const loop = target.keys.find((k) => chain.includes(k));
    if (loop) {
      const names = [...chain, loop].map((k) => basename(k)).join(' -> ');
      throw new Error(`request refused: team "${team}" is already in this chain (${names})`);
    }
    const entry = teamEntry(target.config, null, target.root, team);
    if (target.config.members[entry].team) throw new Error(`team "${team}": its entry member "${entry}" is itself a team`);
    // Budgets are checked before anything is written; spent once the thread exists.
    this.#checkBudget(m, run, scope);   // the checks #delegate does, lifted into one helper
    const threadId = this.store.addThread({
      kind: task ? 'task' : 'question', fromProject: scope.projectRoot, fromRun: m.run_id, fromMember: id,
      toProject: target.root, toMember: entry, parentThread: this.store.run(m.run_id).thread_id ?? null,
      chain: [...chain], text, task: task ?? null
    });
    this.#spendDelegation(run, m.run_id, scope);
    this.store.addEvent(id, 'thread_opened', { thread_id: threadId, team: target.root, kind: task ? 'task' : 'question' });
    const lead = this.#liveLead(target.root, entry);
    let runId;
    if (lead) {
      this.store.setThreadOwner(threadId, lead.id);
      this.#deliver(threadId, lead.id, { side: 'requester', author: m.name, text, state: null, fromTeam: scope.projectRoot });
    } else {
      runId = this.#startThreadRun(threadId);
    }
    return { thread_id: threadId, state: 'open', team: { name: target.name, root: target.root }, ...(runId ? { run_id: runId } : {}) };
  }

  // Ruling 1: the chain of team keys this member's request extends.
  #threadChain(m, scope) {
    const run = this.store.run(m.run_id);
    const parent = run.thread_id == null ? null : this.store.thread(run.thread_id);
    const base = parent ? parent.chain : this.#keys(this.#runs.get(m.run_id), run.project);
    return [...new Set([...base, ...scope.teams])];
  }

  // A member of this supervisor that can own a thread to (project, entry) right now.
  #liveLead(project, entry) {
    for (const rt of this.#live.values()) {
      const m = this.store.member(rt.member.id);
      if (m.name !== entry || m.depth !== 0 || TERMINAL.has(m.state)) continue;
      if (this.#scope(m).projectRoot === project) return m;
    }
    return null;
  }

  // Ruling 6: a new run in the receiving project, under its config and budgets.
  #startThreadRun(threadId) {
    const t = this.store.thread(threadId);
    const from = this.store.member(t.from_member);
    const { runId, rootId } = this.submit({
      projectRoot: t.to_project, member: t.to_member, threadId,
      task: t.task ? `Thread #${t.id}: ${t.task}` : `Thread #${t.id}: answer ${basename(t.from_project)}/${from.name}`
    });
    this.store.setThreadRun(threadId, runId);
    this.store.setThreadOwner(threadId, rootId);
    return runId;
  }
```

`submit` must return the root member's id as well (`{ runId, rootId }`; check its current return with `sed -n 103,120p src/supervisor.js` and extend it), and store `threadId` through `createRun`. `#launch` passes `thread` to `buildBrief` when `this.store.run(m.run_id).thread_id` is set and `m.parent_id == null`: `{ id, kind, from: '<from team basename>/<from member name>', text: <first post>, task }`. For a root member whose run has no thread but whose project has unowned threads to it (`unownedThreadsTo(scope.projectRoot, m.name)`), pass them as `threads` and set this member as their owner (the spec's "at the start of its next run").

`#deliver(threadId, toMemberId, { side, author, text, state, fromTeam })` records the post (`addThreadPost`) and enqueues one message to `toMemberId` with `threadId`, `fromKind: side === 'human' ? 'human' : 'team'`, `fromName: side === 'human' ? author : `${basename(fromTeam)}/${author}``, then `#pump(toMemberId)`. Add `thread_id: m.thread_id ?? null` to `render`.

Lift the three budget checks out of `#delegate` (2a) into `#checkBudget(m, run, scope)`: `max_depth` is **not** part of it (a request is not a delegation down the tree), only the run counter and enclosing `scope_budget`s.

Add `request` to `TOOL_SCHEMAS` in `src/team-tools.js`:

```js
  {
    name: 'request',
    description: 'Open a thread with another team. Give "task" to ask them to do work (it runs as their own run, under their budgets); leave it out to ask a question. Returns the thread id at once; replies and the close arrive through wait_for.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, text: { type: 'string' }, task: { type: 'string' } }, required: ['team', 'text'] },
    annotations: RO
  },
```

and extend `TEAM_NOTE`: "Use request to ask another team for help; their replies arrive through wait_for."

- [ ] **Step 7: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/brief.test.js test/threads.test.js test/cross-team.test.js test/team-tools.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 8: Document `request`**

In `docs/how-it-works.md`, add a "Threads between teams" section after "Delegation":

```markdown
## Threads between teams

Under `agent-team serve`, a member can open a thread with any team the supervisor knows (see
`peers` in configuration) with `request(team, text, task?)`. With `task`, the thread asks the
other team to do work; without, it asks a question. The call returns at once.

The thread goes to the other team's entry member. If that member is running in this supervisor
it gets the thread in its inbox; otherwise `serve` starts a run in that repository, under its
own config, budgets and `deny_paths`, with the thread in the lead's brief. Opening a thread
spends one of the requester's delegations; the work it leads to is charged to the other team.

A request whose chain of threads leads back to a team already in it is refused, so A asking B
asking A cannot loop.
```

- [ ] **Step 9: Commit**

```bash
git add src/supervisor.js src/brief.js src/team-tools.js adapters/mock-live test/threads.test.js test/brief.test.js test/mcp.test.js docs/how-it-works.md
git commit -m "feat(threads): request opens a thread with another team's lead"
```

---

### Task 3: `reply`, the state machine, and closing a thread when its run finishes

**Files:**
- Modify: `src/supervisor.js` (tools map; `#reply`, `#moveThread`, `#holder`; `#delegate` gate; `#conclude` closes threads; `#openReports` → `#openWork`; `#waitFor`)
- Modify: `src/team-tools.js` (`reply` schema)
- Modify: `adapters/mock-live` (`until_threads`)
- Modify: `test/threads.test.js`, `test/mcp.test.js` (tool list: add `'request', 'reply'`)
- Modify: `docs/how-it-works.md` ("Threads between teams")

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - tool `reply({ thread, text, state? })` → `{ thread_id, state }`.
  - Close notice to the requester: a thread message `thread #<n> done ok: <summary>`, `thread #<n> done failed: <summary>`, or `thread #<n> declined: <reason>`.
  - mock-live step option `until_threads: ['$t.thread_id']`: loops `wait_for` until a message with each `thread_id` whose text starts with `thread #<id> done` or `thread #<id> declined` has arrived.

- [ ] **Step 1: Write the failing tests**

In `test/threads.test.js`, add (each with a script and two repos from `twoTeams`):

```js
test('the receiving lead accepts, delegates, finishes, and the requester picks up the result', async () => {
  // manager: request (task) save t; say "keeps working"; wait_for until_threads [$t.thread_id]
  // b-lead: reply({ thread: '$brief.thread.id', text: 'on it', state: 'accepted' });
  //         delegate b-dev; wait_for until_finished; result { status: 'ok', summary: 'fixed rotate' }
  // b-dev:  say 'patched'
});
```

Assertions:
- `store.thread(1).state === 'done'`, `result` is `{ status: 'ok', summary: 'fixed rotate' }`.
- The manager's last `wait_for` result contains a message `{ thread_id: 1, text: 'thread #1 done ok: fixed rotate' }`, and before it one with text `on it` and `thread_id: 1`.
- `threadPosts(1)` sides/states: `requester` (open), `receiver` `on it` (`accepted`), `receiver` (state `done`, text `fixed rotate`).
- Budgets (Ruling 7): A's run `budget` is A's `max_delegations − 1` (only the request), B's run `budget` is B's `max_delegations − 1` (the delegation to `b-dev`); set B `turn_cost_usd: 0.5` on `b-lead` and assert A's run `cost_usd` is unchanged (0 or null) while B's is ≥ 0.5.
- A's manager stayed alive while the thread was open (its `wait_for` returned the close rather than `no open reports`).

Also:
- *delegate before accept*: `b-lead` delegates first → `{ error: /accept thread #1 first/ }`.
- *decline*: `reply({ thread, text: 'not ours', state: 'declined' })` → A gets `thread #1 declined: not ours`; `thread.state === 'declined'`; B's run still finishes normally.
- *decline needs a reason*: empty `text` with `declined` → `{ error: /a reason/ }`.
- *finish without accepting*: `b-lead` just says something and finishes → thread `declined`, notice `thread #1 declined: the lead finished without accepting`.
- *question answered*: `request` without task; `b-lead` `reply({ state: 'done', text: '42' })` → A gets `thread #1 done ok: 42`.
- *question run finishes open*: `b-lead` finishes with summary `use v2` and no reply → thread `done`, A gets `thread #1 done ok: use v2`.
- *thread-run fails*: B's `b-lead` accepts, then its run is cancelled (`sup.cancel({ member_id })`) → thread `done` with `result.status === 'failed'` (cancel → failed), notice `thread #1 done failed: …`.
- *illegal moves*: `done` on an open task thread → `{ error: /cannot move thread #1 from open to done/ }`; the requester trying `state: 'accepted'` → `{ error: /only .* can change its state/ }`; a third member posting → `{ error: /is not on thread #1/ }`.
- *a question back*: `b-lead` `reply({ thread, text: 'which device?' })` (no state) → A's manager receives it via `wait_for`, answers with `reply({ thread, text: 'pixel 8' })`, and `b-lead`'s `wait_for` returns `pixel 8` with `thread_id: 1`.
- *requester finished first*: A has `manager` → `android` (a report). `android` requests and finishes immediately. The close notice arrives at `manager` (its nearest unfinished ancestor).
- *thread posts do not cut ask_human*: `manager` calls `ask_human` after `request`; B's reply arrives; `manager`'s `ask_human` is still pending (answer it with `sup.answer` and assert `answer` came back, not the note `question closed: a message arrived before an answer`).
- *live lead accepts a task*: B's `b-lead` is a live run root when A requests; on `reply(state: 'accepted')` a new run in B starts with `thread_id: 1` and `b-lead` as root; `thread.run_id` is that run; `owner_member` becomes that run's root.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/threads.test.js`
Expected: FAIL — `unknown tool "reply"`.

- [ ] **Step 3: Add `until_threads` to mock-live**

In the tool branch of the step loop, alongside `until_finished`:

```js
        } else if (step.until_threads) {
          const ids = subst(step.until_threads).map(Number);
          const done = new Set();
          const messages = [];
          let error = null;
          while (!ids.every((id) => done.has(id))) {
            const r = await call('wait_for', args).catch((err) => ({ error: err.message }));
            if (r.error) { error = r.error; break; }
            for (const m of r.messages) {
              messages.push(m);
              if (m.thread_id != null && new RegExp(`^thread #${m.thread_id} (done|declined)`).test(m.text)) done.add(m.thread_id);
            }
            if (r.messages.length === 0 && !r.timed_out) break;
            if (interrupted) break;
          }
          res = error ? { messages, error } : { messages };
```

- [ ] **Step 4: Write `#reply` and `#moveThread`**

```js
  #reply(id, { thread, text, state } = {}) {
    const threadId = Number(thread);
    const t = Number.isInteger(threadId) ? this.store.thread(threadId) : null;
    if (!t) throw new Error(`no thread #${thread}`);
    if (typeof text !== 'string') text = '';
    if (!state && !text.trim()) throw new Error('reply needs "text" (or a "state")');
    const m = this.store.member(id);
    const side = this.#sideOf(t, m);
    if (!side) throw new Error(`reply refused: member "${m.name}" is not on thread #${t.id}`);
    if (state != null) {
      if (side !== 'receiver') throw new Error(`reply refused: only the receiving lead on thread #${t.id} can change its state`);
      if (state === 'declined' && !text.trim()) throw new Error('declining a thread needs a reason in "text"');
      this.#moveThread(t, state, { text, author: m.name });
    } else {
      this.store.addThreadPost({ threadId: t.id, side, author: m.name, text });
      const to = side === 'receiver' ? this.#holder(t) : this.store.thread(t.id).owner_member;
      if (to != null) this.#deliver(t.id, to, { side, author: m.name, text, fromTeam: this.#scope(m).projectRoot, posted: true });
    }
    return { thread_id: t.id, state: this.store.thread(t.id).state };
  }
```

`#sideOf(t, m)`: `'receiver'` if `m.id === t.owner_member`; `'requester'` if `m.id === this.#holder(t)`; else null. `#holder(t)`: walk from `t.from_member` up `parent_id` to the first member not in a terminal state, stopping at the run root; null if the run has finished. `#deliver` gains `posted` (the post is already recorded; skip `addThreadPost`).

`#moveThread(t, to, { text, author, result })` holds the legal-move table from Rulings and is the only place a thread's state changes:

```js
const MOVES = { task: { open: ['accepted', 'declined'], accepted: ['done'] },
                question: { open: ['done', 'declined'] } };
```

It refuses an illegal move with `cannot move thread #<id> from <state> to <to>`, calls `store.moveThread` (false → refuse with the same message: a concurrent move won), records the post with `state`, and then:
- `accepted` on a task thread whose `run_id` is null (a live lead in another run accepted): `#startThreadRun(t.id)`, so the work is a separate run under B's budgets; tell the accepting lead `thread #<id>: started run #<run>`.
- `declined` or `done`: send the requester's holder the close notice (`thread #<id> done <status>: <summary>` or `thread #<id> declined: <reason>`). For a `done` reached by `reply`, `result` is `{ status: 'ok', summary: text }`.

- [ ] **Step 5: Gate `delegate` and close threads from `#conclude`**

In `#delegate`, before the budget checks:

```js
    const runThread = this.store.run(m.run_id).thread_id;
    if (runThread != null) {
      const t = this.store.thread(runThread);
      if (t.kind === 'task' && t.state === 'open') {
        throw new Error(`delegation refused: accept thread #${t.id} first — reply({ thread: ${t.id}, state: "accepted" })`);
      }
    }
```

In `#conclude`, in the root branch (`m.parent_id == null`), after `finishRun`:

```js
      this.#closeRunThread(m.run_id, state, result);
```

```js
  #closeRunThread(runId, state, result) {
    const threadId = this.store.run(runId).thread_id;
    const t = threadId == null ? null : this.store.thread(threadId);
    if (!t || t.state === 'done' || t.state === 'declined') return;
    const status = state === 'done' ? result.status : 'failed';
    if (t.kind === 'task' && t.state === 'open') {
      return this.#moveThread(t, 'declined', { text: 'the lead finished without accepting', author: 'agent-team' });
    }
    if (t.kind === 'question' && state !== 'done') {
      return this.#moveThread(t, 'declined', { text: `the lead's run ${state}`, author: 'agent-team' });
    }
    this.#moveThread(t, 'done', { text: result.summary ?? '', author: 'agent-team', result: { status, summary: result.summary ?? '' } });
  }
```

`#moveThread` must accept `author: 'agent-team'` as the receiving side (it is the supervisor acting for the run).

- [ ] **Step 6: Count open threads as open work**

Rename `#openReports(id)` to `#openWork(id)` and make it `children not terminal + store.openThreadsFrom(id).length`. Update its two callers (`#pump`'s stop check and `#waitFor`'s `no open reports` check). In `#waitFor`, the check becomes `reportIds == null && (this.store.children(id).length > 0 || this.store.openThreadsFrom(id).length > 0 || <had a thread>) && this.#openWork(id) === 0`; the simplest correct form is: a member that has ever opened a thread or delegated, with nothing open, gets `no open reports`. Add `threadsFrom(memberId)` (any state) to the store for the "ever opened" check, or count both in one query.

When the holder of a thread changes because its requester finished (`#conclude` for a non-root member with open threads), the holder's `#openWork` now includes those threads: compute it as children not terminal plus open threads whose `#holder` is `id`. Implement by checking `openThreadsFrom` for `id` and for every terminal descendant of `id` whose nearest unfinished ancestor is `id`; keep it a store query: `SELECT t.* FROM threads t WHERE t.state IN ('open','accepted') AND t.from_run = ?` filtered in JS by `#holder(t) === id`.

- [ ] **Step 7: Add the `reply` schema**

```js
  {
    name: 'reply',
    description: 'Post to a thread. The receiving lead can also change its state: "accepted" (task threads, before delegating), "declined" (with the reason in text), or "done" (answering a question). Posts arrive on the other side through wait_for.',
    inputSchema: { type: 'object', properties: {
      thread: { type: 'integer' }, text: { type: 'string' },
      state: { type: 'string', enum: ['accepted', 'declined', 'done'] } }, required: ['thread'] },
    annotations: RO
  }
```

Change `test/mcp.test.js`'s list to `['delegate', 'send_to', 'wait_for', 'report_progress', 'ask_human', 'team_status', 'request', 'reply']`.

- [ ] **Step 8: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/threads.test.js test/mcp.test.js test/supervisor.test.js test/questions.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 9: Document `reply` and the states**

Extend "Threads between teams" in `docs/how-it-works.md`:

```markdown
A thread moves `open → accepted | declined → done`. The receiving lead answers with
`reply(thread, text, state?)`: `accepted` before it delegates any of a task thread's work,
`declined` with a reason, `done` to answer a question. A reply without a state is a post: a
question back, an update. If the lead's run finishes without accepting a task thread, the
thread is declined; if it finishes after accepting, the thread closes `done` with the run's
result. The member that asked gets every post and the close through `wait_for`, and stays
running while a thread it opened is open. If it has finished, its manager gets them instead.
```

- [ ] **Step 10: Commit**

```bash
git add src/supervisor.js src/store.js src/team-tools.js adapters/mock-live test/threads.test.js test/mcp.test.js docs/how-it-works.md
git commit -m "feat(threads): reply, the thread state machine, and closing on run finish"
```

---

### Task 4: Threads across a supervisor restart

**Files:**
- Modify: `src/supervisor.js` (`recover`)
- Modify: `test/recovery.test.js`

**Interfaces:**
- Consumes: Tasks 1–3; 2a's recovery of entered teams.
- Produces: after `recover()`, every thread in `open` or `accepted` has a live owner or a running thread-run, or has been closed.

- [ ] **Step 1: Write the failing tests**

In `test/recovery.test.js`, following its pattern (file store shared by two supervisors, the first closed mid-run, both `shared: true`):

- *thread-run recovered*: A requests; B's run accepts and `b-dev` sleeps; restart; B's run is recovered like any run and the thread closes `done`; A's manager (also recovered, resumed) receives the close notice.
- *owner gone, no run*: A requests while B's `b-lead` is a live root; close the first supervisor before B accepts; on recovery B's old run is recovered (its root resumes), and the thread's owner is that resumed member — the thread is untouched.
- *owner's run failed on recovery*: as above, but rename B's config so B's run fails on recovery; the thread is `open` with a failed owner; `recover()` starts no new triage run (B's config is broken) and declines the thread with `the receiving team could not be recovered: <error>`.
- *triage restarted*: a thread `open` whose `owner_member` is in a finished run and `run_id` is null (seed this directly in the store before `recover()`): recovery starts a triage run for it.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/recovery.test.js`
Expected: FAIL on the last two.

- [ ] **Step 3: Recover threads**

At the end of `recover()`, after runs are recovered:

```js
    for (const t of this.store.threadsInState(['open', 'accepted'])) {
      const owner = t.owner_member == null ? null : this.store.member(t.owner_member);
      const ownerLive = owner && !TERMINAL.has(owner.state) && this.store.run(owner.run_id).status === 'running';
      const runLive = t.run_id != null && this.store.run(t.run_id).status === 'running';
      if (ownerLive || runLive) continue;
      if (t.run_id != null) { this.#closeRunThread(t.run_id, this.store.run(t.run_id).status, { status: 'failed', summary: 'the run ended during a supervisor restart' }); continue; }
      try { this.#startThreadRun(t.id); }
      catch (err) { this.#moveThread(t, 'declined', { text: `the receiving team could not be recovered: ${err.message}`, author: 'agent-team' }); }
    }
```

Only a `shared` supervisor recovers threads (in-process supervisors never have any).

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/recovery.test.js test/threads.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor.js test/recovery.test.js
git commit -m "feat(threads): recover open threads after a supervisor restart"
```

---

### Task 5: Threads for humans: the read model, HTTP, and the CLI

**Files:**
- Modify: `src/view.js` (`THREAD_FIELDS`, `THREAD_POST_FIELDS`, `threadsView`, `threadDetail`)
- Modify: `src/supervisor.js` (admin `thread_reply`; `humanReply`)
- Modify: `src/http.js` (three routes)
- Modify: `bin/agent-team.js` (`threads`, `reply`; `USAGE`)
- Modify: `test/http.test.js`, `test/steer-http.test.js`, `test/cli.test.js`
- Modify: the CLI docs (`grep -rn "agent-team questions" docs README.md` to find where verbs are listed)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `THREAD_FIELDS = ['id', 'kind', 'state', 'from_project', 'from_run', 'to_project', 'run_id', 'parent_thread', 'task', 'created_at', 'updated_at']`, plus derived `from_member` (`{ id, name }`), `owner` (`{ id, name }` or null), `pair` (`'<from basename> → <to basename>'`), and `result` (`{ status, summary }` only). `chain` stays private (it holds real paths of every team in the chain; the page needs only the pair).
  - `THREAD_POST_FIELDS = ['id', 'side', 'author', 'text', 'state', 'at']`.
  - `threadsView(store, { project }) → { pairs: [{ pair, threads: [Thread] }] }` — pairs ordered by their newest thread; threads newest first.
  - `threadDetail(store, id) → { thread, posts } | null`.
  - `Supervisor#humanReply({ thread_id, text, by })` → `{ thread_id, state }`: records a `human` post and delivers it to both sides' current holders (live ones only). No state change (Ruling 5).
  - HTTP: `GET /api/threads?project=`, `GET /api/threads/:id`, `POST /api/threads/:id/reply` (`{ text }`; `steer(...)` as the other POST routes, so it needs the shared supervisor and the same guards).
  - CLI: `agent-team threads [--project <dir>] [--json]`; `agent-team reply <thread> <text>`.

- [ ] **Step 1: Write the failing tests**

`test/http.test.js`: seed a store with two threads between `/a` and `/b` and one between `/a` and `/c`, with posts; `GET /api/threads` groups them into two pairs, newest pair first; no thread has a `chain` key; `GET /api/threads?project=/c` returns one pair; `GET /api/threads/1` returns posts oldest first with exactly `THREAD_POST_FIELDS`; `GET /api/threads/99` is 404. Seed `chain: ['/secret/path']` and assert the string is absent from both responses.

`test/steer-http.test.js`: under the shared supervisor (its existing helper), open a thread through a scripted run and `POST /api/threads/1/reply` with `{ text: 'try rebooting' }` from the browser origin; both sides' live members receive it with `from: '<who> (human)'`; the thread's state is unchanged; an empty `text` is 400; the same POST without the origin/CSRF guard the other steering routes use is 403.

`test/cli.test.js`: with a temp `AGENT_TEAM_SUPERVISOR_DB` seeded with threads, `agent-team threads` prints one line per thread under a header per pair (`a → b`), with control characters in post text stripped (seed `text: 'x\x1b[2Jy'` and assert the output contains `xy`, not `\x1b`); `--json` prints `threadsView`'s object; `agent-team reply 1 hi` with no serve running fails with the same "is `agent-team serve` running?" error the other steering verbs give (match their wording from `test/admin-cli.test.js`).

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/http.test.js test/steer-http.test.js test/cli.test.js`
Expected: FAIL — 404 on `/api/threads`; `unknown command "threads"`.

- [ ] **Step 3: Write the read model**

In `src/view.js`:

```js
const THREAD_FIELDS = ['id', 'kind', 'state', 'from_project', 'from_run', 'to_project', 'run_id', 'parent_thread', 'task', 'created_at', 'updated_at'];
const THREAD_POST_FIELDS = ['id', 'side', 'author', 'text', 'state', 'at'];
const base = (p) => p.split('/').filter(Boolean).at(-1) ?? p;

function publicThread(store, t) {
  const from = store.member(t.from_member);
  const owner = t.owner_member == null ? null : store.member(t.owner_member);
  return { ...pick(t, THREAD_FIELDS),
           from_member: from ? { id: from.id, name: from.name } : null,
           owner: owner ? { id: owner.id, name: owner.name } : null,
           pair: `${base(t.from_project)} → ${base(t.to_project)}`,
           result: t.result ? { status: t.result.status ?? null, summary: t.result.summary ?? null } : null };
}

export function threadsView(store, { project = null } = {}) { /* group publicThread rows by pair */ }
export function threadDetail(store, id) { /* { thread: publicThread, posts: posts.map(p => pick(p, THREAD_POST_FIELDS)) } */ }
```

(`pick` is 2a's helper in the same file.)

- [ ] **Step 4: Add the human reply**

In `src/supervisor.js`, a public `humanReply({ thread_id, text, by })`: refuses an empty `text`, records `addThreadPost({ side: 'human', author: by, text })`, and calls `#deliver(..., posted: true)` to `#holder(t)` and to `t.owner_member` when each is live; it refuses a closed thread (`thread #<n> is <state>`). Add `thread_reply: (p) => this.humanReply(p)` to the admin map. The ownership checks 1c added for `send` apply: the thread's runs on the receiving side are owned by this supervisor (it started them), and the requester's run must be owned by this supervisor to deliver there — if not, the post is recorded and that side is skipped.

- [ ] **Step 5: Routes and CLI verbs**

`src/http.js`:

```js
    ['GET', /^\/api\/threads$/, ({ url }) => threadsView(store, { project: url.searchParams.get('project') || null })],
    ['GET', /^\/api\/threads\/(\d+)$/, ({ params }) => found(threadDetail(store, Number(params[0])), `thread ${params[0]}`)],
    ['POST', /^\/api\/threads\/(\d+)\/reply$/, ({ params, body }) =>
      steer(() => sup.humanReply({ thread_id: Number(params[0]), text: text(body.text, 'text'), by: who }))],
```

`bin/agent-team.js`: add `reply` to `ADMIN`:

```js
  reply: ([id, ...text]) => {
    if (!(Number.isInteger(Number(id)) && Number(id) > 0) || !text.join(' ').trim()) throw new Error('usage: agent-team reply <thread> <text>');
    return ['thread_reply', { thread_id: Number(id), text: text.join(' '), by: whoAmI() }];
  }
```

and a `threads` block next to `watch` that opens `defaultStorePath()` read-only (refuse with the `watch` wording if the store does not exist), calls `threadsView`, and prints either JSON or, per pair, a header line and one line per thread: `#<id> <state> <kind> <from_member.name> -> <owner?.name ?? '-'>: <first 80 chars of task or first post>`, every interpolated string passed through `plain`. Add `--project` to the `parseArgs` options (resolve it to a real path), and both verbs to `USAGE`.

- [ ] **Step 6: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/http.test.js test/steer-http.test.js test/cli.test.js test/admin-cli.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 7: Document the verbs**

Add to the CLI docs, beside `questions`/`answer`:

```markdown
- `agent-team threads [--project <dir>] [--json]` lists threads between teams, grouped by
  team pair, newest first.
- `agent-team reply <thread> <text>` posts to a thread as you. Both sides' leads get it;
  it does not accept or decline the thread.
```

- [ ] **Step 8: Commit**

```bash
git add src/view.js src/supervisor.js src/http.js bin/agent-team.js test/http.test.js test/steer-http.test.js test/cli.test.js docs README.md
git commit -m "feat(threads): list threads and post to them from the CLI and HTTP"
```

---

### Task 6: The threads page

**Files:**
- Modify: `src/web/app.js` (`parseRoute`, `open`, new `drawThreads`, `drawThread`; sidebar link)
- Modify: `src/web/style.css` (thread list and posts)
- Modify: `test/web.test.js`
- Modify: `docs/how-it-works.md` ("Live runs" web-view paragraph)

**Interfaces:**
- Consumes: Task 5's routes; 1c's `h`, `tag`, `state`, `schedule`, SSE `open()`.
- Produces: routes `#/threads` and `#/threads/<id>`. The thread view refetches `GET /api/threads/<id>` when the stream delivers a `message` whose `thread_id` matches, or an event of kind `thread_opened`.

- [ ] **Step 1: Write the failing test**

In `test/web.test.js`, extend the source scan: `src/web/app.js` matches `/#\/threads/`, fetches `/api/threads`, and still contains none of the banned sinks. Add a `feed.js` helper test if the grouping lives there (prefer putting `groupByPair` in `feed.js` so it is unit-testable like `memberTree`): `groupByPair([...])` keeps the server's order.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import ./test/helpers/guard.js --test test/web.test.js`
Expected: FAIL.

- [ ] **Step 3: Draw the page**

- `parseRoute`: also match `^#\/threads(?:\/(\d+))?$` → `{ threads: true, thread: id|null }`.
- `open()`: for a threads route, fetch `/api/threads` (and `/api/threads/<id>`), then stream with no `run` filter from the current cursor; on a message with `thread_id` or an event `thread_opened`, refetch.
- `drawThreads`: one `section` per pair with an `h2` of the pair, then a list: `#id`, `state(t.state)`, `tag(t.kind)`, `from_member.name → owner.name`, the task or first post clipped to 120 characters, and links to `#/run/<from_run>` and `#/run/<run_id>` when set.
- `drawThread`: the thread header as above, then posts oldest first (`author`, `side` as a tag, `state` as a state badge when set, the text in a `pre` with `textContent`), then a `textarea` and "Post" button that `POST`s `/api/threads/<id>/reply` through the page's existing `post()` helper (the one the message box uses, so it sends the same CSRF header). Hide the box for in-process runs (1c ruling) by checking `S.state.own` as the member message box does.
- Sidebar: a "Threads" link under the runs list with the count of `open` + `accepted` threads.

Everything goes through `h(...)`/`textContent`.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/web.test.js test/http.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 5: Document it**

In `docs/how-it-works.md` "Live runs", add: "The Threads page lists threads between teams grouped by team pair, shows each thread's posts, links the runs on both sides, and lets you post to a thread."

- [ ] **Step 6: Commit**

```bash
git add src/web/app.js src/web/feed.js src/web/style.css test/web.test.js docs/how-it-works.md
git commit -m "feat(web): a threads page grouped by team pair"
```

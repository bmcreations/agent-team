# Steerable teams 1b: real harnesses and intervention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run real `claude` members as steerable v2 sessions, and let a human pause, pause-now, resume, cancel, and take over any member or subtree, with restart recovery, stall and timeout enforcement, and a run cost cap. The `codex` v2 adapter and codex take-over are plan 1b-2 (see the end of this plan).

**Architecture:** Every intervention is one mechanism in `src/supervisor.js`: stop or interrupt the adapter, keep the harness's resume id in the store, and relaunch the adapter later in the same workspace with `start {brief, resume, note}`. The `claude` adapter gains a `session` subcommand (protocol 2) beside its v1 `run`, which v1 dispatch trees still use. Take-over is a CLI verb that asks the supervisor to hand the session to a human and to take it back when the human's terminal exits.

**Tech Stack:** Node >= 22.13, ES modules, `node:sqlite`, `node:net`, `node:child_process`, `node --test`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-steerable-teams-design.md` (sections "Harness behaviour this design relies on", "A supervisor that outlives the dispatch", "Adapter contract v2", "Members steer each other through tools", "Humans can always intervene", "Errors and recovery"). Plan 1a, which this builds on: `docs/superpowers/plans/2026-10-13-steerable-teams-1a-core-runtime.md`.

**Size:** 12 tasks. Tasks 1–9 change the runtime and are proven with `mock-live` and fixtures only; Task 10 adds the CLI verbs, Task 11 the real `claude` session adapter, Task 12 take-over. The codex adapter is split off as plan 1b-2 (scope list at the end). Every task ends green.

## Global Constraints

- Stdlib only: the plugin has no install step. `package.json` `engines.node` stays `>=22.13`.
- Tests run under `node --test`. No test may spawn the real `claude` or `codex` unless `AGENT_TEAM_LIVE_SMOKE=1` is set; Task 1's guard enforces this and every later test inherits it.
- Adapter output is untrusted: every line is shape-checked in `src/protocol.js` before use.
- Member states: `queued`, `running`, `waiting` (in `wait_for` or `ask_human`), `paused`, `taken_over`, and the terminal `done`, `failed`, `cancelled`.
- Only an `ok` result prunes a workspace. Pause, cancel, and failure keep it.
- `wait_for` defaults to 600 s (max 1800 s); `ask_human` defaults to 1800 s (max 7200 s); `stall_minutes` defaults to 10.
- Admin RPCs (`submit`, `wait_run`, `send`, `answer`, and the new `questions`, `pause`, `resume`, `cancel`, `takeover`, `handback`) stay tokenless on the `0700` socket. Closing that (a member as the same OS user can call them) is the auth phase's job, not this plan's.
- The new CLI verbs reach only a supervisor started with `agent-team serve`; an in-process supervisor listens on a private socket other CLIs never find.
- Resume and take-over run on the same machine and path as the session (claude stores sessions per working directory under `~/.claude/projects`).
- Commit messages are conventional commits with no attribution trailers.

## Review Focus

- **Pause or cancel while the member is still launching** (between `#live.set` and the adapter spawn, during `resolveCaps`): the member must end `paused` or `cancelled`, never run on. Pinned in Task 5.
- **Resume after the workspace directory was deleted by hand:** a clear `failed` with the missing path, never a silent fresh workspace. Pinned in Task 6.
- **Restart with a run whose project or config is gone:** that run fails with the reason; other runs still recover. Pinned in Task 8.
- **Repeated or out-of-order verbs** (pause twice, resume a running member, cancel a finished one): a clear error and no state change. Pinned in Tasks 5 and 6.
- **A message sent to a paused member:** accepted, queued, and delivered after resume, not refused. Pinned in Task 6.

## Design decisions this plan makes (the spec is silent on them)

- **Pause uses the existing `stop`/`interrupt` messages.** The supervisor marks the runtime `pausing` or `cancelling` before sending them, and `#onExit` reads that mark: an adapter that exits while pausing is `paused`, even if it sent a `result`. `interrupt` means "end the turn now and exit"; an adapter answers it with `idle {interrupted: true}` and exits without a `result`.
- **`start` grows two optional fields:** `start {brief, resume, note}`. `resume` is the string the adapter itself reported in `session {resume}`; `note` is the first user turn after a resume. A fresh start has `resume: null` and the adapter sends `brief.task`.
- **A blocked member is told to end its turn.** Pausing a member blocked in `wait_for` or `ask_human` resolves that call with `{messages: [], timed_out: false, note: "paused by <who> — end your turn now"}` (and closes the open question), because a harness cannot finish its turn while a tool call is pending.
- **`ask_human` reclaims only human and manager messages.** A report's progress would otherwise cut every question short. A reclaim closes the question and returns `{answer: null, timed_out: false, messages, note}`.
- **`maxRunning` counts only members that are not blocked.** A member in `wait_for` or `ask_human` holds no slot. When it wakes, the count can exceed `maxRunning` until members finish; that overshoot is accepted, because the alternative is the 1a deadlock.
- **Take-over is claude-only in this plan, and is a pause with a human in the middle.** `takeover` pauses the member now, waits for its adapter to exit so two processes never write one session file, and marks it `taken_over`; the CLI runs `claude --resume <sid>` in the workspace with inherited stdio, and on any exit calls `handback`, which resumes the member headless with a note that a human drove the session. While taken over, pause and recovery leave the member alone.
- **Claude ack = the replayed user line.** The adapter sets a `uuid` on every user line it writes and acks the inbox message when `--replay-user-messages` echoes that uuid back with `isReplay: true`. The synthetic user lines claude writes after an interrupt carry no `isReplay` and never ack.
- **Schema changes migrate in place.** A 1a `supervisor.db` exists on the developer's machine, so `openStore` runs numbered migrations guarded by `PRAGMA user_version` inside `BEGIN IMMEDIATE`, which also serializes two CLIs opening the same file.
- **Run cost sums what harnesses report.** `claude`'s `total_cost_usd` is cumulative per process, so the adapter reports per-turn deltas on `idle {cost_usd}`. Codex (plan 1b-2) reports tokens, not dollars.
- **Recovered v1 members fail.** A v1 member has no session to resume, so a restart marks it `failed` with "interrupted by a supervisor restart".

## File map

| File | Change | Responsibility |
|---|---|---|
| `test/helpers/guard.js` | create | Sentinel `claude`/`codex` on `PATH` for every test process. |
| `package.json` | modify | `--import` the guard; `test:live` script. |
| `src/store.js` | modify | Migrations; resume id, run cost/limits, recovery queries, `claimForQuestion`. |
| `src/protocol.js` | modify | Shape checks for `session.resume`, `idle {interrupted, cost_usd}`. |
| `src/sessions.js` | modify | `exited` promise, `end()` (interrupt, then SIGTERM, then SIGKILL). |
| `src/supervisor.js` | modify | Slots, single resolution, pause/resume/cancel, recovery, stalls, timeouts, cost cap, take-over. |
| `src/config.js` | modify | `defaults.stall_minutes`, `defaults.max_cost_usd`. |
| `src/admin.js` | create | CLI-side admin calls: find the `serve` socket, name a member, the `attach` loop. |
| `bin/agent-team.js` | modify | `serve` recovers; `questions`, `answer`, `pause`, `resume`, `cancel`, `attach` verbs. |
| `adapters/mock-live` | modify | Interrupt, resume, per-turn cost for tests. |
| `src/claude-session.js` | create | The claude `session` loop: stream-json in and out, acks, interrupt, cost deltas. |
| `adapters/claude` | modify | `session` subcommand; `protocol: 2`; `artifacts.diff_stat`. |
| `test/fixtures/fake-claude` | create | Fake `claude` for adapter and take-over tests. |
| `test/live/*.test.js` | create | Opt-in smoke tests behind `AGENT_TEAM_LIVE_SMOKE=1`. |
| `docs/adapters.md`, `docs/how-it-works.md`, spec | modify | Folded into the owning tasks. |

---

### Task 1: Tests can never reach the real claude or codex

**Files:**
- Create: `test/helpers/guard.js`
- Create: `test/guard.test.js`
- Modify: `test/helpers/live.js:1` (import the guard first)
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: nothing.
- Produces: `GUARD_EXIT = 97` exported from `test/helpers/guard.js`. Side effects in every test process: `process.env.PATH` starts with a sentinel directory holding `claude` and `codex`; `process.env.AGENT_TEAM_CODEX_BIN` points at the sentinel `codex`; `process.env.AGENT_TEAM_TEST_GUARD` names the sentinel directory. The sentinels answer `--version` (exit 0, so adapter probes still pass and resolution stays deterministic) and refuse anything else with exit 97. A test that wants a fake binary puts its own directory *before* `process.env.PATH` (as `test/claude-adapter.test.js` already does) or sets `AGENT_TEAM_CODEX_BIN` itself. `AGENT_TEAM_LIVE_SMOKE=1` disables the guard. Every later task's run commands use `node --import ./test/helpers/guard.js --test ...`.

- [ ] **Step 1: Write the failing test**

Create `test/guard.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { GUARD_EXIT } from './helpers/guard.js';

const live = process.env.AGENT_TEAM_LIVE_SMOKE === '1';
const adapter = (name) => new URL(`../adapters/${name}`, import.meta.url).pathname;

test('a test process cannot run the real claude or codex', { skip: live }, () => {
  for (const bin of ['claude', 'codex', process.env.AGENT_TEAM_CODEX_BIN]) {
    const r = spawnSync(bin, ['-p', 'hello'], { encoding: 'utf8' });
    assert.equal(r.status, GUARD_EXIT, `${bin} was not stopped by the guard`);
    assert.match(r.stderr, /agent-team test guard: refusing to run the real (claude|codex)/);
  }
});

test('adapter probes still pass behind the guard, so resolution is deterministic', { skip: live }, () => {
  assert.match(execFileSync(adapter('claude'), ['probe']).toString(), /agent-team test guard/);
  assert.match(execFileSync(adapter('codex'), ['probe']).toString(), /agent-team test guard/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/guard.test.js`
Expected: FAIL — `Cannot find module '.../test/helpers/guard.js'`.

- [ ] **Step 3: Write the guard**

Create `test/helpers/guard.js`:

```js
// Loaded into every test process (`npm test` passes it with --import, and helpers/live.js
// imports it). A 1a test once ran the real claude by accident; from here on a test can only
// reach a fake. The sentinels answer --version, so `<adapter> probe` still passes and member
// resolution does not depend on what is installed, and refuse everything else loudly.
// AGENT_TEAM_LIVE_SMOKE=1 turns the guard off for the opt-in smoke tests in test/live/.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

export const GUARD_EXIT = 97;

// The test runner process sets this before spawning one process per file; they inherit it.
if (process.env.AGENT_TEAM_LIVE_SMOKE !== '1' && !process.env.AGENT_TEAM_TEST_GUARD) {
  const dir = mkdtempSync(join(tmpdir(), 'at-guard-'));
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(dir, name), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "0.0.0 (agent-team test guard)"; exit 0; fi',
      `echo "agent-team test guard: refusing to run the real ${name} ($*). Use a fake binary, or set AGENT_TEAM_LIVE_SMOKE=1." >&2`,
      `exit ${GUARD_EXIT}`,
      ''
    ].join('\n'));
    chmodSync(join(dir, name), 0o755);
  }
  process.env.AGENT_TEAM_TEST_GUARD = dir;
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  process.env.AGENT_TEAM_CODEX_BIN = join(dir, 'codex');
}
```

In `test/helpers/live.js`, add as the first line, above the other imports:

```js
import './guard.js';   // before anything can spawn an adapter
```

In `package.json`, replace the `scripts` line with:

```json
  "scripts": {
    "test": "node --import ./test/helpers/guard.js --test 'test/**/*.test.js'",
    "test:live": "AGENT_TEAM_LIVE_SMOKE=1 node --test 'test/live/*.test.js'"
  }
```

- [ ] **Step 4: Run the test, then the whole suite**

Run: `node --import ./test/helpers/guard.js --test test/guard.test.js`
Expected: PASS, 2 tests.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 443` and `ℹ fail 0` (441 from 1a plus 2). A failure here is a test that was reaching the real binary; give it a fake on `PATH` rather than weakening the guard.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/guard.js test/helpers/live.js test/guard.test.js package.json
git commit -m "test: stop every test from reaching the real claude or codex"
```

---

### Task 2: Store migrations and protocol fields for resume and cost

**Files:**
- Modify: `src/store.js` (add `MIGRATIONS`, `migrate`, and methods; `createRun` signature)
- Modify: `src/protocol.js:5-11` (`CHECKS`)
- Test: `test/store.test.js`, `test/protocol.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (store):
  - `createRun({ project, task, timeoutMs = null, budget = null, maxCostUsd = null }) -> number` (new columns `timeout_ms`, `budget`, `max_cost_usd`; `cost_usd` starts at 0).
  - `setBudget(runId: number, left: number)`; `setRunCap(runId: number, usd: number|null)`; `addRunCost(runId: number, usd: number) -> number` (new total).
  - `setResume(memberId: number, resume: string|null)`; member rows gain `resume`.
  - `membersInStates(states: string[]) -> member[]` across all runs, ordered by id.
  - `claimForQuestion(memberId) -> message[]`: queued or offered messages from a `human` or `manager`, marked delivered.
- Produces (protocol): `session.resume` must be a string, `null`, or absent; `idle` may carry `interrupted: boolean` and `cost_usd: number >= 0` (finite); anything else drops the line.

- [ ] **Step 1: Write the failing tests**

Add `import { DatabaseSync } from 'node:sqlite';` to the imports at the top of `test/store.test.js`, then append:

```js
test('a 1a database is migrated in place and keeps its rows', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig-')), 's.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL,
              root_member INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE members (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, parent_id INTEGER,
              name TEXT NOT NULL, task TEXT NOT NULL, depth INTEGER NOT NULL, state TEXT NOT NULL,
              token TEXT NOT NULL UNIQUE, harness_id TEXT, workspace TEXT, result TEXT,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            INSERT INTO runs VALUES (1, '/p', 'old run', NULL, 'running', 0);`);
  old.close();
  const store = openStore(path);
  assert.equal(store.run(1).task, 'old run');
  assert.equal(store.run(1).cost_usd, 0);
  const lead = store.addMember({ runId: 1, parentId: null, name: 'lead', task: 't', depth: 0 });
  store.setResume(lead.id, 'sid-1');
  assert.equal(store.member(lead.id).resume, 'sid-1');
  store.close();
  openStore(path).close();   // a second open finds the migrations applied and does nothing
});

test('run cost accumulates and run limits are stored', () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't', timeoutMs: 5000, budget: 7, maxCostUsd: 2 });
  assert.equal(store.run(runId).timeout_ms, 5000);
  assert.equal(store.run(runId).budget, 7);
  assert.equal(store.run(runId).max_cost_usd, 2);
  store.setBudget(runId, 6);
  assert.equal(store.run(runId).budget, 6);
  store.setRunCap(runId, 3.5);
  assert.equal(store.run(runId).max_cost_usd, 3.5);
  assert.equal(store.addRunCost(runId, 0.25), 0.25);
  assert.equal(store.addRunCost(runId, 0.5), 0.75);
});

test('membersInStates finds members across runs', () => {
  const store = openStore(':memory:');
  const r1 = store.createRun({ project: '/a', task: 't' });
  const r2 = store.createRun({ project: '/b', task: 't' });
  const a = store.addMember({ runId: r1, parentId: null, name: 'a', task: 't', depth: 0 });
  const b = store.addMember({ runId: r2, parentId: null, name: 'b', task: 't', depth: 0 });
  store.setState(a.id, 'running');
  store.setState(b.id, 'waiting');
  assert.deepEqual(store.membersInStates(['running', 'waiting']).map((m) => m.name), ['a', 'b']);
  assert.deepEqual(store.membersInStates(['paused']), []);
});

test('claimForQuestion takes human and manager messages and leaves report messages queued', () => {
  const { store, lead } = seeded();
  const human = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'b', text: 'h' });
  const report = store.enqueue({ to: lead.id, fromKind: 'report', fromName: 'r', reportId: 99, text: 'progress: x' });
  assert.deepEqual(store.claimForQuestion(lead.id).map((m) => m.id), [human]);
  assert.equal(store.message(human).state, 'delivered');
  assert.equal(store.message(report).state, 'queued');
});
```

`seeded()` already exists at the top of `test/store.test.js` and returns `{ store, runId, lead }`.

Append to `test/protocol.test.js`:

```js
test('session.resume and the idle fields are shape-checked', () => {
  const ok = (m) => assert.ok(parseAdapterLine(JSON.stringify(m)), JSON.stringify(m));
  const bad = (m) => assert.equal(parseAdapterLine(JSON.stringify(m)), null, JSON.stringify(m));
  ok({ type: 'session', harness_id: 'h', resume: 'sid' });
  ok({ type: 'session', harness_id: 'h' });
  bad({ type: 'session', harness_id: 'h', resume: 42 });
  ok({ type: 'idle', interrupted: true, cost_usd: 0.01 });
  bad({ type: 'idle', interrupted: 'yes' });
  bad({ type: 'idle', cost_usd: -1 });
  bad({ type: 'idle', cost_usd: 'NaN' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js test/protocol.test.js`
Expected: FAIL — `store.run(1).cost_usd` is `undefined`, `store.setResume is not a function`, and the protocol test's `bad({... resume: 42})` returns a message.

- [ ] **Step 3: Implement**

In `src/store.js`, below `SCHEMA`, add:

```js
// Each entry upgrades the schema by one version. SCHEMA stays the 1a shape, so a fresh
// database and a 1a one take the same path. BEGIN IMMEDIATE serializes two CLIs opening the
// same file; the version is re-read inside the lock so the loser applies nothing twice.
const MIGRATIONS = [
  `ALTER TABLE members ADD COLUMN resume TEXT;
   ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN timeout_ms INTEGER;
   ALTER TABLE runs ADD COLUMN budget INTEGER;
   ALTER TABLE runs ADD COLUMN max_cost_usd REAL;`
];

function migrate(db) {
  const version = () => db.prepare('PRAGMA user_version').get().user_version;
  if (version() >= MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = version(); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

In `openStore`, after `db.exec(SCHEMA);` add `migrate(db);`.

Replace `createRun` with:

```js
    createRun: ({ project, task, timeoutMs = null, budget = null, maxCostUsd = null }) => Number(
      q("INSERT INTO runs (project, task, status, created_at, timeout_ms, budget, max_cost_usd) VALUES (?, ?, 'running', ?, ?, ?, ?)")
        .run(project, task, now(), timeoutMs, budget, maxCostUsd).lastInsertRowid),
    setBudget: (id, left) => q('UPDATE runs SET budget = ? WHERE id = ?').run(left, id),
    setRunCap: (id, usd) => q('UPDATE runs SET max_cost_usd = ? WHERE id = ?').run(usd, id),
    addRunCost(id, usd) {
      q('UPDATE runs SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, id);
      return q('SELECT cost_usd FROM runs WHERE id = ?').get(id).cost_usd;
    },
```

After `setHarness`, add:

```js
    setResume: (id, resume) => q('UPDATE members SET resume = ? WHERE id = ?').run(resume, id),
    membersInStates: (states) => q(
      `SELECT * FROM members WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY id`
    ).all(...states).map(memberRow),
```

After `claimForWait`, add:

```js
    // The ask_human path: only a human or the member's manager can cut a question short; a
    // report's progress waits for the member's next wait_for.
    claimForQuestion(memberId) {
      const rows = q("SELECT * FROM messages WHERE to_member = ? AND state IN ('queued', 'offered') " +
                     "AND from_kind IN ('human', 'manager') ORDER BY id").all(memberId);
      for (const m of rows) q("UPDATE messages SET state = 'delivered' WHERE id = ?").run(m.id);
      return rows.map((m) => ({ ...m, state: 'delivered' }));
    },
```

In `src/protocol.js`, replace the `CHECKS` object with:

```js
const nullable = (v, type) => v === undefined || v === null || typeof v === type;
const cost = (v) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

const CHECKS = {
  session: (m) => typeof m.harness_id === 'string' && m.harness_id.length > 0 && nullable(m.resume, 'string'),
  event: (m) => typeof m.kind === 'string' && m.kind.length > 0,
  ack: (m) => Number.isInteger(m.message_id),
  idle: (m) => nullable(m.interrupted, 'boolean') && cost(m.cost_usd),
  result: (m) => RESULT_STATUSES.has(m.status) && typeof m.summary === 'string'
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js test/protocol.test.js`
Expected: PASS.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/protocol.js test/store.test.js test/protocol.test.js
git commit -m "feat(store): migrate the schema for resume ids and run cost"
```

---

### Task 3: close() ends live adapters and leaves their members for recovery

**Files:**
- Modify: `src/sessions.js` (whole file below)
- Modify: `src/supervisor.js` (constructor, `close`, `#onExit`, `#finish`; add `#settle`)
- Modify: `test/helpers/live.js` (`supervise` accepts `graceMs` and `env`)
- Test: `test/supervisor.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `MemberSession#exited: Promise<number|null>` (resolves after `onExit` ran) and `MemberSession#end(graceMs = 5000) -> Promise<number|null>`: sends `interrupt`, then SIGTERM after `graceMs`, SIGKILL after `2 * graceMs`.
  - `new Supervisor({ ..., graceMs = 5000 })`.
  - `Supervisor#close()`: settles blocked tool calls with `{ error: 'the agent-team supervisor is shutting down' }`, ends every live session, then closes the socket. Member states are left as they were (Task 8 recovers them).
  - Private `#settle(rt, value)`: resolves a pending `wait_for` or `ask_human` with `value` and closes the question, without touching the member's state. Later tasks call it.
  - `supervise(script, { adapterDir?, maxRunning?, graceMs?, env? })` in `test/helpers/live.js`; `env` is merged into the supervisor's env.

- [ ] **Step 1: Write the failing tests**

Append to `test/supervisor.test.js`:

```js
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('close() ends live adapters and leaves their members for recovery', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }] } }
  });
  const { sup, store } = await supervise(script, { graceMs: 200 });
  const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  while (!store.events(memberId).some((e) => e.kind === 'text')) await new Promise((r) => setTimeout(r, 20));
  const pid = Number(store.member(memberId).harness_id.split('-').at(-1));
  const started = Date.now();
  await sup.close();
  assert.ok(Date.now() - started < 3000, 'close() waited on the adapter');
  assert.equal(alive(pid), false, 'the adapter process outlived close()');
  assert.equal(store.member(memberId).state, 'running');
  assert.ok(!store.events(memberId).some((e) => e.kind === 'finished'));
});

test('close() settles a blocked wait_for instead of leaving its connection open', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } }
  });
  const { sup, store } = await supervise(script, { graceMs: 200 });
  const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  while (store.member(memberId).state !== 'waiting') await new Promise((r) => setTimeout(r, 20));
  await sup.close();
  const results = store.events(memberId).filter((e) => e.kind === 'tool_result');
  assert.deepEqual(results.map((e) => e.body.result), [{ error: 'the agent-team supervisor is shutting down' }]);
});
```

(`mock-live`'s `harness_id` is `mock-live-<member>-<pid>`, so the test reads the adapter's pid from it.)

In `test/helpers/live.js`, replace the `new Supervisor({...})` call in `supervise` with:

```js
  const sup = new Supervisor({
    store, adapterDir: opts.adapterDir ?? adapterDir(), socketPath,
    env: { AGENT_TEAM_MOCK_SCRIPT: script, ...opts.env }, maxRunning: opts.maxRunning ?? 6,
    graceMs: opts.graceMs ?? 5000
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/supervisor.test.js`
Expected: FAIL — the first test's `alive(pid)` is `true` (today's `close()` only closes the socket), and the second test hangs until the runner's timeout or reports no `tool_result`.

- [ ] **Step 3: Implement**

Replace `src/sessions.js` with:

```js
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { encode, parseAdapterLine } from './protocol.js';

const STDERR_TAIL = 4000;

// One live v2 adapter process. It knows nothing about members or inboxes: it frames lines
// and reports the exit. The supervisor decides what each line means.
export class MemberSession {
  constructor({ execPath, cwd, env, onLine, onExit }) {
    this.stderr = '';
    this.child = spawn(execPath, ['session'], {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdin.on('error', () => {});   // the adapter may exit before we stop writing
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-STDERR_TAIL); });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const m = parseAdapterLine(line);
      if (m) onLine(m);
    });
    // 'close' rather than 'exit', so every stdout line has been read before onExit runs.
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code) => { onExit(code, this.stderr); resolve(code); });
    });
    this.child.on('error', (err) => { this.stderr += `\n${err.message}`; });
  }

  send(message) {
    if (this.child.stdin.writable) this.child.stdin.write(encode(message));
  }

  // Asks the adapter to end its turn and exit, then escalates: SIGTERM after graceMs, SIGKILL
  // after twice that. Resolves with the exit code once the process has closed.
  end(graceMs = 5000) {
    this.send({ type: 'interrupt' });
    const term = setTimeout(() => this.child.kill('SIGTERM'), graceMs);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), graceMs * 2);
    return this.exited.finally(() => { clearTimeout(term); clearTimeout(kill); });
  }
}
```

In `src/supervisor.js`:

Replace the `#runWaiters` field and the constructor with:

```js
  #runWaiters = new Map();    // runId -> [resolve]
  #closing = false;

  constructor({ store, adapterDir, skillsDir = null, socketPath, env = {}, maxRunning = 6,
                timeoutMs = DEFAULT_TIMEOUT_MS, graceMs = 5000 }) {
    Object.assign(this, { store, adapterDir, skillsDir, socketPath, env, maxRunning, timeoutMs, graceMs });
  }
```

Replace `close()` with:

```js
  // Ends every live adapter and leaves the members' states as they are, so the next start
  // can recover them. Blocked tool calls are settled first, or their RPC connections hang.
  async close() {
    this.#closing = true;
    const live = [...this.#live.values()];
    for (const rt of live) this.#settle(rt, { error: 'the agent-team supervisor is shutting down' });
    await Promise.all(live.map((rt) => rt.session?.end(this.graceMs)));
    await this.server?.close();
  }
```

At the top of `#onExit`, after `if (!rt) return;`, add:

```js
    if (this.#closing) {
      this.#live.delete(id);
      for (const mid of rt.offered) this.store.requeue(mid);
      return;
    }
```

Replace the start of `#finish`, from its first line through the `if (rt.question) {...}` block, with:

```js
  #finish(id, result) {
    const rt = this.#live.get(id);
    // A v1 member finishing after close() has nothing to write to: the store may be closed.
    if (!rt || this.#closing) return;
    this.#live.delete(id);
    for (const mid of rt.offered) this.store.requeue(mid);
    this.#settle(rt, { error: 'member finished' });
```

Add above `#resolveWaiter`:

```js
  // Ends a blocked wait_for or ask_human with `value`, leaving the member's state alone.
  #settle(rt, value) {
    if (rt.waiter) {
      clearTimeout(rt.waiter.timer);
      rt.waiter.resolve(value);
      rt.waiter = null;
    }
    if (rt.question) {
      clearTimeout(rt.question.timer);
      this.store.closeQuestion(rt.question.id);
      rt.question.resolve(value);
      rt.question = null;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/supervisor.test.js`
Expected: PASS, 7 tests.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 450`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.js src/supervisor.js test/helpers/live.js test/supervisor.test.js
git commit -m "fix(supervisor): end live adapters on close"
```

---

### Task 4: Blocked members hold no slot, and each member is resolved once

**Files:**
- Modify: `src/supervisor.js` (fields, `submit`, `#drain`, `#launch`, `#delegate`, `#sendTo`, `#waitFor`, `#askHuman`; add `#running`, `#ctx`, `#resolve`)
- Create: `test/scheduling.test.js`

**Interfaces:**
- Consumes: `resolveCaps(ctx)` and `runMember({ preresolved, ...ctx })` from `src/dispatch.js` (`runMember` already skips resolution when `preresolved` is given).
- Produces (private, used by later tasks):
  - `#running() -> number`: live members that are not blocked in `wait_for` or `ask_human`. `#drain` compares it with `maxRunning`.
  - `#ctx(m) -> ctx`: the dispatch context for member row `m`.
  - `#resolve(m) -> Promise<{resolved, caps} | {team: true} | {error}>`: started when the member is created, memoized per member id. `#launch` and `#sendTo` share it.
  - `rt.caps` on every runtime record.
- Behaviour: a manager blocked in `wait_for` frees its slot, so a three-level team runs with `maxRunning: 1` (the 1a deadlock). `send_to` a report that is still queued but resolves to a v1 adapter or a team is refused instead of enqueued into an inbox nothing reads. A v1 member's adapter is asked for `capabilities` once per launch, not twice.

- [ ] **Step 1: Write the failing tests**

Create `test/scheduling.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { project, adapterDir, supervise, LIVE } from './helpers/live.js';

test('a manager blocked in wait_for holds no slot, so a deep team runs with maxRunning 1', { timeout: 15_000 }, async () => {
  const { root, script } = project({
    lead: LIVE(), mid: LIVE({ reports_to: 'lead' }), leaf: LIVE({ reports_to: 'mid' })
  }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'mid', task: 'plan' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      mid: { steps: [
        { tool: 'delegate', args: { to: 'leaf', task: 'do' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      leaf: { steps: [] }
    }
  });
  const { sup, store } = await supervise(script, { maxRunning: 1 });
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.deepEqual(store.members(runId).map((m) => m.state), ['done', 'done', 'done']);
  } finally { await sup.close(); }
});

test('send_to a queued report that resolves to a v1 adapter is refused, not lost', async () => {
  const { root, script } = project({
    lead: LIVE(), a: LIVE({ reports_to: 'lead' }), old: { agent: 'mock', reports_to: 'lead', isolation: 'none' }
  }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'first' }, save: 'ra' },
        { tool: 'delegate', args: { to: 'old', task: 'second' }, save: 'ro' },
        { tool: 'send_to', args: { to: 'old', text: 'hi' } },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id', '$ro.report_id'] }
      ] },
      a: { steps: [{ sleep_ms: 300 }] },
      old: { status: 'ok', summary: 'old done' }
    }
  }, { max_parallel: 1 });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    const sent = result.tool_results.find((t) => t.tool === 'send_to').result;
    assert.match(sent.error ?? '', /"old" runs one-shot and cannot receive messages/);
    const old = store.members(runId).find((m) => m.name === 'old');
    assert.equal(old.state, 'done');
    assert.deepEqual(store.takeQueued(old.id), [], 'nothing was left in the v1 member\'s inbox');
  } finally { await sup.close(); }
});

test('a v1 member is resolved once per launch', async () => {
  const dir = adapterDir();
  const log = join(dir, 'calls.log');
  // Logs each subcommand, then behaves exactly like the mock adapter.
  writeFileSync(join(dir, 'counted'), `#!/bin/sh\necho "$1" >> "${log}"\nexec "$(dirname "$0")/mock" "$@"\n`);
  chmodSync(join(dir, 'counted'), 0o755);
  const { root, script } = project({ solo: { agent: 'counted', isolation: 'none' } },
    { status: 'ok', summary: 'done' });
  const { sup } = await supervise(script, { adapterDir: dir });
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    assert.equal((await sup.waitRun(runId)).status, 'ok');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter((c) => c === 'capabilities').length, 1);
  } finally { await sup.close(); }
});
```

(`max_parallel: 1` keeps `old` queued behind `a` when `lead` calls `send_to`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test --test-name-pattern='send_to a queued|resolved once' test/scheduling.test.js`
Expected: FAIL — `send_to` returns a `message_id` (the `sent.error` match sees `''`), and `capabilities` is called 2 times, not 1.

The deadlock test is left out of this run on purpose: without the fix it never finishes, and its live adapters keep the runner open after the 15 s timeout.

- [ ] **Step 3: Implement**

In `src/supervisor.js`, add a field below `#runs`:

```js
  #resolutions = new Map();   // memberId -> Promise of { resolved, caps } | { team: true } | { error }
```

In `submit`, between `this.store.setRunRoot(runId, id);` and `this.#schedule(id);`, add:

```js
    this.#resolve(this.store.member(id));
```

Replace `#drain` and add `#running` above it:

```js
  // A member blocked in wait_for or ask_human holds no slot, or a manager waiting on its
  // reports would starve them. When it wakes the count can pass maxRunning until members
  // finish; that overshoot is the price of never deadlocking.
  #running() {
    let n = 0;
    for (const rt of this.#live.values()) if (!rt.waiter && !rt.question) n++;
    return n;
  }

  #drain() {
    for (const id of [...this.#pending]) {
      if (this.#running() >= this.maxRunning) return;
      const m = this.store.member(id);
      if (m.parent_id != null) {
        const { config } = this.#runs.get(m.run_id);
        const running = this.store.children(m.parent_id).filter((c) => this.#live.has(c.id)).length;
        if (running >= config.defaults.max_parallel) continue;
      }
      this.#pending.splice(this.#pending.indexOf(id), 1);
      this.#launch(id).catch((err) => this.#finish(id, { status: 'failed', summary: err.message }));
    }
  }

  #ctx(m) {
    const run = this.#runs.get(m.run_id);
    return {
      config: run.config, projectRoot: run.projectRoot, member: m.name, task: m.task,
      adapterDir: this.adapterDir, assignments: {}, skillsDir: this.skillsDir, env: this.env,
      timeoutMs: run.timeoutMs, budget: run.budget, depth: m.depth,
      teams: teamKeys(run.projectRoot), originRoot: run.projectRoot
    };
  }

  // Each member is resolved once, starting when it is created; #launch and #sendTo share the
  // answer. A failure is kept as { error } so it fails the launch, not the delegate call.
  #resolve(m) {
    let p = this.#resolutions.get(m.id);
    if (!p) {
      const { config } = this.#runs.get(m.run_id);
      p = config.members[m.name].team
        ? Promise.resolve({ team: true })
        : resolveCaps(this.#ctx(m)).catch((error) => ({ error }));
      this.#resolutions.set(m.id, p);
    }
    return p;
  }
```

In `#launch`, replace everything from `const run = this.#runs.get(m.run_id);` through `rt.resolved = resolved;` with:

```js
    const run = this.#runs.get(m.run_id);
    // Registered before any await, so #drain counts this member against the caps at once.
    const rt = { member: m, session: null, resolved: null, caps: null, workspace: null, result: null,
                 offered: new Set(), staleOffers: new Set(), idle: false, stopping: false, waiter: null, question: null };
    this.#live.set(id, rt);
    this.store.setState(id, 'running');
    this.store.addEvent(id, 'started', {});

    const ctx = this.#ctx(m);
    const r = await this.#resolve(m);
    if (r.error) throw r.error;
    // Teams in other projects and v1 adapters keep today's one-shot loop, with no session
    // for send_to to deliver to.
    if (r.team || r.caps.protocol !== 2) {
      rt.oneShot = true;
      return this.#finish(id, await runMember(r.team ? ctx : { ...ctx, preresolved: r }));
    }

    const { resolved, caps } = r;
    rt.resolved = resolved;
    rt.caps = caps;
```

In `#delegate`, between `this.store.addEvent(id, 'delegated', ...)` and `this.#schedule(child.id);`, add:

```js
    this.#resolve(this.store.member(child.id));
```

Replace `#sendTo` from its signature through the `oneShot` check with:

```js
  async #sendTo(id, { to, text } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('send_to needs "text"');
    const m = this.#live.get(id).member;
    const parent = m.parent_id != null ? this.store.member(m.parent_id) : null;
    let target;
    let fromKind;
    if (parent && (to === parent.name || to === parent.id)) {
      target = parent;
      fromKind = 'report';
    } else {
      const matches = this.store.children(id).filter((c) => c.id === to || c.name === to);
      target = matches.find((c) => !TERMINAL.has(c.state)) ?? matches.at(-1);
      fromKind = 'manager';
    }
    if (!target) throw new Error(`"${to}" is not your manager or one of your reports`);
    // A queued report may still be resolving; a v1 or team report has no session to read it.
    if (fromKind === 'manager') {
      const r = await this.#resolve(target);
      if (r.team || r.caps?.protocol !== 2) {
        throw new Error(`"${target.name}" runs one-shot and cannot receive messages — wait for its result`);
      }
    }
    // Same guard as send(): a stopping member will not read another message. Re-read: the
    // target can have finished during the await.
    target = this.store.member(target.id);
    if (TERMINAL.has(target.state) || this.#live.get(target.id)?.stopping) {
      throw new Error(`"${target.name}" has finished — delegate a new task`);
    }
```

(The rest of `#sendTo`, from `const messageId = this.store.enqueue({` on, is unchanged.)

In `#waitFor`, inside the returned `Promise`, after `rt.waiter = { resolve, timer, reportIds };`, add:

```js
      this.#drain();   // a blocked member gives up its slot
```

In `#askHuman`, inside the returned `Promise`, after `rt.question = { id: questionId, resolve, timer };`, add:

```js
      this.#drain();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/scheduling.test.js test/team-tools.test.js`
Expected: PASS.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 453`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor.js test/scheduling.test.js
git commit -m "fix(supervisor): free blocked members' slots and resolve each member once"
```

---
### Task 5: Pause, pause-now, and cancel a member or a subtree

**Files:**
- Modify: `src/supervisor.js` (`send`, `#launch`, `#onExit`, `#finish`, `#pump`, `#handle`, `#delegate`, `#waitFor`, `#askHuman`; add the intervention section and `#conclude`)
- Modify: `adapters/mock-live` (`session()`: honour `interrupt` mid-turn)
- Create: `test/intervention.test.js`

**Interfaces:**
- Consumes: `MemberSession#end(graceMs)` and `#settle` (Task 3); `#drain`, `#pending` (Task 4).
- Produces:
  - `Supervisor#pause({ member_id } | { run_id, member }, { subtree?, now?, by? })` and `Supervisor#cancel(...)` with the same parameters in one object: `pause({ run_id, member, subtree, now, by })`. Both return `{ members: [{id, name}], skipped: [{id, name, reason}] }`. Without `subtree`, a member that cannot be stopped throws instead of landing in `skipped`.
  - Admin RPCs `pause` and `cancel` with the same params.
  - Private: `#target(who)` (Tasks 6 and 12 reuse it), `#subtree(id)`, `#halt(m, kind, opts)`, `#halted(id, rt)`, `#paused(m, opts)`, `#notifyManager(m, text)`, `#conclude(m, state, result, workspace)`.
  - `rt.halt = { kind: 'pause' | 'cancel', now, by }` on a runtime record while it stops.
  - Store effects: state `paused` plus event `paused {by, now}`; or state `cancelled`, result `{status: 'failed', summary: 'cancelled by <by>'}`, event `finished {status, state}`. A cancelled root ends its run `cancelled` and resolves `waitRun`.
  - Manager notices (inbox, `from_kind: 'report'`): `paused by <by>` and `finished cancelled: cancelled by <by>`. Every terminal notice starts with `finished `, so a manager looping on `wait_for` until its reports finish stops on a cancelled one.
  - `mock-live`: on `interrupt` it cuts a `sleep_ms` short and, at the next step boundary (after any tool call in flight returns), writes `idle {interrupted: true}` and exits without a `result`.

What each verb does, by the member's state (this table is also a comment above `#halt`):

| State | pause | cancel |
|---|---|---|
| `queued` | paused at once | cancelled at once |
| `paused` | error: already paused | cancelled at once |
| launching (`rt.session` still null) | marked; `#launch` stops before the spawn | same |
| `running` / `waiting` | blocked call settled with a note, then `stop` (with `now`: interrupt) | blocked call settled, then interrupt |
| one-shot (v1), stopping after its own idle, or already halting | error, nothing changes | error, nothing changes |
| `done` / `failed` / `cancelled` | error: already finished | error: already finished |

- [ ] **Step 1: Write the failing tests**

Create `test/intervention.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { project, supervise, LIVE } from './helpers/live.js';
import { callRpc } from '../src/rpc.js';

const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };
const kinds = (store, id) => store.events(id).map((e) => e.kind);

test('pause settles a blocked wait_for with a note, then the member stops as paused', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    assert.deepEqual(sup.pause({ member_id: memberId }), { members: [{ id: memberId, name: 'solo' }], skipped: [] });
    await until(() => store.member(memberId).state === 'paused');
    const result = store.events(memberId).find((e) => e.kind === 'tool_result').body.result;
    assert.deepEqual(result, { messages: [], timed_out: false, note: 'paused by local — end your turn now' });
    assert.equal(store.run(runId).status, 'running', 'a paused root does not end its run');
    assert.ok(!kinds(store, memberId).includes('finished'));
    assert.throws(() => sup.pause({ member_id: memberId }), /"solo" is already paused/);
  } finally { await sup.close(); }
});

test('pause --now interrupts the turn instead of waiting for it', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }] } }
  });
  const { sup, store } = await supervise(script, { graceMs: 10_000 });
  try {
    const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => kinds(store, memberId).includes('text'));
    const started = Date.now();
    sup.pause({ member_id: memberId, now: true, by: 'ann' });
    await until(() => store.member(memberId).state === 'paused');
    assert.ok(Date.now() - started < 3000, 'pause --now waited for SIGTERM instead of interrupting');
    assert.deepEqual(store.events(memberId).find((e) => e.kind === 'paused').body, { by: 'ann', now: true });
  } finally { await sup.close(); }
});

test('pause while the member is still launching stops it before the adapter spawns', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ say: 'ran' }] } } });
  const { sup, store } = await supervise(script);
  try {
    // submit() starts the launch, which awaits the adapter's capabilities: still launching here.
    const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    sup.pause({ member_id: memberId });
    await until(() => store.member(memberId).state === 'paused');
    assert.equal(store.member(memberId).harness_id, null, 'the adapter was spawned');
    assert.ok(!kinds(store, memberId).includes('text'));
  } finally { await sup.close(); }
});

test('cancel a subtree: reports first, the manager is told, the run ends cancelled', async () => {
  const { root, script } = project({
    lead: LIVE(), worker: LIVE({ reports_to: 'lead', isolation: 'workspace' })
  }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'worker', task: 'slow' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      worker: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }] }
    }
  });
  const { sup, store } = await supervise(script, { graceMs: 10_000 });
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.children(leadId).some((c) => kinds(store, c.id).includes('text')));
    const workerId = store.children(leadId)[0].id;
    const res = sup.cancel({ run_id: runId, member: 'lead', subtree: true });
    assert.deepEqual(res.members.map((m) => m.name), ['worker', 'lead']);
    const result = await sup.waitRun(runId);
    assert.deepEqual(result, { status: 'failed', summary: 'cancelled by local' });
    assert.equal(store.run(runId).status, 'cancelled');
    // Both were interrupted at once; the report's adapter may exit after its manager's.
    await until(() => store.member(workerId).state === 'cancelled');
    assert.equal(store.member(leadId).state, 'cancelled');
    assert.ok(existsSync(store.member(workerId).workspace), 'cancel kept the workspace');
    const notice = store.takeQueued(leadId).map((m) => m.text);
    assert.deepEqual(notice, ['finished cancelled: cancelled by local']);
  } finally { await sup.close(); }
});

test('a queued member is paused or cancelled at once', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 30_000 }] } }
  });
  const { sup, store } = await supervise(script, { maxRunning: 1, graceMs: 200 });
  try {
    sup.submit({ projectRoot: root, member: 'solo', task: 'first' });
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'second' });
    assert.equal(store.member(memberId).state, 'queued');
    sup.pause({ member_id: memberId });
    assert.equal(store.member(memberId).state, 'paused');
    sup.cancel({ member_id: memberId });
    assert.equal(store.member(memberId).state, 'cancelled');
    assert.equal((await sup.waitRun(runId)).summary, 'cancelled by local');
  } finally { await sup.close(); }
});

test('verbs out of order are refused and change nothing', async () => {
  const { root, script } = project({ solo: LIVE(), old: { agent: 'mock', isolation: 'none' } }, {
    by_member: { solo: { steps: [] }, old: { hang: true } }
  });
  const { sup, store } = await supervise(script);
  try {
    const done = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(done.runId);
    assert.throws(() => sup.cancel({ member_id: done.memberId }), /"solo" has already finished \(done\)/);
    assert.equal(store.member(done.memberId).state, 'done');

    // A v1 adapter that never answers; the run's timeout ends it after the assertions.
    const v1 = sup.submit({ projectRoot: root, member: 'old', task: 'go', timeoutMs: 1500 });
    await new Promise((r) => setTimeout(r, 500));   // past resolution, into the one-shot run
    assert.throws(() => sup.pause({ member_id: v1.memberId }), /"old" runs one-shot and cannot be paused/);
    assert.equal(store.member(v1.memberId).state, 'running');
    await sup.waitRun(v1.runId);
    assert.throws(() => sup.pause({ run_id: done.runId, member: 'nobody' }), /has no member "nobody"/);
  } finally { await sup.close(); }
});

test('pause and cancel are admin RPCs that name a member by run and name', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const res = await callRpc(sup.socketPath, { method: 'cancel', params: { run_id: runId, member: 'solo', by: 'bob' } });
    assert.deepEqual(res.members, [{ id: memberId, name: 'solo' }]);
    assert.equal((await sup.waitRun(runId)).summary, 'cancelled by bob');
  } finally { await sup.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/intervention.test.js`
Expected: FAIL, 7 tests — `TypeError: sup.pause is not a function` (and `sup.cancel`, and the RPC test's `unknown tool "cancel"`).

- [ ] **Step 3: Implement**

In `adapters/mock-live`, inside `session()`, replace the line `const rl = createInterface({ input: process.stdin });` and the `rl.on('line', ...)` line after it with:

```js
  // `interrupt` stands in for a harness's turn interrupt: a sleep is cut short, and at the
  // next step boundary the adapter reports an interrupted idle and exits without a result.
  // A tool call in flight is not abandoned: the supervisor settles blocking calls before it
  // interrupts, so their results are still recorded.
  let interrupted = false;
  let onInterrupt;
  const interruption = new Promise((r) => { onInterrupt = r; });
  const quit = () => {
    out({ type: 'idle', interrupted: true });
    process.stdout.write('', () => process.exit(0));
  };
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const m = JSON.parse(line);
    if (m.type === 'interrupt') { interrupted = true; onInterrupt(); }
    queue.push(m); wake?.(); wake = null;
  });
```

In the `for (const step of entry.steps ?? [])` loop, replace its first three lines (`drainMessages();`, the `say` line, the `sleep_ms` line) with:

```js
      if (interrupted) return quit();
      drainMessages();
      if (step.say) out({ type: 'event', kind: 'text', text: step.say });
      if (step.sleep_ms) await Promise.race([new Promise((r) => setTimeout(r, step.sleep_ms)), interruption]);
      if (interrupted) return quit();
```

In the `until_finished` loop, after `if (r.messages.length === 0 && !r.timed_out) break;   // nothing left to wait on`, add:

```js
            if (interrupted) break;
```

After the steps loop, replace `drainMessages();\n    out({ type: 'idle' });` with:

```js
    if (interrupted) return quit();
    drainMessages();
    out({ type: 'idle' });
```

and in the idle loop replace `if (m.type === 'stop' || m.type === 'interrupt') break;` with:

```js
      if (m.type === 'interrupt') return quit();
      if (m.type === 'stop') break;
```

In `src/supervisor.js`:

Replace the guard at the top of `send()` (the comment and the `if (TERMINAL.has(m.state) || ...)` line) with:

```js
    // A stopping or cancelling member will not read another message. A pausing or paused one
    // will, after it is resumed.
    const rt = this.#live.get(member_id);
    if (TERMINAL.has(m.state) || rt?.stopping || rt?.halt?.kind === 'cancel') throw new Error(`"${m.name}" has finished — delegate a new task`);
```

After `kick()`, add the intervention section:

```js
  // ---- intervention ----

  // Pause: stop after the current turn (now: interrupt it). Cancel: interrupt and end as
  // cancelled. Either keeps the workspace. With subtree, every unfinished member below too;
  // members that cannot be stopped are listed in `skipped` instead of failing the call.
  pause(p = {}) { return this.#intervene(p, 'pause'); }
  cancel(p = {}) { return this.#intervene(p, 'cancel'); }

  #intervene({ subtree = false, now = false, by = 'local', ...who } = {}, kind) {
    const top = this.#target(who);
    if (!subtree) {
      this.#halt(top, kind, { now, by });
      return { members: [{ id: top.id, name: top.name }], skipped: [] };
    }
    const members = [];
    const skipped = [];
    // Deepest first, so a report's notice is in its manager's inbox before the manager stops.
    for (const m of this.#subtree(top.id).reverse()) {
      try {
        this.#halt(m, kind, { now, by });
        members.push({ id: m.id, name: m.name });
      } catch (err) {
        skipped.push({ id: m.id, name: m.name, reason: err.message });
      }
    }
    return { members, skipped };
  }

  // A member by id, or by run and name. Names repeat when a manager delegates to the same
  // report twice; the latest unfinished one is meant.
  #target({ member_id, run_id, member } = {}) {
    if (member_id != null) {
      const m = this.store.member(Number(member_id));
      if (!m) throw new Error(`unknown member ${member_id}`);
      return m;
    }
    if (run_id == null || typeof member !== 'string') throw new Error('name a member: member_id, or run_id and member');
    const matches = this.store.members(Number(run_id)).filter((m) => m.name === member);
    if (!matches.length) throw new Error(`run ${run_id} has no member "${member}"`);
    return matches.filter((m) => !TERMINAL.has(m.state)).at(-1) ?? matches.at(-1);
  }

  #subtree(id) {
    const out = [];
    const walk = (mid) => { out.push(this.store.member(mid)); for (const c of this.store.children(mid)) walk(c.id); };
    walk(id);
    return out;
  }

  // | state                    | pause                              | cancel                      |
  // | queued                   | paused at once                     | cancelled at once           |
  // | paused                   | error                              | cancelled at once           |
  // | launching (no session)   | marked; #launch stops before spawn | same                        |
  // | running or waiting       | blocked call settled, then stop    | blocked call settled, then  |
  // |                          | (now: interrupt)                   | interrupt                   |
  // | one-shot (v1), stopping, finished, already halting: an error, nothing changes        |
  #halt(m, kind, { now, by }) {
    const verb = kind === 'pause' ? 'paused' : 'cancelled';
    if (TERMINAL.has(m.state)) throw new Error(`"${m.name}" has already finished (${m.state})`);
    const rt = this.#live.get(m.id);
    if (!rt) {
      if (kind === 'pause' && m.state === 'paused') throw new Error(`"${m.name}" is already paused`);
      const i = this.#pending.indexOf(m.id);
      if (i >= 0) this.#pending.splice(i, 1);
      if (kind === 'cancel') return this.#conclude(m, 'cancelled', { status: 'failed', summary: `cancelled by ${by}` });
      return this.#paused(m, { by, now: false });
    }
    if (rt.oneShot) throw new Error(`"${m.name}" runs one-shot and cannot be ${verb} — wait for its result`);
    if (rt.halt?.kind === 'cancel') throw new Error(`"${m.name}" is already being cancelled`);
    if (rt.halt && kind === 'pause' && (!now || rt.halt.now)) throw new Error(`"${m.name}" is already being paused`);
    if (rt.stopping && !rt.halt) throw new Error(`"${m.name}" has finished its work and is stopping`);
    rt.halt = { kind, now: now || kind === 'cancel', by };
    // A harness cannot end its turn while a tool call is pending.
    const note = this.#haltNote(rt);
    if (rt.waiter) this.#settle(rt, { messages: [], timed_out: false, note });
    if (rt.question) this.#settle(rt, { answer: null, timed_out: false, note });
    if (!rt.session) return;   // still launching: #launch checks rt.halt before it spawns
    if (rt.halt.now) rt.session.end(this.graceMs);
    else rt.session.send({ type: 'stop' });
  }

  #haltNote(rt) {
    return `${rt.halt.kind === 'pause' ? 'paused' : 'cancelled'} by ${rt.halt.by} — end your turn now`;
  }

  // A halting member's adapter has exited, or it never spawned.
  #halted(id, rt) {
    this.#live.delete(id);
    for (const mid of rt.offered) this.store.requeue(mid);
    this.#settle(rt, { error: 'member stopped' });
    const { kind, by, now } = rt.halt;
    if (kind === 'cancel') {
      return this.#conclude(rt.member, 'cancelled', { status: 'failed', summary: `cancelled by ${by}` }, rt.workspace);
    }
    this.#paused(rt.member, { by, now });
  }

  #paused(m, { by, now }) {
    this.store.setState(m.id, 'paused');
    this.store.addEvent(m.id, 'paused', { by, now });
    this.#notifyManager(m, `paused by ${by}`);
    this.#drain();
  }

  #notifyManager(m, text) {
    if (m.parent_id == null) return;
    this.store.enqueue({ to: m.parent_id, fromKind: 'report', fromName: m.name, reportId: m.id, text });
    this.#pump(m.parent_id);
  }
```

In `#launch`, after `if (r.error) throw r.error;`, add:

```js
    if (rt.halt) return this.#halted(id, rt);   // paused or cancelled while resolving
```

In `#onExit`, after the `if (this.#closing) { ... }` block, add:

```js
    // Pausing or cancelling wins over whatever the adapter reported on its way out.
    if (rt.halt) return this.#halted(id, rt);
```

Replace `#finish` from `this.#settle(rt, { error: 'member finished' });` to the end of the method with the following, which moves the bookkeeping into `#conclude`:

```js
    this.#settle(rt, { error: 'member finished' });
    this.#conclude(rt.member, result.status === 'ok' ? 'done' : 'failed', result, rt.workspace);
  }

  // Records a member's terminal state, tells its manager or ends the run, and frees its slot.
  // Also used for members that are not live: a cancelled queued or paused member.
  #conclude(m, state, result, workspace = null) {
    const id = m.id;
    this.store.setState(id, state);
    this.store.setResult(id, result);
    this.store.addEvent(id, 'finished', { status: result.status, state });
    if (state === 'done' && workspace) pruneWorkspace(workspace);

    if (m.parent_id != null) {
      const stat = result.artifacts?.diff_stat ? `\n${result.artifacts.diff_stat}` : '';
      // Every terminal notice opens with "finished ", so a manager waiting for its reports
      // stops waiting on a cancelled one too.
      const outcome = state === 'cancelled' ? 'cancelled' : result.status;
      this.#notifyManager(m, `finished ${outcome}: ${result.summary ?? ''}${stat}`);
    } else {
      this.store.finishRun(m.run_id, state);
      for (const resolve of this.#runWaiters.get(m.run_id) ?? []) resolve(this.store.member(id).result);
      this.#runWaiters.delete(m.run_id);
    }
    this.#drain();
  }
```

In `#pump`, replace `if (rt.stopping) return;` with:

```js
    // A halting member's messages wait in the inbox for its resume.
    if (rt.stopping || rt.halt) return;
```

In `#handle`, add to the `admin` object:

```js
      pause: (p) => this.pause(p),
      cancel: (p) => this.cancel(p)
```

A halting member may still call tools before its turn ends. In `#delegate`, after `const { config, budget } = this.#runs.get(m.run_id);`, add:

```js
    if (rt.halt) throw new Error(`delegation refused: ${this.#haltNote(rt)}`);
```

In `#waitFor`, after `this.#assertNotBlocked(rt);`, add:

```js
    if (rt.halt) return { messages: [], timed_out: false, note: this.#haltNote(rt) };
```

In `#askHuman`, after `this.#assertNotBlocked(rt);`, add:

```js
    if (rt.halt) return { answer: null, timed_out: false, note: this.#haltNote(rt) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/intervention.test.js test/supervisor.test.js`
Expected: PASS, 14 tests. (`close() settles a blocked wait_for` in `supervisor.test.js` pins that `mock-live` still records a settled tool call's result before it quits on `interrupt`.)

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 460`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor.js adapters/mock-live test/intervention.test.js
git commit -m "feat(supervisor): pause, pause-now, and cancel members and subtrees"
```

---
### Task 6: Resume a paused member or subtree in its own workspace

**Files:**
- Modify: `src/dispatch.js` (`prepareMember` takes an existing workspace)
- Modify: `src/supervisor.js` (field `#resumes`; `resume`, `#unpause`; `#launch`, `#onLine`, `#handle`)
- Modify: `adapters/mock-live` (reports a resume id; plays `on_resume.steps` when resumed)
- Create: `test/resume.test.js`

**Interfaces:**
- Consumes: `store.setResume(id, resume)` (Task 2); `#target`, `#subtree`, the `paused` event body `{by, now}` (Task 5); `#schedule` / `#launch` (Task 4).
- Produces:
  - `prepareMember(ctx, { resolved, caps }, { workspaceDir } = {})`: with `workspaceDir`, reuses that directory (`workspace = { dir, branch: null, kind: 'resumed' }`) and throws `cannot resume "<member>": its workspace <dir> is gone` when it no longer exists.
  - `Supervisor#resume({ member_id } | { run_id, member }, plus `subtree?`, `note?`, `by?` in the same object)` → `{ members, skipped }`; admin RPC `resume`. Subtree order is top-down. A member that is not `paused` throws `"<name>" is not paused (<state>)`.
  - The resumed launch sends `start { brief, resume, note }`. `resume` is `members.resume` (the adapter's own `session.resume`); `note` is `Resumed by <by>.`, plus the interrupted-turn warning when the pause was `now`, plus `<by>: <note>`. When the member has no stored resume id, the note is appended to `brief.task` instead and `resume`/`note` are `null`.
  - `#onLine` stores a non-null `session.resume`.
  - Event `resumed {by}`. Resume goes through `#schedule`, so `maxRunning` and `max_parallel` apply.
  - `mock-live`: `session.resume` is `start.resume ?? "mock-session-<member>-<pid>"`; on resume it records `[resume <id>] <note>` first in `received` and plays `on_resume.steps` (default none).
  - `#resumes` and `#launch`'s `resume` handling are what Task 8 (recovery) and Task 12 (take-over) reuse.

- [ ] **Step 1: Write the failing tests**

Create `test/resume.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { project, supervise, LIVE } from './helpers/live.js';
import { callRpc } from '../src/rpc.js';

const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };

// A root that blocks in wait_for, so it can be paused at a known point.
const blocked = (extra = {}) => ({ by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], ...extra } } });

test('resume relaunches the session in its workspace and delivers what was sent while paused', async () => {
  const { root, script } = project({ solo: LIVE({ isolation: 'workspace' }) }, blocked());
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const { workspace, resume: sid } = store.member(memberId);
    assert.match(sid, /^mock-session-solo-/);
    sup.pause({ member_id: memberId });
    await until(() => store.member(memberId).state === 'paused');

    assert.deepEqual(sup.send({ member_id: memberId, text: 'while you were out' }), { message_id: 1 });
    sup.resume({ member_id: memberId, note: 'carry on', by: 'ann' });
    const result = await sup.waitRun(runId);

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.received, [
      `[resume ${sid}] Resumed by ann.\nann: carry on`,
      '[from: local (human)] while you were out'
    ]);
    assert.equal(store.member(memberId).workspace, workspace, 'resume used a new workspace');
    assert.equal(store.member(memberId).resume, sid);
    assert.deepEqual(store.events(memberId).filter((e) => e.kind === 'resumed').map((e) => e.body), [{ by: 'ann' }]);
  } finally { await sup.close(); }
});

test('resume after pause --now warns that the interrupted turn may have partly run', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.events(memberId).some((e) => e.kind === 'text'));
    sup.pause({ member_id: memberId, now: true });
    await until(() => store.member(memberId).state === 'paused');
    sup.resume({ member_id: memberId });
    const [note] = (await sup.waitRun(runId)).received;
    assert.match(note, /Resumed by local\.\nYour last turn was interrupted: a command it started may have partly run\./);
  } finally { await sup.close(); }
});

test('resume fails the member clearly when its workspace was deleted', async () => {
  const { root, script } = project({ solo: LIVE({ isolation: 'workspace' }) }, blocked());
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    sup.pause({ member_id: memberId });
    await until(() => store.member(memberId).state === 'paused');
    const { workspace } = store.member(memberId);
    rmSync(workspace, { recursive: true, force: true });
    sup.resume({ member_id: memberId });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'failed');
    assert.equal(result.summary, `cannot resume "solo": its workspace ${workspace} is gone`);
    assert.equal(store.member(memberId).state, 'failed');
  } finally { await sup.close(); }
});

test('resume refuses a member that is not paused', async () => {
  const { root, script } = project({ solo: LIVE() }, blocked());
  const { sup, store } = await supervise(script);
  try {
    const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    assert.throws(() => sup.resume({ member_id: memberId }), /"solo" is not paused \(waiting\)/);
    assert.equal(store.member(memberId).state, 'waiting');
  } finally { await sup.close(); }
});

test('a paused subtree resumes together and the run finishes', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'worker', task: 'w' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      worker: { steps: [{ tool: 'wait_for', args: {} }] }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.members(runId).length === 2 && store.members(runId).every((m) => m.state === 'waiting'));
    sup.pause({ member_id: leadId, subtree: true });
    await until(() => store.members(runId).every((m) => m.state === 'paused'));
    const res = await callRpc(sup.socketPath, { method: 'resume', params: { run_id: runId, member: 'lead', subtree: true } });
    assert.deepEqual(res.members.map((m) => m.name), ['lead', 'worker']);
    assert.equal((await sup.waitRun(runId)).status, 'ok');
    assert.deepEqual(store.members(runId).map((m) => m.state), ['done', 'done']);
  } finally { await sup.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/resume.test.js`
Expected: FAIL — `store.member(memberId).resume` is `null` (`mock-live` reports none and `#onLine` does not store it), and `TypeError: sup.resume is not a function`.

- [ ] **Step 3: Implement**

In `src/dispatch.js`, change the `prepareMember` signature to:

```js
export function prepareMember(ctx, { resolved, caps }, { workspaceDir = null } = {}) {
```

and replace `if (caps.live_session === true) {` (the first branch of the workspace `if` chain) with:

```js
  if (workspaceDir) {
    // A resumed session goes back to the directory it ran in; claude keys its sessions by cwd.
    if (!existsSync(workspaceDir)) throw new Error(`cannot resume "${member}": its workspace ${workspaceDir} is gone`);
    workspace = { dir: workspaceDir, branch: null, kind: 'resumed' };
  } else if (caps.live_session === true) {
```

In `adapters/mock-live`, replace the line `out({ type: 'session', harness_id: ..., resume: null });` with:

```js
    // A resumed session keeps the id it was given; a fresh one makes its own. On resume the
    // member plays `on_resume.steps` instead of `steps`.
    out({ type: 'session', harness_id: `mock-live-${brief.member}-${process.pid}`,
          resume: start.resume ?? `mock-session-${brief.member}-${process.pid}` });
    if (start.resume) {
      received.push(`[resume ${start.resume}] ${start.note}`);
      out({ type: 'event', kind: 'user', text: start.note });
    }
    const steps = start.resume ? entry.on_resume?.steps ?? [] : entry.steps ?? [];
```

and change the steps loop header from `for (const step of entry.steps ?? []) {` to:

```js
    for (const step of steps) {
```

In `src/supervisor.js`, add a field below `#runWaiters`:

```js
  #resumes = new Map();       // memberId -> { note } for a paused member's next launch
```

After `cancel(p = {}) { ... }`, add:

```js
  // Relaunches paused members in their own workspaces, with their harness session resumed
  // and `note` as the first user turn. Queued messages are delivered once the session is up.
  resume({ subtree = false, note = null, by = 'local', ...who } = {}) {
    const top = this.#target(who);
    if (!subtree) {
      this.#unpause(top, { note, by });
      return { members: [{ id: top.id, name: top.name }], skipped: [] };
    }
    const members = [];
    const skipped = [];
    for (const m of this.#subtree(top.id)) {
      try {
        this.#unpause(m, { note, by });
        members.push({ id: m.id, name: m.name });
      } catch (err) {
        skipped.push({ id: m.id, name: m.name, reason: err.message });
      }
    }
    return { members, skipped };
  }

  #unpause(m, { note, by }) {
    if (m.state !== 'paused') throw new Error(`"${m.name}" is not paused (${m.state})`);
    const paused = this.store.events(m.id).findLast((e) => e.kind === 'paused')?.body ?? {};
    const lines = [`Resumed by ${by}.`];
    if (paused.now) {
      lines.push('Your last turn was interrupted: a command it started may have partly run. ' +
                 'Check the workspace before repeating work.');
    }
    if (typeof note === 'string' && note.trim()) lines.push(`${by}: ${note}`);
    this.#resumes.set(m.id, { note: lines.join('\n') });
    this.store.setState(m.id, 'queued');
    this.store.addEvent(m.id, 'resumed', { by });
    this.#schedule(m.id);
  }
```

In `#launch`, after `const run = this.#runs.get(m.run_id);`, add:

```js
    const resume = this.#resumes.get(id) ?? null;
    this.#resumes.delete(id);
```

Replace `const prep = prepareMember(ctx, { resolved, caps });` with:

```js
    // A member paused before its adapter ever ran has no workspace yet and starts fresh.
    const prep = prepareMember(ctx, { resolved, caps }, { workspaceDir: resume ? m.workspace : null });
```

Replace `rt.session.send({ type: 'start', brief });` with:

```js
    // With no harness session to resume, the note rides along with the task instead.
    if (resume && !m.resume) brief.task += `\n\n${resume.note}`;
    rt.session.send({
      type: 'start', brief,
      resume: resume ? m.resume : null,
      note: resume && m.resume ? resume.note : null
    });
```

In `#onLine`, replace `if (msg.type === 'session') this.store.setHarness(id, msg.harness_id);` with:

```js
    if (msg.type === 'session') {
      this.store.setHarness(id, msg.harness_id);
      if (msg.resume != null) this.store.setResume(id, msg.resume);
    }
```

In `#handle`, add `resume: (p) => this.resume(p),` to the `admin` object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/resume.test.js test/intervention.test.js`
Expected: PASS, 12 tests.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 465`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.js src/supervisor.js adapters/mock-live test/resume.test.js
git commit -m "feat(supervisor): resume paused members in their own workspaces"
```

---

### Task 7: ask_human reclaims human and manager messages; list open questions

1a downgraded the spec: a message to a member blocked in `ask_human` sat on stdin until the human answered. This task makes a human or manager message cut the question short, as `wait_for` does, and adds the `questions` admin RPC so `agent-team answer` can find a question id under `serve` (Task 10 adds the CLI verbs).

**Files:**
- Modify: `src/supervisor.js` (`#pump`, `#handle`; add `questions`)
- Modify: `src/team-tools.js` (`ask_human` description)
- Modify: `docs/superpowers/specs/2026-10-12-steerable-teams-design.md` ("Every inbox message is delivered once" paragraph)
- Modify: `docs/adapters.md` ("Message delivery")
- Create: `test/questions.test.js`

**Interfaces:**
- Consumes: `store.claimForQuestion(memberId)` and `store.closeQuestion(id)` (Task 2), `#resolveQuestion(id, value)` (1a), `render` (1a).
- Produces: `Supervisor#questions({run_id?}) -> [{id, run_id, member_id, member, question, options, asked_at}]`; admin RPC `questions`. A reclaimed `ask_human` returns `{answer: null, timed_out: false, messages: [{id, from, text, report_id}], note}`.

- [ ] **Step 1: Write the failing tests**

Create `test/questions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, supervise, LIVE } from './helpers/live.js';
import { callRpc } from '../src/rpc.js';

const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };

test('a human message cuts ask_human short and closes the question', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'a or b?' } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.openQuestions().length === 1);
    const [{ id: questionId }] = store.openQuestions();
    const { message_id } = sup.send({ member_id: memberId, text: 'use b', from: 'ann' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result, {
      answer: null, timed_out: false,
      messages: [{ id: message_id, from: 'ann (human)', text: 'use b', report_id: null }],
      note: 'question closed: a message arrived before an answer'
    });
    assert.deepEqual(result.received, [], 'the message was delivered twice');
    assert.equal(store.question(questionId).closed, 1);
    assert.throws(() => sup.answer({ question_id: questionId, answer: 'a' }), /no longer open/);
  } finally { await sup.close(); }
});

test("a report's progress does not cut its manager's question short", async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'worker', task: 'w' } },
        { tool: 'ask_human', args: { question: 'ship it?' } }
      ] },
      worker: { steps: [{ tool: 'report_progress', args: { text: 'half way' } }] }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.openQuestions().length === 1 && store.children(leadId)[0]?.state === 'done');
    assert.equal(store.member(leadId).state, 'waiting');
    sup.answer({ question_id: store.openQuestions()[0].id, answer: 'yes', by: 'ann' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[1].result, { answer: 'yes', answered_by: 'ann', timed_out: false });
    assert.equal(result.received.length, 2, 'progress and the finish notice arrive after the answer');
  } finally { await sup.close(); }
});

test('the questions RPC lists open questions with who asked them', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'a or b?', options: ['a', 'b'] } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.openQuestions().length === 1);
    const listed = await callRpc(sup.socketPath, { method: 'questions', params: { run_id: runId } });
    assert.equal(listed.length, 1);
    assert.deepEqual({ ...listed[0], id: 0, asked_at: 0 }, {
      id: 0, run_id: runId, member_id: memberId, member: 'solo', question: 'a or b?', options: ['a', 'b'], asked_at: 0
    });
    assert.deepEqual(await callRpc(sup.socketPath, { method: 'questions', params: { run_id: runId + 1 } }), []);
    await callRpc(sup.socketPath, { method: 'answer', params: { question_id: listed[0].id, answer: 'a' } });
    await sup.waitRun(runId);
    assert.deepEqual(sup.questions(), []);
  } finally { await sup.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test --test-name-pattern 'questions RPC|progress does not' test/questions.test.js`
Expected: `ℹ pass 1`, `ℹ fail 1`, with `Error: unknown tool "questions"`. The progress test passes already; it pins that progress does not cut a question short. The first test is left out here because, before the fix, it blocks on the question and keeps the runner alive.

- [ ] **Step 3: Implement**

In `src/supervisor.js`, after the `answer` method, add:

```js
  // Open ask_human questions, newest last, with who asked; `answer` takes their ids.
  questions({ run_id = null } = {}) {
    return this.store.openQuestions().map((q) => {
      const m = this.store.member(q.member_id);
      return { id: q.id, run_id: m.run_id, member_id: m.id, member: m.name,
               question: q.question, options: q.options, asked_at: q.at };
    }).filter((q) => run_id == null || q.run_id === Number(run_id));
  }
```

In `#pump`, directly before `// A halting member's messages wait in the inbox for its resume.` (Task 5), add:

```js
    // A human or the manager can cut a question short, as wait_for would be; a report's
    // progress is offered to the harness as usual and read after the answer.
    if (rt.question) {
      const msgs = this.store.claimForQuestion(id);
      for (const m of msgs) { rt.offered.delete(m.id); rt.staleOffers.delete(m.id); }
      if (msgs.length) {
        this.store.closeQuestion(rt.question.id);
        this.#resolveQuestion(id, {
          answer: null, timed_out: false, messages: msgs.map(render),
          note: 'question closed: a message arrived before an answer'
        });
      }
    }
```

In `#handle`'s `admin` object, add `questions: (p) => this.questions(p),`.

In `src/team-tools.js`, replace the `ask_human` description with:

```js
    description: 'Ask a human and block until they answer. Returns {answer}; or {answer: null, timed_out: true}, in which case decide yourself; or {answer: null, messages}, when a human or your manager wrote to you first.',
```

In the spec, replace the two sentences starting `` `ask_human` does not reclaim: `` with:

```
`ask_human` reclaims too, but only messages from a human or the member's manager: such a
message closes the question and is returned as the result. A report's progress is offered to
the session as usual and read after the answer.
```

In `docs/adapters.md`, replace the paragraph starting `` `ask_human` does not reclaim messages. `` with:

```
`ask_human` reclaims messages from a human or the member's manager the same way: the question
is closed and the call returns `{answer: null, timed_out: false, messages, note}`. A report's
progress is not reclaimed; it is offered on stdin and read after the answer.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/questions.test.js`
Expected: PASS, 3 tests.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 468`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor.js src/team-tools.js test/questions.test.js docs/adapters.md docs/superpowers/specs/2026-10-12-steerable-teams-design.md
git commit -m "feat(supervisor): let humans and managers cut ask_human short"
```

---

### Task 8: Restart recovery

`close()` (Task 3) leaves members in their states. This task makes `serve` adopt runs that no live supervisor owns, rebuild their in-memory run entry from the store, and relaunch the members that were working from their harness sessions.

A run's owner is the socket path of the supervisor that runs it. Recovery adopts a run only when nothing listens on that path, so `serve` never takes a run from a live CLI's in-process supervisor, and a test can stand in for a restart by closing one supervisor and opening another on the same store.

**Files:**
- Modify: `src/store.js` (second migration; `createRun` takes `owner`; add `setRunOwner`, `runsWithStatus`, `requeueOffered`)
- Modify: `src/supervisor.js` (import `isListening`; `submit`, `#delegate`, `#launch`, `#target`; add the recovery section and `#owned`)
- Modify: `bin/agent-team.js` (`serve` calls `recover()`)
- Modify: `test/helpers/live.js` (`supervise` accepts `store`)
- Modify: `docs/how-it-works.md` ("Live runs")
- Test: `test/store.test.js`; create `test/recovery.test.js`

**Interfaces:**
- Consumes: Task 2's columns (`runs.timeout_ms`, `runs.budget`, `members.resume`) and `store.setBudget`, `#resumes` and `#launch`'s resume path (Task 6), `isListening(path)` from `src/rpc.js`.
- Produces: `Supervisor#recover() -> Promise<{recovered: number[], failed: number[]}>`; `store.setRunOwner(id, owner)`, `store.runsWithStatus(status)`, `store.requeueOffered(memberId)`; `#resumes` entries gain `restart: true`. Every admin verb that names a member (`pause`, `cancel`, `resume`) refuses a member of a run this supervisor does not own.

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.js`:

```js
test('runs record their owner, and recovery queries find running runs and offered messages', () => {
  const { store, runId, lead } = seeded();
  store.setRunOwner(runId, '/tmp/a.sock');
  assert.equal(store.run(runId).owner, '/tmp/a.sock');
  assert.deepEqual(store.runsWithStatus('running').map((r) => r.id), [runId]);
  store.finishRun(runId, 'done');
  assert.deepEqual(store.runsWithStatus('running'), []);
  const a = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'b', text: 'a' });
  store.offerQueued(lead.id);
  store.requeueOffered(lead.id);
  assert.equal(store.message(a).state, 'queued');
});
```

In `test/helpers/live.js`, in `supervise`, replace `const store = openStore(':memory:');` with:

```js
  const store = opts.store ?? openStore(':memory:');   // shared to stand in for a restart
```

Create `test/recovery.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { project, supervise, LIVE } from './helpers/live.js';

const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };

// A manager waiting on a slow report. After a restart both resume: the report plays
// `on_resume.steps` (none) and finishes; the manager waits for it again.
const team = () => project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
  by_member: {
    lead: {
      steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }],
      on_resume: { steps: [{ tool: 'wait_for', args: {} }] }
    },
    worker: { steps: [{ sleep_ms: 30_000 }], on_resume: { steps: [] } }
  }
});

test('a restart resumes working members from their sessions and tells the manager its reports', async () => {
  const { root, script } = team();
  const first = await supervise(script);
  const { store } = first;
  const { runId, memberId: leadId } = first.sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
  await until(() => store.member(leadId).state === 'waiting' && store.children(leadId)[0]?.resume);
  const workerId = store.children(leadId)[0].id;
  const sid = store.member(workerId).resume;
  await first.sup.close();
  assert.equal(store.member(workerId).state, 'running');

  const { sup } = await supervise(script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const note = result.received[0];
    assert.match(note, /^\[resume mock-session-lead-\d+\] The agent-team supervisor restarted while you were working/);
    assert.match(note, /A wait_for or ask_human call you were in was ended/);
    assert.match(note, new RegExp(`- worker \\(#${workerId}\\): running`));
    // The worker's notice comes as the wait_for result, or on stdin if it beat the lead's launch.
    const seen = [...result.received, ...result.tool_results[0].result.messages.map((m) => m.text)];
    assert.equal(seen.filter((t) => /finished ok: done/.test(t)).length, 1);
    assert.equal(store.member(workerId).resume, sid, 'the worker came back to the same session');
    assert.deepEqual(store.events(workerId).filter((e) => e.kind === 'interrupted').map((e) => e.body),
      [{ by: 'supervisor restart' }]);
    assert.equal(store.run(runId).owner, sup.socketPath);
  } finally { await sup.close(); }
});

test('a run whose project config is gone fails with the reason; other runs still recover', async () => {
  const a = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], on_resume: { steps: [] } } } });
  const b = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], on_resume: { steps: [] } } } });
  const first = await supervise(a.script);
  const { store } = first;
  const runA = first.sup.submit({ projectRoot: a.root, member: 'solo', task: 'go' });
  const runB = first.sup.submit({ projectRoot: b.root, member: 'solo', task: 'go' });
  await until(() => store.member(runA.memberId).state === 'waiting' && store.member(runB.memberId).state === 'waiting');
  await first.sup.close();
  rmSync(join(a.root, '.claude', 'agent-team.json'));

  const { sup } = await supervise(a.script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runB.runId], failed: [runA.runId] });
    assert.equal(store.run(runA.runId).status, 'failed');
    assert.match(store.member(runA.memberId).result.summary, /^could not recover after a supervisor restart: /);
    assert.equal((await sup.waitRun(runB.runId)).status, 'ok');
  } finally { await sup.close(); }
});

test('recover leaves alone a run whose supervisor is still listening', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } } });
  const first = await supervise(script);
  const second = await supervise(script, { store: first.store });
  try {
    const { memberId } = first.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => first.store.member(memberId).state === 'waiting');
    assert.deepEqual(await second.sup.recover(), { recovered: [], failed: [] });
    assert.throws(() => second.sup.pause({ member_id: memberId }), /is run by another supervisor/);
    assert.equal(first.store.member(memberId).state, 'waiting');
  } finally {
    await second.sup.close();
    await first.sup.close();
  }
});

test('a one-shot member left running fails on recovery: it has no session to resume', async () => {
  const { root, script } = project({ solo: { agent: 'mock', isolation: 'none' } }, {});
  const { sup, store } = await supervise(script);
  try {
    const runId = store.createRun({ project: root, task: 'go', owner: join(root, 'gone.sock') });
    const { id } = store.addMember({ runId, parentId: null, name: 'solo', task: 'go', depth: 0 });
    store.setRunRoot(runId, id);
    store.setState(id, 'running');
    await sup.recover();
    assert.deepEqual(await sup.waitRun(runId), { status: 'failed', summary: 'interrupted by a supervisor restart' });
  } finally { await sup.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js test/recovery.test.js`
Expected: FAIL, 5 tests, with `store.setRunOwner is not a function` and `sup.recover is not a function`.

- [ ] **Step 3: Implement the store side**

In `src/store.js`, add a second entry to `MIGRATIONS`:

```js
  // The socket of the supervisor running the run; recovery adopts a run only when nothing
  // listens there any more.
  `ALTER TABLE runs ADD COLUMN owner TEXT;`
```

Replace `createRun` with:

```js
    createRun: ({ project, task, timeoutMs = null, budget = null, maxCostUsd = null, owner = null }) => Number(
      q("INSERT INTO runs (project, task, status, created_at, timeout_ms, budget, max_cost_usd, owner) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)")
        .run(project, task, now(), timeoutMs, budget, maxCostUsd, owner).lastInsertRowid),
    setRunOwner: (id, owner) => q('UPDATE runs SET owner = ? WHERE id = ?').run(owner, id),
    runsWithStatus: (status) => q('SELECT * FROM runs WHERE status = ? ORDER BY id').all(status),
```

After `requeue`, add:

```js
    // After a restart nothing holds an offer: every unacked one goes back to the queue.
    requeueOffered: (memberId) =>
      q("UPDATE messages SET state = 'queued' WHERE to_member = ? AND state = 'offered'").run(memberId),
```

- [ ] **Step 4: Implement the supervisor side**

In `src/supervisor.js`, change the rpc import to `import { serveRpc, isListening } from './rpc.js';`.

In `submit`, replace the `createRun` line and the `this.#runs.set(...)` statement with:

```js
    const limits = { budget: config.defaults.max_delegations,
                     timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs };
    // Limits and owner are stored so a restarted supervisor can rebuild the run.
    const runId = this.store.createRun({ project: projectRoot, task, ...limits, owner: this.socketPath });
    this.#runs.set(runId, { projectRoot, config, budget: { runs: limits.budget }, timeoutMs: limits.timeoutMs });
```

In `#delegate`, after `budget.runs -= 1;`, add `this.store.setBudget(m.run_id, budget.runs);`.

In `#launch`, replace the one-shot branch body (`rt.oneShot = true;` and the `return this.#finish(...)` after it) with:

```js
      rt.oneShot = true;
      // A one-shot member has no session to resume after a restart.
      if (resume?.restart) return this.#finish(id, { status: 'failed', summary: 'interrupted by a supervisor restart' });
      const result = await runMember(r.team ? ctx : { ...ctx, preresolved: r });
      if (!this.#closing) this.store.setBudget(m.run_id, ctx.budget.runs);   // a team spends the run's budget too
      return this.#finish(id, result);
```

In `#target` (Task 5), wrap both returned members in `this.#owned(...)`: `return this.#owned(m);` in the `member_id` branch and `return this.#owned(matches.filter((m) => !TERMINAL.has(m.state)).at(-1) ?? matches.at(-1));` at the end. Add before `#subtree`:

```js
  // Another supervisor (a CLI's in-process one) may be running this member's run.
  #owned(m) {
    if (!this.#runs.has(m.run_id)) {
      throw new Error(`run ${m.run_id} is run by another supervisor (${this.store.run(m.run_id).owner})`);
    }
    return m;
  }
```

Add this section before `// ---- scheduling ----`:

```js
  // ---- recovery ----

  // Adopts runs left running by a supervisor that is gone: this one before a restart, or a
  // CLI's in-process one. `serve` calls it once after start(). Members that were working are
  // relaunched from their harness sessions within the caps; paused ones stay paused.
  async recover() {
    const out = { recovered: [], failed: [] };
    for (const run of this.store.runsWithStatus('running')) {
      if (this.#runs.has(run.id) || (run.owner && await isListening(run.owner))) continue;
      let config;
      try {
        config = loadConfig(run.project);
      } catch (err) {
        this.#failRun(run, `could not recover after a supervisor restart: ${err.message}`);
        out.failed.push(run.id);
        continue;
      }
      this.#runs.set(run.id, {
        projectRoot: run.project, config,
        budget: { runs: run.budget ?? config.defaults.max_delegations },
        timeoutMs: run.timeout_ms ?? this.timeoutMs
      });
      this.store.setRunOwner(run.id, this.socketPath);
      for (const m of this.store.members(run.id)) this.#recoverMember(m);
      out.recovered.push(run.id);
    }
    return out;
  }

  #recoverMember(m) {
    if (TERMINAL.has(m.state) || m.state === 'paused') return;
    this.store.requeueOffered(m.id);
    if (m.state === 'queued') {
      // Queued after a resume: it has a workspace and maybe a session to go back to.
      if (m.workspace) this.#resumes.set(m.id, { note: 'Resumed after an agent-team supervisor restart.' });
      return this.#schedule(m.id);
    }
    // running or waiting: its process ended with the old supervisor.
    for (const q of this.store.openQuestions()) if (q.member_id === m.id) this.store.closeQuestion(q.id);
    const lines = ['The agent-team supervisor restarted while you were working, and your last turn ' +
                   'was cut off: a command it started may have partly run. Check the workspace ' +
                   'before repeating work.'];
    if (m.state === 'waiting') lines.push('A wait_for or ask_human call you were in was ended; call it again if you still need it.');
    const reports = this.store.children(m.id);
    if (reports.length) {
      lines.push('Your reports now:', ...reports.map((r) => `- ${r.name} (#${r.id}): ${r.state}`));
    }
    this.store.addEvent(m.id, 'interrupted', { by: 'supervisor restart' });
    this.store.setState(m.id, 'queued');
    this.#resumes.set(m.id, { note: lines.join('\n'), restart: true });
    this.#schedule(m.id);
  }

  // A run that cannot be rebuilt: every unfinished member fails with the reason.
  #failRun(run, summary) {
    for (const m of this.store.members(run.id)) {
      if (TERMINAL.has(m.state)) continue;
      this.store.setState(m.id, 'failed');
      this.store.setResult(m.id, { status: 'failed', summary });
      this.store.addEvent(m.id, 'finished', { status: 'failed', state: 'failed' });
    }
    this.store.finishRun(run.id, 'failed');
  }
```

Members are scheduled in id order, so a manager is queued before its reports; `maxRunning` and `max_parallel` apply as for any launch.

In `bin/agent-team.js`, in the `serve` block, after the `listening on` line, add:

```js
  // Runs left behind by a previous serve, or by a CLI whose in-process supervisor died.
  const { recovered, failed } = await sup.recover();
  if (recovered.length || failed.length) {
    process.stderr.write(`agent-team: recovered runs [${recovered.join(', ')}]; could not recover [${failed.join(', ')}]\n`);
  }
```

In `docs/how-it-works.md`, "Live runs", after the store/socket table's paragraph about modes, add:

```
When `serve` starts, it adopts every run still marked running whose supervisor no longer
listens: its own runs from before a restart, and a CLI's run whose in-process supervisor
died. Members that were working are relaunched from their harness sessions in their own
workspaces, within the caps, with a note that their last turn was cut off; a manager is also
given its reports' states. A one-shot (v1) member cannot be resumed and fails. A run whose
project config can no longer be read fails with the reason. `serve` does not watch for
in-process supervisors that die while it runs; it adopts their runs at its next start.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js test/recovery.test.js`
Expected: PASS, 18 tests.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 473`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/store.js src/supervisor.js bin/agent-team.js test/helpers/live.js test/store.test.js test/recovery.test.js docs/how-it-works.md
git commit -m "feat(supervisor): recover runs left behind by a restart"
```

---

### Task 9: Stalls, v2 timeouts, and the run cost cap

One supervisor-wide ticker (every `tickMs`, default 1 s) does three things for each live session: it counts the member's working time against the run's timeout, notices a working member that has been quiet for `stall_minutes`, and leaves both clocks alone while the member is blocked in `wait_for` or `ask_human`, idle between turns, or stopping. A manager waiting on its reports would otherwise time out or stall for doing exactly what it should. Cost is checked on every `idle {cost_usd}`.

This task also brings `docs/adapters.md` up to date with the contract Tasks 5–6 changed (`start {brief, resume, note}`, `interrupt`, `idle {interrupted, cost_usd}`).

**Files:**
- Modify: `src/config.js` (`defaults.stall_minutes`, `defaults.max_cost_usd`)
- Modify: `src/supervisor.js` (fields, constructor, `start`, `close`, `submit`, `send`, `resume`, `#halt`, `#haltNote`, `#halted`, `#launch`, `#onLine`; add `#allowSpend` and the limits section)
- Modify: `adapters/mock-live` (`turn_cost_usd` on every idle)
- Modify: `test/helpers/live.js` (`supervise` passes `tickMs`, default 50)
- Modify: `docs/adapters.md`, `docs/how-it-works.md`, spec ("Errors and recovery")
- Test: `test/config.test.js`; create `test/limits.test.js`

**Interfaces:**
- Consumes: `store.addRunCost`, `store.setRunCap`, `runs.max_cost_usd` (Task 2); `#intervene`, `#notifyManager`, `rt.halt` (Task 5); `#resumes` (Task 6).
- Produces: `new Supervisor({..., tickMs})`; `submit({..., maxCostUsd})`; `resume({..., max_cost_usd})` raises the run's cap and refuses to resume a run at its cap without one; events `stalled {quiet_s}`, `timed_out {after_s}`, `cost_cap {cost_usd, max_cost_usd}`; a manager receives `stalled: no events for <n>s` from a stalled report; a third halt kind, `timeout`, ends the member `failed` with `timed out after <s>s of work`.

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.js`:

```js
test('defaults.stall_minutes defaults to 10 and max_cost_usd to no cap', () => {
  const base = { members: { a: { agent: 'mock' } }, deny_paths: ['x'] };
  const { defaults } = parseConfig(base, 'c.json');
  assert.equal(defaults.stall_minutes, 10);
  assert.equal(defaults.max_cost_usd, null);
  assert.equal(parseConfig({ ...base, defaults: { stall_minutes: 0.5, max_cost_usd: 2 } }, 'c.json').defaults.max_cost_usd, 2);
  assert.throws(() => parseConfig({ ...base, defaults: { stall_minutes: 0 } }, 'c.json'),
    /"defaults.stall_minutes" must be a positive number of minutes/);
  assert.throws(() => parseConfig({ ...base, defaults: { max_cost_usd: '5' } }, 'c.json'),
    /"defaults.max_cost_usd" must be a positive number of dollars, or null/);
});
```

In `test/helpers/live.js`, in `supervise`, replace `graceMs: opts.graceMs ?? 5000` with `graceMs: opts.graceMs ?? 5000, tickMs: opts.tickMs ?? 50`.

Create `test/limits.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, supervise, LIVE } from './helpers/live.js';

const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a quiet working member is reported stalled to its manager, once', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }] },
      worker: { steps: [{ sleep_ms: 1500 }] }
    }
  }, { stall_minutes: 0.005 });   // 0.3 s
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const [stalled] = result.tool_results[1].result.messages;
    assert.match(stalled.text, /^stalled: no events for \d+s$/);
    const workerId = store.children(leadId)[0].id;
    assert.equal(store.events(workerId).filter((e) => e.kind === 'stalled').length, 1);
    assert.equal(store.events(leadId).filter((e) => e.kind === 'stalled').length, 0, 'a blocked manager is not stalled');
  } finally { await sup.close(); }
});

test('a v2 member past its timeout is interrupted and fails', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ sleep_ms: 30_000 }] } } });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go', timeoutMs: 300 });
    assert.deepEqual(await sup.waitRun(runId), { status: 'failed', summary: 'timed out after 0.3s of work' });
    assert.equal(store.member(memberId).state, 'failed');
    assert.deepEqual(store.events(memberId).find((e) => e.kind === 'timed_out').body, { after_s: 0.3 });
  } finally { await sup.close(); }
});

test('time blocked in wait_for does not count toward the timeout', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } } });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go', timeoutMs: 300 });
    await until(() => store.member(memberId).state === 'waiting');
    await sleep(600);
    sup.send({ member_id: memberId, text: 'done waiting' });
    assert.equal((await sup.waitRun(runId)).status, 'ok');
  } finally { await sup.close(); }
});

test('a run past max_cost_usd pauses, and resumes only with a higher cap', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }],
              on_resume: { steps: [] }, turn_cost_usd: 0.5 },
      worker: { steps: [], turn_cost_usd: 0.7 }
    }
  }, { max_cost_usd: 1 });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.member(leadId).state === 'paused');
    assert.equal(store.run(runId).cost_usd, 1.2);
    assert.deepEqual(store.events(leadId).find((e) => e.kind === 'cost_cap').body, { cost_usd: 1.2, max_cost_usd: 1 });
    assert.equal(store.events(leadId).findLast((e) => e.kind === 'paused').body.by, 'cost cap');
    assert.throws(() => sup.resume({ member_id: leadId }), /run \d+ has spent \$1\.20 of its \$1\.00 cap — pass max_cost_usd to raise it/);
    assert.equal(store.member(leadId).state, 'paused');
    sup.resume({ member_id: leadId, max_cost_usd: 5 });
    assert.equal((await sup.waitRun(runId)).status, 'ok');
    assert.equal(store.run(runId).max_cost_usd, 5);
    assert.equal(store.run(runId).cost_usd, 1.7);
  } finally { await sup.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test --test-name-pattern 'stall_minutes|timeout|max_cost_usd' test/config.test.js test/limits.test.js`
Expected: FAIL. The config test fails on `defaults.stall_minutes` (`undefined`), the timeout test fails because the member sleeps its full 30 s, and the cost test never sees `paused`. Stop the run with Ctrl-C once the config failure is printed; the stall test passes or hangs depending on timing and is not the one to confirm.

- [ ] **Step 3: Implement config**

In `src/config.js`, in the merged `defaults`, after `cloud_max_cost_usd: 5,` add:

```js
    stall_minutes: 10,
    max_cost_usd: null,
```

Before the final `return { members, org, ... }`, add:

```js
  // A working member with no events for this long is reported to its manager as stalled.
  if (typeof defaults.stall_minutes !== 'number' || !Number.isFinite(defaults.stall_minutes) ||
      defaults.stall_minutes <= 0) {
    throw new Error(
      `${path}: "defaults.stall_minutes" must be a positive number of minutes — got ` +
      `${JSON.stringify(defaults.stall_minutes)}`
    );
  }
  // What a supervisor run may spend, summed from what harnesses report; null is no cap.
  if (defaults.max_cost_usd !== null && (typeof defaults.max_cost_usd !== 'number' ||
      !Number.isFinite(defaults.max_cost_usd) || defaults.max_cost_usd <= 0)) {
    throw new Error(
      `${path}: "defaults.max_cost_usd" must be a positive number of dollars, or null — got ` +
      `${JSON.stringify(defaults.max_cost_usd)}`
    );
  }
```

- [ ] **Step 4: Implement mock-live's turn cost**

In `adapters/mock-live`, replace the block from the final `drainMessages();` through the message branch of the `for (;;)` loop with:

```js
    drainMessages();
    // `turn_cost_usd` is reported on every idle, as a harness reports a turn's cost.
    const idle = () => out({ type: 'idle', ...(entry.turn_cost_usd ? { cost_usd: entry.turn_cost_usd } : {}) });
    idle();
    for (;;) {
      const m = await next();
      if (m.type === 'message') { accept(m); idle(); continue; }
```

- [ ] **Step 5: Implement the supervisor side**

In `src/supervisor.js`:

Add fields after `#closing = false;`:

```js
  #ticker = null;
  #lastTick = null;
```

Constructor: add `tickMs = 1000` to the options and to the `Object.assign` list.

`start()`, after the `serveRpc` line:

```js
    this.#ticker = setInterval(() => this.#tick(), this.tickMs);
    this.#ticker.unref();
```

`close()`, after `this.#closing = true;`: `clearInterval(this.#ticker);`.

`submit`: the signature becomes `submit({ projectRoot, member, task, timeoutMs, maxCostUsd })`, and the `limits` object (Task 8) gains a third field:

```js
                     maxCostUsd: maxCostUsd ?? config.defaults.max_cost_usd };
```

`send`: a timing-out member, like a cancelling one, reads nothing more. Replace `rt?.halt?.kind === 'cancel'` with `(rt?.halt && rt.halt.kind !== 'pause')`.

`resume`: the signature becomes `resume({ subtree = false, note = null, by = 'local', max_cost_usd = null, ...who } = {})`, and after `const top = this.#target(who);` add `this.#allowSpend(top.run_id, max_cost_usd);`. Add before `#unpause`:

```js
  // A run paused at its cost cap resumes only with a higher cap.
  #allowSpend(runId, cap) {
    if (cap != null) {
      if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) throw new Error('max_cost_usd must be a positive number');
      this.store.setRunCap(runId, cap);
    }
    const run = this.store.run(runId);
    if (run.max_cost_usd != null && run.cost_usd >= run.max_cost_usd) {
      throw new Error(`run ${runId} has spent $${run.cost_usd.toFixed(2)} of its $${run.max_cost_usd.toFixed(2)} cap — ` +
                      'pass max_cost_usd to raise it');
    }
  }
```

`#halt`: replace `if (rt.halt?.kind === 'cancel') throw new Error(`"${m.name}" is already being cancelled`);` with:

```js
    if (rt.halt && rt.halt.kind !== 'pause') {
      throw new Error(`"${m.name}" is already being ${rt.halt.kind === 'cancel' ? 'cancelled' : 'stopped: it timed out'}`);
    }
```

`#haltNote` body becomes:

```js
    const verb = { pause: 'paused', cancel: 'cancelled', timeout: 'stopped' }[rt.halt.kind];
    return `${verb} by ${rt.halt.by} — end your turn now`;
```

`#halted`: after the `if (kind === 'cancel') { ... }` block add:

```js
    if (kind === 'timeout') {
      return this.#conclude(rt.member, 'failed', { status: 'failed', summary: `timed out after ${rt.halt.seconds}s of work` }, rt.workspace);
    }
```

`#launch`: the runtime literal gains `activeMs: 0, quietSince: 0, stalled: false`, and after the `rt.session = new MemberSession({...});` statement add `rt.quietSince = Date.now();`.

`#onLine`: after `if (!rt) return;` add:

```js
    rt.quietSince = Date.now();
    rt.stalled = false;
```

and in the `idle` branch, between `rt.idle = true;` and `this.#pump(id);`, add:

```js
      if (msg.cost_usd) this.#spend(rt.member.run_id, msg.cost_usd);
```

Cost is checked before `#pump`, so an idle root over its cap is paused instead of being told to stop.

Add this section before `// ---- recovery ----`:

```js
  // ---- limits ----

  // Every tickMs. Only a member doing work counts toward its timeout and its stall clock: one
  // blocked in wait_for or ask_human, idle between turns, or already stopping is waiting on
  // someone else. The timeout counts from each launch, so a resumed member gets it afresh.
  #tick() {
    const at = Date.now();
    const elapsed = at - (this.#lastTick ?? at);
    this.#lastTick = at;
    for (const [id, rt] of this.#live) {
      if (!rt.session) continue;
      if (rt.waiter || rt.question || rt.idle || rt.halt || rt.stopping) { rt.quietSince = at; continue; }
      rt.activeMs += elapsed;
      const { timeoutMs, config } = this.#runs.get(rt.member.run_id);
      if (rt.activeMs >= timeoutMs) {
        this.store.addEvent(id, 'timed_out', { after_s: timeoutMs / 1000 });
        rt.halt = { kind: 'timeout', now: true, by: 'timeout', seconds: timeoutMs / 1000 };
        rt.session.end(this.graceMs);
        continue;
      }
      if (!rt.stalled && at - rt.quietSince >= config.defaults.stall_minutes * 60_000) {
        rt.stalled = true;
        const quiet = Math.round((at - rt.quietSince) / 1000);
        this.store.addEvent(id, 'stalled', { quiet_s: quiet });
        this.#notifyManager(rt.member, `stalled: no events for ${quiet}s`);
      }
    }
  }

  // Harness-reported cost. Past the run's cap, the whole run pauses after its current turns.
  #spend(runId, usd) {
    const total = this.store.addRunCost(runId, usd);
    const { max_cost_usd: cap, root_member: root } = this.store.run(runId);
    if (cap == null || total < cap || TERMINAL.has(this.store.member(root).state)) return;
    const { members } = this.#intervene({ member_id: root, subtree: true, by: 'cost cap' }, 'pause');
    if (members.length) this.store.addEvent(root, 'cost_cap', { cost_usd: total, max_cost_usd: cap });
  }
```

- [ ] **Step 6: Update the docs**

In `docs/adapters.md`, delete the paragraph that starts "The dispatch timeout does not apply to a session yet." and replace the message table's `start`, `interrupt`, and `idle` rows with:

```
| in | `start {brief, resume, note}` | Begin. `resume` is null for a fresh start; otherwise it is the string this adapter sent in `session {resume}`, and `note` is the first user turn to send after resuming. |
| in | `interrupt` | End the turn now and exit: send `idle {interrupted: true}` and no `result`. |
| out | `idle {interrupted?, cost_usd?}` | The turn ended. `cost_usd` is this turn's cost in dollars, if the harness reports one; the supervisor sums it against `max_cost_usd`. |
```

After the table's "Adapter output is untrusted" line, add:

```
The supervisor enforces the run's timeout on a session by counting only the time it is working:
time blocked in `wait_for` or `ask_human`, or idle between turns, does not count, and a resumed
session starts a fresh count. Past the timeout it sends `interrupt` and fails the member.
```

In the mock-live step table section, after the paragraph that ends "carries `received` (the messages it saw) and `tool_results`.", add:

```
A member's script entry can also set `on_resume.steps`, played instead of `steps` when the
session is started with a `resume` id, and `turn_cost_usd`, reported on every `idle`.
```

In `docs/how-it-works.md`, "Live runs", replace the sentences from "For a v2 member, `--timeout` only reaches the" through "Enforcement comes with interrupt and cancel in plan 1b." with:

```
For a v2 member, `--timeout` counts only the time the member is working, not time blocked in
`wait_for` or `ask_human` or idle between turns; past it the supervisor interrupts the session
and fails the member. A working member with no events for `defaults.stall_minutes` (default
10) is reported to its manager as `stalled`. `defaults.max_cost_usd` (default none) caps what a
run may spend, summed from the costs harnesses report; past it the whole run is paused, and
`resume` needs a higher cap.
```

In the spec, "Errors and recovery", replace "Plan 1a does not enforce it on v2 members: `--timeout` only reaches the brief until interrupt and cancel land in plan 1b." with "It counts only time the member is working, not time blocked in `wait_for` or `ask_human`."

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/config.test.js test/limits.test.js`
Expected: PASS, `ℹ fail 0`, with the 4 tests in `test/limits.test.js` among them.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 478`, `ℹ fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/supervisor.js adapters/mock-live test/helpers/live.js test/config.test.js test/limits.test.js docs/adapters.md docs/how-it-works.md docs/superpowers/specs/2026-10-12-steerable-teams-design.md
git commit -m "feat(supervisor): enforce v2 timeouts, report stalls, cap run cost"
```

---

### Task 10: CLI verbs for steering a run under `serve`

Tasks 5–7 added the admin RPCs; nothing on the command line calls them. This task adds `pause`, `resume`, `cancel`, `questions`, and `answer` verbs, each one admin RPC to the `serve` supervisor, signed with the OS user name.

**Files:**
- Create: `src/admin.js`
- Modify: `bin/agent-team.js` (parseArgs options, `USAGE`, verb dispatch before the `--member` check)
- Create: `test/admin-cli.test.js`
- Modify: `docs/how-it-works.md` ("Live runs"), `docs/adapters.md` ("Environment")

**Interfaces:**
- Consumes: admin RPCs `pause`, `cancel` (Task 5), `resume` (Task 6, `max_cost_usd` from Task 9), `questions` (Task 7), `answer` (1a); `isListening(path)`, `callRpc(path, {method, params})` from `src/rpc.js`; `defaultSocketPath(env)` from `src/supervisor.js`.
- Produces (`src/admin.js`):
  - `adminCall(method, params, env = process.env)` → the RPC result; throws `no agent-team supervisor is listening on <path>. Start one with \`agent-team serve\` and run the team through it.` when nothing listens.
  - `memberArgs([run, member])` → `{run_id, member}`; throws `name a member: <run-id> <member>`.
  - `whoAmI()` → the OS user name, used as `by`.
  - `renderQuestions(questions)` → one line per question, `#<id>  run <run_id>  <member>: <question> [a | b]`, or `no open questions`.
- Task 12 adds `attach` to `src/admin.js` and reuses all four.

- [ ] **Step 1: Write the failing tests**

Create `test/admin-cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { project, supervise, LIVE } from './helpers/live.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;
const ME = userInfo().username;
const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };

// Async on purpose: the supervisor runs in this process and must keep answering while the
// CLI waits on it.
function cli(args, sock) {
  return promisify(execFile)(process.execPath, [BIN, ...args], {
    env: { ...process.env, AGENT_TEAM_SUPERVISOR_SOCK: sock }
  }).then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
          (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
}

test('a steering verb with no supervisor listening says to start serve', async () => {
  const sock = join(mkdtempSync(join(tmpdir(), 'at-a-')), 'none.sock');
  const { code, stderr } = await cli(['pause', '1', 'lead'], sock);
  assert.equal(code, 1);
  assert.match(stderr, /^agent-team: no agent-team supervisor is listening on .*none\.sock\. Start one with `agent-team serve`/);
});

test('pause and resume a member from the CLI', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], on_resume: { steps: [] } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const paused = await cli(['pause', String(runId), 'solo'], sup.socketPath);
    assert.equal(paused.code, 0, paused.stderr);
    assert.deepEqual(JSON.parse(paused.stdout), { members: [{ id: memberId, name: 'solo' }], skipped: [] });
    await until(() => store.member(memberId).state === 'paused');
    assert.deepEqual(store.events(memberId).find((e) => e.kind === 'paused').body, { by: ME, now: false });

    const resumed = await cli(['resume', String(runId), 'solo', '--note', 'carry on'], sup.socketPath);
    assert.equal(resumed.code, 0, resumed.stderr);
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.match(result.received.at(-1), new RegExp(`Resumed by ${ME}\\.\\n${ME}: carry on$`));
  } finally { await sup.close(); }
});

test('cancel --subtree from the CLI ends the run cancelled', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }] },
      worker: { steps: [{ sleep_ms: 30_000 }] }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.children(leadId)[0]?.state === 'running' && store.member(leadId).state === 'waiting');
    const { code, stderr } = await cli(['cancel', String(runId), 'lead', '--subtree'], sup.socketPath);
    assert.equal(code, 0, stderr);
    assert.deepEqual(await sup.waitRun(runId), { status: 'failed', summary: `cancelled by ${ME}` });
    assert.equal(store.run(runId).status, 'cancelled');
    await until(() => store.children(leadId)[0].state === 'cancelled');   // the report may exit after its manager
  } finally { await sup.close(); }
});

test('questions lists open questions and answer closes one', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'Ship it?', options: ['yes', 'no'] } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const [q] = sup.questions();
    const listed = await cli(['questions'], sup.socketPath);
    assert.equal(listed.stdout, `#${q.id}  run ${runId}  solo: Ship it? [yes | no]\n`);
    assert.equal(JSON.parse((await cli(['questions', String(runId), '--json'], sup.socketPath)).stdout)[0].id, q.id);
    const answered = await cli(['answer', String(q.id), 'yes,', 'ship'], sup.socketPath);
    assert.deepEqual(JSON.parse(answered.stdout), { ok: true });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result, { answer: 'yes, ship', answered_by: ME, timed_out: false });
    assert.equal((await cli(['questions'], sup.socketPath)).stdout, 'no open questions\n');
  } finally { await sup.close(); }
});

test('bad steering arguments fail before reaching the supervisor', async () => {
  const sock = join(mkdtempSync(join(tmpdir(), 'at-a-')), 'none.sock');
  assert.match((await cli(['pause', '1'], sock)).stderr, /^agent-team: name a member: <run-id> <member>/);
  assert.match((await cli(['resume', '1', 'lead', '--max-cost-usd', 'lots'], sock)).stderr,
    /^agent-team: --max-cost-usd must be a positive number of dollars, got "lots"/);
  assert.match((await cli(['answer', '7'], sock)).stderr, /^agent-team: usage: agent-team answer <question-id> <answer>/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/admin-cli.test.js`
Expected: FAIL, `ℹ fail 5`. Every verb falls through to the usage text and exits 2.

- [ ] **Step 3: Write `src/admin.js`**

```js
import { userInfo } from 'node:os';
import { defaultSocketPath } from './supervisor.js';
import { isListening, callRpc } from './rpc.js';

// The CLI side of the admin RPCs. Only `agent-team serve` listens on the shared socket; a
// CLI's in-process supervisor has a private one, so its runs cannot be steered from here.
export async function adminCall(method, params, env = process.env) {
  const socketPath = defaultSocketPath(env);
  if (!(await isListening(socketPath))) {
    throw new Error(`no agent-team supervisor is listening on ${socketPath}. ` +
                    'Start one with `agent-team serve` and run the team through it.');
  }
  return callRpc(socketPath, { method, params });
}

// `<run> <member>` from the positionals after the verb.
export function memberArgs([run, member]) {
  const runId = Number(run);
  if (!Number.isInteger(runId) || runId <= 0 || !member) throw new Error('name a member: <run-id> <member>');
  return { run_id: runId, member };
}

export const whoAmI = () => userInfo().username;

export function renderQuestions(questions) {
  if (!questions.length) return 'no open questions\n';
  return questions.map((q) => {
    const options = q.options?.length ? ` [${q.options.join(' | ')}]` : '';
    return `#${q.id}  run ${q.run_id}  ${q.member}: ${q.question}${options}\n`;
  }).join('');
}
```

- [ ] **Step 4: Add the verbs to `bin/agent-team.js`**

Add the import beside the other `../src/` imports:

```js
import { adminCall, memberArgs, whoAmI, renderQuestions } from '../src/admin.js';
```

In the `parseArgs` options, after `session: { type: 'string' }` (add the comma), add:

```js
    now: { type: 'boolean', default: false },
    subtree: { type: 'boolean', default: false },
    note: { type: 'string' },
    'max-cost-usd': { type: 'string' }
```

Append to `USAGE` (move the closing `;` from the `channel ask` line to the last new line):

```js
  '       agent-team pause <run> <member> [--now] [--subtree]\n' +
  '       agent-team resume <run> <member> [--subtree] [--note <text>] [--max-cost-usd <usd>]\n' +
  '       agent-team cancel <run> <member> [--subtree]\n' +
  '       agent-team questions [<run>] [--json]\n' +
  '       agent-team answer <question-id> <answer>\n';
```

After the `channel` block (its final `process.exit(2);` and `}`), before `if (!values.member || !values.task) {`, add:

```js
// Steering verbs: each is one admin RPC to the `agent-team serve` supervisor.
const usd = (v) => {
  if (v == null) return null;
  if (!(Number(v) > 0)) throw new Error(`--max-cost-usd must be a positive number of dollars, got "${v}"`);
  return Number(v);
};
const ADMIN = {
  pause: (p) => ['pause', { ...memberArgs(p), now: values.now, subtree: values.subtree, by: whoAmI() }],
  cancel: (p) => ['cancel', { ...memberArgs(p), subtree: values.subtree, by: whoAmI() }],
  resume: (p) => ['resume', {
    ...memberArgs(p), subtree: values.subtree, by: whoAmI(), note: values.note ?? null,
    max_cost_usd: usd(values['max-cost-usd'])
  }],
  questions: ([run]) => ['questions', { run_id: run == null ? null : Number(run) }],
  answer: ([id, ...text]) => {
    if (!Number.isInteger(Number(id)) || !text.length) throw new Error('usage: agent-team answer <question-id> <answer>');
    return ['answer', { question_id: Number(id), answer: text.join(' '), by: whoAmI() }];
  }
};
if (Object.hasOwn(ADMIN, positionals[0])) {
  try {
    const [method, params] = ADMIN[positionals[0]](positionals.slice(1));
    const result = await adminCall(method, params);
    process.stdout.write(method === 'questions' && !values.json
      ? renderQuestions(result)
      : JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`agent-team: ${err.message}\n`);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Document the verbs**

In `docs/how-it-works.md`, at the end of "Live runs" (before `## Resolving the agent`), add:

````
### Steering a live run

These verbs reach only a supervisor started with `agent-team serve`; a run that a CLI started
in-process cannot be steered from another terminal. Members are named by run id and name.

```
agent-team pause <run> <member> [--now] [--subtree]
agent-team resume <run> <member> [--subtree] [--note <text>] [--max-cost-usd <usd>]
agent-team cancel <run> <member> [--subtree]
agent-team questions [<run>] [--json]
agent-team answer <question-id> <answer>
```

`pause` lets the current turn finish; `--now` interrupts it, so a command it started may have
partly run. `resume` starts the member again from its harness session in the same workspace
and delivers anything sent to it while paused. `cancel` keeps the workspace. `--subtree`
applies the verb to the member and every report under it. Each verb is signed with your OS
user name, which is what the member and its manager are told.
````

In `docs/adapters.md`, "Environment", replace "The socket also serves admin methods (`submit`, `wait_run`, `send`,
`answer`), which the bridge refuses." with "The socket also serves admin methods (`submit`, `wait_run`, `send`,
`answer`, `questions`, `pause`, `resume`, `cancel`), which the bridge refuses." (Task 12 adds `takeover` and `handback` to the list.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/admin-cli.test.js`
Expected: PASS, `ℹ pass 5`, `ℹ fail 0`.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ pass 483`, `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/admin.js bin/agent-team.js test/admin-cli.test.js docs/how-it-works.md docs/adapters.md
git commit -m "feat(cli): pause, resume, cancel, questions, and answer verbs"
```

---

### Task 11: The `claude` session adapter

`adapters/claude session` runs one member as a long-lived `claude -p` on stream-json, so the supervisor can steer, interrupt, and resume it. The wire facts come from the spec's "Harness behaviour this design relies on" (Claude Code 2.1.296): user content must be a list of blocks (a plain string sent mid-run is dropped without an error); with `--replay-user-messages` claude echoes each consumed user line with its `uuid` and `isReplay: true`, which is the ack; a `control_request` with `subtype: "interrupt"` ends the turn with an error `result` and leaves the process open; `total_cost_usd` on each `result` is cumulative for the process.

Flipping `capabilities` to `protocol: 2` changes routing: `agent-team --member <m>` for a claude root member now runs through the supervisor (a running `serve`, or an in-process one), and the supervisor runs claude reports as sessions. A v1 dispatch tree (a v1 root) still calls `adapters/claude run` for its claude reports.

**Files:**
- Create: `src/claude-session.js` (not related to the existing `adapters/claude-session` adapter, which drives a Claude Code channel session; this file is the stream-json loop behind `adapters/claude session`)
- Modify: `adapters/claude` (extract `gitDiff`/`artifactsOf`, add `diff_stat`, `session` subcommand, `protocol: 2`)
- Create: `test/fixtures/fake-claude` (mode `0755`)
- Create: `test/claude-session.test.js`, `test/live/claude.test.js`
- Modify: `docs/adapters.md` ("Shipped adapters" → "claude"), `docs/how-it-works.md` ("Live runs")

**Interfaces:**
- Consumes: the v2 contract as Tasks 2 and 5 left it: `start {brief, resume, note}`, `message {id, from, text}`, `stop`, `interrupt` in; `session {harness_id, resume}`, `ack {message_id}`, `event {kind, ...}`, `idle {interrupted?, cost_usd?}`, `result` out. `AGENT_TEAM_TEAM_SOCKET` and `AGENT_TEAM_TEAM_TOKEN` from the supervisor's session env. `Supervisor#submit`, `#send`, `#waitRun`, `store.member(id).resume` (Task 2, written from `session.resume`), `store.run(id).cost_usd` (Task 9).
- Produces:
  - `runClaudeSession({ artifacts })` in `src/claude-session.js`; `artifacts(cwd, logDir)` is the adapter's diff reader.
  - `claudeSessionArgs(brief, { resume, mcpConfig })` → the `claude` argv; `MCP_TOOL_TIMEOUT_MS = 7_260_000` (ask_human's 7200 s max plus a minute).
  - Every claude `result` (v1 `run` and v2 `session`) carries `artifacts.diff_stat`, which `#finish` already shows the manager.
  - `test/fixtures/fake-claude`: a stand-in `claude` that Task 12 also uses. Without `-p` it acts as the human's interactive `claude --resume`: logs its argv and cwd to `$FAKE_CLAUDE_LOG` and exits `$FAKE_CLAUDE_EXIT` (default 0).

- [ ] **Step 1: Write the fake `claude`**

Create `test/fixtures/fake-claude` and `chmod 755` it:

```js
#!/usr/bin/env node
// Stands in for `claude` on PATH in adapter tests. It plays the stream-json shapes recorded
// from Claude Code 2.1.296: a user line whose content is a plain string is dropped, an accepted
// one is echoed with isReplay when --replay-user-messages is set, and an interrupt
// control_request ends a held turn with an error result. A turn whose text contains HOLD stays
// open until an interrupt or a message containing RELEASE; CRASH exits 3. total_cost_usd is
// cumulative, 0.25 per turn. Every start appends {argv, cwd, mcp_tool_timeout, mcp} to
// $FAKE_CLAUDE_LOG. Without -p it is a take-over: it records and exits $FAKE_CLAUDE_EXIT.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('9.9.9 (fake claude)\n'); process.exit(0); }
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
if (process.env.FAKE_CLAUDE_LOG) {
  const mcpPath = flag('--mcp-config');
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    argv, cwd: process.cwd(), mcp_tool_timeout: process.env.MCP_TOOL_TIMEOUT ?? null,
    mcp: mcpPath ? JSON.parse(readFileSync(mcpPath, 'utf8')) : null
  }) + '\n');
}
if (!argv.includes('-p')) process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));

const sid = flag('--resume') ?? `fake-sid-${process.pid}`;
const replay = argv.includes('--replay-user-messages');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let cost = 0;
let turn = null;   // the first text of the open turn

const endTurn = (error) => {
  cost += 0.25;
  out(error
    ? { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, total_cost_usd: cost, permission_denials: [] }
    : { type: 'result', subtype: 'success', is_error: false, result: `echo: ${turn}`, session_id: sid, total_cost_usd: cost, permission_denials: [] });
  turn = null;
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    if (turn !== null) endTurn(true);
    return;
  }
  if (m.type !== 'user' || !Array.isArray(m.message?.content)) return;   // a plain string is dropped
  const text = m.message.content.map((b) => b.text ?? '').join('');
  // Like claude: each new turn opens with system/init, then the replayed user line.
  if (turn === null) out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd() });
  if (replay) out({ ...m, session_id: sid, parent_tool_use_id: null, isReplay: true });
  if (text.includes('CRASH')) process.exit(3);
  if (turn !== null) {
    if (text.includes('RELEASE')) endTurn(false);
    return;
  }
  turn = text;
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [
    { type: 'text', text: `echo: ${text}` },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'true' } }
  ] } });
  out({ type: 'user', session_id: sid, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }
  ] } });
  if (!text.includes('HOLD')) endTurn(false);
});
```

- [ ] **Step 2: Write the failing tests**

Create `test/claude-session.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project, supervise } from './helpers/live.js';

const ADAPTER = new URL('../adapters/claude', import.meta.url).pathname;
// fake-claude answers to the name `claude` from a directory put first on PATH.
const FAKE_BIN = mkdtempSync(join(tmpdir(), 'at-fcb-'));
symlinkSync(new URL('./fixtures/fake-claude', import.meta.url).pathname, join(FAKE_BIN, 'claude'));
const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

// `adapters/claude session` against test/fixtures/fake-claude. `next(type)` resolves with the
// next adapter line of that type; `exit` with the exit code.
function session() {
  const log = join(mkdtempSync(join(tmpdir(), 'at-fc-')), 'claude.jsonl');
  const child = spawn(ADAPTER, ['session'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log,
      AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock', AGENT_TEAM_TEAM_TOKEN: 'tok-1'
    }
  });
  const lines = [];
  const waiting = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    lines.push(JSON.parse(l));
    for (const w of waiting.splice(0)) w();
  });
  let seen = 0;
  const next = async (type) => {
    for (;;) {
      const i = lines.findIndex((m, k) => k >= seen && m.type === type);
      if (i >= 0) { seen = i + 1; return lines[i]; }
      await new Promise((r) => waiting.push(r));
    }
  };
  const exit = new Promise((r) => child.on('close', r));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const starts = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { send, next, lines, exit, starts };
}

const brief = (extra = {}) => ({ task: 'build it', cwd: mkdtempSync(join(tmpdir(), 'at-cw-')), read_only: false, ...extra });

test('capabilities declares protocol 2', { timeout: 5000 }, () => {
  assert.equal(JSON.parse(execFileSync(ADAPTER, ['capabilities']).toString()).protocol, 2);
});

test('a session starts claude on stream-json with the team MCP server, then stops on request', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ read_only: true, model: 'haiku' }), resume: null, note: null });
  const started = await s.next('session');
  assert.match(started.harness_id, /^fake-sid-\d+$/);
  assert.equal(started.resume, started.harness_id);
  assert.deepEqual(await s.next('event'), { type: 'event', kind: 'user', text: 'build it' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', cost_usd: 0.25 });
  s.send({ type: 'stop' });
  const result = await s.next('result');
  assert.equal(await s.exit, 0);
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, 'echo: build it');
  assert.deepEqual(result.usage, { cost_usd: 0.25, session_id: started.harness_id, turns: 1 });

  const [run] = s.starts();
  for (const flag of ['--input-format', '--output-format', '--verbose', '--replay-user-messages']) assert.ok(run.argv.includes(flag), flag);
  assert.equal(run.argv[run.argv.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(run.argv[run.argv.indexOf('--allowedTools') + 1], 'mcp__agent-team__*');
  assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'haiku');
  assert.equal(run.mcp_tool_timeout, '7260000');
  assert.deepEqual(run.mcp.mcpServers['agent-team'], {
    command: process.execPath, args: [BIN, 'mcp'],
    env: { AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock', AGENT_TEAM_TEAM_TOKEN: 'tok-1' }
  });
  assert.ok(!JSON.stringify(run.argv).includes('tok-1'), 'the token stays out of argv');
  assert.deepEqual(s.lines.filter((m) => m.type === 'event' && m.kind !== 'user').map((m) => m.kind),
    ['text', 'tool_call', 'tool_result']);
});

test('a steered message is acked when claude replays it, not when it is written', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ task: 'HOLD the turn' }), resume: null, note: null });
  await s.next('session');
  s.send({ type: 'message', id: 41, from: 'ana (human)', text: 'also RELEASE' });
  assert.deepEqual(await s.next('ack'), { type: 'ack', message_id: 41 });
  assert.deepEqual(await s.next('idle'), { type: 'idle', cost_usd: 0.25 });
  const steered = s.lines.find((m) => m.type === 'event' && m.kind === 'user' && m.text.includes('RELEASE'));
  assert.equal(steered.text, '[from: ana (human)] also RELEASE');
  s.send({ type: 'stop' });
  assert.equal((await s.next('result')).summary, 'echo: HOLD the turn');
});

test('interrupt ends a running turn with idle {interrupted} and exits without a result', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ task: 'HOLD forever' }), resume: null, note: null });
  await s.next('session');
  await s.next('event');
  s.send({ type: 'interrupt' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', interrupted: true, cost_usd: 0.25 });
  assert.equal(await s.exit, 0);
  assert.equal(s.lines.filter((m) => m.type === 'result').length, 0);
});

test('a resumed session passes --resume and opens with the note', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief(), resume: 'sid-7', note: 'Resumed by ana.' });
  assert.deepEqual(await s.next('session'), { type: 'session', harness_id: 'sid-7', resume: 'sid-7' });
  assert.deepEqual(await s.next('event'), { type: 'event', kind: 'user', text: 'Resumed by ana.' });
  s.send({ type: 'stop' });
  await s.next('result');
  const [run] = s.starts();
  assert.equal(run.argv[run.argv.indexOf('--resume') + 1], 'sid-7');
});

test('claude dying mid-session fails the member with its exit', { timeout: 5000 }, async () => {
  const s = session();
  s.send({ type: 'start', brief: brief({ task: 'CRASH now' }), resume: null, note: null });
  const result = await s.next('result');
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /^claude exited \(code 3\) before it was asked to stop/);
});

test('the result carries the workspace diff stat', { timeout: 5000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at-cg-'));
  const git = (...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base');
  writeFileSync(join(cwd, 'new.txt'), 'hello\n');
  const s = session();
  s.send({ type: 'start', brief: brief({ cwd }), resume: null, note: null });
  await s.next('idle');
  s.send({ type: 'stop' });
  const result = await s.next('result');
  assert.match(result.artifacts.diff_stat, /new\.txt \| 1 \+/);
});

test('the supervisor runs a claude member as a session and steers it', { timeout: 15_000 }, async () => {
  const { root, script } = project({ solo: { agent: 'claude', isolation: 'workspace' } }, {});
  const { sup, store } = await supervise(script, { env: { PATH: `${FAKE_BIN}:${process.env.PATH}` } });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'HOLD until told' });
    while (!store.member(memberId).resume) await new Promise((r) => setTimeout(r, 20));
    assert.match(store.member(memberId).resume, /^fake-sid-\d+$/);
    const { message_id } = sup.send({ member_id: memberId, text: 'RELEASE it', from: 'ana' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.match(result.summary, /^echo: # Task\n\nHOLD until told\n/);
    assert.equal(store.message(message_id).state, 'delivered');
    assert.equal(store.run(runId).cost_usd, 0.25);
  } finally { await sup.close(); }
});
```

Create `test/live/claude.test.js`. It runs only under `npm run test:live` (Task 1 added the script); `npm test`'s glob also loads it, where it reports as skipped.

```js
// Opt-in: runs the real `claude` on Haiku and costs a few cents. `npm run test:live`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER = new URL('../../adapters/claude', import.meta.url).pathname;
const skip = process.env.AGENT_TEAM_LIVE_SMOKE !== '1' && 'set AGENT_TEAM_LIVE_SMOKE=1 to run';

test('real claude: a session is steered between turns, interrupted, and resumed', { skip, timeout: 180_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at-live-claude-'));
  const brief = { task: 'Reply with the single word PONG.', cwd, read_only: true, model: 'haiku' };
  const run = (start) => {
    const child = spawn(ADAPTER, ['session'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = [];
    const waiting = [];
    createInterface({ input: child.stdout }).on('line', (l) => { lines.push(JSON.parse(l)); for (const w of waiting.splice(0)) w(); });
    let seen = 0;
    const next = async (type) => {
      for (;;) {
        const i = lines.findIndex((m, k) => k >= seen && m.type === type);
        if (i >= 0) { seen = i + 1; return lines[i]; }
        await new Promise((r) => waiting.push(r));
      }
    };
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send(start);
    return { send, next, exit: new Promise((r) => child.on('close', r)) };
  };

  const a = run({ type: 'start', brief, resume: null, note: null });
  const { resume } = await a.next('session');
  assert.ok((await a.next('idle')).cost_usd > 0);
  a.send({ type: 'message', id: 1, from: 'ana (human)', text: 'Now reply with the single word PING.' });
  assert.deepEqual(await a.next('ack'), { type: 'ack', message_id: 1 });
  await a.next('idle');
  a.send({ type: 'message', id: 2, from: 'ana (human)', text: 'Count slowly from 1 to 200, one number per line.' });
  await a.next('ack');
  a.send({ type: 'interrupt' });
  assert.equal((await a.next('idle')).interrupted, true);
  assert.equal(await a.exit, 0);

  const b = run({ type: 'start', brief, resume, note: 'What word did you reply with first? Answer with that word only.' });
  // Whether `-p --resume` keeps the session id is not pinned; the adapter reports what init says.
  assert.equal(typeof (await b.next('session')).resume, 'string');
  await b.next('idle');
  b.send({ type: 'stop' });
  const result = await b.next('result');
  assert.equal(result.status, 'ok');
  assert.match(result.summary, /PONG/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/claude-session.test.js`
Expected: FAIL, `ℹ fail 8`. `capabilities` has no `protocol`, `session` is an unknown subcommand (the session tests time out at 5 s), and the supervisor runs `solo` one-shot.

- [ ] **Step 4: Write `src/claude-session.js`**

```js
// `adapters/claude session`: one member as a long-lived `claude -p` speaking stream-json, so
// the supervisor can steer it mid-run. The wire formats are the ones probed in the spec
// ("Harness behaviour this design relies on"); test/fixtures/fake-claude plays them in tests.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/agent-team.js', import.meta.url));
// claude's own MCP tool timeout must outlast the longest blocking team tool (ask_human, 7200 s).
export const MCP_TOOL_TIMEOUT_MS = 7_260_000;
const STDERR_TAIL = 2000;

export function claudeSessionArgs(brief, { resume, mcpConfig }) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--replay-user-messages', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__agent-team__*',
    // Plan mode admits the team tools because each declares readOnlyHint.
    '--permission-mode', brief.read_only ? 'plan' : (brief.permission_mode ?? 'auto')
  ];
  if (resume) args.push('--resume', resume);
  if (brief.model) args.push('--model', brief.model);
  if (brief.effort) args.push('--effort', brief.effort);
  if (brief.advisor) args.push('--settings', JSON.stringify({ advisorModel: brief.advisor }));
  return args;
}

// The team MCP server, as `agent-team mcp` with this member's socket and token. Written to a
// file in a 0700 directory, not passed inline, so the token stays out of `ps`.
function writeMcpConfig(dir, env) {
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify({
    mcpServers: {
      'agent-team': {
        command: process.execPath, args: [BIN, 'mcp'],
        env: { AGENT_TEAM_TEAM_SOCKET: env.AGENT_TEAM_TEAM_SOCKET ?? '', AGENT_TEAM_TEAM_TOKEN: env.AGENT_TEAM_TEAM_TOKEN ?? '' }
      }
    }
  }), { mode: 0o600 });
  return path;
}

const blocksText = (content) => (Array.isArray(content)
  ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
  : String(content ?? ''));

// `artifacts(cwd, logDir)` is the v1 adapter's diff reader, so a session's result carries the
// same artifacts a `run` result does.
export function runClaudeSession({ artifacts }) {
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const logDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-'));
  const logPath = join(logDir, 'session.log');
  const log = createWriteStream(logPath);
  let brief = null;
  let claude = null;
  let stderr = '';
  const pending = new Map();   // uuid of an injected user line -> inbox message id
  let sessionId = null;
  let inTurn = false;
  let stopping = false;
  let interrupting = false;
  let cost = 0;                // claude's total_cost_usd is cumulative for the process
  let turns = 0;
  let lastText = '';
  let lastError = false;
  const denied = [];

  const write = (m) => { if (claude?.stdin.writable) claude.stdin.write(JSON.stringify(m) + '\n'); };
  // Content must be a list of blocks: claude drops a plain string sent mid-run without a word.
  const userTurn = (text) => {
    const uuid = randomUUID();
    write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, uuid });
    inTurn = true;
    return uuid;
  };
  const finish = (result) => process.stdout.write(JSON.stringify({ type: 'result', ...result }) + '\n', () => process.exit(0));
  const endClaude = () => { stopping = true; claude?.stdin.end(); };

  function onClaudeLine(line) {
    log.write(line + '\n');
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'system' && e.subtype === 'init' && !sessionId && e.session_id) {
      sessionId = e.session_id;
      out({ type: 'session', harness_id: sessionId, resume: sessionId });
    } else if (e.type === 'user') {
      // An injected line counts as delivered when claude replays it, which is when it was
      // consumed. The interrupt's synthetic user lines carry no isReplay.
      if (e.isReplay && pending.has(e.uuid)) {
        out({ type: 'ack', message_id: pending.get(e.uuid) });
        pending.delete(e.uuid);
      }
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'tool_result') {
          out({ type: 'event', kind: 'tool_result', tool_use_id: b.tool_use_id ?? null, is_error: b.is_error === true,
                text: blocksText(b.content).slice(0, 2000) });
        }
      }
      if (e.isReplay) out({ type: 'event', kind: 'user', text: blocksText(e.message?.content) });
    } else if (e.type === 'assistant') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'text' && b.text) out({ type: 'event', kind: 'text', text: b.text });
        else if (b.type === 'tool_use') out({ type: 'event', kind: 'tool_call', name: b.name, args: b.input ?? {} });
      }
    } else if (e.type === 'result') {
      inTurn = false;
      turns++;
      const total = Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : cost;
      const delta = Math.max(0, total - cost);
      cost = total;
      lastError = e.is_error === true;
      if (typeof e.result === 'string') lastText = e.result;
      for (const d of e.permission_denials ?? []) denied.push(d.tool_name);
      out({ type: 'idle', ...(interrupting ? { interrupted: true } : {}), ...(delta > 0 ? { cost_usd: delta } : {}) });
      if (interrupting) endClaude();
    }
  }

  function onClaudeExit(code, signal) {
    if (interrupting) return log.end(() => process.exit(0));   // an interrupt answers with idle, not a result
    const usage = { cost_usd: cost, session_id: sessionId, turns };
    let outcome;
    if (!stopping) {
      outcome = { status: 'failed', summary: `claude exited (${signal ?? `code ${code}`}) before it was asked to stop: ${stderr.trim()}` };
    } else if (!brief.read_only && denied.length) {
      outcome = { status: 'failed', summary: `claude refused ${denied.length} tool call(s): ${denied.join(', ')}. Member summary: ${lastText}` };
    } else {
      outcome = { status: lastError ? 'failed' : 'ok', summary: lastText };
    }
    const art = artifacts(brief.cwd, logDir);
    log.end(() => finish({ ...outcome, usage, permission_denials: denied, findings: [], checked_sound: [],
                           artifacts: art, log_path: logPath }));
  }

  function start({ brief: b, resume = null, note = null }) {
    brief = b;
    if (!existsSync(brief.cwd)) return finish({ status: 'failed', summary: `cwd does not exist: ${brief.cwd}`, log_path: logPath });
    const mcpConfig = writeMcpConfig(logDir, process.env);
    claude = spawn('claude', claudeSessionArgs(brief, { resume, mcpConfig }), {
      cwd: brief.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) }
    });
    claude.stdin.on('error', () => {});
    claude.stderr.on('data', (d) => { log.write(d); stderr = (stderr + d).slice(-STDERR_TAIL); });
    claude.on('error', (err) => { stderr += `\n${err.message}`; });
    createInterface({ input: claude.stdout }).on('line', onClaudeLine);
    claude.on('close', onClaudeExit);
    userTurn(resume ? (note ?? 'Continue where you left off.') : brief.task);
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'start' && !claude) start(m);
    else if (m.type === 'message') pending.set(userTurn(`[from: ${m.from}] ${m.text}`), m.id);
    else if (m.type === 'stop') endClaude();
    else if (m.type === 'interrupt' && !interrupting) {
      interrupting = true;
      if (!claude) { out({ type: 'idle', interrupted: true }); return process.stdout.write('', () => process.exit(0)); }
      if (inTurn) write({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } });
      else { out({ type: 'idle', interrupted: true }); endClaude(); }
    }
  }).on('close', () => { if (claude && !stopping) endClaude(); });

  // The supervisor's last resort after an interrupt is SIGTERM; claude goes with us.
  process.on('SIGTERM', () => { claude?.kill('SIGTERM'); process.exit(143); });
}
```

Notes for the implementer:
- `writeMcpConfig` writes the token to a file in the adapter's `0700` `mkdtemp` directory with mode `0600` so it never appears in `ps`; the test pins that the token is not in argv.
- An interrupt answers with `idle {interrupted: true}` and exits 0 without a `result`, per the design decision on pause. If no turn is open, there is nothing to interrupt and the adapter ends claude itself.
- The steered text is prefixed `[from: <author>]`, so the member can tell a human from its manager.

- [ ] **Step 5: Wire the adapter**

In `adapters/claude`, add to the imports:

```js
import { runClaudeSession } from '../src/claude-session.js';
```

Before `if (sub === 'probe') {`, add the shared diff reader (moved out of the `run` branch, plus `diff_stat`):

```js
// `git diff HEAD` never shows an untracked path, so a member that CREATES a file — a new
// source file, a new test — handed back an empty diff while reporting success, and the manager
// saw no work. Intent-to-add (`add -A -N`) makes the new file visible to diff. It is staged
// into a THROWAWAY index, never the workspace's own: a read_only brief's conformance check
// compares `git status --porcelain` from before the run to after it, and touching the real
// index would turn "?? new.txt" into "A  new.txt" and report a read-only violation that never
// happened.
function gitDiff(cwd, logDir, extra = []) {
  const gitEnv = { ...process.env, GIT_INDEX_FILE: join(logDir, 'diff-index') };
  execFileSync('git', ['-C', cwd, 'read-tree', 'HEAD'], { stdio: 'pipe', env: gitEnv });
  execFileSync('git', ['-C', cwd, 'add', '-A', '-N'], { stdio: 'pipe', env: gitEnv });
  return execFileSync('git', ['-C', cwd, 'diff', ...extra, 'HEAD'], {
    stdio: 'pipe', maxBuffer: DIFF_MAX_BUFFER, env: gitEnv
  }).toString();
}

// The workspace's diff and branch, as a result's `artifacts`. diff_stat is what a manager is
// shown when a live report finishes.
function artifactsOf(cwd, logDir) {
  let diff = '';
  let diffUnreadable = false;
  try {
    diff = gitDiff(cwd, logDir);
  } catch (e) {
    if (e.code === 'ENOBUFS' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      // The diff exists but is too large to capture — distinct from "no diff", which is
      // the normal outcome when cwd is not a git repo or has no changes.
      diffUnreadable = true;
    }
  }
  let diffStat = '';
  try { diffStat = gitDiff(cwd, logDir, ['--stat']).trim(); } catch { /* no repo, or no HEAD */ }

  let branch = null;
  try { branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { stdio: 'pipe' }).toString().trim(); }
  catch { /* ignore */ }
  return {
    branch,
    diff: diff.slice(0, DIFF_KEEP_CHARS),
    diff_truncated: diff.length > DIFF_KEEP_CHARS,
    diff_full_length: diff.length,
    diff_unreadable: diffUnreadable,
    diff_max_buffer_invalid_override: diffMaxBufferInvalidOverride,
    diff_stat: diffStat
  };
}
```

In the `capabilities` branch, change the object to:

```js
    write: true, workspace: true, structured_output: true, tool_dialect: 'claude', protocol: 2
```

After the `capabilities` branch, add:

```js
} else if (sub === 'session') {
  runClaudeSession({ artifacts: artifactsOf });
```

In the `run` branch, delete everything from `let diff = '';` through the `catch { /* ignore */ }` after `let branch = null;` (the inline diff and branch code now in `artifactsOf`), and replace the `artifacts: { branch, ... },` object in the final `process.stdout.write` with:

```js
        artifacts: artifactsOf(brief.cwd, logDir),
```

- [ ] **Step 6: Document the session adapter**

In `docs/adapters.md`, at the end of "### claude" (after the `AGENT_TEAM_CLAUDE_DIFF_MAX_BUFFER` paragraph), add:

```
#### Session (protocol 2)

`adapters/claude session` runs the member as one long-lived process:

    claude -p --input-format stream-json --output-format stream-json --verbose
      --replay-user-messages --mcp-config <file> --allowedTools 'mcp__agent-team__*'
      --permission-mode <plan|permission_mode> [--resume <session>] [--model ...]

| Contract message | claude |
|---|---|
| `start {brief}` | The task as the first user turn. |
| `start {resume, note}` | `--resume <resume>`; the note as the first user turn. |
| `message {from, text}` | A user turn `[from: <from>] <text>`; content is always a list of blocks, since claude drops a plain string. |
| `ack` | Sent when claude replays the user line's `uuid` with `isReplay: true`. |
| `interrupt` | `control_request {subtype: "interrupt"}`; answered with `idle {interrupted: true}`, then the adapter ends claude and exits without a `result`. |
| `idle {cost_usd}` | Each `result` line; `cost_usd` is the change in claude's cumulative `total_cost_usd`. |
| `session {resume}` | The `session_id` of the first `system/init` line. |

The MCP config, written to a `0600` file so the member's token stays out of `ps`, runs
`agent-team mcp` with `AGENT_TEAM_TEAM_SOCKET` and `AGENT_TEAM_TEAM_TOKEN`. `MCP_TOOL_TIMEOUT`
is set to 7,260,000 ms so claude does not give up on an `ask_human` call before its 7200 s
maximum. A read-only member runs in plan mode; the team tools work there because each declares
`readOnlyHint`.

Resume works only on the same machine and in the same directory: claude keeps sessions per
working directory under `~/.claude/projects`.
```

In `docs/adapters.md`, "Shipped adapters", the claude `run` table is unchanged; add `diff_stat` (the output of `git diff --stat HEAD` over the same throwaway index) to the sentence about `artifacts.diff`: "they compute `artifacts.diff` and `artifacts.diff_stat` from the workspace".

In `docs/how-it-works.md`, "Live runs", after the sentence ending "only `serve` listens on the shared path.", add: "The `claude` adapter speaks protocol 2, so a claude root member always runs this way; a v1 root's claude reports still run one-shot."

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/claude-session.test.js test/claude-adapter.test.js`
Expected: PASS, `ℹ fail 0`. `test/claude-adapter.test.js` (the v1 `run` path) still passes with the extracted `artifactsOf`.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail|skipped)'`
Expected: `ℹ pass 491`, `ℹ fail 0`, `ℹ skipped 1` (the live smoke test).

Optional, costs a few cents on Haiku: `npm run test:live`. Expected: `ℹ pass 1`.

- [ ] **Step 8: Commit**

```bash
git add src/claude-session.js adapters/claude test/fixtures/fake-claude test/claude-session.test.js test/live/claude.test.js docs/adapters.md docs/how-it-works.md
git commit -m "feat(claude): run members as steerable stream-json sessions"
```

---

### Task 12: Take over a claude member from a terminal

`agent-team attach <run> <member>` hands a running claude member to the human at the terminal: the supervisor interrupts its turn, waits for the adapter to exit (so two processes never write one session file), and marks it `taken_over`; the CLI runs `claude --resume <sid>` in the member's workspace with the terminal's stdio; when that exits, for any reason, the CLI calls `handback`, which resumes the member headless with a note that a human drove the session. The spec's probe showed the interactive session loads the `-p` history and that the headless resume recalls the human's turns. Claude may first show its folder-trust prompt for the workspace (a fresh clone has never been trusted); the CLI says so before handing over.

Codex take-over is plan 1b-2: `takeover` refuses any member that does not run claude.

**Files:**
- Modify: `src/supervisor.js` (`takeover`, `handback`, `#unpause`'s `drove` note, `#halt` and `#recoverMember` guards, admin RPCs)
- Modify: `src/admin.js` (`attach`)
- Modify: `bin/agent-team.js` (`attach` verb)
- Create: `test/takeover.test.js`
- Modify: `docs/how-it-works.md` ("Steering a live run"), `docs/adapters.md` ("Environment")

**Interfaces:**
- Consumes: `#target(who)`, `#halt(m, 'pause', {now, by})`, `#notifyManager(m, text)` (Task 5); `#unpause(m, {note, by})`, `#resumes` (Task 6); `#resolve(m)` (Task 4); `rt.session.exited` (Task 3); `store.member(id).resume`, `.workspace` (Task 2); `#recoverMember(m)` (Task 8); `adminCall`, `memberArgs`, `whoAmI` (Task 10); `test/fixtures/fake-claude`'s non-`-p` mode (Task 11).
- Produces:
  - `Supervisor#takeover({member_id} | {run_id, member}, by?)` → `Promise<{member_id, name, cwd, argv: ['claude', '--resume', <sid>]}>`; admin RPC `takeover`. Errors: `"<name>" runs <agent>; only claude members can be taken over`, `"<name>" is still pausing — run attach again in a moment`, `"<name>" has no claude session yet — resume it instead`, plus `#halt`'s. A queued or still-launching member has no session: `takeover` pauses it first and then throws "has no claude session yet", so that error leaves the member `paused`; `agent-team resume` runs it again.
  - `Supervisor#handback({member_id} | {run_id, member}, by?)` → `{members: [{id, name}], skipped: []}`; admin RPC `handback`. Error: `"<name>" is not taken over (<state>)`.
  - Events `taken_over {by}` and `handed_back {by}`; the manager is told `taken over by <by>`.
  - `attach(who, {call, run, log})` in `src/admin.js` → the `handback` result. `call`, `run` (a `spawnSync`-shaped function), and `log` are injectable for tests.
  - While `taken_over`: `pause` throws `"<name>" is taken over by a human`; `recover()` leaves the member alone (the human may still be in it; `handback` resumes it).

- [ ] **Step 1: Write the failing tests**

Create `test/takeover.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { project, supervise, LIVE } from './helpers/live.js';
import { attach } from '../src/admin.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;
const ME = userInfo().username;
const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };

// fake-claude as `claude`: with -p it plays a stream-json session; without, it is the human's
// interactive session, which records its argv and cwd and exits.
const FAKE_BIN = mkdtempSync(join(tmpdir(), 'at-tob-'));
symlinkSync(new URL('./fixtures/fake-claude', import.meta.url).pathname, join(FAKE_BIN, 'claude'));
const PATH = `${FAKE_BIN}:${process.env.PATH}`;

function cli(args, sock, env = {}) {
  return promisify(execFile)(process.execPath, [BIN, ...args], {
    env: { ...process.env, AGENT_TEAM_SUPERVISOR_SOCK: sock, PATH, ...env }
  }).then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
          (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
}

test('attach hands a running claude member to a human and resumes it headless on exit', { timeout: 20_000 }, async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'at-tol-')), 'claude.jsonl');
  const { root, script } = project({ solo: { agent: 'claude', isolation: 'workspace' } }, {});
  const { sup, store } = await supervise(script, { env: { PATH, FAKE_CLAUDE_LOG: log } });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'HOLD the work' });
    await until(() => store.member(memberId).resume);
    const sid = store.member(memberId).resume;
    const workspace = realpathSync(store.member(memberId).workspace);   // pruned once the run is ok

    const { code, stdout, stderr } = await cli(['attach', String(runId), 'solo'], sup.socketPath, { FAKE_CLAUDE_LOG: log });
    assert.equal(code, 0, stderr);
    assert.match(stderr, /solo is paused and yours\. claude may first ask whether to trust /);
    assert.deepEqual(JSON.parse(stdout), { members: [{ id: memberId, name: 'solo' }], skipped: [] });

    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.match(result.summary, new RegExp(
      `^echo: Resumed by ${ME}\\.\\nYour last turn was interrupted: .*\\n` +
      `${ME} drove this session in a terminal while you were paused; their turns are in your history\\.`));

    const starts = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(starts.length, 3);
    const [, human, back] = starts;
    assert.deepEqual(human.argv, ['--resume', sid]);
    assert.equal(human.cwd, workspace);
    assert.ok(back.argv.includes('-p'));
    assert.equal(back.argv[back.argv.indexOf('--resume') + 1], sid);
    assert.deepEqual(store.events(memberId).filter((e) => ['paused', 'taken_over', 'handed_back', 'resumed'].includes(e.kind))
      .map((e) => [e.kind, e.body]),
      [['paused', { by: ME, now: true }], ['taken_over', { by: ME }], ['handed_back', { by: ME }], ['resumed', { by: ME }]]);
  } finally { await sup.close(); }
});

test('while a human drives, the manager is told and pause refuses; any exit hands back', { timeout: 20_000 }, async () => {
  const { root, script } = project({
    lead: LIVE(), solo: { agent: 'claude', isolation: 'workspace', reports_to: 'lead' }
  }, {
    by_member: { lead: { steps: [
      { tool: 'delegate', args: { to: 'solo', task: 'HOLD it' }, save: 'r' },
      { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
    ] } }
  });
  const { sup, store } = await supervise(script, { env: { PATH } });
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.children(leadId)[0]?.resume);
    const soloId = store.children(leadId)[0].id;
    const call = async (method, params) => (method === 'takeover' ? sup.takeover(params) : sup.handback(params));
    const run = () => {
      assert.equal(store.member(soloId).state, 'taken_over');
      assert.throws(() => sup.pause({ member_id: soloId }), /^Error: "solo" is taken over by a human$/);
      return { status: 7 };   // the human's claude exited non-zero
    };
    await attach({ member_id: soloId }, { call, run, log: () => {} });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const seen = result.tool_results.flatMap((t) => t.result.messages ?? []).map((m) => m.text);
    assert.ok(seen.includes(`taken over by ${ME}`), JSON.stringify(seen));
    assert.equal(store.member(soloId).state, 'done');
  } finally { await sup.close(); }
});

test('only claude members can be taken over', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } } });
  const { sup, store } = await supervise(script);
  try {
    const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    await assert.rejects(sup.takeover({ member_id: memberId }), /^Error: "solo" runs mock-live; only claude members can be taken over$/);
    assert.equal(store.member(memberId).state, 'waiting');
    assert.throws(() => sup.handback({ member_id: memberId }), /^Error: "solo" is not taken over \(waiting\)$/);
  } finally { await sup.close(); }
});

test('a restart leaves a taken-over member to its human', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } } });
  const first = await supervise(script);
  const { store } = first;
  const { runId, memberId } = first.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  await until(() => store.member(memberId).state === 'waiting');
  await first.sup.close();
  store.setState(memberId, 'taken_over');
  const { sup } = await supervise(script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(store.member(memberId).state, 'taken_over');
  } finally { await sup.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/takeover.test.js`
Expected: FAIL with `SyntaxError: The requested module '../src/admin.js' does not provide an export named 'attach'`.

- [ ] **Step 3: Add `takeover` and `handback` to the supervisor**

In `src/supervisor.js`, before `// A run paused at its cost cap resumes only with a higher cap.` (`#allowSpend`, Task 9), add:

```js
  // Hands a claude member's session to a human: its turn is interrupted, and once its adapter
  // has exited (so two processes never write one session) it is marked taken_over. The caller
  // runs `argv` in `cwd` and calls handback when the human is done.
  async takeover({ by = 'local', ...who } = {}) {
    const m = this.#target(who);
    const r = await this.#resolve(m);
    if (r.resolved?.agent !== 'claude') {
      throw new Error(`"${m.name}" runs ${r.team ? 'a team in another project' : r.resolved?.agent ?? 'nothing'}; only claude members can be taken over`);
    }
    if (m.state !== 'paused') {
      const rt = this.#live.get(m.id);
      this.#halt(m, 'pause', { now: true, by });
      await rt?.session?.exited;
    }
    const now = this.store.member(m.id);
    if (now.state !== 'paused') throw new Error(`"${m.name}" is still pausing — run attach again in a moment`);
    if (!now.resume || !now.workspace) throw new Error(`"${m.name}" has no claude session yet — resume it instead`);
    this.store.setState(m.id, 'taken_over');
    this.store.addEvent(m.id, 'taken_over', { by });
    this.#notifyManager(now, `taken over by ${by}`);
    return { member_id: m.id, name: m.name, cwd: now.workspace, argv: ['claude', '--resume', now.resume] };
  }

  // The human's terminal session has ended: run the member headless again from that session.
  handback({ by = 'local', ...who } = {}) {
    const m = this.#target(who);
    if (m.state !== 'taken_over') throw new Error(`"${m.name}" is not taken over (${m.state})`);
    this.store.setState(m.id, 'paused');
    this.store.addEvent(m.id, 'handed_back', { by });
    this.#unpause(this.store.member(m.id), { note: null, by, drove: true });
    return { members: [{ id: m.id, name: m.name }], skipped: [] };
  }
```

Change `#unpause`'s signature to `#unpause(m, { note, by, drove = false }) {` and, after the `if (paused.now) { ... }` block, add:

```js
    if (drove) {
      lines.push(`${by} drove this session in a terminal while you were paused; their turns are ` +
                 'in your history. Continue from where they left off.');
    }
```

In `#halt`, after the `TERMINAL.has(m.state)` line, add:

```js
    if (m.state === 'taken_over' && kind === 'pause') throw new Error(`"${m.name}" is taken over by a human`);
```

In `#recoverMember`, replace the first line with:

```js
    // A taken-over member may still be in a human's terminal; handback resumes it.
    if (TERMINAL.has(m.state) || m.state === 'paused' || m.state === 'taken_over') return;
```

In `#handle`'s `admin` object, after `cancel: (p) => this.cancel(p)` (add the comma), add:

```js
      takeover: (p) => this.takeover(p),
      handback: (p) => this.handback(p)
```

- [ ] **Step 4: Add `attach` to `src/admin.js`**

Add `import { spawnSync } from 'node:child_process';` as the first import, and append:

```js
// `agent-team attach`: take the member over, run its harness session in this terminal, and
// hand it back when the human exits, whatever the exit. Ctrl-C belongs to the harness while it
// runs; without ignoring it here, this process would die before handing back.
export async function attach(who, { call = adminCall, run = spawnSync, log = (s) => process.stderr.write(s) } = {}) {
  const by = whoAmI();
  const t = await call('takeover', { ...who, by });
  log(`agent-team: ${t.name} is paused and yours. claude may first ask whether to trust ${t.cwd}.\n` +
      'agent-team: exit claude to hand the session back.\n');
  const ignore = () => {};
  process.on('SIGINT', ignore);
  let r;
  try {
    r = run(t.argv[0], t.argv.slice(1), { cwd: t.cwd, stdio: 'inherit' });
  } finally {
    process.off('SIGINT', ignore);
  }
  if (r.error) log(`agent-team: could not run ${t.argv[0]}: ${r.error.message}\n`);
  return call('handback', { member_id: t.member_id, by });
}
```

- [ ] **Step 5: Add the `attach` verb**

In `bin/agent-team.js`, change the `../src/admin.js` import to:

```js
import { adminCall, attach, memberArgs, whoAmI, renderQuestions } from '../src/admin.js';
```

Append to `USAGE` (move the closing `;` from the `answer` line):

```js
  '       agent-team attach <run> <member>\n';
```

Before `if (Object.hasOwn(ADMIN, positionals[0])) {`, add:

```js
if (positionals[0] === 'attach') {
  try {
    const back = await attach(memberArgs(positionals.slice(1)));
    process.stdout.write(JSON.stringify(back, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`agent-team: ${err.message}\n`);
    process.exit(1);
  }
}
```

- [ ] **Step 6: Document take-over**

In `docs/how-it-works.md`, "Steering a live run", add `agent-team attach <run> <member>` as the last line of the verb block, and after the paragraph about `--subtree` add:

```
`attach` hands a claude member to you: its turn is interrupted, and once its process has
exited, `claude --resume <session>` starts in its workspace in your terminal. Its manager is
told it was taken over. Claude may first ask whether to trust the workspace folder. When you
exit claude, however you exit, the member resumes headless and is told that you drove the
session; your turns are in its history. While you have it, `pause` refuses it and a
supervisor restart leaves it alone. Taking over a codex member comes in a later plan.
```

In `docs/adapters.md`, "Environment", add `takeover`, `handback` to the admin method list Task 10 extended.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --import ./test/helpers/guard.js --test test/takeover.test.js test/admin-cli.test.js test/recovery.test.js`
Expected: PASS, `ℹ fail 0`.

Run: `npm test 2>&1 | grep -E '^ℹ (pass|fail|skipped)'`
Expected: `ℹ pass 495`, `ℹ fail 0`, `ℹ skipped 1`.

- [ ] **Step 8: Commit**

```bash
git add src/supervisor.js src/admin.js bin/agent-team.js test/takeover.test.js docs/how-it-works.md docs/adapters.md
git commit -m "feat(cli): attach takes over a claude member and hands it back on exit"
```

---

## Plan 1b-2 scope (split off)

Written as its own plan once this one lands; each item builds on Tasks 2–12 unchanged.

1. **`codex` session adapter over `codex app-server`.** `initialize`, `thread/start` or `thread/resume`, `turn/start`, `turn/steer` with `expectedTurnId`, `turn/interrupt` (method and param names from the generated schema in the probe's `codex-schema/`). Ack = the app-server answered `turn/steer`/`turn/start` without error. Because `turn/interrupt` leaves started shell commands running, pause-now and cancel also end the app-server process. How codex loads the team MCP server (`-c mcp_servers...` or a profile) is not probed yet and must be checked first. Fake app-server fixture; gated real smoke test. Codex reports tokens, not dollars, so it adds nothing to `max_cost_usd`; document that.
2. **Codex take-over.** The adapter owns an app-server listening on `ws://127.0.0.1:0` with `--ws-auth capability-token`; `takeover` asks it to `hold` (finish the turn, keep the app-server) and the CLI runs `codex --remote` against it, so the thread writer never changes. Plain `codex resume` starts a managed daemon that keeps the writer lock after exit. Unverified against a real binary; the first step is a probe. Needs protocol messages `hold`/`held {attach}`/`release {note}` and mock-live support for them.
3. **Spec and docs:** the spec's take-over section updated to what Task 12 and item 2 actually do.

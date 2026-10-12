# Steerable teams 1a: core runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A supervisor that runs v2 (session) members live: a manager delegates to reports that run in parallel, watches their checkpoints with `wait_for`, and steers them with `send_to`, all proven with a scripted mock adapter.

**Architecture:** `src/supervisor.js` owns every live member. It persists runs, members, events, messages, and questions in SQLite (`src/store.js`), spawns v2 adapters as long-lived processes that speak newline-delimited JSON (`src/protocol.js`, `src/sessions.js`), and serves the five team tools to members over a Unix socket (`src/rpc.js`). Real harnesses reach those tools through `agent-team mcp` (`src/mcp.js`), a stdio MCP server; the test adapter `adapters/mock-live` calls the socket directly. v1 members still run through today's `runMember` loop.

**Tech Stack:** Node.js ≥22.13 standard library only: `node:sqlite`, `node:net`, `node:child_process`, `node:readline`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-12-steerable-teams-design.md`. This plan covers the parts of "A supervisor that outlives the dispatch", "Adapter contract v2", and "Members steer each other through tools" that need no real harness. Plan 1b adds the `claude` and `codex` v2 adapters, pause/resume/cancel/attach, restart recovery, stalls, and the cost cap. Plan 1c adds the web view, the remaining CLI verbs, and `report` from the store.

## Global Constraints

- Standard library only. The plugin has no npm install step (`channel/server.js:17`), so no `dependencies`.
- `engines.node` becomes `">=22.13"` (first release where `node:sqlite` needs no flag).
- ESM, semicolons, 2-space indent, single quotes, `//` comments that explain why; no JSDoc.
- Error messages name the member: `member "x": …` or `"x" is not a direct report of "lead"`.
- Every adapter output line is untrusted: shape-check it in `parseAdapterLine` before use; drop anything that fails.
- Every team tool schema declares `annotations: { readOnlyHint: true }`. Without it, a member in `--permission-mode plan` is denied the call even when the tool is in `--allowedTools`.
- `ack` means the harness consumed the message, not that it was written. A message offered but not acked when the turn ends (`idle`) or the process exits goes back to `queued`.
- Messages are rendered to members as `[from: <name> (<kind>)] <text>`, kind one of `human`, `manager`, `report`.
- Existing tests must pass unchanged: `npm test` is green before and after every task. `src/dispatch.js`'s `dispatch()` keeps its signature and behaviour; the `mock` adapter is not modified.
- Test runner: `node --test 'test/**/*.test.js'`; a single file: `node --test test/<name>.test.js`.

## Review Focus

- A member that calls a tool after it has finished, or with a token the supervisor never issued, gets a tool error; the supervisor does not throw. Test in Task 6.
- A human message sent to a member that is still `queued` (not launched) is delivered once, after launch. Test in Task 6.
- An adapter that exits without a `result` line, or prints garbage, fails that member with its stderr tail, and the manager hears `finished failed: …`. Test in Task 5.
- A message offered mid-turn but never acked is re-queued at `idle` and offered again, never delivered twice. Test in Task 1 (store) and Task 5 (supervisor).
- A delegate to a non-report, past `max_depth`, or past `max_delegations` returns a tool error to the caller and the run carries on. Test in Task 6.

---

## File structure

| File | Responsibility |
|---|---|
| `src/store.js` (new) | SQLite schema and every read/write. Only file that touches the database. |
| `src/protocol.js` (new) | Encode supervisor→adapter lines; parse and shape-check adapter→supervisor lines. |
| `src/rpc.js` (new) | Unix-socket JSON-line RPC: `serveRpc`, `callRpc`, `isListening`, stale-socket handling. |
| `src/sessions.js` (new) | `MemberSession`: one spawned v2 adapter process. |
| `src/team-tools.js` (new) | Tool schemas and the brief note that tells a v2 member how to work live. |
| `src/supervisor.js` (new) | Scheduling, inbox delivery, tool implementations, run completion. |
| `src/mcp.js` (new) | stdio MCP server that forwards tool calls to the supervisor socket. |
| `adapters/mock-live` (new) | Scripted v2 adapter for tests. |
| `src/dispatch.js` (modify) | Export `resolveCaps`, `prepareMember`, `runMember` for the supervisor. |
| `src/config.js` (modify) | `defaults.max_parallel` (default 3). |
| `bin/agent-team.js` (modify) | `serve`, `mcp`, and v2 roots submitted to a supervisor. |
| `package.json` (modify) | `engines`. |

---

### Task 1: SQLite store

**Files:**
- Modify: `package.json`
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces: `openStore(path) → store` where `store` has: `close()`, `createRun({project, task}) → runId`, `run(id)`, `setRunRoot(runId, memberId)`, `finishRun(runId, status)`, `addMember({runId, parentId, name, task, depth}) → {id, token}`, `member(id)`, `memberByToken(token)`, `members(runId)`, `children(memberId)`, `setState(id, state)`, `setHarness(id, harnessId)`, `setWorkspace(id, dir)`, `setResult(id, resultObject)`, `addEvent(memberId, kind, body)`, `events(memberId)`, `enqueue({to, fromKind, fromName, reportId?, text}) → messageId`, `takeQueued(memberId, reportIds?) → rows`, `offerQueued(memberId) → rows`, `ackMessage(id)`, `requeue(id)`, `message(id)`, `addQuestion({memberId, question, options}) → questionId`, `question(id)`, `answerQuestion(id, answer, by)`, `openQuestions()`.
- Member rows: `{id, run_id, parent_id, name, task, depth, state, token, harness_id, workspace, result, created_at, updated_at}` with `result` parsed from JSON. Message rows: `{id, to_member, from_kind, from_name, report_id, text, state, at}`; `state` ∈ `queued | offered | delivered`.

- [ ] **Step 1: Raise the Node floor**

In `package.json`, change `"engines": { "node": ">=22" }` to `"engines": { "node": ">=22.13" }`.

- [ ] **Step 2: Write the failing tests**

Create `test/store.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';

function seeded() {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 'ship it' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 'ship it', depth: 0 });
  store.setRunRoot(runId, lead.id);
  return { store, runId, lead };
}

test('members get unique tokens and parse their results', () => {
  const { store, runId, lead } = seeded();
  const kid = store.addMember({ runId, parentId: lead.id, name: 'worker', task: 't', depth: 1 });
  assert.notEqual(lead.token, kid.token);
  assert.equal(store.memberByToken(kid.token).name, 'worker');
  assert.deepEqual(store.children(lead.id).map((m) => m.name), ['worker']);
  store.setResult(kid.id, { status: 'ok', summary: 'done' });
  assert.deepEqual(store.member(kid.id).result, { status: 'ok', summary: 'done' });
  assert.equal(store.member(kid.id).state, 'queued');
});

test('an offered message is delivered once on ack and never offered again', () => {
  const { store, lead } = seeded();
  const id = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'brandon', text: 'hi' });
  assert.deepEqual(store.offerQueued(lead.id).map((m) => m.id), [id]);
  assert.deepEqual(store.offerQueued(lead.id), []);
  store.ackMessage(id);
  store.requeue(id);                       // too late: already delivered
  assert.equal(store.message(id).state, 'delivered');
  assert.deepEqual(store.offerQueued(lead.id), []);
  assert.deepEqual(store.takeQueued(lead.id), []);
});

test('an offered message that was not acked goes back to the queue', () => {
  const { store, lead } = seeded();
  const id = store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'brandon', text: 'hi' });
  store.offerQueued(lead.id);
  store.requeue(id);
  assert.deepEqual(store.takeQueued(lead.id).map((m) => m.id), [id]);
  assert.equal(store.message(id).state, 'delivered');
});

test('takeQueued with report ids leaves other reports\' messages queued', () => {
  const { store, lead } = seeded();
  store.enqueue({ to: lead.id, fromKind: 'report', fromName: 'a', reportId: 10, text: 'a' });
  store.enqueue({ to: lead.id, fromKind: 'report', fromName: 'b', reportId: 11, text: 'b' });
  store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'brandon', text: 'h' });
  assert.deepEqual(store.takeQueued(lead.id, [11]).map((m) => m.text), ['b', 'h']);
  assert.deepEqual(store.takeQueued(lead.id).map((m) => m.text), ['a']);
});

test('questions open, then close with who answered', () => {
  const { store, lead } = seeded();
  const q = store.addQuestion({ memberId: lead.id, question: 'which?', options: ['a', 'b'] });
  assert.deepEqual(store.openQuestions().map((r) => r.id), [q]);
  store.answerQuestion(q, 'a', 'brandon');
  assert.deepEqual(store.question(q).options, ['a', 'b']);
  assert.equal(store.question(q).answered_by, 'brandon');
  assert.deepEqual(store.openQuestions(), []);
});

test('events keep their order and body', () => {
  const { store, lead } = seeded();
  store.addEvent(lead.id, 'text', { text: 'one' });
  store.addEvent(lead.id, 'text', { text: 'two' });
  assert.deepEqual(store.events(lead.id).map((e) => e.body.text), ['one', 'two']);
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test test/store.test.js`
Expected: FAIL, `Cannot find module '…/src/store.js'`.

- [ ] **Step 4: Implement the store**

Create `src/store.js`:

```js
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// One supervisor process owns the database, and node:sqlite is synchronous, so every method
// here runs to completion before any other JavaScript does. That is what makes offerQueued
// and takeQueued safe without explicit transactions.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL,
  root_member INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
  parent_id INTEGER REFERENCES members(id), name TEXT NOT NULL, task TEXT NOT NULL,
  depth INTEGER NOT NULL, state TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
  harness_id TEXT, workspace TEXT, result TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, to_member INTEGER NOT NULL REFERENCES members(id),
  from_kind TEXT NOT NULL, from_name TEXT NOT NULL, report_id INTEGER,
  text TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
  question TEXT NOT NULL, options TEXT, answer TEXT, answered_by TEXT, at INTEGER NOT NULL);
`;

const now = () => Date.now();
const parse = (s) => (s == null ? null : JSON.parse(s));

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const memberRow = (row) => row && { ...row, result: parse(row.result) };
  const questionRow = (row) => row && { ...row, options: parse(row.options) };
  const setMessageState = (id, from, to) =>
    q('UPDATE messages SET state = ? WHERE id = ? AND state = ?').run(to, id, from);
  const queued = (memberId) =>
    q("SELECT * FROM messages WHERE to_member = ? AND state = 'queued' ORDER BY id").all(memberId);

  return {
    close: () => db.close(),

    createRun: ({ project, task }) => Number(
      q("INSERT INTO runs (project, task, status, created_at) VALUES (?, ?, 'running', ?)")
        .run(project, task, now()).lastInsertRowid),
    run: (id) => q('SELECT * FROM runs WHERE id = ?').get(id),
    setRunRoot: (id, memberId) => q('UPDATE runs SET root_member = ? WHERE id = ?').run(memberId, id),
    finishRun: (id, status) => q('UPDATE runs SET status = ? WHERE id = ?').run(status, id),

    addMember({ runId, parentId, name, task, depth }) {
      const token = randomBytes(24).toString('hex');
      const t = now();
      const id = Number(q(
        "INSERT INTO members (run_id, parent_id, name, task, depth, state, token, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)"
      ).run(runId, parentId, name, task, depth, token, t, t).lastInsertRowid);
      return { id, token };
    },
    member: (id) => memberRow(q('SELECT * FROM members WHERE id = ?').get(id)),
    memberByToken: (token) => memberRow(q('SELECT * FROM members WHERE token = ?').get(token)),
    members: (runId) => q('SELECT * FROM members WHERE run_id = ? ORDER BY id').all(runId).map(memberRow),
    children: (id) => q('SELECT * FROM members WHERE parent_id = ? ORDER BY id').all(id).map(memberRow),
    setState: (id, state) => q('UPDATE members SET state = ?, updated_at = ? WHERE id = ?').run(state, now(), id),
    setHarness: (id, harnessId) => q('UPDATE members SET harness_id = ? WHERE id = ?').run(harnessId, id),
    setWorkspace: (id, dir) => q('UPDATE members SET workspace = ? WHERE id = ?').run(dir, id),
    setResult: (id, result) => q('UPDATE members SET result = ? WHERE id = ?').run(JSON.stringify(result), id),

    addEvent: (memberId, kind, body) =>
      q('INSERT INTO events (member_id, kind, body, at) VALUES (?, ?, ?, ?)')
        .run(memberId, kind, JSON.stringify(body ?? {}), now()),
    events: (memberId) => q('SELECT * FROM events WHERE member_id = ? ORDER BY id').all(memberId)
      .map((e) => ({ ...e, body: parse(e.body) })),

    enqueue: ({ to, fromKind, fromName, reportId = null, text }) => Number(q(
      "INSERT INTO messages (to_member, from_kind, from_name, report_id, text, state, at) " +
      "VALUES (?, ?, ?, ?, ?, 'queued', ?)"
    ).run(to, fromKind, fromName, reportId, text, now()).lastInsertRowid),
    // The wait_for path: the tool result itself is the delivery, so these go straight to
    // delivered. Messages from reports not in reportIds stay queued for a later call.
    takeQueued(memberId, reportIds = null) {
      const rows = queued(memberId).filter((m) =>
        reportIds == null || m.report_id == null || reportIds.includes(m.report_id));
      for (const m of rows) setMessageState(m.id, 'queued', 'delivered');
      return rows.map((m) => ({ ...m, state: 'delivered' }));
    },
    // The adapter path: written to the harness, delivered only once the adapter acks it.
    offerQueued(memberId) {
      const rows = queued(memberId);
      for (const m of rows) setMessageState(m.id, 'queued', 'offered');
      return rows.map((m) => ({ ...m, state: 'offered' }));
    },
    ackMessage: (id) => setMessageState(id, 'offered', 'delivered'),
    requeue: (id) => setMessageState(id, 'offered', 'queued'),
    message: (id) => q('SELECT * FROM messages WHERE id = ?').get(id),

    addQuestion: ({ memberId, question, options = null }) => Number(
      q('INSERT INTO questions (member_id, question, options, at) VALUES (?, ?, ?, ?)')
        .run(memberId, question, options == null ? null : JSON.stringify(options), now()).lastInsertRowid),
    question: (id) => questionRow(q('SELECT * FROM questions WHERE id = ?').get(id)),
    answerQuestion: (id, answer, by) =>
      q('UPDATE questions SET answer = ?, answered_by = ? WHERE id = ?').run(answer, by, id),
    openQuestions: () => q('SELECT * FROM questions WHERE answer IS NULL ORDER BY id').all().map(questionRow)
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --test test/store.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json src/store.js test/store.test.js
git commit -m "feat(store): add the SQLite store for live runs"
```

---

### Task 2: Adapter protocol and member sessions

**Files:**
- Create: `src/protocol.js`, `src/sessions.js`
- Create: `test/fixtures/session-echo` (executable)
- Test: `test/protocol.test.js`

**Interfaces:**
- Produces: `encode(message) → string` (one JSON line with `\n`); `parseAdapterLine(line) → message | null`. Accepted adapter messages: `{type:'session', harness_id:string, resume}`, `{type:'event', kind:string, …}`, `{type:'ack', message_id:integer}`, `{type:'idle'}`, `{type:'result', status:'ok'|'failed', summary:string, …}`.
- Produces: `new MemberSession({execPath, cwd, env, onLine, onExit})` that spawns `<execPath> session`; `.send(message)`; `onLine(message)` gets only parsed messages; `onExit(code, stderrTail)`.
- Supervisor → adapter messages: `{type:'start', brief}`, `{type:'message', id, from, text}`, `{type:'stop'}`, `{type:'interrupt'}`.

- [ ] **Step 1: Write the failing tests**

Create `test/fixtures/session-echo` and `chmod +x` it:

```js
#!/usr/bin/env node
// Answers start with a session line, a garbage line, and an event echoing the member; acks
// every message; on stop prints a result and exits. Used to test MemberSession framing.
import { createInterface } from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'start') {
    out({ type: 'session', harness_id: 'h-1', resume: null });
    process.stdout.write('not json\n');
    out({ type: 'event', kind: 'text', text: m.brief.member });
  } else if (m.type === 'message') {
    out({ type: 'ack', message_id: m.id });
  } else if (m.type === 'stop') {
    process.stderr.write('bye\n');
    out({ type: 'result', status: 'ok', summary: 'stopped' });
    process.exit(0);
  }
});
```

Create `test/protocol.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, parseAdapterLine } from '../src/protocol.js';
import { MemberSession } from '../src/sessions.js';

const fixture = new URL('./fixtures/session-echo', import.meta.url).pathname;

test('parseAdapterLine accepts each well-formed message type', () => {
  for (const m of [
    { type: 'session', harness_id: 'x', resume: null },
    { type: 'event', kind: 'text', text: 'hi' },
    { type: 'ack', message_id: 3 },
    { type: 'idle' },
    { type: 'result', status: 'ok', summary: 'done' }
  ]) assert.deepEqual(parseAdapterLine(JSON.stringify(m)), m);
});

test('parseAdapterLine drops malformed or unknown lines', () => {
  for (const line of [
    'not json', '[]', 'null', '{"type":"start"}', '{"type":"ack","message_id":"3"}',
    '{"type":"result","status":"maybe","summary":"x"}', '{"type":"session"}'
  ]) assert.equal(parseAdapterLine(line), null, line);
});

test('encode writes one line', () => {
  assert.equal(encode({ type: 'stop' }), '{"type":"stop"}\n');
});

test('MemberSession frames lines both ways and reports the exit', async () => {
  const seen = [];
  const exited = new Promise((resolve) => {
    const s = new MemberSession({
      execPath: fixture, cwd: process.cwd(), env: {},
      onLine: (m) => {
        seen.push(m);
        if (m.type === 'event') s.send({ type: 'message', id: 7, from: 'x (human)', text: 'hi' });
        if (m.type === 'ack') s.send({ type: 'stop' });
      },
      onExit: (code, stderr) => resolve({ code, stderr })
    });
    s.send({ type: 'start', brief: { member: 'lead' } });
  });
  const { code, stderr } = await exited;
  assert.equal(code, 0);
  assert.match(stderr, /bye/);
  assert.deepEqual(seen.map((m) => m.type), ['session', 'event', 'ack', 'result']);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/protocol.test.js`
Expected: FAIL, `Cannot find module '…/src/protocol.js'`.

- [ ] **Step 3: Implement the protocol**

Create `src/protocol.js`:

```js
// Adapter contract v2: newline-delimited JSON both ways. Lines from the adapter are untrusted
// (it wraps a vendor CLI), so each one is shape-checked here and dropped if it does not fit.
const RESULT_STATUSES = new Set(['ok', 'failed']);

const CHECKS = {
  session: (m) => typeof m.harness_id === 'string' && m.harness_id.length > 0,
  event: (m) => typeof m.kind === 'string' && m.kind.length > 0,
  ack: (m) => Number.isInteger(m.message_id),
  idle: () => true,
  result: (m) => RESULT_STATUSES.has(m.status) && typeof m.summary === 'string'
};

export function parseAdapterLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return null; }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
  const check = Object.hasOwn(CHECKS, m.type) ? CHECKS[m.type] : null;
  return check && check(m) ? m : null;
}

export const encode = (message) => JSON.stringify(message) + '\n';
```

- [ ] **Step 4: Implement the session**

Create `src/sessions.js`:

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
    this.child.on('close', (code) => onExit(code, this.stderr));
    this.child.on('error', (err) => { this.stderr += `\n${err.message}`; });
  }

  send(message) {
    if (this.child.stdin.writable) this.child.stdin.write(encode(message));
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --test test/protocol.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/protocol.js src/sessions.js test/protocol.test.js test/fixtures/session-echo
git commit -m "feat(sessions): add the v2 adapter line protocol"
```

---

### Task 3: Socket RPC

**Files:**
- Create: `src/rpc.js`
- Test: `test/rpc.test.js`

**Interfaces:**
- Produces: `serveRpc(path, handler) → Promise<{close(), path}>` where `handler({token, method, params})` returns a value or promise; a throw becomes `{error: message}`. `callRpc(path, {token, method, params}) → Promise<result>` rejecting with `Error(message)` on `{error}`. `isListening(path) → Promise<boolean>`. `class SupervisorRunning extends Error`.
- The socket's directory is created with mode `0700`. A stale socket file (nothing listening) is removed; a live one makes `serveRpc` reject with `SupervisorRunning`.

- [ ] **Step 1: Write the failing tests**

Create `test/rpc.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRpc, callRpc, isListening, SupervisorRunning } from '../src/rpc.js';

const sockPath = () => join(mkdtempSync(join(tmpdir(), 'at-rpc-')), 's', 'sup.sock');

test('a call reaches the handler with its token and gets the result', async () => {
  const path = sockPath();
  const server = await serveRpc(path, async ({ token, method, params }) => ({ token, method, n: params.n + 1 }));
  try {
    assert.deepEqual(await callRpc(path, { token: 't1', method: 'inc', params: { n: 1 } }),
      { token: 't1', method: 'inc', n: 2 });
    assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
  } finally { await server.close(); }
});

test('a handler error rejects the call with its message', async () => {
  const path = sockPath();
  const server = await serveRpc(path, () => { throw new Error('nope'); });
  try {
    await assert.rejects(callRpc(path, { method: 'x' }), /nope/);
  } finally { await server.close(); }
});

test('a stale socket file is replaced; a live one refuses a second server', async () => {
  const path = sockPath();
  const first = await serveRpc(path, () => 1);
  await assert.rejects(serveRpc(path, () => 2), SupervisorRunning);
  await first.close();
  writeFileSync(path, '');                 // what a crashed supervisor leaves behind
  assert.equal(await isListening(path), false);
  const second = await serveRpc(path, () => 3);
  try {
    assert.equal(await callRpc(path, { method: 'x' }), 3);
  } finally { await second.close(); }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/rpc.test.js`
Expected: FAIL, `Cannot find module '…/src/rpc.js'`.

- [ ] **Step 3: Implement the RPC**

Create `src/rpc.js`:

```js
import { createServer, connect } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// One JSON object per line each way: {id, token, method, params} in, {id, result} or
// {id, error} out. The only access control is the directory mode (0700, same user), as for
// the channel sockets; member tokens identify the caller, they do not authenticate a user.
export class SupervisorRunning extends Error {}

export async function serveRpc(path, handler) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const server = createServer((sock) => {
    sock.on('error', () => {});
    createInterface({ input: sock }).on('line', async (line) => {
      let req;
      try { req = JSON.parse(line); } catch { return; }
      let reply;
      try {
        reply = { id: req.id, result: await handler({ token: req.token ?? null, method: req.method, params: req.params ?? {} }) };
      } catch (err) {
        reply = { id: req.id, error: err.message };
      }
      if (!sock.destroyed) sock.write(JSON.stringify(reply) + '\n');
    });
  });
  await listenExclusive(server, path);
  return { path, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
}

// A socket file with nothing behind it is what a crashed supervisor leaves; remove it once
// and retry. A second EADDRINUSE means another supervisor won the race.
async function listenExclusive(server, path) {
  try {
    await listen(server, path);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    if (await isListening(path)) throw new SupervisorRunning(`a supervisor is already listening on ${path}`);
    try { unlinkSync(path); } catch { /* already gone */ }
    try {
      await listen(server, path);
    } catch (again) {
      if (again.code === 'EADDRINUSE') throw new SupervisorRunning(`a supervisor is already listening on ${path}`);
      throw again;
    }
  }
}

export function isListening(path) {
  return new Promise((resolve) => {
    const sock = connect(path);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

export function callRpc(path, { token = null, method, params = {} }) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    sock.once('error', reject);
    createInterface({ input: sock }).once('line', (line) => {
      sock.destroy();
      let reply;
      try { reply = JSON.parse(line); } catch { return reject(new Error('unreadable reply from the supervisor')); }
      if (reply.error !== undefined) reject(new Error(reply.error));
      else resolve(reply.result);
    });
    sock.write(JSON.stringify({ id: 1, token, method, params }) + '\n');
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test test/rpc.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rpc.js test/rpc.test.js
git commit -m "feat(rpc): add the supervisor socket"
```

---

### Task 4: Expose member preparation from dispatch, and `max_parallel`

**Files:**
- Modify: `src/dispatch.js:281-375` (split `runMember`)
- Modify: `src/config.js:431-445` (defaults)
- Test: `test/config.test.js` (add one test), existing `test/dispatch.test.js` unchanged

**Interfaces:**
- Produces: `export async function resolveCaps(ctx) → {resolved, caps}`; `export function prepareMember(ctx, {resolved, caps}) → {dialectText, skillText, workspace, cloud, session, unmatchedDenyPaths, droppedSymlinks}`; `export async function runMember(ctx)` (unchanged behaviour). `ctx` is `{config, projectRoot, member, task, adapterDir, assignments, skillsDir, env, timeoutMs, budget, depth}` as today.
- Produces: `config.defaults.max_parallel` (integer ≥ 1, default 3).

- [ ] **Step 1: Write the failing config test**

Append to `test/config.test.js` (it already imports `parseConfig`, `test` and `assert`; check the top of the file and add any that are missing):

```js
test('defaults.max_parallel defaults to 3 and must be a positive integer', () => {
  const base = { members: { a: { agent: 'mock' } }, deny_paths: ['x'] };
  assert.equal(parseConfig(JSON.stringify(base), 'c.json').defaults.max_parallel, 3);
  assert.throws(
    () => parseConfig(JSON.stringify({ ...base, defaults: { max_parallel: 0 } }), 'c.json'),
    /"defaults.max_parallel" must be an integer >= 1/
  );
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/config.test.js`
Expected: FAIL on the new test (`undefined !== 3`).

- [ ] **Step 3: Add the default**

In `src/config.js`, add `max_parallel: 3,` to the `defaults` object after `max_delegations: 20,`, and after `validateBoundedInteger(defaults.max_delegations, 'max_delegations', 1, path);` add:

```js
  // How many of one manager's reports run at once under the supervisor; the rest queue.
  validateBoundedInteger(defaults.max_parallel, 'max_parallel', 1, path);
```

- [ ] **Step 4: Split runMember**

In `src/dispatch.js`:

1. Add `export` to `async function runMember(ctx)`.
2. Add a new exported function above `runMember`, holding the first part of its body (the probe, `resolveMember`, the `assignments` write, and `readCapabilities`):

```js
// The supervisor needs to know whether a member speaks the v2 session protocol before it
// builds a workspace, so resolution and capabilities are split from preparation.
export async function resolveCaps(ctx) {
  const { config, member, adapterDir, assignments, env } = ctx;
  const probe = makeProbe(adapterDir, env);
  const resolved = resolveMember(config, member, { probe, assignments });  // throws before side effects
  assignments[member] = resolved.agent;
  const caps = await readCapabilities(adapterDir, resolved.agent, env);
  return { resolved, caps };
}
```

3. Add a new exported function `prepareMember(ctx, { resolved, caps })`. Its body is the current `runMember` code from `const dialectText = loadDialect(...)` through the end of the `for (const linkName of droppedSymlinks)` loop, moved verbatim (comments included), with `const { config, projectRoot, member, skillsDir } = ctx;` at the top and this at the end:

```js
  return { dialectText, skillText, workspace, cloud, session, unmatchedDenyPaths, droppedSymlinks };
```

The moved code refers to `ctx` for `prepareSession(ctx, resolved)` and `prepareCloud(ctx, resolved)`, which keeps working because `ctx` is the parameter.

4. Replace the moved code in `runMember` with:

```js
  const { resolved, caps } = await resolveCaps(ctx);
  const { dialectText, skillText, workspace, cloud, session, unmatchedDenyPaths, droppedSymlinks } =
    prepareMember(ctx, { resolved, caps });
```

so `runMember` now starts: destructure `ctx`, `const spec = …; if (spec?.team) return runTeam(ctx, spec);`, the two lines above, then `const maxDepth = config.defaults.max_depth;` and the rest unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, every existing test plus the new config test. A failure in `test/dispatch.test.js` means the move changed behaviour; diff the moved block against `git show HEAD:src/dispatch.js`.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch.js src/config.js test/config.test.js
git commit -m "refactor(dispatch): expose member preparation for the supervisor"
```

---

### Task 5: Supervisor core with the `mock-live` adapter

**Files:**
- Create: `src/team-tools.js`, `src/supervisor.js`, `adapters/mock-live` (executable)
- Create: `test/fixtures/session-crash` (executable)
- Test: `test/supervisor.test.js`

**Interfaces:**
- Consumes: Task 1 `openStore`; Task 2 `MemberSession`; Task 3 `serveRpc`; Task 4 `resolveCaps`, `prepareMember`, `runMember`; `buildBrief` (`src/brief.js:91`); `pruneWorkspace` (`src/workspace.js`); `loadConfig` (`src/config.js:201`).
- Produces: `new Supervisor({store, adapterDir, skillsDir?, socketPath, env?, maxRunning?, timeoutMs?})`; `start()`; `close()`; `submit({projectRoot, member, task}) → {runId, memberId}`; `waitRun(runId) → Promise<rootResult>`; `send({member_id, text, from?}) → {message_id}`; `answer({question_id, answer, by?}) → {ok}`; `defaultSocketPath(env)`, `defaultStorePath(env)`. RPC methods: admin `submit`, `wait_run`, `send`, `answer` (no token); member `delegate`, `send_to`, `wait_for`, `report_progress`, `ask_human` (token required). Task 6 fills in the member tools; this task wires `report_progress` only, so the core can be tested.
- Produces: `TOOL_SCHEMAS` (array of MCP tool definitions) and `TEAM_NOTE` (string appended to a v2 member's brief) from `src/team-tools.js`.
- `adapters/mock-live` script format (`AGENT_TEAM_MOCK_SCRIPT`): `{by_member: {<name>: {steps: [...], result: {status, summary}}}}`. Steps: `{say}`, `{sleep_ms}`, `{tool, args, save?}`, `{tool: 'wait_for', args, until_finished: [ids]}`. String args of the form `$var.field` are replaced by `vars[var][field]` from earlier `save`s. Messages from the supervisor are acked at the next step boundary and recorded. The result carries `received` (rendered messages) and `tool_results`.

- [ ] **Step 1: Add the tool schemas and the brief note**

Create `src/team-tools.js`:

```js
// readOnlyHint is required, not decorative: claude in --permission-mode plan (read-only
// members) denies any MCP tool without it, even one listed in --allowedTools. None of these
// tools touch the member's workspace.
const RO = { readOnlyHint: true };

export const TOOL_SCHEMAS = [
  {
    name: 'delegate',
    description: 'Start a task on one of your direct reports. Returns {report_id} at once; the report runs in parallel with you. Follow up with wait_for.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: 'Name of a direct report' }, task: { type: 'string' } },
      required: ['to', 'task']
    },
    annotations: RO
  },
  {
    name: 'send_to',
    description: 'Message your manager, or one of your reports by name or report_id. They read it at their next step.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: ['string', 'integer'] }, text: { type: 'string' } },
      required: ['to', 'text']
    },
    annotations: RO
  },
  {
    name: 'wait_for',
    description: 'Block until a report sends progress or a message, or finishes, or until someone messages you. Returns {messages, timed_out}. Call it again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        report_ids: { type: 'array', items: { type: 'integer' } },
        timeout_s: { type: 'integer', minimum: 1, maximum: 1800 }
      }
    },
    annotations: RO
  },
  {
    name: 'report_progress',
    description: 'Send a short checkpoint to your manager.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: RO
  },
  {
    name: 'ask_human',
    description: 'Ask a human and block until they answer. Returns {answer}, or {answer: null, timed_out: true}, in which case decide yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        timeout_s: { type: 'integer', minimum: 1, maximum: 7200 }
      },
      required: ['question']
    },
    annotations: RO
  }
];

export const TEAM_NOTE = `

## Working as a live team

You are running live, with the agent-team tools: delegate, send_to, wait_for, report_progress,
and ask_human. Hand work to your reports with delegate rather than answering with
{"status":"delegating"}. Reports run in parallel: after delegating, call wait_for to hear from
them, and correct them with send_to while they work. Messages reach you as
"[from: <name> (<kind>)] <text>". A message from a human outranks a message from an agent.
Give your final answer only after your reports have finished.
`;
```

- [ ] **Step 2: Write the mock-live adapter**

Create `adapters/mock-live` and `chmod +x` it:

```js
#!/usr/bin/env node
// A scripted v2 (session) adapter for tests. It plays a harness: it runs the member's steps,
// calls the team tools over the supervisor socket the way `agent-team mcp` would for a real
// harness, and accepts inbox messages only at step boundaries, which is where claude picks
// up a mid-run message (at the next tool result).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { callRpc } from '../src/rpc.js';

const sub = process.argv[2];
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');

if (sub === 'probe') {
  process.stdout.write('mock-live 0.1.0\n', () => process.exit(0));
} else if (sub === 'capabilities') {
  process.stdout.write(JSON.stringify({
    write: true, workspace: true, structured_output: true, tool_dialect: 'claude', protocol: 2
  }) + '\n', () => process.exit(0));
} else if (sub === 'session') {
  session();
} else {
  process.stderr.write(`mock-live: unknown subcommand "${sub}"\n`);
  process.exit(2);
}

function session() {
  const queue = [];
  let wake = null;
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => { queue.push(JSON.parse(line)); wake?.(); wake = null; });
  rl.on('close', () => { queue.push({ type: 'stop' }); wake?.(); wake = null; });
  const next = async () => {
    while (queue.length === 0) await new Promise((r) => { wake = r; });
    return queue.shift();
  };

  const received = [];
  const toolResults = [];
  const accept = (m) => {
    out({ type: 'ack', message_id: m.id });
    const text = `[from: ${m.from}] ${m.text}`;
    received.push(text);
    out({ type: 'event', kind: 'user', text });
  };
  const drainMessages = () => {
    for (let i = 0; i < queue.length;) {
      if (queue[i].type === 'message') accept(queue.splice(i, 1)[0]);
      else i++;
    }
  };
  const call = (method, params) => callRpc(process.env.AGENT_TEAM_TEAM_SOCKET, {
    token: process.env.AGENT_TEAM_TEAM_TOKEN, method, params
  });

  (async () => {
    const start = await next();
    const brief = start.brief;
    const script = JSON.parse(readFileSync(process.env.AGENT_TEAM_MOCK_SCRIPT, 'utf8'));
    const entry = script.by_member?.[brief.member] ?? script;
    out({ type: 'session', harness_id: `mock-live-${brief.member}-${process.pid}`, resume: null });

    const vars = {};
    const subst = (v) => {
      if (typeof v === 'string') {
        const m = /^\$(\w+)\.(\w+)$/.exec(v);
        return m ? vars[m[1]]?.[m[2]] : v;
      }
      if (Array.isArray(v)) return v.map(subst);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)]));
      return v;
    };

    for (const step of entry.steps ?? []) {
      drainMessages();
      if (step.say) out({ type: 'event', kind: 'text', text: step.say });
      if (step.sleep_ms) await new Promise((r) => setTimeout(r, step.sleep_ms));
      if (step.tool) {
        const args = subst(step.args ?? {});
        out({ type: 'event', kind: 'tool_call', name: step.tool, args });
        let res;
        if (step.until_finished) {
          const ids = subst(step.until_finished);
          const done = new Set();
          const messages = [];
          while (!ids.every((id) => done.has(id))) {
            const r = await call('wait_for', args);
            for (const m of r.messages) {
              messages.push(m);
              if (m.text.startsWith('finished ')) done.add(m.report_id);
            }
            if (r.messages.length === 0 && !r.timed_out) break;   // nothing left to wait on
          }
          res = { messages };
        } else {
          res = await call(step.tool, args).catch((err) => ({ error: err.message }));
        }
        out({ type: 'event', kind: 'tool_result', name: step.tool, result: res });
        if (step.save) vars[step.save] = res;
        toolResults.push({ tool: step.tool, result: res });
      }
    }
    drainMessages();
    out({ type: 'idle' });
    for (;;) {
      const m = await next();
      if (m.type === 'message') { accept(m); out({ type: 'idle' }); continue; }
      if (m.type === 'stop' || m.type === 'interrupt') break;
    }
    out({
      type: 'result',
      status: entry.result?.status ?? 'ok',
      summary: entry.result?.summary ?? 'done',
      received, tool_results: toolResults
    });
    process.stdout.write('', () => process.exit(0));
  })();
}
```

- [ ] **Step 3: Write the crash fixture**

Create `test/fixtures/session-crash` and `chmod +x` it. It reports v2 capabilities, then dies mid-session:

```js
#!/usr/bin/env node
const sub = process.argv[2];
if (sub === 'probe') process.stdout.write('crash 0.1.0\n', () => process.exit(0));
else if (sub === 'capabilities') {
  process.stdout.write(JSON.stringify({ write: true, workspace: true, tool_dialect: 'claude', protocol: 2 }) + '\n',
    () => process.exit(0));
} else {
  process.stdout.write('{"type":"session","harness_id":"c"}\nthis is not json\n');
  process.stderr.write('boom: harness exploded\n', () => process.exit(3));
}
```

- [ ] **Step 4: Write the failing supervisor tests**

Create `test/supervisor.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';

process.env.AGENT_TEAM_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-sup-wsroot-'));

const repoAdapters = new URL('../adapters/', import.meta.url).pathname;
const fixtures = new URL('./fixtures/', import.meta.url).pathname;

// An adapter directory with the real adapters plus the crash fixture under the name "crash".
function adapterDir() {
  const dir = mkdtempSync(join(tmpdir(), 'at-sup-adapters-'));
  for (const name of readdirSync(repoAdapters)) {
    copyFileSync(join(repoAdapters, name), join(dir, name));
    chmodSync(join(dir, name), 0o755);
  }
  copyFileSync(join(fixtures, 'session-crash'), join(dir, 'crash'));
  chmodSync(join(dir, 'crash'), 0o755);
  return dir;
}

export function project(members, scripted, defaults = {}) {
  const root = mkdtempSync(join(tmpdir(), 'at-sup-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, 'app.js'), 'ok\n');
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members, deny_paths: ['**/.env*'], defaults: { on_unavailable: 'mock-live', ...defaults }
  }));
  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify(scripted));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, script };
}

export async function supervise(script, opts = {}) {
  // Short path: macOS caps Unix socket paths at 104 bytes.
  const socketPath = join(mkdtempSync(join(tmpdir(), 'at-s-')), 'sup.sock');
  const store = openStore(':memory:');
  const sup = new Supervisor({
    store, adapterDir: opts.adapterDir ?? adapterDir(), socketPath,
    env: { AGENT_TEAM_MOCK_SCRIPT: script }, maxRunning: opts.maxRunning ?? 6
  });
  await sup.start();
  return { sup, store };
}

const LIVE = (extra = {}) => ({ agent: 'mock-live', isolation: 'none', ...extra });

test('a v2 member with no reports runs to its result and the run finishes', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }], result: { status: 'ok', summary: 'all good' } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.equal(result.summary, 'all good');
    assert.equal(store.member(memberId).state, 'done');
    assert.equal(store.run(runId).status, 'done');
    assert.ok(store.member(memberId).harness_id.startsWith('mock-live-solo-'));
    assert.deepEqual(store.events(memberId).map((e) => e.kind), ['started', 'text', 'finished']);
  } finally { await sup.close(); }
});

test('a human message sent mid-turn is acked at the next step and delivered once', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 300 }, { say: 'after' }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await new Promise((r) => setTimeout(r, 100));
    const { message_id } = sup.send({ member_id: memberId, text: 'use tabs', from: 'brandon' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.received, ['[from: brandon (human)] use tabs']);
    assert.equal(store.message(message_id).state, 'delivered');
  } finally { await sup.close(); }
});

test('an adapter that dies without a result fails the member with its stderr', async () => {
  const { root, script } = project({ solo: { agent: 'crash', isolation: 'none' } }, {});
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /boom: harness exploded/);
    assert.equal(store.member(memberId).state, 'failed');
    assert.equal(store.run(runId).status, 'failed');
  } finally { await sup.close(); }
});

test('report_progress from a root member is recorded as an event', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'report_progress', args: { text: 'half way' } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(runId);
    assert.ok(store.events(memberId).some((e) => e.kind === 'progress' && e.body.text === 'half way'));
  } finally { await sup.close(); }
});
```

- [ ] **Step 5: Run the tests to see them fail**

Run: `node --test test/supervisor.test.js`
Expected: FAIL, `Cannot find module '…/src/supervisor.js'`.

- [ ] **Step 6: Implement the supervisor**

Create `src/supervisor.js`:

```js
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { buildBrief } from './brief.js';
import { resolveCaps, prepareMember, runMember } from './dispatch.js';
import { pruneWorkspace } from './workspace.js';
import { MemberSession } from './sessions.js';
import { serveRpc } from './rpc.js';
import { TEAM_NOTE } from './team-tools.js';
import { DEFAULT_TIMEOUT_MS } from './adapter.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;
const ASK_DEFAULT_S = 1800;
const ASK_MAX_S = 7200;

const cacheRoot = (env) => env.XDG_CACHE_HOME || join(homedir(), '.cache');
export const defaultSocketPath = (env = process.env) =>
  env.AGENT_TEAM_SUPERVISOR_SOCK || join(cacheRoot(env), 'agent-team', 'supervisor.sock');
export const defaultStorePath = (env = process.env) =>
  env.AGENT_TEAM_SUPERVISOR_DB || join(cacheRoot(env), 'agent-team', 'supervisor.db');

const label = (m) => `${m.from_name} (${m.from_kind})`;
const render = (m) => ({ id: m.id, from: label(m), text: m.text, report_id: m.report_id });
const clampSeconds = (v, dflt, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : dflt);

export class Supervisor {
  #live = new Map();          // memberId -> runtime state of a launched, unfinished member
  #pending = [];              // memberIds waiting for a slot
  #runs = new Map();          // runId -> { projectRoot, config, budget }
  #runWaiters = new Map();    // runId -> [resolve]

  constructor({ store, adapterDir, skillsDir = null, socketPath, env = {}, maxRunning = 6, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    Object.assign(this, { store, adapterDir, skillsDir, socketPath, env, maxRunning, timeoutMs });
  }

  async start() {
    this.server = await serveRpc(this.socketPath, (req) => this.#handle(req));
  }

  async close() {
    await this.server?.close();
  }

  submit({ projectRoot, member, task }) {
    const config = loadConfig(projectRoot);
    if (!Object.hasOwn(config.members, member)) throw new Error(`unknown member "${member}"`);
    const runId = this.store.createRun({ project: projectRoot, task });
    this.#runs.set(runId, { projectRoot, config, budget: { runs: config.defaults.max_delegations } });
    const { id } = this.store.addMember({ runId, parentId: null, name: member, task, depth: 0 });
    this.store.setRunRoot(runId, id);
    this.#schedule(id);
    return { runId, memberId: id };
  }

  waitRun(runId) {
    const run = this.store.run(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.status !== 'running') return Promise.resolve(this.store.member(run.root_member).result);
    return new Promise((resolve) => {
      this.#runWaiters.set(runId, [...(this.#runWaiters.get(runId) ?? []), resolve]);
    });
  }

  send({ member_id, text, from = 'local' }) {
    const m = this.store.member(member_id);
    if (!m) throw new Error(`unknown member ${member_id}`);
    if (TERMINAL.has(m.state)) throw new Error(`"${m.name}" has finished — delegate a new task`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('a message needs text');
    const id = this.store.enqueue({ to: member_id, fromKind: 'human', fromName: from, text });
    this.#pump(member_id);
    return { message_id: id };
  }

  answer({ question_id, answer, by = 'local' }) {
    const q = this.store.question(question_id);
    if (!q || q.answer != null) throw new Error(`question ${question_id} is not open`);
    this.store.answerQuestion(question_id, answer, by);
    const rt = this.#live.get(q.member_id);
    if (rt?.question?.id === question_id) {
      this.#resolveQuestion(q.member_id, { answer, answered_by: by, timed_out: false });
    }
    return { ok: true };
  }

  // ---- scheduling ----

  #schedule(id) {
    this.#pending.push(id);
    this.#drain();
  }

  #drain() {
    for (const id of [...this.#pending]) {
      if (this.#live.size >= this.maxRunning) return;
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

  async #launch(id) {
    const m = this.store.member(id);
    const run = this.#runs.get(m.run_id);
    // Registered before any await, so #drain counts this member against the caps at once.
    const rt = { member: m, session: null, resolved: null, workspace: null, result: null,
                 offered: new Set(), idle: false, stopping: false, waiter: null, question: null };
    this.#live.set(id, rt);
    this.store.setState(id, 'running');
    this.store.addEvent(id, 'started', {});

    const ctx = {
      config: run.config, projectRoot: run.projectRoot, member: m.name, task: m.task,
      adapterDir: this.adapterDir, assignments: {}, skillsDir: this.skillsDir, env: this.env,
      timeoutMs: this.timeoutMs, budget: run.budget, depth: m.depth
    };
    // Teams in other projects and v1 adapters keep today's one-shot loop.
    if (run.config.members[m.name].team) return this.#finish(id, await runMember(ctx));
    const { resolved, caps } = await resolveCaps(ctx);
    if (caps.protocol !== 2) return this.#finish(id, await runMember(ctx));

    rt.resolved = resolved;
    const prep = prepareMember(ctx, { resolved, caps });
    rt.workspace = prep.workspace;
    this.store.setWorkspace(id, prep.workspace.dir);
    const brief = buildBrief({
      resolved, task: m.task, cwd: prep.workspace.dir, denyPaths: run.config.deny_paths,
      skillText: prep.skillText, dialectText: prep.dialectText,
      timeoutSec: Math.floor(this.timeoutMs / 1000), depth: m.depth, maxDepth: run.config.defaults.max_depth
    });
    brief.task += TEAM_NOTE;
    rt.session = new MemberSession({
      execPath: join(this.adapterDir, resolved.agent), cwd: prep.workspace.dir,
      env: { ...this.env, AGENT_TEAM_TEAM_SOCKET: this.socketPath, AGENT_TEAM_TEAM_TOKEN: m.token },
      onLine: (msg) => this.#onLine(id, msg),
      onExit: (code, stderr) => this.#onExit(id, code, stderr)
    });
    rt.session.send({ type: 'start', brief });
    this.#pump(id);   // anything sent while the member was queued
  }

  // ---- adapter lines ----

  #onLine(id, msg) {
    const rt = this.#live.get(id);
    if (!rt) return;
    if (msg.type === 'session') this.store.setHarness(id, msg.harness_id);
    else if (msg.type === 'event') this.store.addEvent(id, msg.kind, msg);
    else if (msg.type === 'ack') {
      if (rt.offered.delete(msg.message_id)) this.store.ackMessage(msg.message_id);
    } else if (msg.type === 'idle') {
      // Written but not consumed before the turn ended: back to the queue, offered again below.
      for (const mid of rt.offered) this.store.requeue(mid);
      rt.offered.clear();
      rt.idle = true;
      this.#pump(id);
    } else if (msg.type === 'result') rt.result = msg;
  }

  #onExit(id, code, stderr) {
    const rt = this.#live.get(id);
    if (!rt) return;
    this.#finish(id, rt.result ?? {
      status: 'failed',
      summary: `adapter exited with code ${code} before a result: ${stderr.trim().slice(-1000)}`
    });
  }

  #finish(id, result) {
    const rt = this.#live.get(id);
    if (!rt) return;
    this.#live.delete(id);
    for (const mid of rt.offered) this.store.requeue(mid);
    if (rt.waiter) clearTimeout(rt.waiter.timer);
    if (rt.question) clearTimeout(rt.question.timer);
    const state = result.status === 'ok' ? 'done' : 'failed';
    this.store.setState(id, state);
    this.store.setResult(id, result);
    this.store.addEvent(id, 'finished', { status: result.status });
    if (state === 'done' && rt.workspace) pruneWorkspace(rt.workspace);

    const m = rt.member;
    if (m.parent_id != null) {
      const stat = result.artifacts?.diff_stat ? `\n${result.artifacts.diff_stat}` : '';
      this.store.enqueue({
        to: m.parent_id, fromKind: 'report', fromName: m.name, reportId: id,
        text: `finished ${result.status}: ${result.summary ?? ''}${stat}`
      });
      this.#pump(m.parent_id);
    } else {
      this.store.finishRun(m.run_id, state);
      for (const resolve of this.#runWaiters.get(m.run_id) ?? []) resolve(this.store.member(id).result);
      this.#runWaiters.delete(m.run_id);
    }
    this.#drain();
  }

  // ---- inbox delivery ----

  #openReports(id) {
    return this.store.children(id).filter((c) => !TERMINAL.has(c.state)).length;
  }

  // Exactly one path delivers each message: a blocked wait_for takes it as its tool result;
  // otherwise it is offered to the adapter and counts as delivered only when acked.
  #pump(id) {
    const rt = this.#live.get(id);
    if (!rt || !rt.session) return;    // queued, finished, or a v1 member: messages wait
    if (rt.waiter) {
      const msgs = this.store.takeQueued(id, rt.waiter.reportIds);
      if (msgs.length) this.#resolveWaiter(id, { messages: msgs.map(render), timed_out: false });
      return;
    }
    if (rt.stopping) return;
    const msgs = this.store.offerQueued(id);
    for (const m of msgs) {
      rt.offered.add(m.id);
      rt.session.send({ type: 'message', id: m.id, from: label(m), text: m.text });
    }
    if (msgs.length) { rt.idle = false; return; }
    if (rt.idle && this.#openReports(id) === 0) {
      rt.stopping = true;
      rt.session.send({ type: 'stop' });
    }
  }

  #resolveWaiter(id, value) {
    const rt = this.#live.get(id);
    if (!rt?.waiter) return;
    clearTimeout(rt.waiter.timer);
    const { resolve } = rt.waiter;
    rt.waiter = null;
    this.store.setState(id, 'running');
    resolve(value);
  }

  #resolveQuestion(id, value) {
    const rt = this.#live.get(id);
    if (!rt?.question) return;
    clearTimeout(rt.question.timer);
    const { resolve } = rt.question;
    rt.question = null;
    this.store.setState(id, 'running');
    resolve(value);
  }

  // ---- RPC ----

  async #handle({ token, method, params }) {
    const admin = {
      submit: (p) => this.submit(p),
      wait_run: (p) => this.waitRun(p.run_id),
      send: (p) => this.send(p),
      answer: (p) => this.answer(p)
    };
    if (Object.hasOwn(admin, method)) return admin[method](params);

    const tools = {
      delegate: (id, p) => this.#delegate(id, p),
      send_to: (id, p) => this.#sendTo(id, p),
      wait_for: (id, p) => this.#waitFor(id, p),
      report_progress: (id, p) => this.#reportProgress(id, p),
      ask_human: (id, p) => this.#askHuman(id, p)
    };
    if (!Object.hasOwn(tools, method)) throw new Error(`unknown tool "${method}"`);
    const m = typeof token === 'string' ? this.store.memberByToken(token) : null;
    if (!m || !this.#live.has(m.id)) throw new Error('this member is not running');
    return tools[method](m.id, params);
  }

  #reportProgress(id, { text }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('report_progress needs "text"');
    const m = this.#live.get(id).member;
    this.store.addEvent(id, 'progress', { text });
    if (m.parent_id != null) {
      this.store.enqueue({ to: m.parent_id, fromKind: 'report', fromName: m.name, reportId: id, text: `progress: ${text}` });
      this.#pump(m.parent_id);
    }
    return { ok: true };
  }

  // Filled in by Task 6.
  #delegate() { throw new Error('delegate is not implemented yet'); }
  #sendTo() { throw new Error('send_to is not implemented yet'); }
  #waitFor() { throw new Error('wait_for is not implemented yet'); }
  #askHuman() { throw new Error('ask_human is not implemented yet'); }
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `node --test test/supervisor.test.js`
Expected: PASS, 4 tests. If the event list in the first test has extra kinds, check that `mock-live` only emits `text` for a `say` step.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. `test/manifest.test.js` or `test/conformance.test.js` may enumerate `adapters/`; if one fails because `mock-live` has no `run` subcommand, read the failing assertion and, if it requires every adapter to support `run`, exclude adapters whose `capabilities` report `protocol: 2` there (they are checked by this suite instead).

- [ ] **Step 9: Commit**

```bash
git add src/team-tools.js src/supervisor.js adapters/mock-live test/fixtures/session-crash test/supervisor.test.js
git commit -m "feat(supervisor): run v2 members live with inbox delivery"
```

---

### Task 6: The team tools

**Files:**
- Modify: `src/supervisor.js` (replace the four placeholder tool methods)
- Test: `test/team-tools.test.js`

**Interfaces:**
- Consumes: Task 5 `Supervisor`, `project`/`supervise` helpers (re-declared in this test file; see Step 1).
- Produces tool results: `delegate → {report_id}`; `send_to → {message_id}`; `wait_for → {messages: [{id, from, text, report_id}], timed_out}`, plus `note: 'no open reports'` when there is nothing to wait for; `ask_human → {answer, answered_by, timed_out:false}` or `{answer:null, timed_out:true}`.

- [ ] **Step 1: Write the failing tests**

Create `test/team-tools.test.js`. It repeats the `project`, `supervise`, `adapterDir` and `LIVE` helpers from `test/supervisor.test.js` verbatim (copy the block from `process.env.AGENT_TEAM_WORKSPACE_ROOT = …` through `const LIVE = …`, keeping the imports it needs), then adds:

```js
const TEAM = {
  lead: LIVE(),
  a: LIVE({ reports_to: 'lead' }),
  b: LIVE({ reports_to: 'lead' })
};

test('a manager steers a report that is running in parallel', async () => {
  const { root, script } = project(TEAM, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'slow job' }, save: 'ra' },
        { tool: 'delegate', args: { to: 'b', task: 'left or right' }, save: 'rb' },
        { tool: 'wait_for', args: { report_ids: ['$rb.report_id'] }, save: 'w1' },
        { tool: 'send_to', args: { to: 'b', text: 'go right' } },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id', '$rb.report_id'] }
      ], result: { status: 'ok', summary: 'merged' } },
      a: { steps: [{ sleep_ms: 400 }], result: { status: 'ok', summary: 'a done' } },
      b: { steps: [
        { tool: 'report_progress', args: { text: 'going left' } },
        { tool: 'wait_for', args: {} }
      ], result: { status: 'ok', summary: 'b done' } }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'ship' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');

    const [w1] = result.tool_results.filter((t) => t.tool === 'wait_for');
    assert.deepEqual(w1.result.messages.map((m) => m.text), ['progress: going left']);
    assert.equal(w1.result.messages[0].from, 'b (report)');

    const members = store.members(runId);
    const b = members.find((m) => m.name === 'b');
    const bWait = b.result.tool_results.find((t) => t.tool === 'wait_for');
    assert.deepEqual(bWait.result.messages.map((m) => [m.from, m.text]), [['lead (manager)', 'go right']]);

    // a and b ran at the same time: b started before a finished.
    const a = members.find((m) => m.name === 'a');
    const at = (m, kind) => store.events(m.id).find((e) => e.kind === kind).at;
    assert.ok(at(b, 'started') <= at(a, 'finished'));
    assert.deepEqual(members.map((m) => m.state), ['done', 'done', 'done']);
  } finally { await sup.close(); }
});

test('delegation outside the rules is a tool error and the run carries on', async () => {
  const { root, script } = project({ ...TEAM, outsider: LIVE() }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'outsider', task: 'x' } },
        { tool: 'delegate', args: { to: 'a', task: 'one' } },
        { tool: 'delegate', args: { to: 'b', task: 'two' } }
      ] },
      a: { steps: [] }, b: { steps: [] }
    }
  }, { max_delegations: 1 });
  const { sup } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    const errors = result.tool_results.map((t) => t.result.error ?? null);
    assert.match(errors[0], /"outsider" is not a direct report of "lead"/);
    assert.equal(errors[1], null);
    assert.match(errors[2], /max_delegations/);
    assert.equal(result.status, 'ok');
  } finally { await sup.close(); }
});

test('max_depth 0 refuses any delegation', async () => {
  const { root, script } = project(TEAM, {
    by_member: { lead: { steps: [{ tool: 'delegate', args: { to: 'a', task: 'x' } }] } }
  }, { max_depth: 0 });
  const { sup } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    const result = await sup.waitRun(runId);
    assert.match(result.tool_results[0].result.error, /max_depth 0/);
  } finally { await sup.close(); }
});

test('max_parallel queues reports beyond the limit', async () => {
  const { root, script } = project(TEAM, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'a', task: 'one' }, save: 'ra' },
        { tool: 'delegate', args: { to: 'b', task: 'two' }, save: 'rb' },
        { tool: 'wait_for', args: {}, until_finished: ['$ra.report_id', '$rb.report_id'] }
      ] },
      a: { steps: [{ sleep_ms: 200 }] }, b: { steps: [] }
    }
  }, { max_parallel: 1 });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await sup.waitRun(runId);
    const [, a, b] = store.members(runId);
    const at = (m, kind) => store.events(m.id).find((e) => e.kind === kind).at;
    assert.ok(at(b, 'started') >= at(a, 'finished'), 'b waited for a');
  } finally { await sup.close(); }
});

test('ask_human blocks until answered, and times out to no answer', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [
      { tool: 'ask_human', args: { question: 'tabs or spaces?', options: ['tabs', 'spaces'] } },
      { tool: 'ask_human', args: { question: 'still there?', timeout_s: 1 } }
    ] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    let open;
    while (!(open = store.openQuestions()).length) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(open[0].options, ['tabs', 'spaces']);
    sup.answer({ question_id: open[0].id, answer: 'tabs', by: 'brandon' });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result, { answer: 'tabs', answered_by: 'brandon', timed_out: false });
    assert.deepEqual(result.tool_results[1].result, { answer: null, timed_out: true });
  } finally { await sup.close(); }
});

test('a message to a queued member is delivered once after it launches', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 50 }] } }
  });
  const { sup, store } = await supervise(script, { maxRunning: 0 });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    assert.equal(store.member(memberId).state, 'queued');
    sup.send({ member_id: memberId, text: 'early note', from: 'brandon' });
    sup.maxRunning = 1;
    sup.kick();
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.received, ['[from: brandon (human)] early note']);
  } finally { await sup.close(); }
});

test('a tool call from a finished or unknown member is an error, not a crash', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [] } } });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(runId);
    const { callRpc } = await import('../src/rpc.js');
    const token = store.member(memberId).token;
    await assert.rejects(callRpc(sup.socketPath, { token, method: 'report_progress', params: { text: 'x' } }), /not running/);
    await assert.rejects(callRpc(sup.socketPath, { token: 'forged', method: 'wait_for' }), /not running/);
    assert.throws(() => sup.send({ member_id: memberId, text: 'late' }), /has finished/);
  } finally { await sup.close(); }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/team-tools.test.js`
Expected: FAIL; the first test's `delegate` returns `{error: 'delegate is not implemented yet'}`, and `sup.kick` is not a function.

- [ ] **Step 3: Implement the tools**

In `src/supervisor.js`, add a public method after `answer`:

```js
  // Re-check the queue, e.g. after raising maxRunning.
  kick() {
    this.#drain();
  }
```

and replace the four placeholder methods at the end of the class with:

```js
  #delegate(id, { to, task } = {}) {
    const rt = this.#live.get(id);
    const m = rt.member;
    const { config, budget } = this.#runs.get(m.run_id);
    if (typeof to !== 'string' || typeof task !== 'string' || !task.trim()) {
      throw new Error('delegate needs "to" (a report\'s name) and "task"');
    }
    if (!rt.resolved.reports.includes(to)) throw new Error(`"${to}" is not a direct report of "${m.name}"`);
    if (m.depth >= config.defaults.max_depth) {
      throw new Error(`delegation refused: already at max_depth ${config.defaults.max_depth}`);
    }
    if (budget.runs <= 0) throw new Error('delegation budget exhausted (max_delegations)');
    budget.runs -= 1;
    const child = this.store.addMember({ runId: m.run_id, parentId: id, name: to, task, depth: m.depth + 1 });
    this.store.addEvent(id, 'delegated', { to, report_id: child.id });
    this.#schedule(child.id);
    return { report_id: child.id };
  }

  // Along the reporting line only: the caller's manager, or one of its own reports.
  #sendTo(id, { to, text } = {}) {
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
    if (TERMINAL.has(target.state)) throw new Error(`"${target.name}" has finished — delegate a new task`);
    const messageId = this.store.enqueue({
      to: target.id, fromKind, fromName: m.name, reportId: fromKind === 'report' ? id : null, text
    });
    this.#pump(target.id);
    return { message_id: messageId };
  }

  #waitFor(id, { report_ids = null, timeout_s } = {}) {
    const rt = this.#live.get(id);
    const reportIds = Array.isArray(report_ids) ? report_ids.filter(Number.isInteger) : null;
    const msgs = this.store.takeQueued(id, reportIds);
    if (msgs.length) return { messages: msgs.map(render), timed_out: false };
    if (reportIds == null && this.#openReports(id) === 0) {
      return { messages: [], timed_out: false, note: 'no open reports' };
    }
    const seconds = clampSeconds(timeout_s, WAIT_DEFAULT_S, WAIT_MAX_S);
    this.store.setState(id, 'waiting');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#resolveWaiter(id, { messages: [], timed_out: true }), seconds * 1000);
      rt.waiter = { resolve, timer, reportIds };
    });
  }

  #askHuman(id, { question, options = null, timeout_s } = {}) {
    if (typeof question !== 'string' || !question.trim()) throw new Error('ask_human needs "question"');
    const rt = this.#live.get(id);
    const opts = Array.isArray(options) ? options.filter((o) => typeof o === 'string') : null;
    const questionId = this.store.addQuestion({ memberId: id, question, options: opts });
    const seconds = clampSeconds(timeout_s, ASK_DEFAULT_S, ASK_MAX_S);
    this.store.setState(id, 'waiting');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#resolveQuestion(id, { answer: null, timed_out: true }), seconds * 1000);
      rt.question = { id: questionId, resolve, timer };
    });
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test test/team-tools.test.js test/supervisor.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor.js test/team-tools.test.js
git commit -m "feat(supervisor): add delegate, send_to, wait_for and ask_human"
```

---

### Task 7: `agent-team mcp`

**Files:**
- Create: `src/mcp.js`
- Modify: `bin/agent-team.js` (add the `mcp` subcommand and its usage line)
- Test: `test/mcp.test.js`

**Interfaces:**
- Consumes: Task 3 `callRpc`; Task 5 `TOOL_SCHEMAS`; `version` from `src/version.js`.
- Produces: `runMcpServer({input, output, env})`. Reads `AGENT_TEAM_TEAM_SOCKET` and `AGENT_TEAM_TEAM_TOKEN` from `env`. Plan 1b's `claude` adapter registers `agent-team mcp` through `--mcp-config` with those two variables.

- [ ] **Step 1: Write the failing tests**

Create `test/mcp.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRpc } from '../src/rpc.js';

const bin = new URL('../bin/agent-team.js', import.meta.url).pathname;

async function withMcp(handler, fn) {
  const socket = join(mkdtempSync(join(tmpdir(), 'at-mcp-')), 's.sock');
  const server = await serveRpc(socket, handler);
  const child = spawn(process.execPath, [bin, 'mcp'], {
    env: { ...process.env, AGENT_TEAM_TEAM_SOCKET: socket, AGENT_TEAM_TEAM_TOKEN: 'tok' }
  });
  const replies = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    replies.get(m.id)?.(m);
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try { await fn(rpc); } finally { child.kill(); await server.close(); }
}

test('lists the five team tools, each read-only', async () => {
  await withMcp(() => null, async (rpc) => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'agent-team');
    const { result } = await rpc('tools/list', {});
    assert.deepEqual(result.tools.map((t) => t.name), ['delegate', 'send_to', 'wait_for', 'report_progress', 'ask_human']);
    assert.ok(result.tools.every((t) => t.annotations.readOnlyHint === true));
  });
});

test('a tool call is forwarded with the member token; errors come back as isError', async () => {
  const seen = [];
  await withMcp(({ token, method, params }) => {
    seen.push({ token, method, params });
    if (method === 'delegate') throw new Error('"x" is not a direct report of "lead"');
    return { report_id: 4 };
  }, async (rpc) => {
    const ok = await rpc('tools/call', { name: 'send_to', arguments: { to: 'a', text: 'hi' } });
    assert.deepEqual(JSON.parse(ok.result.content[0].text), { report_id: 4 });
    const bad = await rpc('tools/call', { name: 'delegate', arguments: { to: 'x', task: 't' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /not a direct report/);
  });
  assert.deepEqual(seen[0], { token: 'tok', method: 'send_to', params: { to: 'a', text: 'hi' } });
});

test('unknown methods get -32601', async () => {
  await withMcp(() => null, async (rpc) => {
    const r = await rpc('resources/list', {});
    assert.equal(r.error.code, -32601);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/mcp.test.js`
Expected: FAIL; the CLI prints its usage for `mcp`, so the first request never gets a reply and the test times out. Stop it with Ctrl-C if it hangs.

- [ ] **Step 3: Implement the server**

Create `src/mcp.js`:

```js
import { createInterface } from 'node:readline';
import { callRpc } from './rpc.js';
import { TOOL_SCHEMAS } from './team-tools.js';
import { version } from './version.js';

// The team tools as a stdio MCP server, hand-rolled like channel/server.js because the plugin
// has no install step. The harness spawns one per member; it holds no state and forwards each
// call to the supervisor with the member's token, so the supervisor, not the member, decides
// who the caller is.
export function runMcpServer({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const socket = env.AGENT_TEAM_TEAM_SOCKET;
  const token = env.AGENT_TEAM_TEAM_TOKEN;
  const send = (m) => output.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

  createInterface({ input }).on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (id === undefined) return;     // notifications need no reply
    if (method === 'initialize') {
      return send({ id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-team', version }
      } });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOL_SCHEMAS } });
    if (method === 'tools/call') {
      try {
        const result = await callRpc(socket, { token, method: params?.name, params: params?.arguments ?? {} });
        return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } catch (err) {
        return send({ id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
      }
    }
    send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  });
}
```

- [ ] **Step 4: Wire the subcommand**

In `bin/agent-team.js`:

1. Add `import { runMcpServer } from '../src/mcp.js';` with the other imports.
2. Add `'       agent-team mcp\n' +` to `USAGE` after the `report` line.
3. Before the `org` block (`if (positionals[0] === 'org')`), add:

```js
// Spawned by a harness, one per live member; it never returns while stdin is open.
if (positionals[0] === 'mcp') {
  runMcpServer();
} else {
```

and close that `else` with `}` after the final default-path block at the end of the file, so the rest of the CLI only runs when the subcommand is not `mcp`. If the existing blocks end with `process.exit(...)` calls rather than relying on fall-through, an early `if (positionals[0] === 'mcp') { runMcpServer(); }` followed by wrapping the remaining top-level code in `else { … }` is equivalent; keep whichever reads cleaner, as long as nothing after the `mcp` branch runs for `mcp`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --test test/mcp.test.js test/cli.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp.js bin/agent-team.js test/mcp.test.js
git commit -m "feat(mcp): serve the team tools to a harness"
```

---

### Task 8: `agent-team serve` and v2 roots through the supervisor

**Files:**
- Modify: `bin/agent-team.js`
- Create: `src/client.js`
- Test: `test/client.test.js`

**Interfaces:**
- Consumes: Task 3 `isListening`, `callRpc`, `SupervisorRunning`; Task 1 `openStore`; Task 5 `Supervisor`, `defaultSocketPath`, `defaultStorePath`; Task 4 `resolveCaps`.
- Produces: `runThroughSupervisor({projectRoot, member, task, adapterDir, skillsDir, env, timeoutMs}) → Promise<result>`: submit to a listening supervisor, or start one in-process for this run when none is listening. `isLiveMember({projectRoot, member, adapterDir, env}) → Promise<boolean>`: true when the member's adapter reports `protocol: 2`. CLI: `agent-team serve` runs the supervisor in the foreground until SIGINT/SIGTERM.

- [ ] **Step 1: Write the failing tests**

Create `test/client.test.js`. Copy `project` from `test/supervisor.test.js` (the same helper; `isolation: 'none'` members), then:

```js
import { runThroughSupervisor, isLiveMember } from '../src/client.js';
import { openStore } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';

const adapterDir = new URL('../adapters/', import.meta.url).pathname;
const LIVE = (extra = {}) => ({ agent: 'mock-live', isolation: 'none', ...extra });

function env(script) {
  const dir = mkdtempSync(join(tmpdir(), 'at-cl-'));
  return { AGENT_TEAM_MOCK_SCRIPT: script, AGENT_TEAM_SUPERVISOR_SOCK: join(dir, 's.sock'),
           AGENT_TEAM_SUPERVISOR_DB: join(dir, 's.db') };
}

test('isLiveMember is true only for protocol 2 adapters', async () => {
  const { root, script } = project({ live: LIVE(), old: { agent: 'mock', isolation: 'none' } }, {});
  assert.equal(await isLiveMember({ projectRoot: root, member: 'live', adapterDir, env: env(script) }), true);
  assert.equal(await isLiveMember({ projectRoot: root, member: 'old', adapterDir, env: env(script) }), false);
});

test('with no supervisor running, a run starts one in-process and leaves no socket behind', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [], result: { status: 'ok', summary: 'hi' } } } });
  const e = env(script);
  const result = await runThroughSupervisor({ projectRoot: root, member: 'solo', task: 'go', adapterDir, env: e });
  assert.equal(result.summary, 'hi');
  const { isListening } = await import('../src/rpc.js');
  assert.equal(await isListening(e.AGENT_TEAM_SUPERVISOR_SOCK), false);
  const store = openStore(e.AGENT_TEAM_SUPERVISOR_DB);
  assert.equal(store.run(1).status, 'done');
  store.close();
});

test('with a supervisor running, a run is submitted to it', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [], result: { status: 'ok', summary: 'remote' } } } });
  const e = env(script);
  const store = openStore(':memory:');
  const sup = new Supervisor({ store, adapterDir, socketPath: e.AGENT_TEAM_SUPERVISOR_SOCK, env: { AGENT_TEAM_MOCK_SCRIPT: script } });
  await sup.start();
  try {
    const result = await runThroughSupervisor({ projectRoot: root, member: 'solo', task: 'go', adapterDir, env: e });
    assert.equal(result.summary, 'remote');
    assert.equal(store.run(1).status, 'done', 'the running supervisor recorded the run');
  } finally { await sup.close(); }
});
```

(Keep the imports the copied `project` helper needs: `test`, `assert`, `mkdtempSync`, `mkdirSync`, `writeFileSync`, `tmpdir`, `join`, `execFileSync`. Set `process.env.AGENT_TEAM_WORKSPACE_ROOT` to a temp directory at the top, as the other suites do.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/client.test.js`
Expected: FAIL, `Cannot find module '…/src/client.js'`.

- [ ] **Step 3: Implement the client**

Create `src/client.js`:

```js
import { loadConfig } from './config.js';
import { resolveCaps } from './dispatch.js';
import { openStore } from './store.js';
import { Supervisor, defaultSocketPath, defaultStorePath } from './supervisor.js';
import { isListening, callRpc, SupervisorRunning } from './rpc.js';

export async function isLiveMember({ projectRoot, member, adapterDir, env = {} }) {
  const config = loadConfig(projectRoot);
  if (config.members[member]?.team) return false;
  const { caps } = await resolveCaps({ config, member, adapterDir, assignments: {}, env });
  return caps.protocol === 2;
}

async function submitRemote(socketPath, { projectRoot, member, task }) {
  const { runId } = await callRpc(socketPath, { method: 'submit', params: { projectRoot, member, task } });
  return callRpc(socketPath, { method: 'wait_run', params: { run_id: runId } });
}

// Submit to the machine's supervisor if one is listening; otherwise run one in-process for
// the length of this run, so one-shot use and the /delegate skill need no `serve` running.
export async function runThroughSupervisor({ projectRoot, member, task, adapterDir, skillsDir = null, env = {}, timeoutMs }) {
  const merged = { ...process.env, ...env };
  const socketPath = defaultSocketPath(merged);
  if (await isListening(socketPath)) return submitRemote(socketPath, { projectRoot, member, task });

  const store = openStore(defaultStorePath(merged));
  const sup = new Supervisor({ store, adapterDir, skillsDir, socketPath, env, ...(timeoutMs ? { timeoutMs } : {}) });
  try {
    await sup.start();
  } catch (err) {
    store.close();
    if (err instanceof SupervisorRunning) return submitRemote(socketPath, { projectRoot, member, task });
    throw err;
  }
  try {
    const { runId } = sup.submit({ projectRoot, member, task });
    return await sup.waitRun(runId);
  } finally {
    await sup.close();
    store.close();
  }
}
```

- [ ] **Step 4: Wire the CLI**

In `bin/agent-team.js`:

1. Add imports:

```js
import { runThroughSupervisor, isLiveMember } from '../src/client.js';
import { openStore } from '../src/store.js';
import { Supervisor, defaultSocketPath, defaultStorePath } from '../src/supervisor.js';
```

2. Add `'       agent-team serve\n' +` to `USAGE` after the `mcp` line.
3. Next to the `mcp` branch, add a `serve` branch:

```js
if (positionals[0] === 'serve') {
  const store = openStore(defaultStorePath());
  const sup = new Supervisor({
    store, adapterDir: join(ROOT, 'adapters'), skillsDir: join(ROOT, 'skills'),
    socketPath: defaultSocketPath()
  });
  try {
    await sup.start();
  } catch (err) {
    fail(err);
  }
  process.stderr.write(`agent-team: supervisor listening on ${defaultSocketPath()}\n`);
  const shutdown = async () => { await sup.close(); store.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
```

with the same `else` structure as the `mcp` branch so nothing after it runs for `serve`.

4. In the default path (currently around lines 114-133), where it calls `dispatch({...})`, choose by the root member:

```js
const opts = { projectRoot: values.project, member: values.member, task: values.task,
               adapterDir: join(ROOT, 'adapters'), skillsDir: join(ROOT, 'skills'), timeoutMs };
const result = await isLiveMember(opts)
  ? await runThroughSupervisor(opts)
  : await dispatch(opts);
```

keeping the existing output and exit-code handling after it unchanged. Use the variable names the existing block already uses for the timeout; do not change how `timeoutMs` is computed.

- [ ] **Step 5: Run the tests**

Run: `node --test test/client.test.js test/cli.test.js`
Expected: PASS. `test/cli.test.js` uses v1 members, so it still goes through `dispatch`.

- [ ] **Step 6: Check `serve` by hand**

Run:

```bash
AGENT_TEAM_SUPERVISOR_SOCK=$(mktemp -d)/s.sock node bin/agent-team.js serve & sleep 1; kill -INT $!
```

Expected: `agent-team: supervisor listening on …/s.sock`, then a clean exit.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/client.js bin/agent-team.js test/client.test.js
git commit -m "feat(cli): add serve and run live members through the supervisor"
```

---

### Task 9: Document the v2 contract

**Files:**
- Modify: `docs/adapters.md`, `docs/how-it-works.md`

**Interfaces:** none.

- [ ] **Step 1: Document the session contract in `docs/adapters.md`**

Add a section `## Session adapters (protocol 2)` after the existing contract description, covering, in this order:
- An adapter opts in by reporting `"protocol": 2` from `capabilities`, and implements `<adapter> session`.
- The table of messages in each direction, copied from the spec's "Adapter contract v2" table, including the `ack` row's rule that ack means consumed, not written.
- The environment the supervisor sets: `AGENT_TEAM_TEAM_SOCKET`, `AGENT_TEAM_TEAM_TOKEN`; a real harness passes them to `agent-team mcp`.
- That every team tool declares `readOnlyHint: true` and why (plan-mode members).
- `adapters/mock-live` as the reference implementation and its script format (from Task 5's Interfaces block).

- [ ] **Step 2: Add the supervisor to `docs/how-it-works.md`**

Add a short section `## Live runs` describing: `agent-team serve`; that a v2 root member runs through the supervisor (submitted to a running one, or an in-process one otherwise); the store's location (`~/.cache/agent-team/supervisor.db`, `AGENT_TEAM_SUPERVISOR_DB`); the socket (`supervisor.sock`, `AGENT_TEAM_SUPERVISOR_SOCK`); `max_parallel` and `serve`'s global cap of 6; and that v1 members keep the `{"status":"delegating"}` loop.

- [ ] **Step 3: Commit**

```bash
git add docs/adapters.md docs/how-it-works.md
git commit -m "docs: describe live runs and session adapters"
```

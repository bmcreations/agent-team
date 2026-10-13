import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
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
  question TEXT NOT NULL, options TEXT, answer TEXT, answered_by TEXT, closed INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
`;

// Each entry upgrades the schema by one version. SCHEMA stays the 1a shape, so a fresh
// database and a 1a one take the same path. BEGIN IMMEDIATE serializes two CLIs opening the
// same file; the version is re-read inside the lock so the loser applies nothing twice.
const MIGRATIONS = [
  `ALTER TABLE members ADD COLUMN resume TEXT;
   ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN timeout_ms INTEGER;
   ALTER TABLE runs ADD COLUMN budget INTEGER;
   ALTER TABLE runs ADD COLUMN max_cost_usd REAL;`,
  // The socket of the supervisor running the run; recovery adopts a run only when nothing
  // listens there any more.
  `ALTER TABLE runs ADD COLUMN owner TEXT;`
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

const now = () => Date.now();
const parse = (s) => (s == null ? null : JSON.parse(s));

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);   // it holds member tokens in plaintext
  // Several in-process supervisors (one per CLI run) can share this file; wait for a write lock
  // instead of failing with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  const q = (sql) => db.prepare(sql);
  const memberRow = (row) => row && { ...row, result: parse(row.result) };
  const questionRow = (row) => row && { ...row, options: parse(row.options) };
  const setMessageState = (id, from, to) =>
    q('UPDATE messages SET state = ? WHERE id = ? AND state = ?').run(to, id, from);
  const queued = (memberId) =>
    q("SELECT * FROM messages WHERE to_member = ? AND state = 'queued' ORDER BY id").all(memberId);

  return {
    close: () => db.close(),

    createRun: ({ project, task, timeoutMs = null, budget = null, maxCostUsd = null, owner = null }) => Number(
      q("INSERT INTO runs (project, task, status, created_at, timeout_ms, budget, max_cost_usd, owner) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)")
        .run(project, task, now(), timeoutMs, budget, maxCostUsd, owner).lastInsertRowid),
    setRunOwner: (id, owner) => q('UPDATE runs SET owner = ? WHERE id = ?').run(owner, id),
    // Atomic adoption: true only for the caller whose update changed the owner.
    claimRun: (id, from, to) => q('UPDATE runs SET owner = ? WHERE id = ? AND owner IS ?').run(to, id, from).changes > 0,
    runsWithStatus: (status) => q('SELECT * FROM runs WHERE status = ? ORDER BY id').all(status),
    setBudget: (id, left) => q('UPDATE runs SET budget = ? WHERE id = ?').run(left, id),
    setRunCap: (id, usd) => q('UPDATE runs SET max_cost_usd = ? WHERE id = ?').run(usd, id),
    addRunCost(id, usd) {
      q('UPDATE runs SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, id);
      return q('SELECT cost_usd FROM runs WHERE id = ?').get(id).cost_usd;
    },
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
    setResume: (id, resume) => q('UPDATE members SET resume = ? WHERE id = ?').run(resume, id),
    membersInStates: (states) => q(
      `SELECT * FROM members WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY id`
    ).all(...states).map(memberRow),
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
    // A member blocked in wait_for cannot be consuming its stdin, so messages already offered
    // to it are as undelivered as queued ones; the tool result delivers both.
    claimForWait(memberId, reportIds = null) {
      const rows = q("SELECT * FROM messages WHERE to_member = ? AND state IN ('queued', 'offered') ORDER BY id")
        .all(memberId).filter((m) => reportIds == null || m.report_id == null || reportIds.includes(m.report_id));
      for (const m of rows) q("UPDATE messages SET state = 'delivered' WHERE id = ?").run(m.id);
      return rows.map((m) => ({ ...m, state: 'delivered' }));
    },
    // The ask_human path: only a human or the member's manager can cut a question short; a
    // report's progress waits for the member's next wait_for.
    claimForQuestion(memberId) {
      const rows = q("SELECT * FROM messages WHERE to_member = ? AND state IN ('queued', 'offered') " +
                     "AND from_kind IN ('human', 'manager') ORDER BY id").all(memberId);
      for (const m of rows) q("UPDATE messages SET state = 'delivered' WHERE id = ?").run(m.id);
      return rows.map((m) => ({ ...m, state: 'delivered' }));
    },
    ackMessage: (id) => setMessageState(id, 'offered', 'delivered'),
    requeue: (id) => setMessageState(id, 'offered', 'queued'),
    // After a restart nothing holds an offer: every unacked one goes back to the queue.
    requeueOffered: (memberId) =>
      q("UPDATE messages SET state = 'queued' WHERE to_member = ? AND state = 'offered'").run(memberId),
    message: (id) => q('SELECT * FROM messages WHERE id = ?').get(id),

    addQuestion: ({ memberId, question, options = null }) => Number(
      q('INSERT INTO questions (member_id, question, options, at) VALUES (?, ?, ?, ?)')
        .run(memberId, question, options == null ? null : JSON.stringify(options), now()).lastInsertRowid),
    question: (id) => questionRow(q('SELECT * FROM questions WHERE id = ?').get(id)),
    // False when the question was already answered or closed.
    answerQuestion: (id, answer, by) => q(
      'UPDATE questions SET answer = ?, answered_by = ? WHERE id = ? AND answer IS NULL AND closed = 0'
    ).run(answer, by, id).changes > 0,
    // Timed out, or its asker finished: no longer answerable.
    closeQuestion: (id) => q('UPDATE questions SET closed = 1 WHERE id = ? AND answer IS NULL').run(id),
    openQuestions: () => q('SELECT * FROM questions WHERE answer IS NULL AND closed = 0 ORDER BY id').all().map(questionRow)
  };
}

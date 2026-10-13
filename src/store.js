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
// Legal thread moves; the supervisor narrows them further by kind. declined and done are final.
const THREAD_MOVES = { open: ['accepted', 'declined', 'done'], accepted: ['done'] };
const POST_SIDES = ['requester', 'receiver', 'human'];

const MIGRATIONS = [
  `ALTER TABLE members ADD COLUMN resume TEXT;
   ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN timeout_ms INTEGER;
   ALTER TABLE runs ADD COLUMN budget INTEGER;
   ALTER TABLE runs ADD COLUMN max_cost_usd REAL;`,
  // The socket of the supervisor running the run; recovery adopts a run only when nothing
  // listens there any more.
  `ALTER TABLE runs ADD COLUMN owner TEXT;`,
  // What each member has spent, handed to its adapter as the cost baseline on resume.
  `ALTER TABLE members ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;`,
  // Token usage, for harnesses that report tokens and no dollar cost (codex).
  `ALTER TABLE members ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;`,
  // What the web view shows per member: the harness, the configured model, and whether the
  // member could write. Indexes for the view's timeline reads.
  `ALTER TABLE members ADD COLUMN agent TEXT;
   ALTER TABLE members ADD COLUMN model TEXT;
   ALTER TABLE members ADD COLUMN read_only INTEGER;
   CREATE INDEX IF NOT EXISTS events_member ON events(member_id, id);
   CREATE INDEX IF NOT EXISTS messages_to ON messages(to_member, id);
   CREATE INDEX IF NOT EXISTS members_run ON members(run_id);`,
  // Live cross-team delegation: the project a member was entered into (null: its run's),
  // the name its manager delegated to, and the entered team's own delegation counter.
  `ALTER TABLE members ADD COLUMN project TEXT;
   ALTER TABLE members ADD COLUMN alias TEXT;
   ALTER TABLE members ADD COLUMN scope_budget INTEGER;`,
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
   CREATE INDEX threads_parent ON threads(parent_thread);
   CREATE TABLE thread_posts (
     id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id),
     side TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, state TEXT, at INTEGER NOT NULL);
   CREATE INDEX thread_posts_thread ON thread_posts(thread_id, id);
   ALTER TABLE runs ADD COLUMN thread_id INTEGER;
   ALTER TABLE messages ADD COLUMN thread_id INTEGER;`,
  // threadsInState runs on every pump; this keeps it from reading the whole thread history.
  `CREATE INDEX IF NOT EXISTS threads_state ON threads(state, id);`
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
  const eventRow = (row) => row && { ...row, body: parse(row.body) };
  const threadRow = (row) => row && { ...row, chain: parse(row.chain), result: parse(row.result) };
  const questionRow = (row) => row && { ...row, options: parse(row.options) };
  const setMessageState = (id, from, to) =>
    q('UPDATE messages SET state = ? WHERE id = ? AND state = ?').run(to, id, from);
  const queued = (memberId) =>
    q("SELECT * FROM messages WHERE to_member = ? AND state = 'queued' ORDER BY id").all(memberId);

  return {
    close: () => db.close(),

    createRun: ({ project, task, timeoutMs = null, budget = null, maxCostUsd = null, owner = null, threadId = null }) => Number(
      q("INSERT INTO runs (project, task, status, created_at, timeout_ms, budget, max_cost_usd, owner, thread_id) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)")
        .run(project, task, now(), timeoutMs, budget, maxCostUsd, owner, threadId).lastInsertRowid),
    setRunOwner: (id, owner) => q('UPDATE runs SET owner = ? WHERE id = ?').run(owner, id),
    // Atomic adoption: true only for the caller whose update changed the owner.
    claimRun: (id, from, to) => q('UPDATE runs SET owner = ? WHERE id = ? AND owner IS ?').run(to, id, from).changes > 0,
    runsWithStatus: (status) => q('SELECT * FROM runs WHERE status = ? ORDER BY id').all(status),
    setBudget: (id, left) => q('UPDATE runs SET budget = ? WHERE id = ?').run(left, id),
    setRunCap: (id, usd) => q('UPDATE runs SET max_cost_usd = ? WHERE id = ?').run(usd, id),
    addTokens(id, memberId, n) {
      q('UPDATE runs SET tokens = tokens + ? WHERE id = ?').run(n, id);
      q('UPDATE members SET tokens = tokens + ? WHERE id = ?').run(n, memberId);
    },
    // Adds to the run's spend and, given a member, to that member's. Returns the run's total.
    addRunCost(id, usd, memberId = null) {
      q('UPDATE runs SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, id);
      if (memberId != null) q('UPDATE members SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, memberId);
      return q('SELECT cost_usd FROM runs WHERE id = ?').get(id).cost_usd;
    },
    run: (id) => q('SELECT * FROM runs WHERE id = ?').get(id),
    setRunRoot: (id, memberId) => q('UPDATE runs SET root_member = ? WHERE id = ?').run(memberId, id),
    finishRun: (id, status) => q('UPDATE runs SET status = ? WHERE id = ?').run(status, id),

    addMember({ runId, parentId, name, task, depth, project = null, alias = null, scopeBudget = null }) {
      const token = randomBytes(24).toString('hex');
      const t = now();
      const id = Number(q(
        "INSERT INTO members (run_id, parent_id, name, task, depth, state, token, created_at, updated_at, " +
        "project, alias, scope_budget) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)"
      ).run(runId, parentId, name, task, depth, token, t, t, project, alias, scopeBudget).lastInsertRowid);
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
    setScopeBudget: (id, n) => q('UPDATE members SET scope_budget = ? WHERE id = ?').run(n, id),
    projects: () => q('SELECT project FROM runs UNION SELECT project FROM members WHERE project IS NOT NULL ORDER BY 1')
      .all().map((r) => r.project),

    addEvent: (memberId, kind, body) =>
      q('INSERT INTO events (member_id, kind, body, at) VALUES (?, ?, ?, ?)')
        .run(memberId, kind, JSON.stringify(body ?? {}), now()),
    events: (memberId) => q('SELECT * FROM events WHERE member_id = ? ORDER BY id').all(memberId)
      .map((e) => ({ ...e, body: parse(e.body) })),

    enqueue: ({ to, fromKind, fromName, reportId = null, text, threadId = null }) => Number(q(
      "INSERT INTO messages (to_member, from_kind, from_name, report_id, text, state, at, thread_id) " +
      "VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)"
    ).run(to, fromKind, fromName, reportId, text, now(), threadId).lastInsertRowid),
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

    addThread({ kind, fromProject, fromRun, fromMember, toProject, toMember, parentThread = null, chain, text, task = null }) {
      const author = q('SELECT name FROM members WHERE id = ?').get(fromMember)?.name ?? String(fromMember);
      const t = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const id = Number(q(
          "INSERT INTO threads (kind, state, from_project, from_run, from_member, to_project, to_member, " +
          "parent_thread, chain, task, created_at, updated_at) VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(kind, fromProject, fromRun, fromMember, toProject, toMember, parentThread,
              JSON.stringify(chain), task, t, t).lastInsertRowid);
        q("INSERT INTO thread_posts (thread_id, side, author, text, at) VALUES (?, 'requester', ?, ?, ?)")
          .run(id, author, text, t);
        db.exec('COMMIT');
        return id;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    thread: (id) => threadRow(q('SELECT * FROM threads WHERE id = ?').get(id)),
    threads({ project = null, state = null, limit = 200 } = {}) {
      const where = [], args = [];
      if (project != null) { where.push('(from_project = ? OR to_project = ?)'); args.push(project, project); }
      if (state != null) { where.push('state = ?'); args.push(state); }
      return q(`SELECT * FROM threads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
        .all(...args, Math.min(Math.max(1, Math.trunc(limit) || 200), 1000)).map(threadRow);
    },
    // Conditional on the current state, so two racing moves cannot both win.
    moveThread: (id, from, to, { result = null } = {}) => !THREAD_MOVES[from]?.includes(to) ? false :
      q('UPDATE threads SET state = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ? AND state = ?')
        .run(to, result == null ? null : JSON.stringify(result), now(), id, from).changes > 0,
    setThreadOwner: (id, memberId) =>
      q('UPDATE threads SET owner_member = ?, updated_at = ? WHERE id = ?').run(memberId, now(), id),
    setThreadRun: (id, runId) =>
      q('UPDATE threads SET run_id = ?, updated_at = ? WHERE id = ?').run(runId, now(), id),
    addThreadPost({ threadId, side, author, text, state = null }) {
      if (!POST_SIDES.includes(side)) throw new Error(`thread post side "${side}" is not one of ${POST_SIDES.join(', ')}`);
      if (side === 'human' && state != null) throw new Error('a human post cannot carry a thread state');
      return Number(q('INSERT INTO thread_posts (thread_id, side, author, text, state, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(threadId, side, author, text, state, now()).lastInsertRowid);
    },
    threadPosts: (threadId) => q('SELECT * FROM thread_posts WHERE thread_id = ? ORDER BY id').all(threadId),
    threadsFrom: (memberId) => q('SELECT * FROM threads WHERE from_member = ? ORDER BY id').all(memberId).map(threadRow),
    unownedThreadsTo: (project, member) =>
      q("SELECT * FROM threads WHERE state = 'open' AND owner_member IS NULL AND to_project = ? AND to_member = ? ORDER BY id")
        .all(project, member).map(threadRow),
    threadsInState: (states) => !states.length ? [] : q(
      `SELECT * FROM threads WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id`)
      .all(...states).map(threadRow),

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
    openQuestions: () => q('SELECT * FROM questions WHERE answer IS NULL AND closed = 0 ORDER BY id').all().map(questionRow),

    // ---- reads for the web view, `watch`, and `report` ----

    setHarnessInfo: (id, { agent = null, model = null, readOnly = null }) =>
      q('UPDATE members SET agent = ?, model = ?, read_only = ? WHERE id = ?')
        .run(agent, model, readOnly == null ? null : (readOnly ? 1 : 0), id),
    // Differs after any committed write: data_version moves for other connections' commits
    // (an in-process supervisor in another CLI), total_changes() for this connection's own.
    version: () => `${q('PRAGMA data_version').get().data_version}.${q('SELECT total_changes() AS n').get().n}`,
    // node:sqlite rows have a null prototype; spread so callers can deepEqual plain objects.
    maxIds: () => ({ ...q('SELECT (SELECT ifnull(max(id), 0) FROM events) AS event, ' +
                    '(SELECT ifnull(max(id), 0) FROM messages) AS message').get() }),
    listRuns: ({ project = null, limit = 50 } = {}) =>
      q('SELECT * FROM runs WHERE ?1 IS NULL OR project = ?1 ORDER BY id DESC LIMIT ?2').all(project, limit),
    // Events and messages of one run, one member, or every run, after a cursor (oldest first)
    // or before one (the newest `limit`, still returned oldest first).
    timeline({ runId = null, memberId = null, afterEvent = 0, afterMessage = 0,
               beforeEvent = null, beforeMessage = null, limit = 200 } = {}) {
      const back = beforeEvent != null || beforeMessage != null;
      const order = back ? 'DESC' : 'ASC';
      const top = Number.MAX_SAFE_INTEGER;
      const events = q(
        'SELECT e.*, m.run_id, m.name AS member FROM events e JOIN members m ON m.id = e.member_id ' +
        'WHERE (?1 IS NULL OR m.run_id = ?1) AND (?2 IS NULL OR e.member_id = ?2) AND e.id > ?3 AND e.id < ?4 ' +
        `ORDER BY e.id ${order} LIMIT ?5`
      ).all(runId, memberId, afterEvent, beforeEvent ?? top, limit).map(eventRow);
      const messages = q(
        'SELECT g.*, m.run_id, m.name AS to_name FROM messages g JOIN members m ON m.id = g.to_member ' +
        'WHERE (?1 IS NULL OR m.run_id = ?1) AND (?2 IS NULL OR g.to_member = ?2) AND g.id > ?3 AND g.id < ?4 ' +
        `ORDER BY g.id ${order} LIMIT ?5`
      ).all(runId, memberId, afterMessage, beforeMessage ?? top, limit);
      if (back) { events.reverse(); messages.reverse(); }
      return { events, messages };
    },
    event: (id) => eventRow(q('SELECT * FROM events WHERE id = ?').get(id)),
    lastEventOfKind: (memberId, kind) => eventRow(
      q('SELECT * FROM events WHERE member_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(memberId, kind)),
    lastEvent: (memberId) => eventRow(q('SELECT * FROM events WHERE member_id = ? ORDER BY id DESC LIMIT 1').get(memberId)),
    memberSpan: (memberId) => ({ ...q(
      "SELECT (SELECT min(at) FROM events WHERE member_id = ?1) AS started, " +
      "(SELECT max(at) FROM events WHERE member_id = ?1 AND kind = 'finished') AS finished"
    ).get(memberId) })
  };
}

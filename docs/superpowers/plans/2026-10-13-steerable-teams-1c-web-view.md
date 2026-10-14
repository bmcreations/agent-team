# Steerable teams 1c: the web view, CLI verbs, and the report from the store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent-team serve` serves a page on `http://127.0.0.1:4747/` that shows every run in the store live and steers the runs `serve` owns; the CLI gains `send` and `watch`; `agent-team report` reads live runs from the store as well as the v1 run log.

**Architecture:** A new `src/http.js` runs a `node:http` server beside the supervisor in the `serve` process. It reads only from the store (through a small read model in `src/view.js`), so a run that finished, or one a CLI's in-process supervisor is running, shows the same way as a live one. Live updates are Server-Sent Events from one hub that polls `store.version()` (`PRAGMA data_version` plus `total_changes()`) every 250 ms and pushes only what changed. One poll covers writes by `serve` itself and by in-process supervisors in other processes, which no in-process listener could see. Steering calls the same `Supervisor` methods the admin RPCs call. The page is static HTML, CSS, and ES-module JavaScript in `src/web/`, built with `textContent` only. Loupe screenshots and Figma previews are proxied by the server, so their tokens never reach the page, the store, or a log.

**Tech Stack:** Node >= 22.13, ES modules, `node:http`, `node:https`, `node:sqlite`, global `fetch`, `node --test`. No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-10-12-steerable-teams-design.md`: sections "A supervisor that outlives the dispatch" (the `src/http.js` row, `--port` 4747), "Humans can always intervene" (the verb list, the "Take over" button), "One supervisor across projects" (`serve --max-running`), "Web view", "Testing" (HTTP and SSE tests under `node --test`). Earlier plans: `docs/superpowers/plans/2026-10-13-steerable-teams-1a-core-runtime.md` (line 11 assigns "the web view, the remaining CLI verbs, and `report` from the store" to 1c) and `docs/superpowers/plans/2026-10-13-steerable-teams-1b-2-codex.md` (`members.tokens` and `runs.tokens` exist "so plan 1c's view can show codex usage").

**Size:** 8 tasks. Tasks 1–6 are the spec's 1c scope. Task 7 (loupe) and Task 8 (Figma) are the user's 2026-10-12 request, opt-in, and come last so either can be dropped without touching the rest.

## Global Constraints

- Stdlib only: the plugin has no install step. `package.json` `engines.node` stays `>=22.13`. No framework, bundler, or CDN on the page.
- Tests run under `node --test` (`npm test`). `test/helpers/guard.js` is loaded first and keeps real `claude` and `codex` unreachable; every new test that runs members uses `test/helpers/live.js` (`project`, `supervise`, `LIVE`) and the `mock-live` adapter.
- HTTP tests use `node:http` against port `0` on `127.0.0.1`. No browser automation in the unit suite.
- The server binds to `127.0.0.1` only. There is no `--host` flag and no sign-in in 1c; the auth plan adds both. Every place that says where the page is reachable says this plainly.
- The JSON API never returns a member's `token` (its MCP credential, the reason the store file is mode `0600`) or `resume`. Member rows leave the server only through `publicMember` in `src/view.js`, an allowlist.
- Member output is untrusted. The page builds every node with `document.createElement` and `textContent`; `innerHTML`, `outerHTML`, `insertAdjacentHTML`, and `document.write` do not appear in `src/web/`. Every response carries a `Content-Security-Policy` with no `'unsafe-inline'`.
- Steering from the page calls the `Supervisor` methods the admin RPCs call (`send`, `pause`, `resume`, `cancel`, `answer`), signed with `whoAmI()` (the OS user running `serve`). The page never calls `takeover`; "Take over" shows `agent-team attach <run> <member>` to copy.
- Loupe's and Figma's tokens are read from the environment or loupe's token file when a request needs them. They never go into the store, a response body, an error message, or stderr.
- Admin RPCs stay tokenless (the deferred gap from 1a). Do not add an auth scheme.
- Commit messages are conventional commits with no attribution trailers.

## Rulings this plan makes

- **In-process runs are read-only in the view.** A run whose `owner` is not `serve`'s socket and whose status is `running` belongs to a CLI's in-process supervisor. The page shows it, live, with a "read-only: started without `agent-team serve`" note, and every steering endpoint answers `409` for it. Registering in-process sockets with `serve` was rejected: `serve` would then relay steering into a process that may exit mid-call, and the CLI already says to start `serve` to steer.
- **The same ruling fixes `answer` and `send`.** Today `Supervisor.answer` writes the answer for a question asked in another supervisor's run, where nothing wakes the asker, and `send` takes a bare `member_id` with no ownership check. Both now go through `#owned` (Task 3).
- **Live cross-team delegation is not in 1c.** The spec section "One supervisor across projects, and live cross-team delegation" changes the supervisor's run model: members of one run would load different projects' configs, `deny_paths`, and budgets. 1c builds read and steer surfaces over the run model as it is. The ruling moves it to the plan after 1c, with peer threads, because both make one supervisor hold work from several projects. 1c renders a `team:` member as one node tagged `team`, as `report` does today.
- **Live updates poll the store, server-side.** The page gets pushes over SSE. The server finds changes by polling `store.version()`, because writes from another process's in-process supervisor reach the shared file without passing through any code in `serve`.
- **`watch` reads the store directly.** It needs no `serve`, so it follows in-process runs too, and it exits when the run ends.
- **`report` merges the store and the v1 run log.** Live runs never called `recordRun`, so today's report misses every v2 run. A store run becomes the same tree shape the log uses, so `renderRun` and `renderTotals` do not fork.
- **Loupe is opt-in through `AGENT_TEAM_LOUPE_URL` and must be loopback.** The server proxies `GET /api/targets` and `GET /api/screenshot` with `Authorization: Bearer <token>`. For a loopback `https:` URL it accepts loupe's self-signed certificate. The live view is a link to `GET /loupe/open?target=…`, which redirects to loupe with `?token=` so loupe can set its session. The token is in that one `Location` header and nowhere else. The page cannot frame or fetch loupe directly: loupe is `https://localhost:18456` and the page is `http://127.0.0.1:4747`.
- **Figma is opt-in through `FIGMA_TOKEN` and is the last task.** Previews are rendered for node ids a member mentions: Figma URLs carry their own file key, and bare `node 1234:5678` mentions use the project's `defaults.figma_file_key`.
- **Web actions are signed `whoAmI()`.** It is the same name the CLI verbs use, until the auth plan supplies people.

## Review Focus

1. **Another site in the same browser steers a member.** A page on any origin can `POST` to `http://127.0.0.1:4747/api/members/3/pause`, or rebind its own DNS name to `127.0.0.1` and read the API. A reasonable person expects neither to work: requests with a foreign `Host` are refused, and `POST`s need `Content-Type: application/json` and no foreign `Origin` or cross-site `Sec-Fetch-Site`. Pinned in Task 1 (Host) and Task 3 (POST).
2. **Member output containing markup.** A tool result holding `<img src=x onerror=…>` or `</script>` must show as text, never run. Pinned in Task 4 (a source scan for HTML sinks, the CSP header, and the API returning JSON with `nosniff`).
3. **SSE clients that go away.** A closed tab, a sleeping laptop, or a stalled reader must not leave a client, a timer, or an unbounded buffer behind, and `serve` must still shut down at once. Pinned in Task 2 (disconnect drops the client and stops the timer; a blocked client is cut after 60 s; `close()` ends open streams).
4. **A run with a huge event stream.** Tens of thousands of events and multi-megabyte tool results must not freeze the page or the server. The page loads a tail, streams arrive in batches of at most 500 with back-pressure, and event bodies are clipped to 4,000 characters per field with the full event one request away. Pinned in Task 1 (clipping, tail) and Task 2 (batches).
5. **A run finishing, or owned elsewhere, while the page is open.** When a run finishes, `Supervisor` forgets it, so the view must keep reading from the store: the final `finished` event and `done` status arrive, and later reads still work. Steering a run another process owns must say "read-only", not fail obscurely. Pinned in Task 2 (finish while subscribed, a write from a second connection) and Task 3 (409).

## Files

| File | Task | Responsibility |
|---|---|---|
| `src/store.js` | 1 | Migration 5 (`members.agent`, `model`, `read_only`, indexes); `version`, `maxIds`, `listRuns`, `timeline`, `event`, `lastEvent`, `memberSpan`, `setHarnessInfo` |
| `src/view.js` | 1 | Read model: `publicMember`, `publicRun`, `publicMessage`, `clipEvent`, `runState`, `runDetail`, `needsYou`, `streamState`, `memberTexts` |
| `src/http.js` | 1–3, 7, 8 | `startHttp`: routing, guards, static files, JSON API, SSE hub, steering, loupe and Figma proxies |
| `src/supervisor.js` | 1, 3 | Record agent, model, `read_only` at launch; `send` by run and name; ownership checks in `send` and `answer` |
| `bin/agent-team.js` | 1, 5, 6 | `serve --port --max-running`; `send`, `watch`; `report` from the store |
| `src/web/index.html`, `style.css`, `feed.js`, `app.js` | 4, 7, 8 | The page |
| `src/watch.js` | 5 | `watchRun`, `formatRow` |
| `src/report.js` | 6 | `storeRuns`, `allRuns`, a tokens column when a run has tokens |
| `src/loupe.js` | 7 | `loupeConfig`, `loupeGet`, `openUrl`, `mentionedTargets` |
| `src/figma.js`, `src/config.js` | 8 | `figmaRefs`, `figmaImage`; `defaults.figma_file_key` |
| `test/helpers/http.js` | 1, 2 | `call`, `get`, `post`, `stream`, `view`, `until` |
| `docs/how-it-works.md`, `docs/configuration.md` | 1, 4–8 | Each task documents what it changes |

---

### Task 1: Store reads, migration 5, and the read-only JSON API in `serve`

**Files:**
- Modify: `src/store.js` (MIGRATIONS, new methods at the end of the returned object)
- Create: `src/view.js`
- Create: `src/http.js`
- Modify: `src/supervisor.js` (`#launch`, after `if (r.error) throw r.error;`)
- Modify: `bin/agent-team.js` (options, `USAGE`, the `serve` block)
- Create: `test/helpers/http.js`
- Modify: `test/store.test.js` (the "version 3 database" test, line 196; new tests)
- Create: `test/http.test.js`
- Modify: `docs/how-it-works.md` ("Live runs")

**Interfaces:**
- Consumes: `openStore`, `Supervisor` (`socketPath`), `loadConfig(projectRoot)`, `supervise`/`project`/`LIVE` from `test/helpers/live.js`.
- Produces:
  - store: `setHarnessInfo(id, { agent, model, readOnly })`; `version(): string`; `maxIds(): { event: number, message: number }`; `listRuns({ project = null, limit = 50 }): RunRow[]` (newest first; `limit: -1` for all); `timeline({ runId = null, memberId = null, afterEvent = 0, afterMessage = 0, beforeEvent = null, beforeMessage = null, limit = 200 }): { events: EventRow[], messages: MessageRow[] }` (ascending by id either way; an `EventRow` adds `run_id` and `member`; a `MessageRow` adds `run_id` and `to_name`); `event(id)`; `lastEvent(memberId)`; `memberSpan(memberId): { started: number|null, finished: number|null }`.
  - `src/view.js`: `publicMember(row)`, `publicRun(store, row, ownSocket)`, `publicMessage(row)`, `clipEvent(row, max = 4000)`, `runState(store, runId, ownSocket): { run, members }`, `runDetail(store, runId, ownSocket): { run, members, deny_paths }`, `needsYou(store): { questions, stalled, cost_capped }`, `streamState(store, runId, ownSocket)`, `memberTexts(store, memberId, limit = 500): string[]`, `READ_ONLY_NOTE`.
  - `src/http.js`: `DEFAULT_PORT = 4747`; `class HttpError(status, message)`; `startHttp({ store, sup = null, host = '127.0.0.1', port = DEFAULT_PORT, env = process.env, by = null, pollMs = 250, heartbeatMs = 15000, fetchImpl = fetch }): Promise<{ port, url, close(): Promise<void>, clients(): number }>`.
  - `test/helpers/http.js`: `call(base, method, path, { body, headers })`, `get(base, path, headers)`, `post(base, path, body, headers)`, `view(script, opts)`, `until(f, ms)`; `stream` is added in Task 2.

- [ ] **Step 1: Fix the migration test that rewinds to version 3, and write the store tests**

Migration 5 adds columns, so the existing test's rewind to version 3 must drop them too, or reapplying migration 5 fails with "duplicate column name". In `test/store.test.js`, replace line 196 with:

```js
  raw.exec('ALTER TABLE members DROP COLUMN tokens; ALTER TABLE runs DROP COLUMN tokens; ' +
           'ALTER TABLE members DROP COLUMN agent; ALTER TABLE members DROP COLUMN model; ' +
           'ALTER TABLE members DROP COLUMN read_only; PRAGMA user_version = 3');
```

Append to `test/store.test.js`:

```js
test('a version 4 database gains agent, model and read_only, unset', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-mig5-')), 's.db');
  const first = openStore(path);
  const runId = first.createRun({ project: '/p', task: 't' });
  const lead = first.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec('ALTER TABLE members DROP COLUMN agent; ALTER TABLE members DROP COLUMN model; ' +
           'ALTER TABLE members DROP COLUMN read_only; PRAGMA user_version = 4');
  raw.close();
  const store = openStore(path);
  assert.equal(store.member(lead.id).agent, null);
  store.setHarnessInfo(lead.id, { agent: 'codex', model: 'gpt-5.5', readOnly: true });
  const m = store.member(lead.id);
  assert.deepEqual([m.agent, m.model, m.read_only], ['codex', 'gpt-5.5', 1]);
  store.close();
});

test('the timeline pages forward from a cursor and backward from the newest', () => {
  const { store, runId, lead } = seeded();
  const other = store.createRun({ project: '/q', task: 'x' });
  const stranger = store.addMember({ runId: other, parentId: null, name: 'x', task: 'x', depth: 0 });
  for (let i = 1; i <= 5; i++) store.addEvent(lead.id, 'text', { text: `t${i}` });
  store.addEvent(stranger.id, 'text', { text: 'elsewhere' });
  store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'b', text: 'hi' });

  const top = store.maxIds();
  assert.deepEqual(top, { event: 6, message: 1 });
  const tail = store.timeline({ runId, beforeEvent: top.event + 1, beforeMessage: top.message + 1, limit: 2 });
  assert.deepEqual(tail.events.map((e) => e.body.text), ['t4', 't5']);
  assert.equal(tail.events[0].member, 'lead');
  assert.equal(tail.events[0].run_id, runId);
  assert.equal(tail.messages[0].to_name, 'lead');

  const after = store.timeline({ runId, afterEvent: 2, limit: 10 });
  assert.deepEqual(after.events.map((e) => e.body.text), ['t3', 't4', 't5']);
  assert.equal(store.timeline({ afterEvent: 5 }).events[0].body.text, 'elsewhere');   // every run
  assert.equal(store.timeline({ memberId: stranger.id }).events.length, 1);
});

test('version changes on a write from this connection and from another', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-ver-')), 's.db');
  const a = openStore(path);
  const b = openStore(path);
  const v0 = a.version();
  a.createRun({ project: '/p', task: 't' });
  const v1 = a.version();
  assert.notEqual(v1, v0);
  b.createRun({ project: '/p', task: 'u' });
  assert.notEqual(a.version(), v1);
  assert.equal(a.version(), a.version());
  a.close();
  b.close();
});

test('runs list newest first, by project; a member span runs from its first event to finished', () => {
  const { store, runId, lead } = seeded();
  store.createRun({ project: '/q', task: 'other' });
  assert.deepEqual(store.listRuns({ project: '/p' }).map((r) => r.id), [runId]);
  assert.equal(store.listRuns().length, 2);
  assert.equal(store.listRuns({ limit: -1 }).length, 2);
  assert.deepEqual(store.memberSpan(lead.id), { started: null, finished: null });
  store.addEvent(lead.id, 'started', {});
  store.addEvent(lead.id, 'finished', { status: 'ok', state: 'done' });
  const span = store.memberSpan(lead.id);
  assert.ok(span.started <= span.finished);
  assert.equal(store.lastEvent(lead.id).kind, 'finished');
  assert.equal(store.event(store.lastEvent(lead.id).id).body.state, 'done');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js`
Expected: FAIL. The rewind test fails with "no such column: agent", and the new tests fail with "store.setHarnessInfo is not a function" and "store.maxIds is not a function".

- [ ] **Step 3: Add migration 5 and the store reads**

In `src/store.js`, append to `MIGRATIONS`:

```js
  // What the web view shows per member: the harness, the configured model, and whether the
  // member could write. Indexes for the view's timeline reads.
  `ALTER TABLE members ADD COLUMN agent TEXT;
   ALTER TABLE members ADD COLUMN model TEXT;
   ALTER TABLE members ADD COLUMN read_only INTEGER;
   CREATE INDEX IF NOT EXISTS events_member ON events(member_id, id);
   CREATE INDEX IF NOT EXISTS messages_to ON messages(to_member, id);
   CREATE INDEX IF NOT EXISTS members_run ON members(run_id);`
```

Add a helper beside `memberRow`:

```js
  const eventRow = (row) => row && { ...row, body: parse(row.body) };
```

Add to the object `openStore` returns, after `openQuestions`:

```js
    // ---- reads for the web view, `watch`, and `report` ----

    setHarnessInfo: (id, { agent = null, model = null, readOnly = null }) =>
      q('UPDATE members SET agent = ?, model = ?, read_only = ? WHERE id = ?')
        .run(agent, model, readOnly == null ? null : (readOnly ? 1 : 0), id),
    // Differs after any committed write: data_version moves for other connections' commits
    // (an in-process supervisor in another CLI), total_changes() for this connection's own.
    version: () => `${q('PRAGMA data_version').get().data_version}.${q('SELECT total_changes() AS n').get().n}`,
    maxIds: () => q('SELECT (SELECT ifnull(max(id), 0) FROM events) AS event, ' +
                    '(SELECT ifnull(max(id), 0) FROM messages) AS message').get(),
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
    lastEvent: (memberId) => eventRow(q('SELECT * FROM events WHERE member_id = ? ORDER BY id DESC LIMIT 1').get(memberId)),
    memberSpan: (memberId) => q(
      "SELECT (SELECT min(at) FROM events WHERE member_id = ?1) AS started, " +
      "(SELECT max(at) FROM events WHERE member_id = ?1 AND kind = 'finished') AS finished"
    ).get(memberId)
```

- [ ] **Step 4: Run the store tests**

Run: `node --import ./test/helpers/guard.js --test test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Record agent, model, and `read_only` at launch**

Append to `test/supervisor.test.js`:

```js
test('a launched member records its harness, model and whether it could write', async () => {
  const { root, script } = project({ solo: LIVE({ model: 'mock-1' }) }, {
    by_member: { solo: { steps: [], result: { status: 'ok', summary: 'ok' } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await sup.waitRun(runId);
    const m = store.member(memberId);
    assert.deepEqual([m.agent, m.model, m.read_only], ['mock-live', 'mock-1', 1]);   // isolation none is read-only
  } finally { await sup.close(); }
});
```

Run: `node --import ./test/helpers/guard.js --test --test-name-pattern 'records its harness' test/supervisor.test.js`
Expected: FAIL, `[null, null, null]`.

In `src/supervisor.js` `#launch`, directly after `if (r.error) throw r.error;`, add:

```js
    // For the web view and the report: the resolution is not otherwise kept.
    this.store.setHarnessInfo(id, r.team
      ? { agent: 'team' }
      : { agent: r.resolved.agent, model: r.resolved.model, readOnly: r.resolved.isolation !== 'workspace' });
```

`read_only` mirrors `buildBrief`'s `read_only: resolved.isolation !== 'workspace'` (`src/brief.js:126`).

Run the same command. Expected: PASS.

- [ ] **Step 6: Write the HTTP test helper**

Create `test/helpers/http.js`:

```js
import { request } from 'node:http';
import { supervise } from './live.js';
import { startHttp } from '../../src/http.js';

export const until = async (f, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// node:http rather than fetch: fetch will not let a test set Host, Origin or Sec-Fetch-Site.
export function call(base, method, path, { body, headers = {} } = {}) {
  const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), {
      method,
      headers: {
        ...(data != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, buf, json });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}
export const get = (base, path, headers) => call(base, 'GET', path, { headers });
export const post = (base, path, body, headers) => call(base, 'POST', path, { body, headers });

// A supervisor on mock-live adapters with the web view in front of it, on a free port.
export async function view(script, opts = {}) {
  const s = await supervise(script, opts);
  const web = await startHttp({ store: s.store, sup: s.sup, port: 0, ...(opts.http ?? {}) });
  return {
    ...s, web, base: web.url,
    close: async () => { await web.close(); await s.sup.close(); }
  };
}
```

- [ ] **Step 7: Write the failing HTTP tests**

Create `test/http.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { project, LIVE } from './helpers/live.js';
import { get, view } from './helpers/http.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

function seeded() {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 'ship it', owner: '/elsewhere.sock' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 'ship it', depth: 0 });
  store.setRunRoot(runId, lead.id);
  store.setState(lead.id, 'running');
  return { store, runId, lead };
}

test('runs and a run\'s members come back without member tokens', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'hello' }], result: { status: 'ok', summary: 'done it' } } }
  });
  const v = await view(script);
  try {
    const { runId, memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await v.sup.waitRun(runId);
    const runs = await get(v.base, '/api/runs');
    assert.equal(runs.status, 200);
    assert.equal(runs.json.runs[0].id, runId);
    assert.equal(runs.json.runs[0].root, 'solo');
    assert.equal(runs.json.runs[0].status, 'done');
    assert.equal(runs.json.runs[0].steerable, false);   // finished: nothing to steer

    const detail = await get(v.base, `/api/runs/${runId}`);
    const m = detail.json.members[0];
    assert.equal(m.id, memberId);
    assert.equal(m.agent, 'mock-live');
    assert.equal(m.read_only, true);
    assert.deepEqual(m.result, { status: 'ok', summary: 'done it' });
    assert.equal(m.attach, `agent-team attach ${runId} solo`);
    assert.deepEqual(detail.json.deny_paths, ['**/.env*']);
    assert.ok(!('token' in m) && !('resume' in m));
    assert.ok(!detail.text.includes(v.store.member(memberId).token));
  } finally { await v.close(); }
});

test('the timeline returns a tail with a cursor, pages after it, and clips huge bodies', async () => {
  const { store, runId, lead } = seeded();
  for (let i = 1; i <= 3; i++) store.addEvent(lead.id, 'text', { text: `t${i}` });
  store.addEvent(lead.id, 'tool_result', { name: 'Read', text: 'x'.repeat(10_000) });
  const web = await startHttp({ store, port: 0 });
  try {
    const tail = await get(web.url, `/api/runs/${runId}/timeline?limit=2`);
    assert.deepEqual(tail.json.events.map((e) => e.kind), ['text', 'tool_result']);
    assert.deepEqual(tail.json.cursor, { event: 4, message: 0 });
    const big = tail.json.events[1];
    assert.equal(big.body.clipped, true);
    assert.equal(big.body.text.length, 4001);   // 4000 characters and an ellipsis
    const full = await get(web.url, `/api/events/${big.id}`);
    assert.equal(full.json.body.text.length, 10_000);
    const after = await get(web.url, `/api/runs/${runId}/timeline?after_event=1`);
    assert.deepEqual(after.json.events.map((e) => e.id), [2, 3, 4]);
    const member = await get(web.url, `/api/members/${lead.id}/timeline?after_event=0`);
    assert.equal(member.json.events.length, 4);
    const all = await get(web.url, '/api/timeline?after_event=3');
    assert.deepEqual(all.json.events.map((e) => e.id), [4]);
  } finally { await web.close(); store.close(); }
});

test('needs-you lists open questions, stalled members and runs paused by the cost cap', async () => {
  const { store, runId, lead } = seeded();
  const qid = store.addQuestion({ memberId: lead.id, question: 'tabs or spaces?', options: ['tabs', 'spaces'] });
  store.addEvent(lead.id, 'stalled', { quiet_s: 600 });
  const capped = store.createRun({ project: '/p', task: 'spend' });
  const boss = store.addMember({ runId: capped, parentId: null, name: 'boss', task: 'spend', depth: 0 });
  store.setRunRoot(capped, boss.id);
  store.setState(boss.id, 'paused');
  store.addEvent(boss.id, 'cost_cap', { cost_usd: 5.2, max_cost_usd: 5 });
  const web = await startHttp({ store, port: 0 });
  try {
    const { json } = await get(web.url, '/api/needs-you');
    assert.deepEqual(json.questions.map((q) => [q.id, q.run_id, q.member, q.options]),
                     [[qid, runId, 'lead', ['tabs', 'spaces']]]);
    assert.deepEqual(json.stalled.map((s) => [s.member, s.quiet_s]), [['lead', 600]]);
    assert.deepEqual(json.cost_capped.map((c) => [c.run_id, c.member, c.cost_usd, c.max_cost_usd]),
                     [[capped, 'boss', 5.2, 5]]);
  } finally { await web.close(); store.close(); }
});

test('a run another supervisor owns reads as running but not steerable', async () => {
  const { store, runId } = seeded();
  const web = await startHttp({ store, sup: { socketPath: '/mine.sock' }, port: 0 });
  try {
    const { json } = await get(web.url, `/api/runs/${runId}`);
    assert.equal(json.run.status, 'running');
    assert.equal(json.run.steerable, false);
    assert.match(json.run.read_only_note, /agent-team serve/);
  } finally { await web.close(); store.close(); }
});

test('a request naming another host is refused, so a rebound DNS name cannot read the API', async () => {
  const { store } = seeded();
  const web = await startHttp({ store, port: 0 });
  try {
    const refused = await get(web.url, '/api/runs', { Host: `evil.example:${web.port}` });
    assert.equal(refused.status, 403);
    assert.equal((await get(web.url, '/api/runs', { Host: `localhost:${web.port}` })).status, 200);
  } finally { await web.close(); store.close(); }
});

test('bad ids, unknown paths and wrong methods get JSON errors', async () => {
  const { store } = seeded();
  const web = await startHttp({ store, port: 0 });
  try {
    assert.equal((await get(web.url, '/api/runs/999')).status, 404);
    assert.equal((await get(web.url, '/api/nope')).status, 404);
    assert.equal((await get(web.url, '/api/runs?limit=-1')).status, 400);
    const r = await get(web.url, '/api/runs');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  } finally { await web.close(); store.close(); }
});

test('a port already in use is reported with what to do about it', async () => {
  const busy = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => busy.once('listening', r));
  const port = busy.address().port;
  const store = openStore(':memory:');
  try {
    await assert.rejects(startHttp({ store, port }), (err) => {
      assert.equal(err.code, 'EADDRINUSE');
      assert.match(err.message, new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already in use; pass --port`));
      return true;
    });
    const dir = mkdtempSync(join(tmpdir(), 'at-sv-'));
    const r = await promisify(execFile)(process.execPath, [BIN, 'serve', '--port', String(port)], {
      env: { ...process.env, AGENT_TEAM_SUPERVISOR_SOCK: join(dir, 's.sock'), AGENT_TEAM_SUPERVISOR_DB: join(dir, 's.db') },
      timeout: 15_000
    }).then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code, stderr: e.stderr }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use; pass --port/);
  } finally { busy.close(); store.close(); }
});
```

- [ ] **Step 8: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/http.test.js`
Expected: FAIL with "Cannot find module '…/src/http.js'".

- [ ] **Step 9: Write the read model**

Create `src/view.js`:

```js
import { loadConfig } from './config.js';

// What leaves the server about the store. Member rows go out through an allowlist: a row's
// `token` is the member's MCP credential, and new columns stay private until listed here.
const MEMBER_FIELDS = ['id', 'run_id', 'parent_id', 'name', 'task', 'depth', 'state', 'agent', 'model',
                       'workspace', 'cost_usd', 'tokens', 'created_at', 'updated_at'];

export const READ_ONLY_NOTE = 'started without `agent-team serve`, so this page can watch it but not steer it. ' +
  'Run the team while `agent-team serve` is up to steer it from here.';

export function publicMember(row) {
  const out = Object.fromEntries(MEMBER_FIELDS.map((k) => [k, row[k] ?? null]));
  out.read_only = row.read_only == null ? null : row.read_only === 1;
  out.result = row.result ? { status: row.result.status ?? null, summary: row.result.summary ?? null } : null;
  out.attach = `agent-team attach ${row.run_id} ${row.name}`;
  return out;
}

export function publicRun(store, row, ownSocket) {
  const steerable = row.status === 'running' && ownSocket != null && row.owner === ownSocket;
  return {
    id: row.id, project: row.project, task: row.task, status: row.status, created_at: row.created_at,
    cost_usd: row.cost_usd, tokens: row.tokens, max_cost_usd: row.max_cost_usd,
    root: row.root_member == null ? null : store.member(row.root_member)?.name ?? null,
    steerable,
    read_only_note: row.status === 'running' && !steerable ? READ_ONLY_NOTE : null
  };
}

export const publicMessage = (row) => ({
  id: row.id, run_id: row.run_id, to_member: row.to_member, to_name: row.to_name,
  from_kind: row.from_kind, from_name: row.from_name, report_id: row.report_id,
  text: row.text, state: row.state, at: row.at
});

// A tool result can be megabytes. Each long field is cut to `max` characters; the full event
// is GET /api/events/:id.
export function clipEvent(row, max = 4000) {
  const body = row.body ?? {};
  if (JSON.stringify(body).length <= max) return row;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string') out[k] = v.length > max ? `${v.slice(0, max)}…` : v;
    else if (v !== null && typeof v === 'object') {
      const s = JSON.stringify(v);
      out[k] = s.length > max ? `${s.slice(0, max)}…` : v;
    } else out[k] = v;
  }
  out.clipped = true;
  return { ...row, body: out };
}

export function runState(store, runId, ownSocket) {
  const run = store.run(runId);
  if (!run) return null;
  return { run: publicRun(store, run, ownSocket), members: store.members(runId).map(publicMember) };
}

// deny_paths come from the project's config as it is now; a config that no longer loads
// shows as null rather than failing the page.
export function runDetail(store, runId, ownSocket) {
  const state = runState(store, runId, ownSocket);
  if (!state) return null;
  let denyPaths = null;
  try { denyPaths = loadConfig(state.run.project).deny_paths; } catch { /* moved or broken */ }
  return { ...state, deny_paths: denyPaths };
}

// The "Needs you" section: open ask_human questions, working members gone quiet, and runs the
// cost cap paused (one entry per run, on its root).
export function needsYou(store) {
  const questions = store.openQuestions().map((q) => {
    const m = store.member(q.member_id);
    return { id: q.id, run_id: m.run_id, member_id: m.id, member: m.name,
             question: q.question, options: q.options, asked_at: q.at };
  });
  const stalled = [];
  const capped = [];
  for (const m of store.membersInStates(['running', 'paused'])) {
    const last = store.lastEvent(m.id);
    if (!last) continue;
    if (m.state === 'running' && last.kind === 'stalled') {
      stalled.push({ run_id: m.run_id, member_id: m.id, member: m.name, quiet_s: last.body.quiet_s ?? null, at: last.at });
    }
    const byCap = last.kind === 'cost_cap' || (last.kind === 'paused' && last.body.by === 'cost cap');
    if (m.state === 'paused' && m.parent_id == null && byCap) {
      const run = store.run(m.run_id);
      capped.push({ run_id: m.run_id, member_id: m.id, member: m.name, cost_usd: run.cost_usd, max_cost_usd: run.max_cost_usd });
    }
  }
  return { questions, stalled, cost_capped: capped };
}

// What every SSE stream sends as its `state` event: recent runs, the members of running
// runs (the sidebar), Needs you, and for a run-scoped stream that run in full.
export function streamState(store, runId, ownSocket) {
  const runs = store.listRuns({ limit: 50 });
  const live = runs.filter((r) => r.status === 'running').flatMap((r) => store.members(r.id).map((m) => ({
    id: m.id, run_id: m.run_id, parent_id: m.parent_id, name: m.name, agent: m.agent ?? null, state: m.state
  })));
  return {
    runs: runs.map((r) => publicRun(store, r, ownSocket)),
    live,
    needs: needsYou(store),
    ...(runId != null ? runState(store, runId, ownSocket) : {})
  };
}

// The text a member produced or was handed, newest last: what loupe and Figma mentions are
// read from.
export function memberTexts(store, memberId, limit = 500) {
  const { events, messages } = store.timeline({ memberId, beforeEvent: Number.MAX_SAFE_INTEGER, limit });
  const texts = [];
  for (const e of events) {
    const b = e.body ?? {};
    for (const v of [b.text, b.command, b.args && JSON.stringify(b.args)]) if (typeof v === 'string') texts.push(v);
  }
  for (const m of messages) texts.push(m.text);
  return texts;
}
```

- [ ] **Step 10: Write the server**

Create `src/http.js`:

```js
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { whoAmI } from './admin.js';
import { publicRun, publicMessage, clipEvent, runDetail, needsYou } from './view.js';

// The web view: a JSON API over the store, server-sent events, and a static page. It binds to
// 127.0.0.1 and has no sign-in yet: anyone who can open a connection to the port on this
// machine can read every run and steer the ones serve owns. The auth plan adds sign-in.
export const DEFAULT_PORT = 4747;
const MAX = Number.MAX_SAFE_INTEGER;

const WEB_DIR = new URL('./web/', import.meta.url);
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/feed.js', ['feed.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendBody(res, status, type, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, status, value) => sendBody(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

export function positiveInt(v, what = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${what} must be a positive integer`);
  return n;
}

export function intParam(url, name, def, max) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`);
  return Math.min(n, max);
}

// A tail (the newest `limit`) unless the caller pages after or before a cursor. The cursor is
// what an SSE stream continues from.
function timelineView(store, scope, url) {
  const limit = intParam(url, 'limit', 200, 1000);
  const has = (n) => url.searchParams.has(n);
  let rows;
  let cursor;
  if (has('after_event') || has('after_message')) {
    const afterEvent = intParam(url, 'after_event', 0, MAX);
    const afterMessage = intParam(url, 'after_message', 0, MAX);
    rows = store.timeline({ ...scope, afterEvent, afterMessage, limit });
    cursor = { event: rows.events.at(-1)?.id ?? afterEvent, message: rows.messages.at(-1)?.id ?? afterMessage };
  } else {
    const top = store.maxIds();
    rows = store.timeline({
      ...scope, limit,
      beforeEvent: intParam(url, 'before_event', top.event + 1, MAX),
      beforeMessage: intParam(url, 'before_message', top.message + 1, MAX)
    });
    cursor = top;
  }
  return { events: rows.events.map((e) => clipEvent(e)), messages: rows.messages.map(publicMessage), cursor };
}

export function startHttp({ store, sup = null, host = '127.0.0.1', port = DEFAULT_PORT, env = process.env,
                            by = null, pollMs = 250, heartbeatMs = 15_000, fetchImpl = fetch } = {}) {
  const own = sup?.socketPath ?? null;
  let bound = null;
  const found = (v, what) => { if (v == null) throw new HttpError(404, `unknown ${what}`); return v; };
  const member = (id) => found(store.member(id), `member ${id}`);

  // [method, path pattern, handler]. A handler returns a value to send as JSON, or undefined
  // when it wrote the response itself.
  const routes = [
    ['GET', /^\/api\/runs$/, ({ url }) => ({
      runs: store.listRuns({ project: url.searchParams.get('project') || null, limit: intParam(url, 'limit', 50, 500) })
        .map((r) => publicRun(store, r, own))
    })],
    ['GET', /^\/api\/runs\/(\d+)$/, ({ params }) => found(runDetail(store, params[0], own), `run ${params[0]}`)],
    ['GET', /^\/api\/runs\/(\d+)\/timeline$/, ({ params, url }) => {
      found(store.run(params[0]), `run ${params[0]}`);
      return timelineView(store, { runId: params[0] }, url);
    }],
    ['GET', /^\/api\/members\/(\d+)\/timeline$/, ({ params, url }) => {
      member(params[0]);
      return timelineView(store, { memberId: params[0] }, url);
    }],
    ['GET', /^\/api\/timeline$/, ({ url }) => timelineView(store, {}, url)],
    ['GET', /^\/api\/events\/(\d+)$/, ({ params }) => found(store.event(params[0]), `event ${params[0]}`)],
    ['GET', /^\/api\/needs-you$/, () => needsYou(store)]
  ];

  function serveStatic(res, path) {
    const [file, type] = STATIC.get(path);
    let body;
    try { body = readFileSync(new URL(file, WEB_DIR)); } catch { throw new HttpError(404, 'not found'); }
    sendBody(res, 200, type, body);
  }

  const server = createServer(async (req, res) => {
    try {
      // Only names this server is reached by. A site that points its own name at 127.0.0.1
      // (DNS rebinding) sends that name as Host and is refused here.
      const h = req.headers.host;
      if (h !== `127.0.0.1:${bound}` && h !== `localhost:${bound}`) {
        throw new HttpError(403, `open the view at http://127.0.0.1:${bound}/`);
      }
      const url = new URL(req.url, `http://${h}`);
      if (req.method === 'GET' && STATIC.has(url.pathname)) return serveStatic(res, url.pathname);
      const hits = routes.map(([method, re, handler]) => [method, re.exec(url.pathname), handler]).filter(([, m]) => m);
      if (!hits.length) throw new HttpError(404, 'not found');
      const hit = hits.find(([method]) => method === req.method);
      if (!hit) throw new HttpError(405, 'method not allowed');
      const [, match, handler] = hit;
      const params = match.slice(1).map((s) => positiveInt(s));
      const out = await handler({ req, res, url, params, body: null });
      if (out !== undefined) json(res, 200, out);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const status = err instanceof HttpError ? err.status : 500;
      // Never req.url: a loupe link carries a target, and later tasks proxy with secrets.
      if (status === 500) process.stderr.write(`agent-team: web request failed: ${err.stack ?? err}\n`);
      json(res, status, { error: status === 500 ? 'internal error' : err.message });
    }
  });

  function close() {
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        err.message = `port ${port} on ${host} is already in use; pass --port <n>, or --port 0 for any free port`;
      }
      reject(err);
    });
    server.listen(port, host, () => {
      bound = server.address().port;
      server.on('error', (err) => process.stderr.write(`agent-team: web server error: ${err.message}\n`));
      resolve({ port: bound, url: `http://${host}:${bound}/`, close, clients: () => 0 });
    });
  });
}
```

`env`, `by`, `pollMs`, `heartbeatMs`, and `fetchImpl` are unused until Tasks 2, 3, 7, and 8. They are in the signature now so `test/helpers/http.js` does not change shape later.

- [ ] **Step 11: Wire `serve`**

In `bin/agent-team.js`:

1. Import: `import { startHttp, DEFAULT_PORT } from '../src/http.js';`
2. Add to `parseArgs` options: `port: { type: 'string', default: String(DEFAULT_PORT) },` and `'max-running': { type: 'string', default: '6' },`
3. In `USAGE`, replace `'       agent-team serve\n'` with `'       agent-team serve [--port <n>] [--max-running <n>]\n'`.
4. Replace the `serve` block from `lockSupervisorDir();` through the `process.stderr.write(\`agent-team: supervisor listening …\`)` line with:

```js
  const count = (v, flag, min) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > 65535) {
      process.stderr.write(`agent-team: ${flag} must be a whole number from ${min}, got "${v}"\n`);
      process.exit(2);
    }
    return n;
  };
  const port = count(values.port, '--port', 0);
  const maxRunning = count(values['max-running'], '--max-running', 1);
  lockSupervisorDir();
  const store = openStore(defaultStorePath());
  const sup = new Supervisor({
    store, adapterDir: join(ROOT, 'adapters'), skillsDir: join(ROOT, 'skills'),
    socketPath: defaultSocketPath(), maxRunning
  });
  try {
    await sup.start();
  } catch (err) {
    store.close();
    fail(err);
  }
  process.stderr.write(`agent-team: supervisor listening on ${defaultSocketPath()}\n`);
  let web;
  try {
    web = await startHttp({ store, sup, port });
  } catch (err) {
    await sup.close().catch(() => {});
    store.close();
    process.stderr.write(`agent-team: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`agent-team: web view at ${web.url} (this machine only, no sign-in: ` +
                       'any local user who can reach the port can steer runs serve owns)\n');
```

5. In `shutdown`, replace `sup.close().catch(() => {})` with `web.close().then(() => sup.close()).catch(() => {})`.

- [ ] **Step 12: Run the HTTP tests and the suite**

Run: `node --import ./test/helpers/guard.js --test test/http.test.js test/store.test.js test/supervisor.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail (577 before this plan, plus this task's tests).

- [ ] **Step 13: Document `serve`'s flags and the view's address**

In `docs/how-it-works.md` "Live runs", replace the first sentence with:

```markdown
`agent-team serve [--port <n>] [--max-running <n>]` runs the supervisor in the foreground until
SIGINT or SIGTERM, with the web view at `http://127.0.0.1:4747/` (`--port 0` picks a free port;
the address is printed at start). The view binds to `127.0.0.1` only and has no sign-in yet:
any user or process on this machine that can reach the port can read every run and steer the
runs `serve` owns. `--max-running` (default 6) caps the members working at once across every
project.
```

- [ ] **Step 14: Commit**

```bash
git add src/store.js src/view.js src/http.js src/supervisor.js bin/agent-team.js test/helpers/http.js test/store.test.js test/supervisor.test.js test/http.test.js docs/how-it-works.md
git commit -m "feat(serve): JSON API over the store on 127.0.0.1:4747"
```

---

### Task 2: Live updates over server-sent events

**Files:**
- Modify: `src/http.js` (a `Hub` class, the `/api/stream` route, `close`, `clients`)
- Modify: `test/helpers/http.js` (`stream`)
- Create: `test/sse.test.js`

**Interfaces:**
- Consumes: `store.version`, `store.timeline`, `store.maxIds`, `streamState`, `clipEvent`, `publicMessage` (Task 1).
- Produces:
  - `GET /api/stream?run=<id>&after_event=<n>&after_message=<n>`: `text/event-stream`. `run` is optional (no run: every run, for the Activity view). The cursor comes from `Last-Event-ID` (`"<event>.<message>"`, what `EventSource` sends on reconnect), else the query, else the store's newest ids. Frames: `event: state` (a `streamState` object, sent on connect and whenever it changes) and `id: <e>.<m>` + `event: timeline` (`{ events, messages, cursor }`, at most 500 of each per frame). A `: ping` comment every `heartbeatMs`.
  - `startHttp` gains `stallMs = 60000`; `clients()` returns the number of open streams.
  - `test/helpers/http.js`: `stream(base, path, headers = {}) → { frames, comments(), ready, waitFor(pred, ms), ended(), pause(), close() }`.

- [ ] **Step 1: Add the stream reader to the test helper**

Append to `test/helpers/http.js`:

```js
// Reads a text/event-stream response into frames: { event, id, data } with data parsed as
// JSON. Comment lines (": ping") are only counted.
export function stream(base, path, headers = {}) {
  const frames = [];
  let comments = 0;
  let ended = false;
  let response = null;
  const req = request(new URL(path, base), { headers: { Accept: 'text/event-stream', ...headers } });
  const ready = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      response = res;
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const frame = { event: 'message', id: null, data: null };
          const data = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) { comments++; continue; }
            const at = line.indexOf(':');
            const key = line.slice(0, at);
            const value = line.slice(at + 1).replace(/^ /, '');
            if (key === 'event') frame.event = value;
            else if (key === 'id') frame.id = value;
            else if (key === 'data') data.push(value);
          }
          if (data.length) {
            frame.data = JSON.parse(data.join('\n'));
            frames.push(frame);
          }
        }
      });
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
      resolve(res);
    });
    req.on('error', (err) => { ended = true; reject(err); });
  });
  req.end();
  return {
    frames, ready,
    comments: () => comments,
    ended: () => ended,
    async waitFor(pred, ms = 15_000) {
      await until(() => frames.some(pred), ms);
      return frames.find(pred);
    },
    pause: () => response.pause(),
    close: () => req.destroy()
  };
}
```

- [ ] **Step 2: Write the failing SSE tests**

Create `test/sse.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { project, LIVE } from './helpers/live.js';
import { get, stream, until, view } from './helpers/http.js';

function seeded(path = ':memory:') {
  const store = openStore(path);
  const runId = store.createRun({ project: '/p', task: 'ship it' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 'ship it', depth: 0 });
  store.setRunRoot(runId, lead.id);
  store.setState(lead.id, 'running');
  return { store, runId, lead };
}
const timeline = (f) => f.event === 'timeline';
const hasEvent = (text) => (f) => timeline(f) && f.data.events.some((e) => e.body.text === text);

test('a stream sends state at once, then events and messages after its cursor', async () => {
  const { store, runId, lead } = seeded();
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  try {
    await s.ready;
    const state = await s.waitFor((f) => f.event === 'state');
    assert.equal(state.data.run.id, runId);
    assert.equal(state.data.members[0].name, 'lead');
    assert.ok(!('token' in state.data.members[0]));
    store.addEvent(lead.id, 'text', { text: 'hello' });
    store.enqueue({ to: lead.id, fromKind: 'human', fromName: 'b', text: 'hi' });
    const frame = await s.waitFor((f) => timeline(f) && f.data.messages.length);
    assert.equal(frame.id, '1.1');
    assert.ok(s.frames.some(hasEvent('hello')));
  } finally { s.close(); await web.close(); store.close(); }
});

test('an unknown run is a 404, not an empty stream', async () => {
  const { store } = seeded();
  const web = await startHttp({ store, port: 0 });
  try {
    assert.equal((await get(web.url, '/api/stream?run=999')).status, 404);
  } finally { await web.close(); store.close(); }
});

test('a run that finishes while watched arrives as finished, and reads still work after', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 300 }, { say: 'last words' }], result: { status: 'ok', summary: 'shipped' } } }
  });
  const v = await view(script, { http: { pollMs: 20 } });
  try {
    const { runId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const s = stream(v.base, `/api/stream?run=${runId}&after_event=0&after_message=0`);
    await s.ready;
    await v.sup.waitRun(runId);
    await s.waitFor((f) => timeline(f) && f.data.events.some((e) => e.kind === 'finished'));
    await s.waitFor((f) => f.event === 'state' && f.data.run.status === 'done');
    s.close();
    const after = await get(v.base, `/api/runs/${runId}`);
    assert.equal(after.json.members[0].result.summary, 'shipped');
  } finally { await v.close(); }
});

test('a write from another connection to the same file reaches the stream', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-sse-')), 's.db');
  const { store, runId, lead } = seeded(path);
  const other = openStore(path);   // an in-process supervisor in another CLI writes like this
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  try {
    await s.ready;
    await s.waitFor((f) => f.event === 'state');
    other.addEvent(lead.id, 'text', { text: 'from elsewhere' });
    await s.waitFor(hasEvent('from elsewhere'));
  } finally { s.close(); await web.close(); other.close(); store.close(); }
});

test('reconnecting with Last-Event-ID resumes after it', async () => {
  const { store, runId, lead } = seeded();
  for (const text of ['a', 'b', 'c']) store.addEvent(lead.id, 'text', { text });
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0`, { 'Last-Event-ID': '2.0' });
  try {
    const frame = await s.waitFor(timeline);
    assert.deepEqual(frame.data.events.map((e) => e.body.text), ['c']);
  } finally { s.close(); await web.close(); store.close(); }
});

test('a long backlog arrives in frames of at most 500 events', async () => {
  const { store, runId, lead } = seeded();
  for (let i = 0; i < 1200; i++) store.addEvent(lead.id, 'text', { text: `e${i}` });
  const web = await startHttp({ store, port: 0, pollMs: 20 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  try {
    const count = () => s.frames.filter(timeline).reduce((n, f) => n + f.data.events.length, 0);
    await until(() => count() === 1200);
    const sizes = s.frames.filter(timeline).map((f) => f.data.events.length);
    assert.deepEqual(sizes, [500, 500, 200]);
  } finally { s.close(); await web.close(); store.close(); }
});

test('a closed tab drops its client and the poll stops', async () => {
  const { store, runId } = seeded();
  const web = await startHttp({ store, port: 0, pollMs: 20, heartbeatMs: 30 });
  const s = stream(web.url, `/api/stream?run=${runId}`);
  try {
    await s.ready;
    await until(() => web.clients() === 1);
    await until(() => s.comments() > 0);   // the heartbeat
    s.close();
    await until(() => web.clients() === 0);
  } finally { await web.close(); store.close(); }
});

test('a reader that stops reading is cut off instead of buffering forever', async () => {
  const { store, runId, lead } = seeded();
  const web = await startHttp({ store, port: 0, pollMs: 20, stallMs: 300 });
  const s = stream(web.url, `/api/stream?run=${runId}&after_event=0&after_message=0`);
  try {
    await s.ready;
    await until(() => web.clients() === 1);
    s.pause();
    const big = 'x'.repeat(3900);
    for (let i = 0; i < 3000; i++) store.addEvent(lead.id, 'tool_result', { text: big });
    await until(() => web.clients() === 0);
  } finally { s.close(); await web.close(); store.close(); }
});

test('close() ends open streams at once', async () => {
  const { store, runId } = seeded();
  const web = await startHttp({ store, port: 0 });
  const s = stream(web.url, `/api/stream?run=${runId}`);
  await s.ready;
  const started = Date.now();
  await web.close();
  assert.ok(Date.now() - started < 1000, 'close() waited on an open stream');
  await until(() => s.ended());
  store.close();
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/sse.test.js`
Expected: FAIL. `/api/stream` answers 404, so `waitFor` times out and the 404 test passes alone.

- [ ] **Step 4: Write the hub**

In `src/http.js`, change the view import to `import { publicRun, publicMessage, clipEvent, runDetail, needsYou, streamState } from './view.js';` and add above `startHttp`:

```js
const BATCH = 500;

// Every open stream shares one timer. store.version() is one cheap pragma read; nothing else
// runs while it is unchanged, except for a client that still has a backlog to send.
class Hub {
  #clients = new Set();
  #timer = null;
  #version = null;

  constructor({ store, own, pollMs, heartbeatMs, stallMs }) {
    Object.assign(this, { store, own, pollMs, heartbeatMs, stallMs });
  }

  get size() { return this.#clients.size; }

  add(req, res, { runId, cursor }) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const c = { res, runId, cursor, state: null, more: false, blockedAt: null };
    // A full socket buffer pauses this client; it resumes from its cursor once drained.
    res.on('drain', () => { c.blockedAt = null; c.more = true; });
    c.heartbeat = setInterval(() => { if (c.blockedAt == null) c.res.write(': ping\n\n'); }, this.heartbeatMs);
    c.heartbeat.unref();
    this.#clients.add(c);
    req.on('close', () => this.#drop(c));
    res.on('error', () => this.#drop(c));
    this.#push(c);
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#poll(), this.pollMs);
      this.#timer.unref();
    }
  }

  close() {
    for (const c of [...this.#clients]) { c.res.end(); this.#drop(c); }
  }

  #drop(c) {
    if (!this.#clients.delete(c)) return;
    clearInterval(c.heartbeat);
    if (this.#clients.size === 0) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #poll() {
    let changed = false;
    try {
      const v = this.store.version();
      changed = v !== this.#version;
      this.#version = v;
    } catch { return; }   // the store is closing
    for (const c of [...this.#clients]) {
      if (changed || c.more || c.blockedAt != null) this.#push(c);
    }
  }

  #push(c) {
    if (c.blockedAt != null) {
      // A reader that has not drained for stallMs (a sleeping laptop, a stuck proxy) is cut;
      // EventSource reconnects with Last-Event-ID when it wakes.
      if (Date.now() - c.blockedAt >= this.stallMs) { c.res.destroy(); this.#drop(c); }
      return;
    }
    c.more = false;
    const state = JSON.stringify(streamState(this.store, c.runId, this.own));
    if (state !== c.state) {
      c.state = state;
      this.#send(c, `event: state\ndata: ${state}\n\n`);
    }
    if (c.blockedAt != null) return;
    const scope = c.runId != null ? { runId: c.runId } : {};
    const rows = this.store.timeline({ ...scope, afterEvent: c.cursor.event, afterMessage: c.cursor.message, limit: BATCH });
    if (!rows.events.length && !rows.messages.length) return;
    c.cursor = { event: rows.events.at(-1)?.id ?? c.cursor.event, message: rows.messages.at(-1)?.id ?? c.cursor.message };
    c.more = rows.events.length === BATCH || rows.messages.length === BATCH;
    const data = JSON.stringify({ events: rows.events.map((e) => clipEvent(e)), messages: rows.messages.map(publicMessage), cursor: c.cursor });
    this.#send(c, `id: ${c.cursor.event}.${c.cursor.message}\nevent: timeline\ndata: ${data}\n\n`);
  }

  #send(c, frame) {
    if (!c.res.write(frame)) c.blockedAt = Date.now();
  }
}

// "<event>.<message>", as the stream's ids are written.
function lastEventId(raw) {
  const m = /^(\d+)\.(\d+)$/.exec(raw ?? '');
  return m ? { event: Number(m[1]), message: Number(m[2]) } : null;
}
```

`JSON.stringify` never emits a raw newline, so one `data:` line per frame is safe.

- [ ] **Step 5: Route `/api/stream` and close streams on shutdown**

In `startHttp`:

1. Add `stallMs = 60_000` to the destructured options.
2. After `let bound = null;`, add `const hub = new Hub({ store, own, pollMs, heartbeatMs, stallMs });`.
3. Add to `routes`:

```js
    ['GET', /^\/api\/stream$/, ({ req, res, url }) => {
      const raw = url.searchParams.get('run');
      const runId = raw == null || raw === '' ? null : positiveInt(raw, 'run');
      if (runId != null) found(store.run(runId), `run ${runId}`);
      const top = store.maxIds();
      const cursor = lastEventId(req.headers['last-event-id']) ?? {
        event: intParam(url, 'after_event', top.event, MAX),
        message: intParam(url, 'after_message', top.message, MAX)
      };
      hub.add(req, res, { runId, cursor });
    }],
```

4. In `close()`, call `hub.close();` before `server.close(...)`.
5. In the resolved object, replace `clients: () => 0` with `clients: () => hub.size`.

- [ ] **Step 6: Run the SSE tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/sse.test.js test/http.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/http.js test/helpers/http.js test/sse.test.js
git commit -m "feat(serve): stream run changes to the web view over SSE"
```

---

### Task 3: Steering from HTTP, and ownership checks in `send` and `answer`

**Files:**
- Modify: `src/supervisor.js` (`send`, `answer`)
- Modify: `src/http.js` (POST guards, body reading, five steering routes)
- Modify: `test/supervisor.test.js`
- Create: `test/steer-http.test.js`
- Modify: `docs/how-it-works.md` ("Live runs")

**Interfaces:**
- Consumes: `Supervisor.send/pause/resume/cancel/answer`, `READ_ONLY_NOTE`, `whoAmI`.
- Produces:
  - `Supervisor.send({ member_id?, run_id?, member?, text, from })`: a member by id or by run and name, as `pause` takes it; refuses a run another supervisor owns.
  - `Supervisor.answer`: refuses a question whose run another supervisor owns.
  - `POST /api/members/:id/message {text}`, `/pause {now?, subtree?}`, `/resume {subtree?, note?, max_cost_usd?}`, `/cancel {subtree?}`, `POST /api/questions/:id/answer {answer}`. Each returns what the `Supervisor` method returns. Errors: `400` bad input, `403` cross-origin, `404` unknown member or question, `409` read-only run or a state the action cannot apply to, `413` body over 64 KiB, `415` not JSON, `503` no supervisor.

- [ ] **Step 1: Write the failing supervisor tests**

Append to `test/supervisor.test.js`:

```js
test('send names a member by run and name, as pause does', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ sleep_ms: 400 }, { say: 'done' }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const { message_id } = sup.send({ run_id: runId, member: 'solo', text: 'use tabs', from: 'b' });
    assert.equal(store.timeline({ memberId }).messages.find((m) => m.id === message_id).text, 'use tabs');
    await sup.waitRun(runId);
  } finally { await sup.close(); }
});

test('send and answer refuse a run another supervisor is running', async () => {
  const { script } = project({ solo: LIVE() }, { by_member: {} });
  const { sup, store } = await supervise(script);
  try {
    // Seeded after start, so recovery never sees it.
    const runId = store.createRun({ project: '/p', task: 't', owner: '/elsewhere.sock' });
    const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
    store.setRunRoot(runId, lead.id);
    store.setState(lead.id, 'waiting');
    const qid = store.addQuestion({ memberId: lead.id, question: 'ok?' });
    assert.throws(() => sup.send({ member_id: lead.id, text: 'hi' }), /run by another supervisor/);
    assert.throws(() => sup.answer({ question_id: qid, answer: 'yes' }), /run by another supervisor/);
    assert.equal(store.question(qid).answer, null);
  } finally { await sup.close(); }
});
```

Run: `node --import ./test/helpers/guard.js --test --test-name-pattern 'send names|send and answer refuse' test/supervisor.test.js`
Expected: FAIL. The first with "unknown member undefined", the second because neither call throws.

- [ ] **Step 2: Route `send` and `answer` through the ownership check**

In `src/supervisor.js`, replace `send`:

```js
  send({ member_id, run_id, member, text, from = 'local' }) {
    const m = this.#target({ member_id, run_id, member });
    // A stopping or cancelling member will not read another message. A pausing or paused one
    // will, after it is resumed.
    const rt = this.#live.get(m.id);
    if (TERMINAL.has(m.state) || rt?.stopping || (rt?.halt && rt.halt.kind !== 'pause')) throw new Error(`"${m.name}" has finished — delegate a new task`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('a message needs text');
    const id = this.store.enqueue({ to: m.id, fromKind: 'human', fromName: from, text });
    this.#pump(m.id);
    return { message_id: id };
  }
```

In `answer`, after the first `if (!q || …) throw …;` line, add:

```js
    // The asker's wait lives in the supervisor running its run; an answer written here would
    // never reach it.
    this.#owned(this.store.member(q.member_id));
```

Run the command from Step 1. Expected: PASS.

- [ ] **Step 3: Write the failing HTTP steering tests**

Create `test/steer-http.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { project, supervise, LIVE } from './helpers/live.js';
import { call, get, post, until, view } from './helpers/http.js';

const LONG = { steps: [{ say: 'working' }, { sleep_ms: 30_000 }], on_resume: { steps: [{ say: 'back' }] } };

test('a message from the page lands in the member\'s inbox, signed by the serve user', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script, { http: { by: 'tester' } });
  try {
    const { memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const r = await post(v.base, `/api/members/${memberId}/message`, { text: 'use tabs' });
    assert.equal(r.status, 200);
    const msg = v.store.timeline({ memberId }).messages.find((m) => m.id === r.json.message_id);
    assert.deepEqual([msg.from_kind, msg.from_name, msg.text], ['human', 'tester', 'use tabs']);
  } finally { await v.close(); }
});

test('pause now, resume with a note, then cancel, all from the page', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script, { http: { by: 'tester' } });
  try {
    const { memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => v.store.events(memberId).some((e) => e.kind === 'text'));
    const paused = await post(v.base, `/api/members/${memberId}/pause`, { now: true });
    assert.deepEqual(paused.json, { members: [{ id: memberId, name: 'solo' }], skipped: [] });
    await until(() => v.store.member(memberId).state === 'paused');
    assert.equal(v.store.events(memberId).find((e) => e.kind === 'paused').body.by, 'tester');
    assert.equal((await post(v.base, `/api/members/${memberId}/resume`, { note: 'carry on' })).status, 200);
    await until(() => v.store.events(memberId).some((e) => e.kind === 'text' && e.body.text === 'back'));
  } finally { await v.close(); }
});

test('cancel from the page ends the member as cancelled', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script);
  try {
    const { runId, memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => v.store.events(memberId).some((e) => e.kind === 'text'));
    assert.equal((await post(v.base, `/api/members/${memberId}/cancel`, { subtree: true })).status, 200);
    await v.sup.waitRun(runId);
    assert.equal(v.store.member(memberId).state, 'cancelled');
    const late = await post(v.base, `/api/members/${memberId}/message`, { text: 'too late' });
    assert.equal(late.status, 409);
    assert.match(late.json.error, /has finished/);
  } finally { await v.close(); }
});

test('an ask_human question is answered from the page', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'Ship it?', options: ['yes', 'no'] } }] } }
  });
  const v = await view(script, { http: { by: 'tester' } });
  try {
    const { runId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    let q;
    await until(async () => { [q] = (await get(v.base, '/api/needs-you')).json.questions; return q; });
    assert.equal((await post(v.base, `/api/questions/${q.id}/answer`, { answer: 'yes' })).status, 200);
    const result = await v.sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result, { answer: 'yes', answered_by: 'tester', timed_out: false });
    assert.equal((await post(v.base, `/api/questions/${q.id}/answer`, { answer: 'no' })).status, 409);
  } finally { await v.close(); }
});

test('a run another supervisor owns is read-only from the page', async () => {
  const { script } = project({ solo: LIVE() }, { by_member: {} });
  const v = await view(script);
  try {
    const runId = v.store.createRun({ project: '/p', task: 't', owner: '/elsewhere.sock' });
    const lead = v.store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
    v.store.setRunRoot(runId, lead.id);
    v.store.setState(lead.id, 'running');
    for (const action of ['pause', 'cancel', 'resume']) {
      const r = await post(v.base, `/api/members/${lead.id}/${action}`, {});
      assert.equal(r.status, 409, action);
      assert.match(r.json.error, /^read-only: started without `agent-team serve`/);
    }
  } finally { await v.close(); }
});

test('with no supervisor, steering says it needs serve', async () => {
  const store = openStore(':memory:');
  const web = await startHttp({ store, port: 0 });
  try {
    const r = await post(web.url, '/api/members/1/pause', {});
    assert.equal(r.status, 503);
    assert.match(r.json.error, /agent-team serve/);
  } finally { await web.close(); store.close(); }
});

test('cross-site and malformed requests cannot steer', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: LONG } });
  const v = await view(script);
  try {
    const { memberId } = v.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const path = `/api/members/${memberId}/pause`;
    // A form post or no-cors fetch from another site cannot set application/json.
    assert.equal((await call(v.base, 'POST', path, { body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await post(v.base, path, {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(v.base, path, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post(v.base, path, {}, { Origin: `http://127.0.0.1:${v.web.port}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    // A preflight gets no CORS headers, so a browser never sends the real request.
    const pre = await call(v.base, 'OPTIONS', path, { headers: { Origin: 'https://evil.example' } });
    assert.equal(pre.status, 405);
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
    const msg = `/api/members/${memberId}/message`;
    assert.equal((await call(v.base, 'POST', msg, { body: '{"text":', headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal((await post(v.base, msg, { text: '   ' })).status, 400);
    assert.equal((await post(v.base, msg, { text: 'x'.repeat(70_000) })).status, 413);
    assert.equal((await post(v.base, `/api/members/${memberId}/resume`, { max_cost_usd: 'lots' })).status, 400);
    assert.equal((await post(v.base, '/api/members/999/pause', {})).status, 404);
    assert.equal(v.store.member(memberId).state !== 'cancelled', true);
  } finally { await v.close(); }
});
```

Run: `node --import ./test/helpers/guard.js --test test/steer-http.test.js`
Expected: FAIL. Every POST route answers 404.

- [ ] **Step 4: Add the POST guards and body reader**

In `src/http.js`, change the view import to also take `READ_ONLY_NOTE`, and add above `startHttp`:

```js
const MAX_BODY = 64 * 1024;

// Not auth: a check that the request came from this page and not from another site open in
// the same browser. application/json makes a cross-origin browser send a CORS preflight,
// which this server answers without CORS headers; Origin and Sec-Fetch-Site catch the rest.
function checkSameSite(req, bound) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'send Content-Type: application/json');
  const origin = req.headers.origin;
  if (origin != null && origin !== `http://127.0.0.1:${bound}` && origin !== `http://localhost:${bound}`) {
    throw new HttpError(403, 'requests from another site cannot steer');
  }
  const site = req.headers['sec-fetch-site'];
  if (site != null && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'requests from another site cannot steer');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'request body is over 64 KiB'));
      let value;
      try { value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch {
        return reject(new HttpError(400, 'request body is not JSON'));
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return reject(new HttpError(400, 'request body must be a JSON object'));
      }
      resolve(value);
    });
    req.on('error', reject);
  });
}

const text = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} must be non-empty text`);
  return v;
};
const flag = (v) => v === true;
```

- [ ] **Step 5: Add the steering routes**

In `startHttp`, after `const member = …`, add:

```js
  const who = by ?? whoAmI();
  // The admin RPCs' operations, with their errors mapped to statuses. Supervisor messages
  // name members and runs, never tokens, so they are safe to return.
  const steer = (f) => {
    if (!sup) throw new HttpError(503, 'steering needs `agent-team serve`');
    try { return f(); } catch (err) {
      if (/run by another supervisor/.test(err.message)) throw new HttpError(409, `read-only: ${READ_ONLY_NOTE}`);
      if (/^(unknown |run \d+ has no member)/.test(err.message)) throw new HttpError(404, err.message);
      throw new HttpError(409, err.message);
    }
  };
  const cap = (v) => {
    if (v == null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new HttpError(400, 'max_cost_usd must be a positive number');
    return v;
  };
```

Add to `routes`:

```js
    ['POST', /^\/api\/members\/(\d+)\/message$/, ({ params, body }) =>
      steer(() => sup.send({ member_id: params[0], text: text(body.text, 'text'), from: who }))],
    ['POST', /^\/api\/members\/(\d+)\/pause$/, ({ params, body }) =>
      steer(() => sup.pause({ member_id: params[0], now: flag(body.now), subtree: flag(body.subtree), by: who }))],
    ['POST', /^\/api\/members\/(\d+)\/cancel$/, ({ params, body }) =>
      steer(() => sup.cancel({ member_id: params[0], subtree: flag(body.subtree), by: who }))],
    ['POST', /^\/api\/members\/(\d+)\/resume$/, ({ params, body }) => {
      const note = body.note == null || body.note === '' ? null : text(body.note, 'note');
      const maxCost = cap(body.max_cost_usd);
      return steer(() => sup.resume({ member_id: params[0], subtree: flag(body.subtree), note, max_cost_usd: maxCost, by: who }));
    }],
    ['POST', /^\/api\/questions\/(\d+)\/answer$/, ({ params, body }) =>
      steer(() => sup.answer({ question_id: params[0], answer: text(body.answer, 'answer'), by: who }))],
```

`text()` and `cap()` run before `steer`, so bad input is a `400` even with no supervisor; the 503 test sends `{}` to `pause`, which needs no fields.

In the request handler, replace `const out = await handler({ req, res, url, params, body: null });` with:

```js
      let body = null;
      if (req.method === 'POST') {
        checkSameSite(req, bound);
        body = await readJson(req);
      }
      const out = await handler({ req, res, url, params, body });
```

- [ ] **Step 6: Run the steering tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/steer-http.test.js test/supervisor.test.js test/admin-cli.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 7: Document steering and the read-only rule**

In `docs/how-it-works.md` "Live runs", after the paragraph Task 1 changed, add:

```markdown
The page steers with the same operations as the CLI verbs: message a member, pause, pause now,
resume, cancel (one member or its subtree), and answer an `ask_human` question. Actions are
signed with the name of the OS user running `serve`. Take-over stays in the terminal: the page
shows the `agent-team attach <run> <member>` command to copy. A run started by a CLI with no
`serve` running belongs to that CLI's in-process supervisor; the page shows it live but
read-only, and `send` and `answer` refuse it too, because only the supervisor running a member
can deliver to it.
```

- [ ] **Step 8: Commit**

```bash
git add src/supervisor.js src/http.js test/supervisor.test.js test/steer-http.test.js docs/how-it-works.md
git commit -m "feat(serve): steer owned runs from the web view"
```

---

### Task 4: The page

**Files:**
- Create: `src/web/index.html`, `src/web/style.css`, `src/web/feed.js`, `src/web/app.js`
- Create: `test/web.test.js`
- Modify: `docs/how-it-works.md` ("Live runs")

**Interfaces:**
- Consumes: every route from Tasks 1–3.
- Produces:
  - `src/web/feed.js` (no DOM, importable by `node --test`): `describe(event): string`, `memberTree(members): Node[]` (each with `children`), `activity(events): { member_id, member, run_id, items: { id, kind, label, count, at }[] }[]`, `countLabel(n)`, `todayCount(events, now)`, `mergeTimeline(model, batch, cap = 2000)`, `conversation({ events, messages })`, `matches(query, ...fields)`, `TERMINAL`.
  - `src/web/app.js`: `extras(member): Node[]`, the hook Tasks 7 and 8 fill in the member panel.

Layout follows the spec's "Web view" section: a sidebar (search, then projects with their runs and live members tagged by harness and state), "Needs you" pinned above everything, Activity as the default view, a run page (org tree beside the merged conversation of messages and team events), and a member panel (transcript, what the member can reach, message box, controls, and the `attach` command to copy).

- [ ] **Step 1: Write the failing tests**

Create `test/web.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { get } from './helpers/http.js';
import { describe, memberTree, activity, countLabel, mergeTimeline, conversation, matches } from '../src/web/feed.js';

const WEB = new URL('../src/web/', import.meta.url);
const XSS = '<img src=x onerror="alert(1)"></script><script>alert(2)</script>';

test('the page and its assets are served with their types and a CSP with no inline code', async () => {
  const store = openStore(':memory:');
  const web = await startHttp({ store, port: 0 });
  try {
    for (const [path, type] of [['/', /^text\/html/], ['/app.js', /^text\/javascript/],
                                ['/feed.js', /^text\/javascript/], ['/style.css', /^text\/css/]]) {
      const r = await get(web.url, path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers['content-type'], type, path);
      assert.doesNotMatch(r.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    }
    const html = (await get(web.url, '/')).text;
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'inline script');
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, 'inline style or handler');
    assert.equal((await get(web.url, '/%2e%2e/src/http.js')).status, 404);
    assert.equal((await get(web.url, '/index.html')).status, 404);
  } finally { await web.close(); store.close(); }
});

test('nothing in src/web parses text as HTML', () => {
  for (const name of readdirSync(WEB)) {
    const src = readFileSync(new URL(name, WEB), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|srcdoc/, name);
    assert.doesNotMatch(src, /setAttribute\(\s*['"`]on/i, name);
  }
  // Links built from data go through safeHref, which allows only this page's own paths.
  assert.match(readFileSync(new URL('app.js', WEB), 'utf8'), /k === 'href'\) el\.setAttribute\('href', safeHref\(v\)\)/);
});

test('markup in member output comes back as JSON text, never as a page', async () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: XSS });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: XSS, depth: 0 });
  store.addEvent(lead.id, 'tool_result', { name: 'Read', text: XSS });
  const web = await startHttp({ store, port: 0 });
  try {
    const r = await get(web.url, `/api/runs/${runId}/timeline`);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.json.events[0].body.text, XSS);
  } finally { await web.close(); store.close(); }
});

test('describe gives one line per event and keeps markup as text', () => {
  assert.equal(describe({ kind: 'text', body: { text: XSS } }), XSS);
  assert.equal(describe({ kind: 'tool_call', body: { name: 'Bash', args: { command: 'ls\n-la' } } }), 'Bash {"command":"ls\\n-la"}');
  assert.equal(describe({ kind: 'delegated', body: { to: 'worker', report_id: 3 } }), 'delegated to worker');
  assert.equal(describe({ kind: 'finished', body: { state: 'done', summary: 'shipped' } }), 'done: shipped');
  assert.equal(describe({ kind: 'paused', body: { by: 'b' } }), 'by b');
  assert.ok(describe({ kind: 'tool_result', body: { name: 'Read', text: 'y'.repeat(500) } }).length < 200);
});

test('activity nests calls under each member and collapses identical repeats', () => {
  const call = (id, member_id, command) => ({ id, member_id, member: `m${member_id}`, run_id: 1, kind: 'tool_call', at: id, body: { name: 'Bash', args: { command } } });
  const events = [
    call(1, 1, 'npm test'), call(2, 1, 'npm test'), call(3, 1, 'npm test'),
    { id: 4, member_id: 1, member: 'm1', run_id: 1, kind: 'tool_result', at: 4, body: { name: 'Bash', text: 'ok' } },
    call(5, 2, 'ls'), call(6, 1, 'git status'), call(7, 1, 'npm test')
  ];
  const feed = activity(events);
  assert.deepEqual(feed.map((e) => e.member), ['m1', 'm2']);
  assert.deepEqual(feed[0].items.map((i) => [i.label, i.count]),
                   [['Bash {"command":"npm test"}', 3], ['Bash {"command":"git status"}', 1], ['Bash {"command":"npm test"}', 1]]);
  assert.equal(countLabel(12), '12 times');
  assert.equal(countLabel(1), '');
});

test('the member tree nests reports under their managers', () => {
  const roots = memberTree([
    { id: 3, parent_id: 1, name: 'reviewer' }, { id: 1, parent_id: null, name: 'lead' }, { id: 2, parent_id: 1, name: 'worker' }
  ]);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].children.map((c) => c.name), ['worker', 'reviewer']);
});

test('merging a batch keeps ids unique and the newest `cap` rows', () => {
  const e = (id) => ({ id, at: id });
  let model = { events: [e(1), e(2)], messages: [] };
  model = mergeTimeline(model, { events: [e(2), e(3)], messages: [{ id: 1, at: 1 }], cursor: { event: 3, message: 1 } }, 2);
  assert.deepEqual(model.events.map((x) => x.id), [2, 3]);
  assert.deepEqual(model.cursor, { event: 3, message: 1 });
});

test('the conversation interleaves messages and team events by time', () => {
  const rows = conversation({
    events: [{ id: 1, kind: 'delegated', member: 'lead', at: 10, body: { to: 'worker' } },
             { id: 2, kind: 'tool_call', member: 'lead', at: 11, body: { name: 'Read' } }],
    messages: [{ id: 1, from_name: 'b', from_kind: 'human', to_name: 'worker', text: 'use tabs', at: 12 }]
  });
  assert.deepEqual(rows.map((r) => r.text), ['delegated: delegated to worker', 'use tabs']);
  assert.ok(matches('wor', 'lead', 'Worker'));
  assert.ok(!matches('x', null, 'lead'));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import ./test/helpers/guard.js --test test/web.test.js`
Expected: FAIL with "Cannot find module '…/src/web/feed.js'".

- [ ] **Step 3: Write `feed.js`**

Create `src/web/feed.js`:

```js
// Pure helpers for the page. No DOM here, so node --test can import this file.

export const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const json = (v) => (v == null ? '' : JSON.stringify(v));

// One line for an event, as the transcript and the activity feed show it. The page puts it
// into the DOM as text, so markup in it stays markup.
export function describe(e) {
  const b = e.body ?? {};
  switch (e.kind) {
    case 'text': case 'user': case 'progress': return b.text ?? '';
    case 'tool_call': return `${b.name ?? 'tool'} ${clip(oneLine(json(b.args)))}`.trim();
    case 'tool_result': return `${b.name ?? 'tool'} → ${clip(oneLine(typeof b.text === 'string' ? b.text : json(b.result ?? b)))}`;
    case 'command': return clip(oneLine(b.command ?? json(b)));
    case 'delegated': return `delegated to ${b.to}`;
    case 'stalled': return `quiet for ${Math.round((b.quiet_s ?? 0) / 60)} min`;
    case 'cost_cap': return `cost cap: $${(b.cost_usd ?? 0).toFixed(2)} of $${(b.max_cost_usd ?? 0).toFixed(2)}`;
    case 'finished': return [b.state ?? b.status, b.summary].filter(Boolean).join(': ');
    default: return b.by ? `by ${b.by}` : '';
  }
}

export function memberTree(members) {
  const byId = new Map(members.map((m) => [m.id, { ...m, children: [] }]));
  const roots = [];
  for (const m of [...byId.values()].sort((a, b) => a.id - b.id)) {
    const parent = m.parent_id == null ? null : byId.get(m.parent_id);
    (parent ? parent.children : roots).push(m);
  }
  return roots;
}

// The Activity feed: one entry per member task, in order of its first event, with its tool
// calls nested under it and identical consecutive calls collapsed into a count.
export function activity(events) {
  const entries = new Map();
  for (const e of events) {
    if (e.kind === 'tool_result') continue;
    let entry = entries.get(e.member_id);
    if (!entry) {
      entry = { member_id: e.member_id, member: e.member, run_id: e.run_id, items: [] };
      entries.set(e.member_id, entry);
    }
    const label = describe(e);
    const last = entry.items.at(-1);
    if (e.kind === 'tool_call' && last?.kind === 'tool_call' && last.label === label) {
      last.count++;
      last.at = e.at;
      continue;
    }
    entry.items.push({ id: e.id, kind: e.kind, label, count: 1, at: e.at });
  }
  return [...entries.values()];
}

export const countLabel = (n) => (n > 1 ? `${n} times` : '');

export function todayCount(events, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return events.filter((e) => e.kind === 'tool_call' && e.at >= start.getTime()).length;
}

// What the page holds is bounded: the newest `cap` events and messages.
export function mergeTimeline(model, batch, cap = 2000) {
  const merge = (have, add = []) => {
    const seen = new Set(have.map((r) => r.id));
    const out = have.concat(add.filter((r) => !seen.has(r.id))).sort((a, b) => a.id - b.id);
    return out.length > cap ? out.slice(out.length - cap) : out;
  };
  return { events: merge(model.events, batch.events), messages: merge(model.messages, batch.messages), cursor: batch.cursor ?? model.cursor };
}

const TEAM_KINDS = new Set(['started', 'delegated', 'progress', 'paused', 'resumed', 'interrupted', 'stalled',
                            'timed_out', 'cost_cap', 'taken_over', 'handed_back', 'finished']);

// The run as a team conversation: messages between members and humans, and the events the
// supervisor records, not tool calls.
export function conversation({ events, messages }) {
  const rows = [
    ...events.filter((e) => TEAM_KINDS.has(e.kind)).map((e) => {
      const said = describe(e);
      return { type: 'event', at: e.at, key: `e${e.id}`, who: e.member, text: said ? `${e.kind}: ${said}` : e.kind };
    }),
    ...messages.map((m) => ({ type: 'message', at: m.at, key: `m${m.id}`, who: `${m.from_name} (${m.from_kind}) → ${m.to_name}`, text: m.text }))
  ];
  return rows.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

export const matches = (query, ...fields) => {
  const q = query.toLowerCase();
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
};
```

- [ ] **Step 4: Write `index.html` and `style.css`**

Create `src/web/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-team</title>
<link rel="stylesheet" href="/style.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<header class="top">
  <a href="#/" class="brand">agent-team</a>
  <span id="conn" class="muted">connecting…</span>
  <span class="muted local">this machine only · no sign-in</span>
</header>
<div class="layout">
  <nav id="side" aria-label="Projects">
    <input id="search" type="search" placeholder="Search members, projects, tasks" aria-label="Search">
    <div id="projects"></div>
  </nav>
  <main>
    <section id="needs" aria-label="Needs you" hidden></section>
    <section id="view"></section>
  </main>
</div>
<p id="flash" role="status"></p>
</body>
</html>
```

Create `src/web/style.css`:

```css
:root {
  --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e3e2de; --card: #ffffff;
  --accent: #2357d9; --warn: #a15c00; --bad: #b3261e; --ok: #1f7a3a;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --fg: #ecebe8; --muted: #9b9a95; --line: #2e2d2b; --card: #1e1e1c;
          --accent: #8aa8ff; --warn: #e0a24a; --bad: #ff8a80; --ok: #6fd08c; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); }
a { color: var(--accent); text-decoration: none; }
a.current { font-weight: 600; }
.muted { color: var(--muted); }
.top { display: flex; gap: 16px; align-items: baseline; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; color: var(--fg); }
.local { margin-left: auto; }
.layout { display: grid; grid-template-columns: 260px 1fr; min-height: calc(100vh - 44px); }
#side { border-right: 1px solid var(--line); padding: 12px; overflow: auto; }
#search { width: 100%; padding: 6px 8px; margin-bottom: 12px; }
#side h2 { font-size: 12px; text-transform: uppercase; color: var(--muted); margin: 12px 0 4px; }
#side ul { list-style: none; margin: 0; padding-left: 0; }
#side ul.members { padding-left: 14px; }
main { padding: 16px; overflow: auto; min-width: 0; }
#needs { border: 1px solid var(--warn); border-radius: 8px; padding: 8px 12px; margin-bottom: 16px; }
#needs h2 { margin: 0 0 8px; font-size: 14px; color: var(--warn); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin: 6px 0;
        display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.tag { font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.state { font-size: 11px; color: var(--muted); }
.state.running, .state.waiting { color: var(--ok); }
.state.paused, .state.taken_over { color: var(--warn); }
.state.failed, .state.cancelled { color: var(--bad); }
.run { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 16px; }
.tree, .tree ul { list-style: none; padding-left: 14px; margin: 0; }
.talk, .transcript, .feed { list-style: none; padding: 0; margin: 0; }
.talk li, .transcript li { padding: 3px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; white-space: pre-wrap; }
.transcript li.collapsed .text { display: inline-block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.transcript pre { white-space: pre-wrap; margin: 4px 0; }
.kind { font-size: 11px; color: var(--muted); }
.count { color: var(--muted); }
time { font-size: 11px; color: var(--muted); }
.note { border-left: 3px solid var(--warn); padding-left: 8px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.controls textarea { width: 100%; }
.controls .buttons { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; align-items: center; }
.devices img, .designs img { max-width: 100%; max-height: 480px; border: 1px solid var(--line); }
#flash { position: fixed; bottom: 12px; right: 16px; margin: 0; color: var(--muted); }
@media (max-width: 800px) {
  .layout, .run { grid-template-columns: 1fr; }
  #side { border-right: 0; border-bottom: 1px solid var(--line); }
}
```

- [ ] **Step 5: Write `app.js`**

Create `src/web/app.js`:

```js
import { describe, memberTree, activity, countLabel, todayCount, mergeTimeline, conversation, matches, TERMINAL } from './feed.js';

// Member output is untrusted. Every node is built here with createElement and text nodes;
// nothing from the API is parsed as HTML.
const $ = (id) => document.getElementById(id);
const S = { route: null, state: null, detail: null, model: { events: [], messages: [] }, source: null, query: '', panel: null };

const safeHref = (v) => { const s = String(v); return s.startsWith('#') || s.startsWith('/') ? s : '#'; };
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.setAttribute('href', safeHref(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// Rebuilds a list, reusing the node of every row whose key is unchanged, so a half-typed
// answer survives an update and a long transcript is not rebuilt on every event.
function keyed(container, items, key, build) {
  const old = new Map([...container.children].map((el) => [el.dataset.key, el]));
  container.replaceChildren(...items.map((it) => {
    const k = key(it);
    const el = old.get(k) ?? build(it);
    el.dataset.key = k;
    return el;
  }));
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
const flash = (text) => { $('flash').textContent = text; };
const act = (path, body, done) => api(path, body).then((r) => { flash(done); return r; }, (err) => { flash(err.message); });
function button(label, path, body, confirmText = null) {
  return h('button', { type: 'button', onclick: () => {
    if (confirmText && !confirm(confirmText)) return;
    act(path, typeof body === 'function' ? body() : body, `${label}: sent`);
  } }, label);
}

const money = (usd) => (usd ? `$${usd.toFixed(2)}` : '—');
const clock = (at) => new Date(at).toLocaleTimeString();
const tag = (agent) => (agent ? h('span', { class: 'tag' }, agent) : null);
const state = (s) => h('span', { class: `state ${s}` }, s.replace('_', ' '));
const projectOf = (runId) => S.state?.runs.find((r) => r.id === runId)?.project ?? null;

function parseRoute() {
  const m = /^#\/run\/(\d+)(?:\/member\/(\d+))?$/.exec(location.hash);
  return m ? { run: Number(m[1]), member: m[2] ? Number(m[2]) : null } : { run: null, member: null };
}

// Each view loads a tail over HTTP, then streams from that tail's cursor.
async function open() {
  const route = parseRoute();
  if (S.route && route.run === S.route.run && route.run != null) {   // another member, same run
    S.route = route;
    return schedule();
  }
  S.source?.close();
  Object.assign(S, { route, panel: null, detail: null, model: { events: [], messages: [] } });
  try {
    const tl = await api(route.run ? `/api/runs/${route.run}/timeline?limit=500` : '/api/timeline?limit=500');
    S.model = { events: tl.events, messages: tl.messages };
    if (route.run) S.detail = await api(`/api/runs/${route.run}`);
    const q = new URLSearchParams({ after_event: tl.cursor.event, after_message: tl.cursor.message });
    if (route.run) q.set('run', route.run);
    const src = new EventSource(`/api/stream?${q}`);
    src.addEventListener('state', (ev) => { S.state = JSON.parse(ev.data); schedule(); });
    src.addEventListener('timeline', (ev) => { S.model = mergeTimeline(S.model, JSON.parse(ev.data)); schedule(); });
    src.onopen = () => { $('conn').textContent = 'live'; };
    src.onerror = () => { $('conn').textContent = 'reconnecting…'; };
    S.source = src;
  } catch (err) { flash(err.message); }
  schedule();
}

// At most one redraw per frame, however many batches arrive.
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; draw(); });
}

function draw() {
  drawSidebar();
  drawNeeds();
  if (S.route.run) drawRun(); else drawActivity();
}

function drawSidebar() {
  const live = S.state?.live ?? [];
  const byProject = new Map();
  for (const run of S.state?.runs ?? []) {
    const members = live.filter((m) => m.run_id === run.id);
    if (S.query && !matches(S.query, run.project, run.task, run.root, ...members.map((m) => m.name))) continue;
    byProject.set(run.project, [...(byProject.get(run.project) ?? []), { run, members }]);
  }
  $('projects').replaceChildren(...[...byProject].map(([project, items]) => h('div', { class: 'project' },
    h('h2', { title: project }, project.split('/').filter(Boolean).at(-1) ?? project),
    h('ul', {}, items.map(({ run, members }) => h('li', {},
      h('a', { href: `#/run/${run.id}` }, `#${run.id} ${run.root ?? ''}`), ' ', state(run.status),
      members.length ? h('ul', { class: 'members' }, members.map((m) => h('li', {},
        h('a', { href: `#/run/${m.run_id}/member/${m.id}` }, m.name), ' ', tag(m.agent), ' ', state(m.state)))) : null))))));
}

function drawNeeds() {
  const n = S.state?.needs ?? { questions: [], stalled: [], cost_capped: [] };
  const items = [
    ...n.questions.map((q) => ({ key: `q${q.id}`, build: () => questionCard(q) })),
    ...n.stalled.map((s) => ({ key: `s${s.member_id}.${s.at}`, build: () => h('div', { class: 'card' },
      h('a', { href: `#/run/${s.run_id}/member/${s.member_id}` }, s.member),
      ` has been quiet for ${Math.round((s.quiet_s ?? 0) / 60)} min`,
      button('Pause now', `/api/members/${s.member_id}/pause`, { now: true }),
      button('Cancel', `/api/members/${s.member_id}/cancel`, {}, `Cancel ${s.member}?`)) })),
    ...n.cost_capped.map((c) => ({ key: `c${c.run_id}.${c.max_cost_usd}`, build: () => capCard(c) }))
  ];
  const section = $('needs');
  section.hidden = items.length === 0;
  if (!section.firstChild) section.append(h('h2', {}, 'Needs you'), h('div', { class: 'cards' }));
  keyed(section.lastChild, items, (i) => i.key, (i) => i.build());
}

function questionCard(q) {
  const input = h('input', { type: 'text', placeholder: 'Your answer', 'aria-label': `Answer ${q.member}` });
  const send = (answer) => act(`/api/questions/${q.id}/answer`, { answer }, 'answered');
  return h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) send(input.value); } },
    h('div', {}, h('a', { href: `#/run/${q.run_id}/member/${q.member_id}` }, q.member), ' asks: ', h('q', {}, q.question)),
    (q.options ?? []).map((o) => h('button', { type: 'button', onclick: () => send(o) }, o)),
    input, h('button', { type: 'submit' }, 'Answer'));
}

function capCard(c) {
  const input = h('input', { type: 'number', min: '0', step: '0.5', value: String((c.max_cost_usd ?? 0) * 2), 'aria-label': 'New cap in dollars' });
  return h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    act(`/api/members/${c.member_id}/resume`, { subtree: true, max_cost_usd: Number(input.value) }, 'resumed');
  } },
    `Run #${c.run_id} paused at its cost cap: ${money(c.cost_usd)} of ${money(c.max_cost_usd)}. New cap $`,
    input, h('button', { type: 'submit' }, 'Raise and resume'));
}

function drawActivity() {
  const entries = activity(S.model.events).reverse()
    .filter((e) => !S.query || matches(S.query, e.member, projectOf(e.run_id)));
  $('view').replaceChildren(
    h('h1', {}, 'Activity'),
    h('p', { class: 'muted' }, `${todayCount(S.model.events)} tool calls today`),
    h('ol', { class: 'feed' }, entries.slice(0, 200).map((e) => h('li', { class: 'card' },
      h('div', {}, h('a', { href: `#/run/${e.run_id}/member/${e.member_id}` }, e.member), h('span', { class: 'muted' }, ` run #${e.run_id}`)),
      h('ul', {}, e.items.slice(-20).map((it) => h('li', {},
        h('span', { class: 'kind' }, it.kind), ' ', it.label, it.count > 1 ? h('span', { class: 'count' }, ` ${countLabel(it.count)}`) : null)))))));
}

function drawRun() {
  const run = S.state?.run ?? S.detail?.run;
  if (!run) return $('view').replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const members = S.state?.members ?? S.detail.members;
  if (!S.panel) {
    S.panel = { head: h('header'), tree: h('ul', { class: 'tree' }), talk: h('ol', { class: 'talk' }), member: h('aside'), controls: null };
    $('view').replaceChildren(S.panel.head, h('div', { class: 'run' },
      h('div', {}, h('h2', {}, 'Team'), S.panel.tree, h('h2', {}, 'Conversation'), S.panel.talk), S.panel.member));
  }
  S.panel.head.replaceChildren(
    h('h1', {}, `Run #${run.id}: `, run.task),
    h('p', { class: 'muted' }, run.project, ' · ', run.status, ' · ', money(run.cost_usd), run.tokens ? ` · ${run.tokens} tokens` : ''),
    run.read_only_note ? h('p', { class: 'note' }, 'Read-only: ', run.read_only_note) : null);
  const node = (m) => h('li', {}, h('a', { href: `#/run/${run.id}/member/${m.id}`, class: m.id === S.route.member ? 'current' : null }, m.name),
    ' ', tag(m.agent), ' ', state(m.state), m.children.length ? h('ul', {}, m.children.map(node)) : null);
  S.panel.tree.replaceChildren(...memberTree(members).map(node));
  keyed(S.panel.talk, conversation(S.model).slice(-300), (r) => r.key,
    (r) => h('li', { class: r.type }, h('time', {}, clock(r.at)), ' ', h('b', {}, r.who), ' ', r.text));
  const m = members.find((x) => x.id === S.route.member);
  if (m) drawMember(run, m);
  else { S.panel.controls = null; S.panel.member.replaceChildren(h('p', { class: 'muted' }, 'Pick a member to read its transcript and steer it.')); }
}

function drawMember(run, m) {
  const p = S.panel;
  if (p.controls?.id !== m.id) {
    p.controls = memberControls(m);
    p.facts = h('dl', { class: 'facts' });
    p.transcript = h('ol', { class: 'transcript' });
    p.member.replaceChildren(h('h2', {}, m.name), p.facts, p.controls.el, ...extras(m), h('h3', {}, 'Transcript'), p.transcript);
  }
  const deny = S.detail?.deny_paths;
  p.facts.replaceChildren(...[
    ['state', m.state], ['harness', m.agent ?? '—'], ['model', m.model ?? '—'], ['workspace', m.workspace ?? 'project folder'],
    ['read-only', m.read_only == null ? '—' : m.read_only ? 'yes' : 'no'], ['deny_paths', deny ? deny.join(', ') || 'none' : '—'],
    ['cost', money(m.cost_usd)], ['tokens', m.tokens ? String(m.tokens) : '—'], ['task', m.task],
    ['result', m.result ? `${m.result.status}: ${m.result.summary ?? ''}` : '—']
  ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  p.controls.update(run, m);
  const rows = [
    ...S.model.events.filter((e) => e.member_id === m.id).map((e) => ({ at: e.at, key: `e${e.id}`, e })),
    ...S.model.messages.filter((x) => x.to_member === m.id).map((x) => ({ at: x.at, key: `m${x.id}.${x.state}`, x }))
  ].sort((a, b) => a.at - b.at).slice(-400);
  keyed(p.transcript, rows, (r) => r.key, (r) => (r.e ? eventRow(r.e) : messageRow(r.x)));
}

function eventRow(e) {
  const text = h('span', { class: 'text' }, describe(e));
  const full = h('pre', { hidden: true });
  const li = h('li', { class: `ev ${e.kind}` }, h('time', {}, clock(e.at)), ' ', h('span', { class: 'kind' }, e.kind), ' ', text, full);
  if (e.kind === 'tool_call' || e.kind === 'tool_result' || e.kind === 'command') {
    li.classList.add('collapsed');
    li.addEventListener('click', async () => {
      if (full.hidden && !full.textContent) {
        const body = e.body?.clipped ? (await api(`/api/events/${e.id}`).catch(() => e)).body : e.body;
        full.textContent = JSON.stringify(body, null, 2);
      }
      full.hidden = !full.hidden;
    });
  }
  return li;
}

const messageRow = (x) => h('li', { class: 'msg' }, h('time', {}, clock(x.at)), ' ',
  h('b', {}, `${x.from_name} (${x.from_kind})`), ' ', x.text, ' ', h('span', { class: 'muted' }, x.state));

function memberControls(m) {
  const base = `/api/members/${m.id}`;
  const text = h('textarea', { rows: '2', placeholder: `Message ${m.name}`, 'aria-label': `Message ${m.name}` });
  const note = h('input', { type: 'text', placeholder: 'Note for resume (optional)', 'aria-label': 'Resume note' });
  const subtree = h('input', { type: 'checkbox' });
  const send = h('button', { type: 'submit' }, 'Send');
  const b = {
    pause: button('Pause', `${base}/pause`, () => ({ subtree: subtree.checked })),
    now: button('Pause now', `${base}/pause`, () => ({ now: true, subtree: subtree.checked })),
    resume: button('Resume', `${base}/resume`, () => ({ subtree: subtree.checked, note: note.value || null })),
    cancel: button('Cancel', `${base}/cancel`, () => ({ subtree: subtree.checked }), `Cancel ${m.name}? Its workspace is kept.`)
  };
  const form = h('form', { onsubmit: (e) => {
    e.preventDefault();
    if (text.value.trim()) act(`${base}/message`, { text: text.value }, 'sent').then((r) => { if (r) text.value = ''; });
  } }, text, send);
  const el = h('div', { class: 'controls' }, form,
    h('div', { class: 'buttons' }, b.pause, b.now, b.resume, b.cancel, h('label', {}, subtree, ' with its reports')), note,
    h('p', { class: 'muted' }, 'Take over in a terminal: ', h('code', {}, m.attach), ' ',
      h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(m.attach).then(() => flash('copied')) }, 'Copy')));
  return {
    id: m.id, el,
    update(run, cur) {
      const off = !run.steerable || TERMINAL.has(cur.state);
      for (const x of [text, send, b.cancel]) x.disabled = off;
      b.pause.disabled = b.now.disabled = off || cur.state === 'paused';
      b.resume.disabled = note.disabled = !run.steerable || cur.state !== 'paused';
    }
  };
}

// Sections later tasks add to the member panel (devices, designs).
function extras(m) {
  return [];
}

$('search').addEventListener('input', (e) => { S.query = e.target.value; schedule(); });
addEventListener('hashchange', open);
open();
```

- [ ] **Step 6: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/web.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 7: Check the page by hand**

Unit tests cannot run the DOM, so drive it once. In one terminal: `node bin/agent-team.js serve --port 0` and note the printed URL. In another, from a project with a live member configured, run `node bin/agent-team.js --member <member> --task "count the files in src"`. Open the URL and confirm: the run appears in the sidebar and under Activity; the run page shows the tree and conversation; the member panel's transcript fills live; "Pause now" then "Resume" work; the `attach` command copies. Note what you saw in the commit body if anything differed.

- [ ] **Step 8: Document the page**

In `docs/how-it-works.md` "Live runs", after Task 3's paragraph, add:

```markdown
The page's sidebar lists recent runs by project, with each running member's harness and state.
"Needs you" holds open `ask_human` questions, members reported stalled, and runs paused by the
cost cap, each answerable in place. Activity is the default view: each member's task with its
tool calls nested under it, identical consecutive calls collapsed into a count. A run's page
shows its org tree beside the conversation between members and humans; a member's panel shows
its transcript, workspace, `read_only` and `deny_paths`, a message box, and the controls. The
page holds the newest 2,000 events of what it shows; long tool output is cut to 4,000
characters per field, and clicking a call loads it whole.
```

- [ ] **Step 9: Commit**

```bash
git add src/web test/web.test.js docs/how-it-works.md
git commit -m "feat(web): runs, Needs you, activity and member panel in one static page"
```

---

### Task 5: `agent-team send` and `agent-team watch`

The spec's verb list is `watch`, `send`, `pause`, `resume`, `cancel`, `attach`, `answer`. 1b shipped the last five (plus `questions` and `handback`); this task adds the first two.

**Files:**
- Create: `src/watch.js`
- Modify: `bin/agent-team.js` (`USAGE`, `ADMIN.send`, the `watch` block)
- Create: `test/watch.test.js`
- Modify: `test/admin-cli.test.js`
- Modify: `docs/how-it-works.md` ("Live runs")

**Interfaces:**
- Consumes: `store.timeline`, `store.version`, `store.run`, `describe` from `src/web/feed.js` (pure, so node imports it), `Supervisor.send` by run and name (Task 3).
- Produces:
  - `agent-team send <run> <member> <text…>`: one admin RPC; prints `{ "message_id": n }`.
  - `agent-team watch <run> [--json]`: reads the store (no `serve` needed), prints the run's events and messages from the start, then follows until the run is no longer `running`, then exits `0` (`1` for an unknown run). `--json` prints one row object per line.
  - `src/watch.js`: `formatRow(row): string`; `watchRun({ store, runId, write, json = false, pollMs = 250, signal = null }): Promise<string>` (the run's final status).

- [ ] **Step 1: Write the failing tests**

Create `test/watch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { formatRow, watchRun } from '../src/watch.js';
import { project, supervise, LIVE } from './helpers/live.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

test('a row reads as time, member, kind and the event\'s line', () => {
  const at = new Date('2026-10-13T09:05:07').getTime();
  assert.equal(formatRow({ type: 'event', at, member: 'lead', kind: 'delegated', body: { to: 'worker' } }),
               '09:05:07  lead  delegated  delegated to worker');
  assert.equal(formatRow({ type: 'message', at, from_name: 'b', from_kind: 'human', to_name: 'lead', text: 'use\ntabs' }),
               '09:05:07  b → lead  message  use tabs');
});

test('watch prints what is there, follows new rows, and returns when the run ends', async () => {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 't', depth: 0 });
  store.setRunRoot(runId, lead.id);
  store.addEvent(lead.id, 'started', {});
  const lines = [];
  const done = watchRun({ store, runId, write: (s) => lines.push(s), pollMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  store.addEvent(lead.id, 'text', { text: 'halfway' });
  store.addEvent(lead.id, 'finished', { state: 'done', summary: 'ok' });
  store.finishRun(runId, 'done');
  assert.equal(await done, 'done');
  assert.deepEqual(lines.map((l) => l.split('  ').slice(2).join('  ').trim()),
                   ['started', 'text  halfway', 'finished  done: ok']);
  store.close();
});

test('watch --json follows a live run from another process and exits 0 when it ends', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'at-w-')), 's.db');
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'one' }, { sleep_ms: 300 }, { say: 'two' }] } }
  });
  const { sup } = await supervise(script, { store: openStore(path) });
  try {
    const { runId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    const r = await promisify(execFile)(process.execPath, [BIN, 'watch', String(runId), '--json'], {
      env: { ...process.env, AGENT_TEAM_SUPERVISOR_DB: path }, timeout: 20_000
    });
    const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.filter((x) => x.kind === 'text').map((x) => x.body.text), ['one', 'two']);
    assert.equal(rows.at(-1).kind, 'finished');
    const missing = await promisify(execFile)(process.execPath, [BIN, 'watch', '999'], {
      env: { ...process.env, AGENT_TEAM_SUPERVISOR_DB: path }
    }).catch((e) => e);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /unknown run 999/);
  } finally { await sup.close(); }
});
```

Append to `test/admin-cli.test.js`:

```js
test('send from the CLI puts a message in the member\'s inbox', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], on_resume: { steps: [] } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const sent = await cli(['send', String(runId), 'solo', 'use', 'tabs'], sup.socketPath);
    assert.equal(sent.code, 0, sent.stderr);
    const { message_id } = JSON.parse(sent.stdout);
    const msg = store.timeline({ memberId }).messages.find((m) => m.id === message_id);
    assert.deepEqual([msg.from_name, msg.text], [ME, 'use tabs']);
    const bad = await cli(['send', String(runId), 'solo'], sup.socketPath);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /usage: agent-team send <run> <member> <text>/);
    await sup.cancel({ run_id: runId, member: 'solo', subtree: true });
  } finally { await sup.close(); }
});
```

Run: `node --import ./test/helpers/guard.js --test test/watch.test.js test/admin-cli.test.js`
Expected: FAIL. `src/watch.js` is missing, and `send` prints the usage text with exit 2.

- [ ] **Step 2: Write `src/watch.js`**

```js
import { describe } from './web/feed.js';

const pad = (n) => String(n).padStart(2, '0');
const clock = (at) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function formatRow(row) {
  if (row.type === 'message') {
    return `${clock(row.at)}  ${row.from_name} → ${row.to_name}  message  ${oneLine(row.text)}`;
  }
  return `${clock(row.at)}  ${row.member}  ${row.kind}  ${oneLine(describe(row))}`.trimEnd();
}

// Follows one run in the store: every write lands there, whichever supervisor made it, so
// this needs no socket and works for in-process runs too.
export async function watchRun({ store, runId, write, json = false, pollMs = 250, signal = null }) {
  if (!store.run(runId)) throw new Error(`unknown run ${runId}`);
  let afterEvent = 0;
  let afterMessage = 0;
  let seen = null;
  for (;;) {
    const v = store.version();
    if (v !== seen) {
      seen = v;
      // Status first: rows written before it said "done" are read below, in this pass.
      const status = store.run(runId).status;
      for (;;) {
        const { events, messages } = store.timeline({ runId, afterEvent, afterMessage, limit: 500 });
        const rows = [...events.map((e) => ({ type: 'event', ...e })), ...messages.map((m) => ({ type: 'message', ...m }))]
          .sort((a, b) => a.at - b.at || a.id - b.id);
        for (const row of rows) write(json ? `${JSON.stringify(row)}\n` : `${formatRow(row)}\n`);
        afterEvent = events.at(-1)?.id ?? afterEvent;
        afterMessage = messages.at(-1)?.id ?? afterMessage;
        if (events.length < 500 && messages.length < 500) break;
      }
      if (status !== 'running') return status;
    }
    if (signal?.aborted) return store.run(runId).status;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
```

- [ ] **Step 3: Wire the verbs**

In `bin/agent-team.js`:

1. Imports: `import { watchRun } from '../src/watch.js';` and add `defaultStorePath` is already imported.
2. `USAGE`: after the `cancel` line add `'       agent-team send <run> <member> <text>\n'` and `'       agent-team watch <run> [--json]\n'`.
3. Add to `ADMIN`:

```js
  send: ([run, member, ...text]) => {
    if (!text.join(' ').trim()) throw new Error('usage: agent-team send <run> <member> <text>');
    return ['send', { ...memberArgs([run, member]), text: text.join(' '), from: whoAmI() }];
  },
```

4. Before `if (positionals[0] === 'attach')`, add:

```js
if (positionals[0] === 'watch') {
  const runId = Number(positionals[1]);
  if (!Number.isInteger(runId) || runId <= 0) {
    process.stderr.write('usage: agent-team watch <run> [--json]\n');
    process.exit(2);
  }
  const store = openStore(defaultStorePath());
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  try {
    const status = await watchRun({ store, runId, json: values.json, signal: stop.signal, write: (s) => process.stdout.write(s) });
    if (!values.json) process.stderr.write(`agent-team: run ${runId} ${status}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`agent-team: ${err.message}\n`);
    process.exit(1);
  } finally { store.close(); }
}
```

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/watch.test.js test/admin-cli.test.js test/cli.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 5: Document the verbs**

In `docs/how-it-works.md` "Live runs", in the list of steering verbs, add `agent-team send <run> <member> <text>` (one message into the member's inbox, needs `serve`) and:

```markdown
`agent-team watch <run> [--json]` prints a run's events and messages and follows it until it
ends. It reads the store, so it works with or without `serve`, including for a run a CLI
started in-process.
```

- [ ] **Step 6: Commit**

```bash
git add src/watch.js bin/agent-team.js test/watch.test.js test/admin-cli.test.js docs/how-it-works.md
git commit -m "feat(cli): send a member a message, and watch a run from the store"
```

---

### Task 6: `report` from the store

Live runs (everything since 1a) are in the store and never reach the JSONL run log, which only `dispatch()` writes, so `agent-team report` misses them. The spec's store "replaces the JSONL run log". The log stays readable because older runs live only there; nothing new writes to it from a supervised run.

**Files:**
- Modify: `src/report.js` (`storeRuns`, `allRuns`, the tokens column, `renderReport`)
- Modify: `bin/agent-team.js` (the `report` block)
- Modify: `test/report.test.js`
- Modify: `skills/report/SKILL.md` (one line: live runs included)

**Interfaces:**
- Consumes: `store.listRuns`, `store.members`, `store.memberSpan`, `defaultStorePath`.
- Produces:
  - `storeRuns(store, projectRoot): Run[]`: each `{ v: 2, id, at, project, task, tree }`, oldest first, only finished runs (`status !== 'running'`), `tree` in the run log's node shape: `{ member, team?, agent, model, advisor: null, status, summary, depth, elapsed_ms, usage: { cost_usd, tokens } | null, delegated }`.
  - `allRuns(projectRoot, { store = null }): Run[]`: log runs and store runs, ordered by `at`.
  - `renderReport(projectRoot, { all = false, store = null })`.
  - `renderRun` gains a `tokens` column, shown only when some node has `usage.tokens`; `renderTotals` likewise. Existing exact-string assertions for claude-only runs stay unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/report.test.js`:

```js
import { openStore } from '../src/store.js';
import { storeRuns, allRuns } from '../src/report.js';

function storeWithRun(project = '/p') {
  const store = openStore(':memory:');
  const runId = store.createRun({ project, task: 'fix the login bug' });
  const lead = store.addMember({ runId, parentId: null, name: 'lead', task: 'fix', depth: 0 });
  const worker = store.addMember({ runId, parentId: lead.id, name: 'worker', task: 'patch', depth: 1 });
  store.setRunRoot(runId, lead.id);
  store.setHarnessInfo(lead.id, { agent: 'claude', model: 'claude-opus-5-5', readOnly: true });
  store.setHarnessInfo(worker.id, { agent: 'codex', model: 'gpt-5.5', readOnly: false });
  store.addRunCost(runId, 0.5, lead.id);
  store.addTokens(runId, worker.id, 12_345);
  for (const m of [lead, worker]) store.addEvent(m.id, 'started', {});
  store.addEvent(worker.id, 'finished', { state: 'done' });
  store.addEvent(lead.id, 'finished', { state: 'done' });
  store.setResult(worker.id, { status: 'ok', summary: 'patched' });
  store.setResult(lead.id, { status: 'ok', summary: 'fixed' });
  for (const m of [lead, worker]) store.setState(m.id, 'done');
  store.finishRun(runId, 'done');
  return { store, runId };
}

test('a finished store run becomes a report tree with cost, tokens and nesting', () => {
  const { store } = storeWithRun();
  store.createRun({ project: '/p', task: 'still going' });   // running: left out
  const [run] = storeRuns(store, '/p');
  assert.equal(run.task, 'fix the login bug');
  assert.equal(run.tree.member, 'lead');
  assert.equal(run.tree.model, 'claude-opus-5-5');
  assert.equal(run.tree.usage.cost_usd, 0.5);
  assert.equal(run.tree.delegated[0].usage.tokens, 12_345);
  assert.equal(run.tree.delegated[0].status, 'ok');
  assert.ok(run.tree.elapsed_ms >= 0);
  assert.deepEqual(storeRuns(store, '/elsewhere'), []);
  const text = renderRun(run);
  assert.match(text, /tokens/);
  assert.match(text, /└ worker\s+gpt-5\.5\s+ok/);
  assert.match(text, /12345/);
  store.close();
});

test('the report merges the run log with the store, oldest first', () => {
  const project = mkdtempSync(join(tmpdir(), 'at-report-merge-'));
  const path = runLogPath(project);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...RUN, project, at: '2020-01-01T00:00:00.000Z' }) + '\n');
  const { store } = storeWithRun(project);
  const runs = allRuns(project, { store });
  assert.deepEqual(runs.map((r) => r.v), [1, 2]);
  assert.match(renderReport(project, { store }), /fix the login bug/);
  assert.match(renderReport(project, { store, all: true }), /2 delegation\(s\)/);
  store.close();
});
```

Run: `node --import ./test/helpers/guard.js --test test/report.test.js`
Expected: FAIL with "storeRuns is not exported".

- [ ] **Step 2: Build trees from the store**

In `src/report.js`, add:

```js
// A run in the store, as the run log's tree: one node per member, nested by parent.
function storeTree(store, runId) {
  const rows = store.members(runId);
  const nodes = new Map(rows.map((m) => {
    const span = store.memberSpan(m.id);
    const status = m.result?.status ?? (m.state === 'done' ? 'ok' : m.state);
    return [m.id, {
      member: m.name, ...(m.agent === 'team' ? { team: m.name } : {}),
      agent: m.agent ?? null, model: m.model ?? null, advisor: null,
      status, summary: m.result?.summary ?? null, depth: m.depth,
      elapsed_ms: span.started != null && span.finished != null ? span.finished - span.started : null,
      usage: m.cost_usd || m.tokens ? { cost_usd: m.cost_usd || null, tokens: m.tokens || null } : null,
      delegated: [], parent: m.parent_id
    }];
  }));
  let root = null;
  for (const n of nodes.values()) {
    const parent = n.parent == null ? null : nodes.get(n.parent);
    if (parent) parent.delegated.push(n); else root ??= n;
    delete n.parent;
  }
  return root;
}

export function storeRuns(store, projectRoot) {
  return store.listRuns({ project: resolve(projectRoot), limit: -1 })
    .filter((r) => r.status !== 'running')
    .reverse()
    .map((r) => ({ v: 2, id: r.id, at: new Date(r.created_at).toISOString(), project: r.project, task: r.task, tree: storeTree(store, r.id) }))
    .filter((r) => r.tree);
}

export function allRuns(projectRoot, { store = null } = {}) {
  return [...readRuns(projectRoot), ...(store ? storeRuns(store, projectRoot) : [])]
    .sort((a, b) => a.at.localeCompare(b.at));
}
```

Import `resolve` from `node:path`. `runs.created_at` is milliseconds since the epoch (`now()` in `src/store.js`). A run's `project` is stored resolved (`src/client.js:35`), so `resolve(projectRoot)` matches it.

In `renderRun` and `renderTotals`, add a `tokens` column after `cost` only when `flatten(...).some(([n]) => n.usage?.tokens)` (per run) or any node across runs has tokens (totals), using `formatCount`. Right-align it. Leave the column set unchanged otherwise, so the existing assertions hold.

Change `renderReport`:

```js
export function renderReport(projectRoot, { all = false, store = null } = {}) {
  const runs = allRuns(projectRoot, { store });
  if (runs.length === 0) {
    return `No delegations recorded for ${projectRoot} yet.`;
  }
  return all ? renderTotals(runs) : renderRun(runs[runs.length - 1]);
}
```

Update the existing test that asserts the empty-log message to the new text.

- [ ] **Step 3: Open the store in `report`**

In `bin/agent-team.js`'s `report` block, open the store only when its file exists, so `report` never creates one:

```js
    const dbPath = defaultStorePath();
    const store = existsSync(dbPath) ? openStore(dbPath) : null;
    try {
      const out = values.json
        ? JSON.stringify(values.all ? allRuns(values.project, { store }) : allRuns(values.project, { store }).slice(-1), null, 2)
        : renderReport(values.project, { all: values.all, store });
      process.stdout.write(out + '\n');
    } finally { store?.close(); }
```

Import `existsSync` from `node:fs` and `allRuns` from `../src/report.js`.

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/report.test.js test/cli.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/report.js bin/agent-team.js test/report.test.js skills/report/SKILL.md
git commit -m "feat(report): read live runs from the store beside the run log"
```

---

### Task 7: Loupe device views (opt-in)

The user asked on 2026-10-12 to see simulators and devices "via loupe" from the page. Loupe (`~/dev/loupe`) serves `https://localhost:18456`; every endpoint takes `?target=` (`sim:<udid>`, `avd:<name>`, an Android serial); `GET /api/targets` lists `[{ id, kind, label, active }]`; `GET /api/screenshot` returns one PNG; requests carry `Authorization: Bearer <token>`; its page reads `?target=` and redirects a `?token=` link away after setting a cookie. The token comes from `LOUPE_TOKEN`, else `~/Library/Caches/loupe/token`.

**Files:**
- Create: `src/loupe.js`
- Modify: `src/http.js` (four routes; `startHttp` reads the loupe config)
- Modify: `src/web/app.js` (`extras`: a Devices section)
- Create: `test/loupe.test.js`
- Modify: `docs/configuration.md` (a "Web view" section)

**Interfaces:**
- Consumes: `memberTexts` (Task 1), `sendBody`, `HttpError`.
- Produces:
  - `src/loupe.js`: `loupeConfig(env = process.env, { tokenFile }) → { base: URL, token(): string } | null` (throws for a non-loopback or non-http(s) URL); `loupeGet(cfg, path, query): Promise<{ status, type, body: Buffer }>`; `openUrl(cfg, target): string`; `mentionedTargets(texts, targets)`; `TARGET_RE`.
  - Routes: `GET /api/loupe` → `{ enabled, targets }`; `GET /api/members/:id/devices` → `{ enabled, targets }` (the loupe targets the member's events or messages name); `GET /api/loupe/screenshot?target=` → `image/png`; `GET /loupe/open?target=` → `302` to loupe's page.

- [ ] **Step 1: Write the failing tests**

Create `test/loupe.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { loupeConfig, mentionedTargets } from '../src/loupe.js';
import { get } from './helpers/http.js';

const TOKEN = 'loupe-secret-7f3a';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const TARGETS = [{ id: 'sim:ABCD-1234', kind: 'simulator', label: 'iPhone 17', active: true },
                 { id: 'emulator-5554', kind: 'android', label: 'Pixel', active: false }];

// A stand-in for loupe over plain http: it answers only with the right bearer token.
async function fakeLoupe() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('no'); }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/targets') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(TARGETS)); }
    if (url.pathname === '/api/screenshot' && url.searchParams.get('target') === 'sim:ABCD-1234') {
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG);
    }
    res.writeHead(404); res.end(`no target ${url.searchParams.get('target')}`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

async function setup(env) {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't' });
  const m = store.addMember({ runId, parentId: null, name: 'qa', task: 't', depth: 0 });
  store.addEvent(m.id, 'tool_call', { name: 'Bash', args: { command: 'curl "https://localhost:18456/api/screenshot?target=sim:ABCD-1234"' } });
  const web = await startHttp({ store, port: 0, env });
  return { store, web, m, close: async () => { await web.close(); store.close(); } };
}

test('loupe is off unless configured, and must be on this machine', () => {
  assert.equal(loupeConfig({}), null);
  assert.throws(() => loupeConfig({ AGENT_TEAM_LOUPE_URL: 'https://loupe.example.com' }), /must be on this machine/);
  assert.throws(() => loupeConfig({ AGENT_TEAM_LOUPE_URL: 'file:///tmp/x' }), /http or https/);
  const dir = mkdtempSync(join(tmpdir(), 'at-lt-'));
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`);
  const cfg = loupeConfig({ AGENT_TEAM_LOUPE_URL: 'https://localhost:18456' }, { tokenFile: join(dir, 'token') });
  assert.equal(cfg.token(), TOKEN);
  assert.equal(loupeConfig({ AGENT_TEAM_LOUPE_URL: 'https://localhost:18456', LOUPE_TOKEN: 'env' }).token(), 'env');
});

test('targets a member named are found in its events', () => {
  assert.deepEqual(mentionedTargets(['open sim:ABCD-1234 then', 'nothing'], TARGETS).map((t) => t.id), ['sim:ABCD-1234']);
});

test('screenshots, the target list and the open link go through serve with the token', async () => {
  const loupe = await fakeLoupe();
  const s = await setup({ AGENT_TEAM_LOUPE_URL: loupe.url, LOUPE_TOKEN: TOKEN });
  try {
    const list = await get(s.web.url, '/api/loupe');
    assert.deepEqual(list.json, { enabled: true, targets: TARGETS });
    const mine = await get(s.web.url, `/api/members/${s.m.id}/devices`);
    assert.deepEqual(mine.json.targets.map((t) => t.id), ['sim:ABCD-1234']);
    const shot = await get(s.web.url, '/api/loupe/screenshot?target=sim:ABCD-1234');
    assert.equal(shot.status, 200);
    assert.equal(shot.headers['content-type'], 'image/png');
    assert.deepEqual(shot.buf, PNG);
    const open = await get(s.web.url, '/loupe/open?target=sim:ABCD-1234');
    assert.equal(open.status, 302);
    const to = new URL(open.headers.location);
    assert.equal(to.origin, loupe.url);
    assert.deepEqual([to.searchParams.get('target'), to.searchParams.get('token')], ['sim:ABCD-1234', TOKEN]);
    assert.equal(open.headers['referrer-policy'], 'no-referrer');
    // The token is in that Location header and nowhere else.
    for (const r of [list, mine, shot]) assert.ok(!r.buf.includes(TOKEN) && !JSON.stringify(r.headers).includes(TOKEN));
  } finally { await s.close(); loupe.close(); }
});

test('loupe errors, bad targets and cross-site opens never echo the token', async () => {
  const loupe = await fakeLoupe();
  const s = await setup({ AGENT_TEAM_LOUPE_URL: loupe.url, LOUPE_TOKEN: TOKEN });
  try {
    const missing = await get(s.web.url, '/api/loupe/screenshot?target=sim:NOPE');
    assert.equal(missing.status, 502);
    assert.match(missing.json.error, /loupe answered 404/);
    assert.ok(!missing.text.includes(TOKEN));
    assert.equal((await get(s.web.url, '/api/loupe/screenshot?target=a%20b')).status, 400);
    assert.equal((await get(s.web.url, '/loupe/open?target=sim:ABCD-1234', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.ok(loupe.seen.every((u) => !u.includes(TOKEN)), 'the token travels in a header, not the URL');
  } finally { await s.close(); loupe.close(); }
});

test('with loupe unset the device routes say how to turn it on', async () => {
  const s = await setup({});
  try {
    assert.deepEqual((await get(s.web.url, '/api/loupe')).json, { enabled: false, targets: [] });
    const shot = await get(s.web.url, '/api/loupe/screenshot?target=sim:ABCD-1234');
    assert.equal(shot.status, 404);
    assert.match(shot.json.error, /AGENT_TEAM_LOUPE_URL/);
  } finally { await s.close(); }
});
```

Run: `node --import ./test/helpers/guard.js --test test/loupe.test.js`
Expected: FAIL with "Cannot find module '…/src/loupe.js'".

- [ ] **Step 2: Write `src/loupe.js`**

```js
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Loupe (a local device viewer) behind the web view. Opt-in: AGENT_TEAM_LOUPE_URL names it.
// Its token is read when a request needs it and is sent only to loupe, in a header.
export const TARGET_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loupeConfig(env = process.env, { tokenFile = join(homedir(), 'Library', 'Caches', 'loupe', 'token') } = {}) {
  const raw = env.AGENT_TEAM_LOUPE_URL;
  if (!raw) return null;
  let base;
  try { base = new URL(raw); } catch { throw new Error(`AGENT_TEAM_LOUPE_URL is not a URL: "${raw}"`); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('AGENT_TEAM_LOUPE_URL must be an http or https URL');
  if (!LOOPBACK.has(base.hostname)) {
    throw new Error('AGENT_TEAM_LOUPE_URL must be on this machine (localhost, 127.0.0.1 or [::1]): serve sends it the loupe token');
  }
  return {
    base,
    token: () => {
      if (env.LOUPE_TOKEN) return env.LOUPE_TOKEN;
      try { return readFileSync(tokenFile, 'utf8').trim(); } catch {
        throw new Error('no loupe token: set LOUPE_TOKEN or start loupe once to create its token file');
      }
    }
  };
}

// Loupe on localhost serves a self-signed certificate, so a loopback https URL is accepted
// without verifying it. loupeConfig has already refused anything not on this machine.
export function loupeGet(cfg, path, query = {}) {
  const url = new URL(path, cfg.base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const https = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (https ? httpsRequest : httpRequest)(url, {
      headers: { Authorization: `Bearer ${cfg.token()}` },
      ...(https ? { rejectUnauthorized: false } : {}),
      timeout: 10_000
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 32 * 1024 * 1024) req.destroy(new Error('loupe sent over 32 MiB')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('loupe did not answer within 10s')));
    req.on('error', (err) => reject(new Error(`loupe is not reachable at ${cfg.base.origin}: ${err.message}`)));
    req.end();
  });
}

// Loupe's own page: it reads ?target=, sets its cookie from ?token= and redirects the token
// out of the address bar.
export function openUrl(cfg, target) {
  const url = new URL('/', cfg.base);
  url.searchParams.set('target', target);
  url.searchParams.set('token', cfg.token());
  return url.toString();
}

export const mentionedTargets = (texts, targets) =>
  targets.filter((t) => texts.some((s) => s.includes(t.id)));
```

None of `loupeConfig`'s errors include the token; the `token()` error names where the token comes from, not its value.

- [ ] **Step 3: Add the routes**

In `src/http.js`, import `{ loupeConfig, loupeGet, openUrl, mentionedTargets, TARGET_RE }` from `./loupe.js` and `memberTexts` from `./view.js`. At the top of `startHttp`'s body, before the `Promise`, compute the config so a bad URL fails `serve` at start:

```js
  let loupe;
  try { loupe = loupeConfig(env); } catch (err) { return Promise.reject(err); }
```

Add helpers inside `startHttp`:

```js
  const needLoupe = () => { if (!loupe) throw new HttpError(404, 'loupe is off: set AGENT_TEAM_LOUPE_URL to its address'); return loupe; };
  const targetParam = (url) => {
    const t = url.searchParams.get('target') ?? '';
    if (!TARGET_RE.test(t)) throw new HttpError(400, 'target must be a loupe target id');
    return t;
  };
  async function loupeTargets() {
    const r = await loupeGet(needLoupe(), '/api/targets').catch((err) => { throw new HttpError(502, err.message); });
    if (r.status !== 200) throw new HttpError(502, `loupe answered ${r.status}`);
    return JSON.parse(r.body.toString('utf8')).map(({ id, kind, label, active }) => ({ id, kind, label, active }));
  }
```

Add to `routes`:

```js
    ['GET', /^\/api\/loupe$/, async () => (loupe ? { enabled: true, targets: await loupeTargets() } : { enabled: false, targets: [] })],
    ['GET', /^\/api\/members\/(\d+)\/devices$/, async ({ params }) => {
      member(params[0]);
      if (!loupe) return { enabled: false, targets: [] };
      return { enabled: true, targets: mentionedTargets(memberTexts(store, params[0]), await loupeTargets()) };
    }],
    ['GET', /^\/api\/loupe\/screenshot$/, async ({ url, res }) => {
      const target = targetParam(url);
      const r = await loupeGet(needLoupe(), '/api/screenshot', { target }).catch((err) => { throw new HttpError(502, err.message); });
      if (r.status !== 200 || !r.type.startsWith('image/png')) throw new HttpError(502, `loupe answered ${r.status}`);
      sendBody(res, 200, 'image/png', r.body);
    }],
    ['GET', /^\/loupe\/open$/, ({ req, url, res }) => {
      const site = req.headers['sec-fetch-site'];
      if (site != null && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'open loupe from this page');
      const to = openUrl(needLoupe(), targetParam(url));
      res.writeHead(302, { ...SECURITY_HEADERS, Location: to });
      res.end();
    }],
```

`SECURITY_HEADERS` already carries `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so the redirect is neither cached nor leaked onward. The error path in the request handler never prints `req.url` or a loupe response body.

- [ ] **Step 4: Show devices in the member panel**

In `src/web/app.js`, replace `extras`:

```js
function extras(m) {
  const section = h('section', { class: 'devices', hidden: true });
  api(`/api/members/${m.id}/devices`).then(({ enabled, targets }) => {
    if (!enabled) return;
    const pick = h('select', { 'aria-label': 'Loupe target' }, h('option', { value: '' }, 'Pick a device'));
    const shown = h('div');
    const show = (id) => {
      const img = h('img', { alt: `Screenshot of ${id}`, src: `/api/loupe/screenshot?target=${encodeURIComponent(id)}` });
      shown.replaceChildren(img, h('p', {},
        h('button', { type: 'button', onclick: () => { img.src = `/api/loupe/screenshot?target=${encodeURIComponent(id)}&t=${Date.now()}`; } }, 'Refresh'),
        ' ', h('a', { href: `/loupe/open?target=${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open live view in loupe')));
    };
    pick.addEventListener('change', () => pick.value && show(pick.value));
    section.append(h('h3', {}, 'Devices'), pick, shown);
    section.hidden = false;
    targets.forEach((t, i) => { if (i === 0) show(t.id); });
    api('/api/loupe').then(({ targets: all }) => all.forEach((t) => pick.append(h('option', { value: t.id }, `${t.label} (${t.id})`))), () => {});
  }, () => {});
  return [section];
}
```

The route ignores the `&t=` parameter; it only defeats the browser's image cache.

- [ ] **Step 5: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/loupe.test.js test/web.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 6: Document it**

Add to `docs/configuration.md`, after `## defaults`:

```markdown
## Web view

`agent-team serve` reads two optional environment variables for the web view.

- `AGENT_TEAM_LOUPE_URL`: the address of a loupe (a local device viewer) running on this machine, for
  example `https://localhost:18456`. A member's panel then shows screenshots of any loupe
  target the member named (`sim:<udid>`, `avd:<name>`, an Android serial), a picker for the
  rest, and a link that opens loupe's live view. `serve` reads loupe's token from
  `LOUPE_TOKEN` or `~/Library/Caches/loupe/token` when it needs it and sends it only to
  loupe. The URL must be `localhost`, `127.0.0.1` or `[::1]`; `serve` accepts loupe's
  self-signed certificate there.
```

- [ ] **Step 7: Commit**

```bash
git add src/loupe.js src/http.js src/web/app.js test/loupe.test.js docs/configuration.md
git commit -m "feat(web): loupe screenshots and live-view links for a member's devices"
```

---

### Task 8: Figma previews (opt-in, last)

The other half of the 2026-10-12 request. This task can be dropped without touching Tasks 1–7.

**Files:**
- Create: `src/figma.js`
- Modify: `src/config.js` (`defaults.figma_file_key`)
- Modify: `src/http.js` (two routes)
- Modify: `src/web/app.js` (`extras`: a Designs section)
- Create: `test/figma.test.js`
- Modify: `test/config.test.js`
- Modify: `docs/configuration.md` ("Web view", `defaults`)

**Interfaces:**
- Consumes: `memberTexts`, `runDetail`'s project, `loadConfig`, the `fetchImpl` option of `startHttp` (Task 1).
- Produces:
  - `src/figma.js`: `figmaRefs(texts, defaultFileKey = null): { file_key, node_id }[]` (at most 12, unique, newest mention first); `figmaImage({ token, fileKey, nodeId, fetchImpl, cache }): Promise<Buffer>`; `FILE_KEY_RE`, `NODE_RE`.
  - `defaults.figma_file_key`: a string or `null` (default).
  - Routes: `GET /api/members/:id/designs` → `{ enabled, refs }`; `GET /api/figma/image?file=&node=` → `image/png`.

- [ ] **Step 1: Write the failing tests**

Create `test/figma.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { figmaRefs } from '../src/figma.js';
import { get } from './helpers/http.js';

const TOKEN = 'figd_secret_91';
const HOST = 'www.figma.com';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);

test('refs come from Figma links and from bare node ids with a default file', () => {
  const texts = [`see https://${HOST}/design/AbCdEf123456/App?node-id=12-34&t=x`, 'then node 56:78', 'and node 56:78 again'];
  assert.deepEqual(figmaRefs([`https://${HOST}/design/AbCdEf123456/App?node-id=1-3345`]), [{ file_key: 'AbCdEf123456', node_id: '1:3345' }]);
  assert.deepEqual(figmaRefs(texts, 'Default12345'), [
    { file_key: 'Default12345', node_id: '56:78' },
    { file_key: 'AbCdEf123456', node_id: '12:34' }
  ]);
  assert.deepEqual(figmaRefs(['node 56:78']), []);   // no file to look it up in
});

// fetch stand-in: the images endpoint, then the rendered image's own URL.
function fakeFetch(calls) {
  return async (url, opts = {}) => {
    calls.push({ url: String(url), token: opts.headers?.['X-Figma-Token'] ?? null });
    const u = new URL(url);
    if (u.hostname === 'api.figma.com') {
      if (opts.headers?.['X-Figma-Token'] !== TOKEN) return new Response('{"err":"bad token"}', { status: 403 });
      const id = u.searchParams.get('ids');
      return Response.json({ err: null, images: { [id]: id === '12:34' ? 'https://images.example/render.png' : null } });
    }
    return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
  };
}

async function setup(env) {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't' });
  const m = store.addMember({ runId, parentId: null, name: 'designer', task: 't', depth: 0 });
  store.addEvent(m.id, 'text', { text: `matching https://${HOST}/design/AbCdEf123456/App?node-id=12-34` });
  const calls = [];
  const web = await startHttp({ store, port: 0, env, fetchImpl: fakeFetch(calls) });
  return { store, web, m, calls, close: async () => { await web.close(); store.close(); } };
}

test('a member\'s Figma node renders through serve, with the token sent only to Figma', async () => {
  const s = await setup({ FIGMA_TOKEN: TOKEN });
  try {
    const refs = await get(s.web.url, `/api/members/${s.m.id}/designs`);
    assert.deepEqual(refs.json, { enabled: true, refs: [{ file_key: 'AbCdEf123456', node_id: '12:34' }] });
    const img = await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=12:34');
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.deepEqual(img.buf, PNG);
    await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=12:34');
    assert.equal(s.calls.length, 2, 'the second request is served from the cache');
    assert.equal(s.calls[1].token, null, 'the rendered image URL never gets the token');
    const none = await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=99:1');
    assert.equal(none.status, 502);
    assert.ok(!none.text.includes(TOKEN) && !img.buf.includes(TOKEN) && !refs.text.includes(TOKEN));
    assert.equal((await get(s.web.url, '/api/figma/image?file=../x&node=1:2')).status, 400);
  } finally { await s.close(); }
});

test('with no FIGMA_TOKEN the routes say how to turn previews on', async () => {
  const s = await setup({});
  try {
    assert.equal((await get(s.web.url, `/api/members/${s.m.id}/designs`)).json.enabled, false);
    const img = await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=12:34');
    assert.equal(img.status, 404);
    assert.match(img.json.error, /FIGMA_TOKEN/);
    assert.equal(s.calls.length, 0);
  } finally { await s.close(); }
});
```

Append to `test/config.test.js` (it already imports `parseConfig` and defines the valid config `OK`):

```js
test('defaults.figma_file_key is a file key or null', () => {
  const base = OK;
  assert.equal(parseConfig(base, 'c.json').defaults.figma_file_key, null);
  assert.equal(parseConfig({ ...base, defaults: { figma_file_key: 'AbCdEf123456' } }, 'c.json').defaults.figma_file_key, 'AbCdEf123456');
  assert.throws(() => parseConfig({ ...base, defaults: { figma_file_key: 'a/b' } }, 'c.json'), /figma_file_key/);
});
```

Run: `node --import ./test/helpers/guard.js --test test/figma.test.js test/config.test.js`
Expected: FAIL with "Cannot find module '…/src/figma.js'".

- [ ] **Step 2: Write `src/figma.js`**

```js
// Previews of Figma nodes a member mentions, rendered by Figma's REST images endpoint.
// Opt-in: FIGMA_TOKEN. The token goes to api.figma.com in a header and nowhere else; the
// rendered image is fetched without it and served from this process, so the page's CSP can
// stay img-src 'self'.
export const FILE_KEY_RE = /^[A-Za-z0-9]{10,64}$/;
export const NODE_RE = /^\d+:\d+$/;
const LINK = /figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]{10,64})\/[^\s?#]*\?[^\s#]*?node-id=(\d+)(?:-|:|%3A)(\d+)/gi;
const BARE = /\bnode[ -](?:id[ :]+)?(\d+):(\d+)\b/gi;
const TTL_MS = 10 * 60_000;

export function figmaRefs(texts, defaultFileKey = null) {
  const out = [];
  const seen = new Set();
  const add = (file_key, node_id) => {
    const k = `${file_key}/${node_id}`;
    if (!seen.has(k) && out.length < 12) { seen.add(k); out.push({ file_key, node_id }); }
  };
  for (const text of [...texts].reverse()) {
    for (const [, key, a, b] of text.matchAll(LINK)) add(key, `${a}:${b}`);
    if (defaultFileKey) for (const [, a, b] of text.matchAll(BARE)) add(defaultFileKey, `${a}:${b}`);
  }
  return out;
}

export async function figmaImage({ token, fileKey, nodeId, fetchImpl = fetch, cache = new Map() }) {
  const k = `${fileKey}/${nodeId}`;
  const hit = cache.get(k);
  if (hit && hit.until > Date.now()) return hit.png;
  const api = new URL(`https://api.figma.com/v1/images/${fileKey}`);
  api.searchParams.set('ids', nodeId);
  api.searchParams.set('format', 'png');
  api.searchParams.set('scale', '1');
  const r = await fetchImpl(api, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Figma answered ${r.status}`);
  const src = (await r.json()).images?.[nodeId];
  if (!src) throw new Error(`Figma has no image for node ${nodeId} in file ${fileKey}`);
  const img = await fetchImpl(src, { signal: AbortSignal.timeout(15_000) });
  if (!img.ok) throw new Error(`the rendered image answered ${img.status}`);
  const png = Buffer.from(await img.arrayBuffer());
  cache.set(k, { png, until: Date.now() + TTL_MS });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return png;
}
```

- [ ] **Step 3: Add `defaults.figma_file_key`**

In `src/config.js`, add `figma_file_key: null,` to the `defaults` object before `...(raw.defaults ?? {})`, and after the `max_cost_usd` check:

```js
  if (defaults.figma_file_key !== null && (typeof defaults.figma_file_key !== 'string' ||
      !/^[A-Za-z0-9]{10,64}$/.test(defaults.figma_file_key))) {
    throw new Error(
      `${path}: "defaults.figma_file_key" must be a Figma file key (letters and digits), or null — got ` +
      `${JSON.stringify(defaults.figma_file_key)}`
    );
  }
```

- [ ] **Step 4: Add the routes**

In `src/http.js`, import `{ figmaRefs, figmaImage, FILE_KEY_RE, NODE_RE }` from `./figma.js` and `loadConfig` from `./config.js`. Inside `startHttp`:

```js
  const figmaCache = new Map();
  const figmaToken = () => {
    if (!env.FIGMA_TOKEN) throw new HttpError(404, 'Figma previews are off: set FIGMA_TOKEN before starting serve');
    return env.FIGMA_TOKEN;
  };
  const defaultFileKey = (runId) => {
    try { return loadConfig(store.run(runId).project).defaults.figma_file_key; } catch { return null; }
  };
```

Add to `routes`:

```js
    ['GET', /^\/api\/members\/(\d+)\/designs$/, ({ params }) => {
      const m = member(params[0]);
      if (!env.FIGMA_TOKEN) return { enabled: false, refs: [] };
      return { enabled: true, refs: figmaRefs(memberTexts(store, m.id), defaultFileKey(m.run_id)) };
    }],
    ['GET', /^\/api\/figma\/image$/, async ({ url, res }) => {
      const fileKey = url.searchParams.get('file') ?? '';
      const nodeId = url.searchParams.get('node') ?? '';
      if (!FILE_KEY_RE.test(fileKey) || !NODE_RE.test(nodeId)) throw new HttpError(400, 'file and node must be a Figma file key and a node id like 12:34');
      const png = await figmaImage({ token: figmaToken(), fileKey, nodeId, fetchImpl, cache: figmaCache })
        .catch((err) => { throw new HttpError(502, err.message); });
      sendBody(res, 200, 'image/png', png);
    }],
```

`figmaImage`'s errors name the status, node and file, never the token.

- [ ] **Step 5: Show designs in the member panel**

In `src/web/app.js`, rename the Task 7 `extras` body to a `devices(m)` function returning its section, and make `extras`:

```js
function extras(m) {
  return [devices(m), designs(m)];
}

function designs(m) {
  const section = h('section', { class: 'designs', hidden: true });
  api(`/api/members/${m.id}/designs`).then(({ enabled, refs }) => {
    if (!enabled || !refs.length) return;
    section.append(h('h3', {}, 'Designs'), ...refs.map((r) => h('figure', {},
      h('img', { loading: 'lazy', alt: `Figma node ${r.node_id}`,
                 src: `/api/figma/image?file=${encodeURIComponent(r.file_key)}&node=${encodeURIComponent(r.node_id)}` }),
      h('figcaption', { class: 'muted' }, `node ${r.node_id} · file ${r.file_key}`))));
    section.hidden = false;
  }, () => {});
  return section;
}
```

- [ ] **Step 6: Run the tests, then the suite**

Run: `node --import ./test/helpers/guard.js --test test/figma.test.js test/config.test.js test/web.test.js`
Expected: PASS.

Run: `npm test`
Expected: all pass, 0 fail.

- [ ] **Step 7: Document it**

In `docs/configuration.md` "Web view", add:

```markdown
- `FIGMA_TOKEN`: a Figma personal access token. A member's panel then shows a rendered
  preview of each Figma node the member mentioned, as a Figma link with `node-id`, or as
  `node 12:34` when the project sets `defaults.figma_file_key`. `serve` sends the token only
  to Figma's API and caches each image for ten minutes.
```

And in the `## defaults` table or list, add `figma_file_key` (default `null`): the Figma file that bare `node 12:34` mentions refer to, for previews in the web view.

- [ ] **Step 8: Commit**

```bash
git add src/figma.js src/config.js src/http.js src/web/app.js test/figma.test.js test/config.test.js docs/configuration.md
git commit -m "feat(web): opt-in Figma previews of the nodes a member mentions"
```

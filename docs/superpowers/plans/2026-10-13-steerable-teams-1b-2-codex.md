# Steerable teams 1b-2: codex sessions and codex take-over — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `codex` members as steerable v2 sessions over `codex app-server`, with the same pause, pause-now, resume, cancel, recovery, and take-over that `claude` members got in plan 1b.

**Architecture:** `adapters/codex` gains a `session` subcommand (protocol 2) beside its v1 `run`. The session owns one `codex app-server` per member and speaks JSON-RPC to it over stdio. The team MCP server is passed per thread in `thread/start` and `thread/resume`, so the member's token never reaches argv. Take-over stays the supervisor's existing pause-then-hand-out flow. What it hands out becomes generic: `[<adapter>, 'attach', <resume>]`. `adapters/codex attach` starts its own app-server on `ws://127.0.0.1:0` with a capability token. It runs `codex resume <thread> --remote …` against that server and kills the server when the human exits. With `--remote`, codex never starts its managed daemon, so no writer lock outlives the take-over.

**Tech Stack:** Node >= 22.13, ES modules, `node:sqlite`, `node:child_process`, `node --test`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-steerable-teams-design.md` (sections "Harness behaviour this design relies on" → Codex, "Adapter contract v2", "Humans can always intervene", "Errors and recovery" → Cost, "Testing"). This plan builds on plan 1b: `docs/superpowers/plans/2026-10-13-steerable-teams-1b-harnesses-and-intervention.md` (scope list "Plan 1b-2 scope" at its end).

**Probe evidence:** `codex-cli 0.162.1`, ChatGPT login, probed 2026-10-13. The raw traffic and generated JSON schema are in the controller's scratchpad, `codex-probe2/` (`schema/` holds `codex_app_server_protocol.schemas.json` and one file per type). The facts this plan relies on are copied into "Codex behaviour" below. Implementers use those facts and do not need the scratchpad.

**Size:** 5 tasks. Tasks 1–4 are proven with a fake `codex` only. Task 5 updates the docs and adds the gated live test, which the controller runs.

## Global Constraints

- Stdlib only: the plugin has no install step. `package.json` `engines.node` stays `>=22.13`.
- Tests run under `node --test`. No test may spawn the real `claude` or `codex` unless `AGENT_TEAM_LIVE_SMOKE=1` is set. `test/helpers/guard.js` puts sentinel binaries first on `PATH` **and sets `AGENT_TEAM_CODEX_BIN` to its sentinel**, so a fake-codex test must set `AGENT_TEAM_CODEX_BIN` to the fake, not only prepend `PATH`.
- Adapter output is untrusted: every line is shape-checked in `src/protocol.js` before use.
- Secrets never go in argv. The member's team token reaches codex only inside the `thread/start` and `thread/resume` JSON-RPC params. The take-over's ws token goes in a `0600` file (for the server) and an env var (for the TUI).
- The codex binary is `process.env.AGENT_TEAM_CODEX_BIN || 'codex'`, as `adapters/codex` already resolves it.
- Commit messages are conventional commits with no attribution trailers.

## Codex behaviour this plan relies on (probed, codex-cli 0.162.1)

JSON-RPC 2.0, one JSON object per line on the app-server's stdio. Requests carry `id`. Server-initiated requests carry both `id` and `method`, and need a reply `{jsonrpc:'2.0', id, result}`.

- **Handshake:** `initialize {clientInfo:{name, version}}`, then the notification `initialized`.
- **Thread:**
  - Start: `thread/start {cwd, model?, approvalPolicy:'never', sandbox, config, ephemeral:false}` → `result.thread.id`.
  - Resume, in a fresh app-server: `thread/resume {threadId, excludeTurns:true, cwd, approvalPolicy, sandbox, config}` restores the history.
  - **`config` must be sent again on resume.** Without it the team MCP server is not loaded: verified, the model answered "tool unavailable". With it, the server starts with the new env and tool calls reach it.
  - A non-git `cwd` works; no git check is involved.
- **Team MCP server, per thread:**
  ```js
  config: { mcp_servers: { 'agent-team': {
    command: process.execPath, args: [BIN, 'mcp'],
    env: { AGENT_TEAM_TEAM_SOCKET, AGENT_TEAM_TEAM_TOKEN },
    default_tools_approval_mode: 'approve',
    tool_timeout_sec: 7500 } } }
  ```
  - Without `default_tools_approval_mode: 'approve'`, every call under `approvalPolicy:'never'` fails with "MCP tool call requires approval, but approval policy is never".
  - The default tool timeout is 300 s, which is too short for `ask_human`'s 7200 s maximum. The probe verified 7200 against a 330 s call.
  - The user's own `~/.codex/config.toml` MCP servers load as well (`config` adds to them, it does not replace them).
- **Turns:**
  - `turn/start {threadId, input}` → `result.turn.id`. `input` is `[{type:'text', text, text_elements:[]}]`.
  - `turn/steer {threadId, input, expectedTurnId}` adds input to the running turn. It errors when no turn is running.
  - `turn/interrupt {threadId, turnId}` → `{}` at once. Then `turn/completed {threadId, turn:{id, status:'interrupted'}}` arrives.
- **Notifications** (filter all by `params.threadId`; the server also emits other threads' traffic):
  - `turn/started`.
  - `turn/completed {turn:{id, status:'completed'|'interrupted'|'failed', error?:{message}}}`. It carries no usage.
  - `item/started` and `item/completed {item}`. Item types are `agentMessage {text, phase?}`, `mcpToolCall {server, tool, arguments, status, result?, error?}`, `commandExecution {command, exitCode?}`, and others.
  - The final answer is the last `agentMessage` in the turn. When one has `phase:'final_answer'`, that one is it.
- **Usage:**
  - `thread/tokenUsage/updated {threadId, tokenUsage:{total:{totalTokens,…}, last:{…}}}` fires after each model request. `total` is cumulative for the thread.
  - After `thread/resume` it is re-emitted once with the restored total, and accumulates from there.
  - **No dollar figure exists anywhere.**
- **Server requests** (with `approvalPolicy:'never'` these should not occur; they are answered so a turn can never hang):
  - `mcpServer/elicitation/request {serverName}` → `{action:'accept', content:{}}` when `serverName === 'agent-team'`, otherwise `{action:'decline'}`.
  - `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` → `{decision:'decline'}`.
  - `execCommandApproval` and `applyPatchApproval` (legacy `ReviewDecision`) → `{decision:'denied'}`.
  - Anything else → a JSON-RPC error `{code:-32601, message:'not supported by agent-team'}`.
- **Process:** SIGTERM ends `codex app-server` in about 0.8 s. Shell commands it started die with it (the spec requires pause-now and cancel to end the process for this reason).
- **Take-over:**
  - Server: `codex app-server --listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-file <0600 file>`. It prints `listening on: ws://127.0.0.1:<port>` on **stderr**; stdout stays empty.
  - TUI: `codex resume <threadId> --remote ws://127.0.0.1:<port> --remote-auth-token-env <VAR>`, with the token in `<VAR>`. The human's turns land in the thread.
  - After `/quit`, no daemon is left. A later fresh app-server's `thread/resume` recalls the human's turns; this combination is proven only by Task 5's live test.

## Review Focus

- **A message that arrives while `turn/start` is in flight** (no turn id yet): it must be steered into that turn once the id is known, or started as the next turn. It must never be dropped or acked twice. Pinned in Task 2.
- **`turn/steer` losing the race with `turn/completed`:** the steer errors, and the message must run as the next `turn/start`, acked once. Pinned in Task 2.
- **The supervisor dies mid-turn:** the adapter's stdin closes, the turn is interrupted, and the app-server is killed within a few seconds, so no second writer outlives a recovering supervisor. Pinned in Task 2.
- **The human's attach exits by Ctrl-C or crash:** the attach-owned app-server is still killed, and `agent-team attach` still hands back. Pinned in Task 4.
- **Another thread's notifications on the same server:** never reported as this member's events or final answer. Pinned in Task 1.

## Design decisions this plan makes

- **One app-server per member, over stdio.** Per-thread `config` would let one server host many members, but one per member keeps the claude adapter's lifecycle unchanged: the process exits on stop and is killed on interrupt, and a crash affects one member. The ws transport is used only by take-over.
- **Take-over is generic, not codex-specific.**
  - Capabilities gain `takeover: {notice}`. The supervisor allows `takeover` for any member whose adapter declares it, and replaces the claude-only check.
  - The payload becomes `{member_id, name, cwd, argv: [<adapter path>, 'attach', <resume>], harness: <agent>, notice}`.
  - `adapters/claude attach <sid>` runs `claude --resume <sid>`. `adapters/codex attach <thread>` runs the ws server plus the remote TUI.
  - This replaces plan 1b's `hold`/`held`/`release` sketch, which kept the adapter alive during take-over. That would have needed a ws client and server in the adapter and tests, plus a new protocol state. The probe showed the TUI does not need the adapter's server.
- **Codex adds $0 to `max_cost_usd`.**
  - The spec's cap "sums the per-turn cost the harnesses report"; codex reports tokens only. `idle` gains an optional `tokens` (a non-negative integer, the turn's tokens), and `start` gains an optional `tokens`, the member's recorded total and the baseline on resume. These mirror `cost_usd`.
  - The store records `members.tokens` and `runs.tokens` (migration 4) so plan 1c's view can show codex usage.
  - No token cap is added. On a ChatGPT subscription the dollar cost is not knowable.
- **Unanswerable server requests are declined, not accepted.** A read-only member must never have a command approved on its behalf.

---

### Task 1: Fake codex and the codex session's basic turn

**Files:**
- Create: `test/fixtures/fake-codex`
- Create: `src/codex-session.js`
- Modify: `adapters/codex` (add `session` subcommand, `protocol: 2` in capabilities, extract `artifacts(cwd, logDir)`)
- Create: `test/codex-session.test.js`

**Interfaces:**
- Consumes: the v2 contract in `src/protocol.js`: in `start {brief, resume, note, cost_usd?}`, `message {id, from, text}`, `stop`, `interrupt`; out `session`, `event`, `ack`, `idle`, `result`. Mirror `src/claude-session.js` for structure: `runClaudeSession({artifacts})`, `finish`, `onExit`, orphan grace.
- Produces: `export function runCodexSession({ artifacts })` in `src/codex-session.js`, and `export const CODEX_TOOL_TIMEOUT_SEC = 7500`. `adapters/codex session` calls it. The fake codex fixture is used by Tasks 2–4.

- [ ] **Step 1: Write the fake codex.** `test/fixtures/fake-codex` is an executable node script (`#!/usr/bin/env node`). It logs every request it receives and its own argv, as JSON lines, to `$FAKE_CODEX_LOG` when that is set. Its behaviour:

```js
#!/usr/bin/env node
// Plays `codex` for tests: `--version`, `app-server` over stdio JSON-RPC, `app-server --listen
// ws://…` (take-over server; prints the listening line and waits), and `resume <id> --remote …`
// (the human's TUI; logs and exits). Wire shapes are the ones probed from codex-cli 0.162.1.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const LOG = process.env.FAKE_CODEX_LOG;
const log = (o) => { if (LOG) appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n'); };
const argv = process.argv.slice(2);
log({ argv, cwd: process.cwd() });

if (argv[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }

if (argv[0] === 'resume') {
  // The human's interactive session. Records which env var carried the token and its value.
  const envVar = argv[argv.indexOf('--remote-auth-token-env') + 1];
  log({ tui: true, thread: argv[1], remote: argv[argv.indexOf('--remote') + 1], token: process.env[envVar] ?? null });
  process.exit(Number(process.env.FAKE_CODEX_TUI_EXIT ?? 0));
}

if (argv[0] === 'app-server' && argv.includes('--listen')) {
  const file = argv[argv.indexOf('--ws-token-file') + 1];
  log({ listen: argv[argv.indexOf('--listen') + 1], token: readFileSync(file, 'utf8').trim() });
  if (process.env.FAKE_CODEX_NO_LISTEN !== '1') {
    process.stderr.write('codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:45454\n');
  }
  process.on('SIGTERM', () => { log({ serverExit: true }); process.exit(0); });
  setInterval(() => {}, 1 << 30);
} else if (argv[0] === 'app-server') {
  stdioServer();
} else {
  process.stderr.write(`fake-codex: unknown args ${argv.join(' ')}\n`);
  process.exit(2);
}

function stdioServer() {
  const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
  const notify = (method, params) => send({ method, params });
  let thread = null;
  let total = 0;
  let turn = null;          // { id, texts: [] }
  let turns = 0;
  let serverReq = 0;
  const waitingReply = new Map();
  const text = (input) => input.map((i) => i.text).join('\n');
  const complete = (status = 'completed') => {
    const t = turn; turn = null;
    if (status === 'completed') {
      const failed = t.texts.some((s) => s.includes('FAIL'));
      notify('item/completed', { threadId: thread, turnId: t.id,
        item: { type: 'agentMessage', id: `m-${t.id}`, text: `echo: ${t.texts.join(' | ')}`, phase: 'final_answer' } });
      total += 100;
      notify('thread/tokenUsage/updated', { threadId: thread, turnId: t.id, tokenUsage: { total: { totalTokens: total }, last: { totalTokens: 100 } } });
      notify('turn/completed', { threadId: thread, turn: failed
        ? { id: t.id, status: 'failed', error: { message: 'model refused' } }
        : { id: t.id, status: 'completed' } });
    } else {
      notify('turn/completed', { threadId: thread, turn: { id: t.id, status } });
    }
  };
  const begin = (input) => {
    turns++;
    turn = { id: `turn-${turns}`, texts: [text(input)] };
    notify('turn/started', { threadId: thread, turn: { id: turn.id, status: 'inProgress' } });
    // Another thread's traffic on the same server: the adapter must ignore it.
    notify('item/completed', { threadId: 'thr-other', item: { type: 'agentMessage', id: 'x', text: 'NOT YOURS', phase: 'final_answer' } });
    const s = turn.texts[0];
    if (s.includes('TOOL')) {
      notify('item/started', { threadId: thread, item: { type: 'mcpToolCall', id: 'c1', server: 'agent-team', tool: 'report_progress', arguments: { note: 'hi' }, status: 'inProgress' } });
      notify('item/completed', { threadId: thread, item: { type: 'mcpToolCall', id: 'c1', server: 'agent-team', tool: 'report_progress', arguments: { note: 'hi' }, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } } });
    }
    if (s.includes('ASK')) {
      // Server requests the adapter must answer before the turn can go on.
      for (const [method, params] of [
        ['mcpServer/elicitation/request', { threadId: thread, serverName: 'agent-team', mode: 'form', message: 'Allow?' }],
        ['mcpServer/elicitation/request', { threadId: thread, serverName: 'figma', mode: 'form', message: 'Allow?' }],
        ['item/commandExecution/requestApproval', { threadId: thread, itemId: 'c2', command: 'rm -rf /' }],
        ['execCommandApproval', { conversationId: thread, callId: 'c3', command: ['ls'] }],
        ['item/tool/requestUserInput', { threadId: thread }]
      ]) {
        const id = `srv-${++serverReq}`;
        waitingReply.set(id, method);
        send({ id, method, params });
      }
      return;   // the turn completes once every reply is in
    }
    if (!s.includes('HOLD')) setTimeout(() => complete(), 5);
  };

  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && !m.method) {          // a reply to one of our requests
      log({ reply: waitingReply.get(m.id), result: m.result ?? null, error: m.error ?? null });
      waitingReply.delete(m.id);
      if (turn && waitingReply.size === 0) complete();
      return;
    }
    log({ method: m.method, params: m.params });
    const ok = (result) => send({ id: m.id, result });
    const err = (message) => send({ id: m.id, error: { code: -32600, message } });
    switch (m.method) {
      case 'initialize': return ok({ userAgent: 'fake' });
      case 'initialized': return;
      case 'thread/start':
        thread = 'thr-1';
        return ok({ thread: { id: thread } });
      case 'thread/resume':
        thread = m.params.threadId;
        total = Number(process.env.FAKE_CODEX_RESUME_TOKENS ?? 1000);
        ok({ thread: { id: thread } });
        return notify('thread/tokenUsage/updated', { threadId: thread, tokenUsage: { total: { totalTokens: total }, last: { totalTokens: 0 } } });
      case 'turn/start':
        if (turn) return err('a turn is already running');
        begin(m.params.input);
        return ok({ turn: { id: turn?.id ?? `turn-${turns}`, status: 'inProgress' } });
      case 'turn/steer': {
        if (!turn || m.params.expectedTurnId !== turn.id) return err('no active turn to steer');
        const s = text(m.params.input);
        turn.texts.push(s);
        ok({ turnId: turn.id });
        if (s.includes('RELEASE')) setTimeout(() => complete(), 5);
        return;
      }
      case 'turn/interrupt':
        ok({});
        if (process.env.FAKE_CODEX_LINGER !== '1' && turn) setTimeout(() => complete('interrupted'), 5);
        return;
      default: return err(`unknown method ${m.method}`);
    }
  });
  // LINGER: ignores SIGTERM and stdin EOF, so only SIGKILL ends it (the orphan test).
  if (process.env.FAKE_CODEX_LINGER === '1') process.on('SIGTERM', () => log({ sigterm: true }));
  else process.stdin.on('end', () => process.exit(0));
}
```

Note: `turn/start` replies **after** `turn/started`, as the real server's response and notification can arrive in either order. The adapter must take the turn id from whichever comes first.

- [ ] **Step 2: Write the failing tests.** `test/codex-session.test.js` mirrors `test/claude-session.test.js`'s `session(env)` harness: spawn `adapters/codex session`, collect lines, `next(type)`, `send`, `exit`. Pass `AGENT_TEAM_CODEX_BIN: <fake-codex path>` and `FAKE_CODEX_LOG`, plus `AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock'` and `AGENT_TEAM_TEAM_TOKEN: 'tok-1'`. A helper `requests(log, method)` returns the logged params for one method. Tests:

```js
test('a fresh session starts a thread with the team tools and reports the first turn', async () => {
  const s = session();
  const cwd = mkdtempSync(join(tmpdir(), 'at-cx-'));
  s.send({ type: 'start', brief: { task: 'Say hi', cwd, read_only: true, model: 'gpt-5.5' }, resume: null, note: null });
  assert.deepEqual(await s.next('session'), { type: 'session', harness_id: 'thr-1', resume: 'thr-1' });
  const ev = await s.next('event');
  assert.deepEqual(ev, { type: 'event', kind: 'text', text: 'echo: Say hi' });
  assert.deepEqual(await s.next('idle'), { type: 'idle', tokens: 100 });
  const [start] = s.requests('thread/start');
  assert.equal(start.cwd, cwd);
  assert.equal(start.model, 'gpt-5.5');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.sandbox, 'read-only');
  assert.deepEqual(start.config.mcp_servers['agent-team'], {
    command: process.execPath, args: [BIN, 'mcp'],
    env: { AGENT_TEAM_TEAM_SOCKET: '/tmp/team.sock', AGENT_TEAM_TEAM_TOKEN: 'tok-1' },
    default_tools_approval_mode: 'approve', tool_timeout_sec: 7500
  });
  // The token is never in any codex argv.
  assert.ok(s.argvs().every((a) => !a.join(' ').includes('tok-1')));
  s.send({ type: 'stop' });
  const result = await s.next('result');
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, 'echo: Say hi');
  assert.deepEqual(result.usage, { tokens: 100, session_id: 'thr-1', turns: 1 });
  assert.equal(await s.exit, 0);
});

test('a writable member runs in the workspace-write sandbox', /* sandbox === 'workspace-write' when read_only is false */);

test('tool calls become events, and other threads on the server are ignored', async () => {
  // task 'Use TOOL' → events in order: tool_call {name:'agent-team.report_progress', args:{note:'hi'}},
  // tool_result {name:'agent-team.report_progress', is_error:false, text:'ok'}, text 'echo: Use TOOL'.
  // No event or summary ever contains 'NOT YOURS'.
});

test('server requests are answered so the turn can finish', async () => {
  // task 'ASK'. After idle, the fake's log shows these replies:
  //   elicitation agent-team → {action:'accept', content:{}}; elicitation figma → {action:'decline'};
  //   item/commandExecution/requestApproval → {decision:'decline'}; execCommandApproval → {decision:'denied'};
  //   item/tool/requestUserInput → error code -32601.
});

test('a failed turn makes a failed result', /* task 'FAIL now' → idle, then stop → result failed with summary containing 'model refused' */);

test('a start in a missing cwd fails without starting codex', /* result failed 'cwd does not exist: …'; the fake log has no app-server argv */);

test('capabilities declare protocol 2', /* `adapters/codex capabilities` JSON includes protocol: 2 and keeps write/workspace/structured_output/tool_dialect */);
```

Write each stub's body in full, in the style of the first test.

- [ ] **Step 3: Run the tests to verify they fail.** Run `node --test --import ./test/helpers/guard.js test/codex-session.test.js`. Expected: FAIL, because `adapters/codex session` is not a known subcommand.

- [ ] **Step 4: Implement `src/codex-session.js`.** It follows `src/claude-session.js` closely. Required behaviour for this task:
  - On `start`, check `existsSync(brief.cwd)`. Then spawn `BIN app-server` with `cwd: brief.cwd` and `stdio: ['pipe','pipe','pipe']`, and keep the last 2000 chars of stderr. Send `initialize {clientInfo:{name:'agent-team', version: <package.json version>}}` and `initialized`, then `thread/start` with the params from the Codex behaviour section:
    - `sandbox` is `brief.read_only ? 'read-only' : 'workspace-write'`.
    - Pass `model` only if `brief.model` is set.
    - If `brief.effort` is set, add `model_reasoning_effort` to `config`.
  - Emit `session {harness_id: threadId, resume: threadId}` once, from `result.thread.id`. Then `turn/start` with `brief.task`.
  - A small JSON-RPC client: request ids, a `pending` map of `id → {resolve}`, and replies to server requests per the Codex behaviour section. Ignore every notification whose `params.threadId` is set and is not this thread. Write every line received to the session log.
  - `item/completed` handling:
    - `agentMessage` → `event {kind:'text', text}`, and remember it as the turn's last text. A `phase:'final_answer'` message wins over later non-final ones.
    - `mcpToolCall` on `item/started` → `event {kind:'tool_call', name:`${server}.${tool}`, args: arguments ?? {}}`.
    - `mcpToolCall` on `item/completed` → `event {kind:'tool_result', name, is_error: status !== 'completed', text}`. `text` is the result's text blocks joined, or `error.message`, cut to 2000 chars.
    - `commandExecution` on `item/completed` → `event {kind:'command', command, exit_code: exitCode ?? null}`.
    - Any other item type → `event {kind: item.type}`.

    Every event resets the supervisor's stall clock, so these are not optional.
  - `thread/tokenUsage/updated` for this thread → `total = tokenUsage.total.totalTokens`.
  - `turn/completed` for this thread:
    - Set `inTurn = false`, `turns++`, `delta = max(0, total - baseline)`, `baseline = total`.
    - Remember the turn's final text as `lastText`.
    - `lastError = status === 'failed'`. A failed turn's `error.message` is added to `lastText` as `codex turn failed: <message>`.
    - Emit `idle {…(interrupted), …(delta > 0 ? {tokens: delta} : {})}`.
  - `stop`: if no turn is running, end the server now (SIGTERM). Otherwise set `stopping` and end it after `turn/completed`.
  - On server exit, emit the result like `onClaudeExit`. If it exited without being asked to stop, the result is `failed` with "codex app-server exited (…) before it was asked to stop: <stderr>". The result carries `usage: {tokens: total - startBaseline… }`; use `tokens: <sum of reported deltas>` so it equals what the idles reported. It also carries `session_id: threadId`, `turns`, `permission_denials: []`, `findings: []`, `checked_sound: []`, `artifacts: artifacts(brief.cwd, logDir)`, and `log_path`.
  - SIGTERM to the adapter kills the server and exits 143, as claude-session does.

  In `adapters/codex`:
  - Extract the `run` branch's diff block into `function artifacts(cwd, logDir)` returning exactly what `run` puts in its result's `artifacts` today, and have `run` call it. Its existing tests must stay green.
  - Add `else if (sub === 'session') runCodexSession({ artifacts });`.
  - Add `protocol: 2` to capabilities.

- [ ] **Step 5: Run the tests to verify they pass.** Run `node --test --import ./test/helpers/guard.js test/codex-session.test.js`, then the full `npm test`. Expected: all green. Existing codex `run` and conformance tests are unchanged.

- [ ] **Step 6: Commit.**

```bash
git add test/fixtures/fake-codex src/codex-session.js adapters/codex test/codex-session.test.js
git commit -m "feat(codex): run a member as a long-lived codex app-server session"
```

---

### Task 2: Steering, interrupt, resume, and orphan cleanup for codex sessions

**Files:**
- Modify: `src/codex-session.js`
- Modify: `test/codex-session.test.js`

**Interfaces:**
- Consumes: Task 1's session and fake codex. `start {resume, note, tokens?}`. `tokens` is new in this plan; Task 3 adds it to the protocol checks and to the supervisor.
- Produces: the full v2 behaviour for codex members, which Task 3 relies on.

- [ ] **Step 1: Write the failing tests** (in full, in the Task 1 style):

```js
test('a message between turns starts a turn and is acked', async () => {
  // start 'Say hi' → idle; send {type:'message', id: 7, from: 'lead', text: 'next'}
  // → ack {message_id: 7}; event text 'echo: [from: lead] next'; idle {tokens: 100}.
  // The fake's log shows turn/start input text '[from: lead] next'.
});

test('a message mid-turn is steered into the running turn', async () => {
  // start 'HOLD please' (the fake keeps the turn open); after the session line, send
  // message id 8 'RELEASE now' → ack 8; the fake logs turn/steer with expectedTurnId 'turn-1';
  // then event text 'echo: HOLD please | [from: lead] RELEASE now' and one idle.
});

test('a message sent before the turn id is known is steered once the id arrives', async () => {
  // Send start and message id 9 'RELEASE' in the same write, so the message lands before
  // turn/start's reply. Expect exactly one ack for 9, one turn/start, one turn/steer to turn-1.
});

test('a steer that loses the race with the end of the turn runs as the next turn', async () => {
  // FAKE_CODEX_STEER_FAIL=1 (fake rejects every turn/steer) and FAKE_CODEX_HOLD_MS=50 (a HOLD
  // turn completes by itself after 50 ms). start 'HOLD'; after the session line send message
  // id 10 'more'. No ack for 10 before the first idle. After turn/completed the fake logs a
  // second turn/start whose text is '[from: lead] more'; ack {message_id: 10} arrives exactly
  // once; a second idle follows.
});

test('interrupt mid-turn reports an interrupted idle and ends the app-server', async () => {
  // start 'HOLD'; interrupt → fake logs turn/interrupt {threadId:'thr-1', turnId:'turn-1'};
  // idle {interrupted: true}; adapter exits 0 with no result line; the fake's pid is gone.
});

test('interrupt between turns reports an interrupted idle at once', /* … */);

test('resume restores the thread with the team tools and sends the note', async () => {
  // start {resume:'thr-9', note:'Resumed by bmc.', tokens: 1000}, FAKE_CODEX_RESUME_TOKENS=1000
  // → fake logs thread/resume {threadId:'thr-9', excludeTurns:true, config.mcp_servers['agent-team']
  // as in Task 1}; no thread/start; session {harness_id:'thr-9', resume:'thr-9'};
  // turn/start input 'Resumed by bmc.'; idle {tokens: 100} — not 1100.
});

test('resume with no note continues where it left off', /* turn/start text 'Continue where you left off.' */);

test('resume with no recorded tokens counts the restored total once', /* tokens absent → idle {tokens: 1100} */);

test('closing stdin mid-turn interrupts the turn and kills a lingering app-server', async () => {
  // FAKE_CODEX_LINGER=1 (ignores SIGTERM and EOF); start 'HOLD'; close stdin.
  // The fake logs turn/interrupt, then {sigterm:true}; within 6 s its pid no longer exists
  // (process.kill(pid, 0) throws ESRCH).
});
```

Add both switches to the fixture in this task: `FAKE_CODEX_STEER_FAIL=1` makes `turn/steer` always return an error, and `FAKE_CODEX_HOLD_MS=<n>` makes a `HOLD` turn complete by itself after n ms.

- [ ] **Step 2: Run the tests to verify they fail.** Run `node --test --import ./test/helpers/guard.js test/codex-session.test.js`. Expected: FAIL. The new tests fail and the Task 1 tests still pass.

- [ ] **Step 3: Implement.**
  - **Message queue.** Keep `queue` (messages not yet sent), `turnId` (null until known from `turn/start`'s reply or `turn/started`, whichever comes first), and `inTurn`.
    - On `message`: if `inTurn && turnId`, send `turn/steer`. On a success reply, emit `ack`. On an error reply, put the message back at the head of `queue`.
    - If `inTurn && !turnId`, push it to `queue`; it is flushed as steers when `turnId` becomes known.
    - If not in a turn, send `turn/start` with it, set `inTurn`, and emit `ack` on the success reply.
    - On `turn/completed` (not interrupted, not stopping): if `queue` is non-empty, start the next turn with the head of the queue, acked on success. The rest steer into that turn.
    - Text is `[from: ${from}] ${text}`, as in claude-session.
  - **Interrupt.**
    - In a turn: send `turn/interrupt {threadId, turnId}` (once `turnId` is known). On `turn/completed` with `interrupted`, emit `idle {interrupted:true, …tokens}`, then end the server; the adapter exits 0 with no result.
    - Not in a turn: emit `idle {interrupted:true}` and end the server.
    - "End the server" means SIGTERM, then SIGKILL after 2000 ms if it is still alive.
  - **Resume.** When `start.resume` is set, send `thread/resume {threadId: resume, excludeTurns:true, cwd, approvalPolicy:'never', sandbox, config}` instead of `thread/start`.
    - The first turn's text is `note ?? 'Continue where you left off.'`.
    - `baseline = Number.isInteger(start.tokens) && start.tokens > 0 ? start.tokens : 0`.
    - The restored `thread/tokenUsage/updated` only moves `total`, so the first idle reports `total - baseline`.
  - **Stdin close.** Mirror claude-session's `close` handler:
    - In a turn and not interrupting or stopping: `turn/interrupt`.
    - Otherwise, if not stopping: end the server.
    - Either way, SIGTERM after 2000 ms and SIGKILL after 4000 ms, both `unref()`'d.

- [ ] **Step 4: Run the tests to verify they pass.** Run the file 5 times in parallel, then `npm test`:

```bash
for i in 1 2 3 4 5; do node --test --import ./test/helpers/guard.js test/codex-session.test.js > /tmp/cx-$i.log 2>&1 & done; wait; grep -h "^ℹ fail" /tmp/cx-*.log
```

Expected: `ℹ fail 0` five times.

- [ ] **Step 5: Commit.**

```bash
git add src/codex-session.js test/codex-session.test.js test/fixtures/fake-codex
git commit -m "feat(codex): steer, interrupt and resume codex sessions"
```

---

### Task 3: Token usage in the protocol, store, and supervisor; codex members end to end

**Files:**
- Modify: `src/protocol.js`, `src/store.js` (migration 4), `src/supervisor.js`
- Modify: `test/store.test.js`, `test/protocol.test.js` (or wherever `parseAdapterLine` is tested; find it with `grep -rln parseAdapterLine test`)
- Create: `test/codex-supervisor.test.js`

**Interfaces:**
- Consumes: `idle.tokens` and `start.tokens` from Tasks 1 and 2. The supervisor's `#spend(runId, memberId, cost)` at `src/supervisor.js` around line 720, and the start payload around line 691 (`...(resume && m.resume ? { cost_usd: m.cost_usd } : {})`).
- Produces:
  - `store.member(id).tokens` and `store.run(id).tokens`, both integers defaulting to 0.
  - `start` carries `tokens: m.tokens` on resume.
  - Plan 1c reads these columns.

- [ ] **Step 1: Write the failing tests.**
  - Protocol: `idle {tokens: 5}` is accepted. `idle {tokens: -1}`, `{tokens: 1.5}`, and `{tokens: '5'}` are dropped (`parseAdapterLine` returns null).
  - Store: migrating a store at `user_version` 3 adds `members.tokens` and `runs.tokens` at 0, and reopening changes nothing. Follow the existing migration test for version 3.
  - Supervisor, in `test/codex-supervisor.test.js`, using `project({ solo: { agent: 'codex', isolation: 'none' } }, {})` and `supervise(script, { env: { AGENT_TEAM_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log } })`:
    1. A codex member runs its task. A `send` while it is in a `HOLD` turn is steered into the turn. The run's member and the run each record the tokens the idles reported: 200 after two turns. `run.cost_usd` stays 0.
    2. `pause` (plain) after the first turn, then `resume`: the relaunched session sends `thread/resume` for `thr-1` with `tokens` equal to the member's recorded tokens. The resumed turn adds only its own 100.
    3. A pause-now (`pause {now: true}`) during a `HOLD` turn ends the member `paused`. The fake's app-server pid is gone.
    4. `cancel` during a `HOLD` turn ends the member `cancelled` and its app-server is gone.

- [ ] **Step 2: Run the tests to verify they fail.**

- [ ] **Step 3: Implement.**
  - `protocol.js`: `idle` also checks `tokens` is `undefined`, `null`, or a non-negative integer.
  - `store.js`: migration 4 is `ALTER TABLE members ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0; ALTER TABLE runs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;`, plus `addTokens(runId, memberId, n)` beside the cost method.
  - Supervisor: on `idle`, `if (msg.tokens) this.store.addTokens(...)`. Tokens never touch the cost cap. On resume, `start` carries `tokens: m.tokens` next to `cost_usd`.

- [ ] **Step 4: Run the tests to verify they pass.** Run the new and changed files, then `npm test`. Then run `test/codex-supervisor.test.js` 5 times in parallel; expected `fail 0` each time.

- [ ] **Step 5: Commit.**

```bash
git add src/protocol.js src/store.js src/supervisor.js test/
git commit -m "feat(supervisor): record codex members' token usage and resume them from it"
```

---

### Task 4: Generic take-over, and `codex` attach over a private remote app-server

**Files:**
- Modify: `src/supervisor.js` (`takeover`, `#takeoverPayload`)
- Modify: `src/admin.js` (`attach`)
- Modify: `adapters/claude` (`attach` subcommand, `takeover` capability)
- Modify: `adapters/codex` (`attach` subcommand, `takeover` capability)
- Create: `src/codex-attach.js`
- Modify: `test/takeover.test.js`
- Create: `test/codex-attach.test.js`

**Interfaces:**
- Consumes: `r.caps` (the adapter's capabilities, cached on resolution) and `r.resolved.agent` in `takeover`. The adapter path comes from the same `adapterDir` the supervisor passes to dispatch; check how `#resolve` builds it, and reuse that rather than joining paths again.
- Produces:
  - Capability `takeover: { notice: string | null }`. In `notice`, `{cwd}` is replaced with the member's workspace.
  - Payload `{ member_id, name, cwd, argv: [adapterPath, 'attach', resume], harness, notice }`.
  - `adapters/<agent> attach <resume>` runs the human's session in the current directory with inherited stdio and exits with its code.

- [ ] **Step 1: Write the failing tests.**
  - `test/takeover.test.js`:
    - Keep the claude test. Its stderr regex changes to `/solo is paused and yours\. claude may first ask whether to trust /`; that line is unchanged, because the claude notice is `'claude may first ask whether to trust {cwd}.'`.
    - `human.argv` is still `['--resume', sid]`, because `adapters/claude attach` runs `claude --resume <sid>`.
    - The "only claude members" test becomes: `"solo" runs mock-live, which does not support take-over`.
  - `test/codex-attach.test.js`:
    1. **Supervisor and CLI end to end, with the fake.** A codex member in a `HOLD` turn is taken over with `agent-team attach <run> solo`. The fake's log then shows, in order:
       - an `app-server --listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-file <f>` server;
       - a TUI `resume thr-1 --remote ws://127.0.0.1:45454 --remote-auth-token-env AGENT_TEAM_CODEX_REMOTE_TOKEN` whose `token` equals the server's token file content (which is 64 hex chars);
       - `serverExit: true` after the TUI exits;
       - the handed-back member's new session sending `thread/resume` for `thr-1`.

       The member ends `ok`. The token file no longer exists after attach (`existsSync` false).
    2. **The TUI exits non-zero** (`FAKE_CODEX_TUI_EXIT=1`): the server is still killed, and the CLI still hands back.
    3. **The server never prints its listening line** (`FAKE_CODEX_NO_LISTEN=1`): `adapters/codex attach thr-1` exits non-zero within 15 s, printing `codex app-server did not start listening`. The server is killed and no TUI is started. The CLI then hands back with `drove: false`, so the member resumes without the "a human drove this session" line.
    4. `adapters/codex capabilities` includes `takeover: { notice: null }`. `adapters/claude capabilities` includes `takeover: { notice: 'claude may first ask whether to trust {cwd}.' }`.

- [ ] **Step 2: Run the tests to verify they fail.**

- [ ] **Step 3: Implement.**
  - **Supervisor `takeover`.**
    - Replace the `agent !== 'claude'` check with `if (r.team || !r.caps?.takeover) throw new Error(`"${m.name}" runs ${…}, which does not support take-over`)`.
    - The "no claude session yet" messages become "no harness session yet". Keep the rest of the wording, since `attach` matches `has already finished (<state>)`.
    - `#takeoverPayload(m, r)` returns the payload above. `notice` is `r.caps.takeover.notice?.replaceAll('{cwd}', m.workspace) ?? null`.
    - For an already-`taken_over` member, `#resolve` it again to build the payload. Resolution is cached.
  - **`admin.attach`.** It logs `agent-team: ${t.name} is paused and yours.${t.notice ? ' ' + t.notice : ''}\nagent-team: exit ${t.harness} to hand the session back.\n`, then runs `t.argv` as today (`cwd: t.cwd`, inherited stdio, SIGINT ignored). `drove` is `!r.error && r.status !== 3`; exit code 3 means "the harness never started".
  - **`adapters/claude attach <sid>`.** Run `spawnSync('claude', ['--resume', sid], { stdio: 'inherit' })`, using the same binary resolution as the adapter's `session`. Exit with its status, or 3 if it could not be started.
  - **`src/codex-attach.js`, `export async function codexAttach(threadId)`.** `adapters/codex attach <thread>` calls it.
    1. Make a 0700 temp dir, and write a 0600 `token` file holding `randomBytes(32).toString('hex')`.
    2. Spawn `BIN app-server --listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-file <file>` with stdio `['ignore','ignore','pipe']`, and read stderr until `/listening on: (ws:\/\/\S+)/`. If that line has not appeared after 10 s, or the server exits first, print `agent-team: codex app-server did not start listening: <stderr tail>` and go to cleanup with exit code 3.
    3. Ignore SIGINT. Run `spawn(BIN, ['resume', threadId, '--remote', url, '--remote-auth-token-env', 'AGENT_TEAM_CODEX_REMOTE_TOKEN'], { stdio: 'inherit', env: { ...process.env, AGENT_TEAM_CODEX_REMOTE_TOKEN: token } })` and await its exit.
    4. Cleanup runs in a `finally`, and again on SIGTERM or SIGHUP of the attach process. It SIGTERMs the server, SIGKILLs it after 2 s if it is still alive, and removes the temp dir.
    5. Exit with the TUI's code, or 3 if the TUI or the server never started.
  - Capabilities: claude `takeover: { notice: 'claude may first ask whether to trust {cwd}.' }`; codex `takeover: { notice: null }`.

- [ ] **Step 4: Run the tests to verify they pass.** Run the takeover and codex-attach files, then `npm test`.

- [ ] **Step 5: Commit.**

```bash
git add src/supervisor.js src/admin.js src/codex-attach.js adapters/claude adapters/codex test/takeover.test.js test/codex-attach.test.js
git commit -m "feat(attach): take over codex members through a private remote app-server"
```

---

### Task 5: Docs, spec, and the live codex test

**Files:**
- Modify: `docs/adapters.md`, `docs/how-it-works.md`, `docs/superpowers/specs/2026-10-12-steerable-teams-design.md`
- Create: `test/live/codex.test.js`
- Modify: `package.json` (`test:live` must include `test/live/codex.test.js` if it lists files)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further.

- [ ] **Step 1: Docs.**
  - `docs/adapters.md`:
    - The codex session: app-server over stdio, per-thread team tools with `default_tools_approval_mode` and `tool_timeout_sec`, steer and start, interrupt kills the process, resume re-sends the config.
    - `idle.tokens` and `start.tokens`.
    - The `takeover` capability and the `attach` subcommand contract.
  - `docs/how-it-works.md`:
    - Codex take-over, through a private remote app-server.
    - Codex usage is recorded in tokens and adds nothing to `max_cost_usd`.
  - Spec:
    - The codex hand-back caveat ends with what was built.
    - The take-over bullet names the `attach` subcommand.
    - The adapter table lists `tokens` on `start` and `idle`.
    - The Cost bullet says harnesses that report only tokens are recorded but not capped.
    - "Codex gets the same once it is installed" becomes a pointer to `test/live/codex.test.js`.

- [ ] **Step 2: Live test** (`test/live/codex.test.js`, skipped unless `AGENT_TEAM_LIVE_SMOKE=1`; timeout 300 s; every child killed in `finally`, like `test/live/claude.test.js`). It drives `adapters/codex session` directly, with a stub team MCP: point `AGENT_TEAM_TEAM_SOCKET` at a small `net` server in the test that answers `agent-team mcp`'s RPC for `report_progress`. If that is more than about 40 lines, use a real in-process supervisor from `test/helpers/live.js` instead. Assert:
  1. A fresh session answers `PONG` to "Reply with the single word PONG.", and `idle.tokens > 0`.
  2. A message sent between turns is acked, and the next turn answers it.
  3. A turn running `sleep 30` through the shell is interrupted: `idle {interrupted:true}`, the adapter exits, and no `sleep 30` process is left (`pgrep -f "sleep 30"` finds nothing that the test started).
  4. A resumed session, started with `tokens` set to the recorded total, recalls a word from the first session. Its first `idle.tokens` is less than the recorded total, so the restored total was not counted again.
  5. The team tool works after resume: asking the model to call `report_progress` reaches the stub socket.
  6. **Take-over handoff:**
     - Run `adapters/codex attach <thread>` under a pty: `script -q /dev/null` on macOS, `script -qc` on Linux. Type "Remember the word TAKEN", wait for the reply, then `/quit`. Send Enter 2 s after typing; an Enter within about 1 s is taken as part of a paste.
     - Then resume headless. The next turn recalls `TAKEN`.
     - No `codex app-server` started by the test is left running.

- [ ] **Step 3: Run what can run without codex.** `npm test`: expected green, with the live tests skipped. Then `node --test test/live/codex.test.js` without the flag: expected `skipped 1`. The controller runs the live test, `AGENT_TEAM_LIVE_SMOKE=1 node --test test/live/codex.test.js`, against the user's ChatGPT login. The implementer does not.

- [ ] **Step 4: Commit.**

```bash
git add docs/ test/live/codex.test.js package.json
git commit -m "docs: describe codex sessions and take-over; add the live codex test"
```

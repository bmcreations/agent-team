# Steerable teams: live runs that members and humans can steer

Date: 2026-10-12
Status: draft, in review

## The problem

A dispatch today is a single synchronous process. A manager answers
`{"status":"delegating"}`, exits, and is called back after its reports finish, and those
reports run one after another (`for … await runMember`, `src/dispatch.js:412`). Nothing can
reach a member while it runs: vendor CLIs are headless `spawnSync` calls whose output lands in
a temp `session.log` once they exit. The only inbound path is `claude-session`, which hands
one task to the owner's interactive session over a same-user Unix socket and waits for one
reply.

So a team cannot manage itself. A manager cannot see that a report has gone the wrong way
until the report is finished, and a human cannot correct, pause, or take over a member
mid-run. The run log is one JSONL line per top-level dispatch, so there is nothing live to
watch either.

This spec is the first of three:

1. **Steerable runs** (this spec): one machine, live members with inboxes, managers that stay
   alive while their reports work, human intervention, and a local web view.
2. **Peer teams**: teams that are not in each other's reporting tree talk, request work from
   each other, and share in-progress artifacts.
3. **Fleet**: `agent-team worker` on other machines, with the supervisor reachable over a
   tailnet.

Steering comes first because it forces the adapter contract to carry input as well as output.
Designing that contract once, in both directions, is the main reason for this order.

## The demo this spec ends at

On one Mac, a manager delegates to two reports that run concurrently. The manager watches
their checkpoints and sends one of them a correction mid-run. A human watches the run live in
the browser and can message any member, pause and resume it, answer a question it escalates,
and take it over in a terminal and hand it back.

## Harness behaviour this design relies on

These were checked on 2026-10-12 before committing to the design.

**Claude Code 2.1.296**, probed with
`claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`:

- A user message written to stdin while a tool call is running is consumed at the next
  tool-result boundary, in the same run. The model acted on it in its next turn.
- The message content must be an array of blocks (`[{"type":"text","text":…}]`). The same
  message sent as a plain string mid-run was silently dropped.
- After `result`, writing another message starts a new turn in the same process and session.
- `claude -p --resume <session_id>`, run from the same directory, recalled the earlier turns.
  Sessions are stored per working directory under `~/.claude/projects` on the machine that ran
  them, so resume and take-over must run on the same machine and path.
- Not yet verified: interrupting a turn through a stream-json control message, and opening a
  `-p` session interactively with `claude --resume`.

**Codex** is not installed on this machine, so these come from the documentation
(learn.chatgpt.com/docs/app-server, /docs/non-interactive-mode, /docs/cli/reference):

- `codex app-server` speaks newline-delimited JSON-RPC over stdio. It has `thread/start`,
  `turn/start`, `turn/steer` (input during a running turn, needs `expectedTurnId`),
  `turn/interrupt`, and `thread/resume`, with `item/*` and `turn/*` events.
- `codex exec` reads stdin once and has no input mid-run, so it cannot back a steerable member.
- `codex resume <id>` opens a session interactively, and `codex --remote` attaches the TUI to a
  running app-server.
- Both `exec` and `app-server` use the saved CLI login.

## Decisions

### A supervisor that outlives the dispatch

`agent-team serve` is a long-running supervisor. One supervisor serves every project on the
machine. It is made of four units:

| Unit | Responsibility |
|---|---|
| `src/store.js` | SQLite store: runs, members, events, messages, questions. Replaces the JSONL run log. |
| `src/sessions.js` | Spawns adapters, holds their processes, delivers inbox messages, records events. |
| `agent-team mcp` | The team MCP server each member gets. Connects back to the supervisor over a Unix socket. Generalizes `channel/server.js`. |
| `src/http.js` | JSON API, server-sent event streams, and the web page. Binds to localhost, `--port` defaulting to 4747. |

The existing CLI becomes a client. `agent-team --member X --task T` submits to a running
supervisor and follows the run. With no supervisor running, it starts one in-process for the
duration of the dispatch, so the `/delegate` skill and one-shot use keep working unchanged.

Chosen over building the fleet coordinator first. That order delivers multi-machine scheduling
sooner, but it redesigns the adapter contract twice and puts agents steering agents last. Here
the supervisor is the future coordinator. The fleet spec binds it to the tailnet and adds
workers.

The store uses `node:sqlite`, which needs no flag from Node 22.13, so `engines` moves from
`>=22` to `>=22.13`. Dependencies are allowed where they earn it; none are needed for this
spec.

### Adapter contract v2: a session, not a call

A v2 adapter is a long-lived process speaking newline-delimited JSON in both directions.

| Direction | Message | Meaning |
|---|---|---|
| in | `start {brief}` | Begin, with the brief composed as today. |
| in | `message {id, from, text}` | Inbox delivery. |
| in | `stop` | Finish after the current turn. |
| in | `interrupt` | Finish now. |
| out | `session {harness_id, resume}` | The harness session id and how to resume it. Sent first. |
| out | `event {kind, …}` | Text, tool call, tool result, or turn end, normalized across harnesses. |
| out | `ack {message_id}` | The message reached the harness. |
| out | `idle` | The turn ended. |
| out | `result {status, summary, usage}` | Final outcome. |

v2 adapters in this spec:

- `claude`: stream-json in and out. Inbox messages are written as block arrays.
- `codex`: a new adapter over `codex app-server`. Inbox messages become `turn/steer` during a
  turn and `turn/start` between turns.
- `mock`: a scripted v2 mock for tests.

`grok`, `claude-cloud`, and `claude-session` stay v1, one-shot. They appear in the run as
started and finished and cannot be steered.

A member is done when a turn ends with its inbox empty and no reports open. The supervisor then
closes its input and records the result. A manager blocked in `wait_for` is mid-turn, so it
stays alive while its reports run.

Member states: `queued`, `running`, `waiting` (in `wait_for` or `ask_human`), `paused`,
`taken_over`, and the terminal `done`, `failed`, `cancelled`.

Adapter output stays untrusted. Every line is shape-checked before use, as the delegation
parser does today.

### Members steer each other through tools, not transcripts

Every member gets the team MCP server with five tools.

| Tool | Behaviour |
|---|---|
| `delegate(to, task)` | Starts a report and returns a `report_id` immediately. Keeps the reporting line as a hard boundary (an error), `max_depth`, and `max_delegations`. A new `max_parallel` (default 3) queues the overflow. Each report gets its own workspace as today. |
| `send_to(to, text)` | Inbox message along the reporting line: the member's manager and its direct reports. |
| `wait_for(report_ids?, timeout?)` | Blocks until a report sends progress, a message, or a question, or finishes (status, summary, diff stat). Also returns early when the caller's own inbox gets a message. |
| `report_progress(text)` | A checkpoint to the manager's `wait_for` and the web view. |
| `ask_human(question, options?, timeout?)` | Blocks until a human answers. On timeout it returns "no answer" and the member decides. |

A manager sees checkpoints, messages, and results, not its reports' transcripts. Feeding full
event streams into the manager's context would spend tokens on detail it rarely needs; the
full stream still goes to the store and the web view.

Every inbox message is delivered exactly once, by one of two paths. If the member is blocked
in `wait_for` or `ask_human`, the tool returns with it. Otherwise the adapter writes it into
the session, where it is picked up at the next tool boundary. Messages carry their author,
rendered as `[from: brandon (human)]` or `[from: lead (manager)]`, and each member's brief
states that human messages outrank agent messages.

Peer-to-peer messages between members that share a manager are left out. Peers coordinate
through their manager for now, and the peer-teams spec takes up direct collaboration.

A v1 member can be a report; its manager's `wait_for` only ever sees it finish. A v1 member
acting as a manager keeps today's `{"status":"delegating"}` loop.

### Humans can always intervene

Pause, resume, take-over, and hand-back are one mechanism: stop the harness after a turn, keep
its session id, and resume that session either headless or interactively.

- **Pause** sends `stop`. The process exits after its turn and the workspace stays. *Pause
  now* sends `interrupt`. For `claude`, if a stream-json interrupt turns out not to work, the
  fallback is to kill the process and resume from the last completed turn, losing that turn's
  partial work. Codex has `turn/interrupt`.
- **Resume** starts `claude -p --resume <sid>` or `thread/resume` in the same workspace, then
  delivers anything that queued while paused.
- **Cancel** stops the member and keeps its workspace for inspection, matching today's rule
  that only `ok` runs prune their workspace.
- Pause and cancel apply to one member or its whole subtree.
- **Take-over** is `agent-team attach <run> <member>`. It pauses the member and runs
  `claude --resume <sid>` or `codex resume <id>` in the workspace, in the user's own terminal.
  On exit the member resumes headless with a note that a human drove it. The web view's "Take
  over" button shows that command.
- A manager in `wait_for` is told when a report is paused, taken over, or cancelled.
- `ask_human` questions are pinned in the web view and can be answered with
  `agent-team answer`.

Every action has a CLI verb: `watch`, `send`, `pause`, `resume`, `cancel`, `attach`, `answer`.
That keeps everything reachable from Claude Code as well as the browser.

Chosen over a browser terminal (xterm.js and `node-pty`) for take-over. On one machine the
session is local, so running the CLI in the user's terminal needs no relay. The fleet spec
needs the relay because the session will live on another machine, so it moves there.

### One supervisor across projects, and live cross-team delegation

Runs are keyed by project root, and each run loads its project's `.claude/agent-team.json` when
it starts, as dispatch does today. A global `serve --max-running` (default 6) caps members
running at once across all projects, on top of each team's `max_parallel`. Rate limits belong
to the Claude or Codex login, not the repo, so this is the cap that protects the account.

A `team:` member pointing at another local repo becomes a live part of the same run. When a
manager delegates to it, that repo's entry member starts as a report, its tree is visible and
steerable, and the boundary stays where `runTeam` puts it today: the manager can message the
other team's entry member, its members use that repo's `deny_paths` and `max_depth`, and its
runs spend the parent run's `max_delegations` capped by the team's own. Because `delegate`
returns immediately, one orchestrator can run several teams at once and relay one team's
output to another.

GitHub-named teams run as a single cloud session and stay one-shot.

### Web view

One page served by `serve`, in plain HTML and JavaScript with no build step, driven by the JSON
API and server-sent events.

- **Run list**: live status, cost, and elapsed time, with a project switcher and an "All
  projects" view.
- **Run page**: the org tree with live member states and any open questions pinned at the top,
  next to a merged timeline of messages between members and humans. Members are shown by name
  and role, so the run reads as a team conversation rather than a list of processes.
- **Member panel**: the live transcript (text, collapsed tool calls, authored messages), a
  message box, and controls for pause, pause now, resume, cancel, take over, and answer.

## Errors and recovery

- **Supervisor restart.** The store survives and member processes exit with the supervisor. On
  the next start, members left `running` are marked interrupted and resumed from their session
  ids, within the concurrency caps. A manager whose `wait_for` was cut off is told the
  supervisor restarted and given its reports' states. This also covers a CLI dispatch whose
  in-process supervisor died.
- **Adapter crash.** The member fails with the tail of its stderr, and its manager's `wait_for`
  sees it finish as failed. There are no automatic retries.
- **Stalls and timeouts.** A member with no events for `stall_minutes` (default 10) emits
  `stalled` to its manager and the web view. The existing wall-clock timeout interrupts, then
  fails. `wait_for` times out after 10 minutes by default and returns "nothing yet", leaving
  the manager to decide whether to keep waiting. `ask_human` defaults to 30 minutes. `wait_for`
  also returns on a paused report instead of waiting on it.
- **Messages to finished members** are rejected back to the sender.
- **Author spoofing.** Each member's MCP server receives a per-member token in its environment.
  The supervisor sets a message's author from that token, never from what the member claims.
  The socket directory stays mode 0700, as `channel/server.js` does now.
- **Cost.** An optional run-level `max_cost_usd` sums the per-turn cost the harnesses report
  and pauses the run when reached, so the human can raise it and resume.

## Testing

- A scripted v2 `mock` adapter drives deterministic supervisor tests: concurrent delegation,
  exactly-once inbox delivery, `wait_for` returning on its own inbox, subtree pause, resume, and
  cancel, recovery after killing the supervisor, cross-team delegation, and the cross-project
  cap.
- Adapter contract tests run `claude` and `codex` against fake binaries through bin overrides,
  as `AGENT_TEAM_CODEX_BIN` already allows.
- Unit tests cover the store, delivery, and policy checks: reporting line, budgets, caps.
- HTTP and SSE tests run under `node --test` with the rest of the suite.
- An opt-in live smoke test, behind an environment flag, runs real `claude` on Haiku and turns
  the steering probe into an assertion. Codex gets the same once it is installed.
- The demo scenario is checked end to end in the browser.

## Out of scope

- Peer teams: talking to, requesting work from, and observing teams outside the reporting
  tree, and publishing artifacts between them. The direction agreed for that spec is open by
  default, like a workplace: any team can ask any team, the receiving team's lead triages, and
  request chains that loop back to a team already in them are refused.
- Fleet: workers on other machines, tailnet binding, repo mirrors, and a browser terminal for
  take-over.
- Authentication and roles. The supervisor binds to localhost and trusts the local user.
- Steering `grok`, `claude-cloud`, `claude-session`, and GitHub-named teams.

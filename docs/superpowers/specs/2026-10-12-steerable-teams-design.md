# Steerable teams: live runs that members and humans can steer

Date: 2026-10-12
Status: draft, in review (peer teams and auth added)

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

This spec is the first of two:

1. **Steerable teams** (this spec): one machine runs every member. Members have inboxes,
   managers stay alive while their reports work, and humans can intervene. Teams outside each
   other's reporting tree talk, request work, and share in-progress artifacts. Teammates reach
   the web view and API over a tailnet, signed in with Tailscale or GitHub.
2. **Fleet**: `agent-team worker` runs members on other machines.

Steering comes first because it forces the adapter contract to carry input as well as output.
Designing that contract once, in both directions, is the main reason for this order.

## The demo this spec ends at

On one Mac, a manager delegates to two reports that run concurrently. The manager watches
their checkpoints and sends one of them a correction mid-run. A human watches the run live in
the browser and can message any member, pause and resume it, answer a question it escalates,
and take it over in a terminal and hand it back.

A teammate signed in with GitHub opens the same run from another machine on the tailnet and
can steer the members below them in the org tree. Separately, the Android team hits a bug in
loupe, opens a thread with loupe's team, keeps working while loupe's lead accepts and fixes
it, and picks up the fix when the thread closes.

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
- In `--permission-mode plan`, which read-only members use, an MCP tool call is denied even
  with `--allowedTools 'mcp__agent-team__*'`, unless the tool declares
  `annotations: {readOnlyHint: true}`. With the hint, the call goes through.
- An MCP tool call that blocked for 150 seconds returned normally. `wait_for` relies on this;
  the adapter also sets `MCP_TOOL_TIMEOUT` so a longer wait is not cut off.
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
| `src/store.js` | SQLite store: runs, members, events, messages, questions, threads, published versions, people. Replaces the JSONL run log. |
| `src/sessions.js` | Spawns adapters, holds their processes, delivers inbox messages, records events. |
| `agent-team mcp` | The team MCP server each member gets. Connects back to the supervisor over a Unix socket. Generalizes `channel/server.js`. |
| `src/http.js` | JSON API, server-sent event streams, and the web page. Binds to localhost, `--port` defaulting to 4747; teammates reach it through `tailscale serve` or a GitHub sign-in. |

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
| out | `ack {message_id}` | The harness consumed the message: for `claude`, the user message echoed back by `--replay-user-messages`. Writing it to stdin is not enough. A message written but not acked by the end of the turn goes back to the queue. |
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

Every member gets the team MCP server with five tools. Each declares `readOnlyHint: true`:
none of them touch the member's workspace, and without the hint a read-only member in plan
mode cannot call them.

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

Every inbox message is delivered once, by one of two paths. If the member is blocked in
`wait_for` or `ask_human`, the tool reclaims it and returns it as the result; the harness may
also surface it in its own context. Otherwise the adapter writes it into the session, where it
is picked up at the next tool boundary, and `ack` marks it delivered. An offered message that
is not acked goes back to the queue at the second `idle` or when the process exits. Messages carry their author,
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

The layout borrows from Agent Picnic's activity screen, as shown in Shane Mac's launch demo on
2026-10-12. That screen has a sidebar of agents, each tagged with its harness and state, and a
main column with a "Needs you" section above a history feed that groups each agent's tool
calls under its task and collapses repeats ("12 times").

- **Sidebar**: a search box, then projects, each listing its members by name, role, harness
  tag (`claude`, `codex`), and live state. Running runs sit under their project.
- **Needs you**: pinned above everything else, across all projects. It holds open `ask_human`
  questions, stalled members, and members paused by the cost cap, each answerable in place.
- **Activity**: the default view. Filters for member and project, a count of today's actions,
  and a history feed: one entry per member task, with its tool calls nested under it and
  identical consecutive calls collapsed into a count.
- **Run page**: the org tree with live member states, next to a merged timeline of messages
  between members and humans, so the run reads as a team conversation rather than a list of
  processes.
- **Member panel**: the live transcript (text, collapsed tool calls, authored messages), what
  the member can reach (workspace, `read_only`, `deny_paths`), a message box, and controls for
  pause, pause now, resume, cancel, take over, and answer.

### Peer teams talk in threads

Any team can open a thread with any other team the supervisor knows about. This is open by
default, as in a workplace: there is no allowlist, and the receiving team decides what to do
with the request. Each thread is about one thing, has an owner on each side, and moves through
`open → accepted | declined → done`. A thread opened with a task runs as a separate run owned
by the receiving team, under that team's config, budgets, and `deny_paths`. A thread opened
with a question may close with a reply and no run.

Known teams are the supervisor's projects plus any `peers` a config lists, so a team can find
`~/dev/loupe` before anyone has run a job there.

New member tools:

| Tool | Behaviour |
|---|---|
| `request(team, text, task?)` | Opens a thread with the team's entry member and returns its id. Non-blocking. |
| `reply(thread, text)` | Posts to the thread. The receiving lead uses it to accept, decline with a reason, or ask a question. |
| `team_status(team)` | Returns the team's active runs, member states, and latest checkpoints. No transcripts. |
| `publish(name, path)` | Snapshots a file or directory from the member's workspace as a new read-only version. |
| `use(team, name, version?)` | Copies a published version into the caller's workspace and returns where. Defaults to the latest. |

`wait_for` also returns on thread events: a reply, a state change, the linked run finishing,
or a newer version of something the caller uses. The receiving lead sees new threads the same
way, through `wait_for`, or at the start of its next run if none is live.

A thread whose chain of requests returns to a team already in it is refused, so A asking B
asking A cannot loop. The web view groups threads by team pair, which gives a channel-like
history without a standing channel nobody owns.

### Auth and roles

The supervisor accepts two identity sources and links them into one person record:

- **Tailscale.** Requests through `tailscale serve` carry the verified login in
  `Tailscale-User-Login`. The supervisor trusts that header only on the `tailscale serve`
  listener, never on its other ports.
- **GitHub.** Sign in with GitHub's OAuth flow for anyone not on the tailnet. Sessions are
  signed cookies.
- **Local CLI.** The OS user who runs `serve` is the owner, as today.

A person's GitHub login and Tailscale login map to the same record in the supervisor config.

**Project roles come from GitHub.** The supervisor reads the person's effective permission on
the project's repo, which already includes org team grants and base permissions, and caches it
for five minutes:

| Repo permission | Role |
|---|---|
| admin | `owner`: everything in the project, including its settings |
| write, maintain | `steer`: start runs, message, pause, answer, take over |
| read, triage | `watch`: read only |
| none | project hidden |

Projects without a GitHub remote, and people known only by Tailscale, use roles set in the
supervisor config, which can also override the GitHub-derived ones.

**Inside a project, roles come from the team config.** People can be members of the org tree,
and agents can report to them:

```json
"brandon":      { "human": true, "github": "bmcreations", "tailscale": "brandon@example.com" },
"orchestrator": { "agent": "claude", "reports_to": "brandon" }
```

- A person steers the members in their own subtree, the same reporting-line rule `send_to`
  and `delegate` apply to agents. An `owner` can act anywhere in the project.
- `ask_human` goes to the nearest person above the asking member, and their "Needs you" lists
  it first.
- The project role is a ceiling: a `watch` person never steers, even in their own subtree.
- A team that lists no people treats every `steer` person as the top of the tree, which is how
  it works today.
- A thread from another team is triaged by the receiving entry member. A person above that
  member sees the thread and can override the decision.

Take-over stays on the supervisor's machine. Teammates elsewhere can steer through the web view
but cannot `attach` until the fleet spec adds a browser terminal.

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
- **Expired or revoked access.** A cached GitHub role that comes back lower on refresh takes
  effect at once, and open web sessions drop to the new role.
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
- Thread tests cover open, accept, decline, question-only threads, the loop guard, and
  `wait_for` waking on thread events and new published versions.
- Auth tests use fake Tailscale headers and a fake GitHub API: role mapping, the cache and its
  downgrade, linked identities, subtree steering, and the `watch` ceiling.
- The demo scenario is checked end to end in the browser.

## Out of scope

- Fleet: workers on other machines, repo mirrors, and a browser terminal for take-over.
- Threads with teams on another supervisor.
- Steering `grok`, `claude-cloud`, `claude-session`, and GitHub-named teams.

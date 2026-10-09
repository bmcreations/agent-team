# Spike: delegating to a Claude session that is already running

Status: spike, not for merge. Based on `feat/cloud-members` (PR #16). Docs read on
2026-10-08 against Claude Code 2.1.294 and the Managed Agents beta
`managed-agents-2026-04-01`. Part 1 was later checked against the live API in
supervised runs; see "Results from a real session".

| Question | Recommendation |
| :- | :- |
| 1. Join an existing Managed Agents session (`session_id` on a `claude-cloud` member) | **Build**, read-only only, with the refusals in the prototype |
| 2a. Send a task to a local CLI session, opted in at start | **Build as experimental, behind the channels research preview.** Channels are documented and two-way; see the channel prototype |
| 2b. Send a task to a desktop app session, or a CLI session not started with the channel | **Wait**. Listing is documented; sending with a readable reply is not |

## 1. Managed Agents: `session_id` on a `claude-cloud` member

### What the API gives us

`POST /v1/sessions/{id}/events` accepts a `user.message` on any session in the
workspace, and the response returns the created event with a server-assigned id:
"Events that were successfully sent to the session."
([send](https://platform.claude.com/docs/en/api/beta/sessions/events/send)).
The request has no client id or metadata field, so that server id is the only
handle we get on our message.

`GET /v1/sessions/{id}` returns `status`, `archived_at`, `budget`, the resolved
`agent` snapshot (tools, MCP servers, model) and `resources[]`, including each
`github_repository`'s `url` and `checkout`
([retrieve](https://platform.claude.com/docs/en/api/beta/sessions/retrieve)).
Repositories are fixed for the session's lifetime: "to change which repositories
are mounted, create a new session"
([github](https://platform.claude.com/docs/en/managed-agents/github)).

### Open question: which `agent.message` answers our task

Nothing links them. The `agent.message` schema has `id`, `type`, `content` and
`processed_at`, with no parent or turn field
([events list](https://platform.claude.com/docs/en/api/beta/sessions/events/list)).
Events list in `processed_at` order, and a sent event's `processed_at` "is null
while the event is still queued behind earlier events"
([events and streaming](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)).

So correlation is by position only. The prototype:

1. Records the id from the POST response.
2. Polls the full event list (deduped by id, as the adapter already does) until
   that event appears with a non-null `processed_at`.
3. Takes everything after it, up to the first `session.status_idle` or
   `session.status_terminated`, as our turn. The last `agent.message` in that
   span is the answer.

The create path's "first idle ends the run" is correct for a session it owns,
but reused here it would return the owner's previous answer. Position-based
correlation avoids that. It doesn't rule out
a second client posting into the same turn. The prototype detects that case after
the fact (another `user.message` inside our span) and appends a warning, but it
can't prevent it. The API has no lock and no reply-to link.

The `created_at[gt]` list filter compares against `processed_at`, so it would
skip our own event while it's queued. The prototype doesn't use it.

### Open question: posting while the session is busy

Posting while `running` is allowed; the overview says to "Send additional user
events to guide the agent mid-execution"
([overview](https://platform.claude.com/docs/en/managed-agents/overview)). The
docs don't say whether a message posted mid-turn joins the current turn or starts
the next one, and no 409 is documented.

Because of that gap, the prototype polls `GET /v1/sessions/{id}` until `idle`
before posting. If the session never goes idle before the deadline, it returns
`failed` without sending anything rather than queue a task behind unknown work.
There is still a window between the idle check and the POST in which the owner
can start a turn.

Other documented outcomes the prototype maps to `failed`:

- `stop_reason.type: budget_reached`. A session at its cap rejects new work with
  a 400 ([budgets](https://platform.claude.com/docs/en/managed-agents/budgets)).
- `requires_action`. A tool confirmation agent-team has no way to give.
- `archived_at` set, or `terminated`. Archiving exists "to prevent new events
  from being sent" ([session operations](https://platform.claude.com/docs/en/managed-agents/session-operations)).

### Open question: do `deny_paths` checks still mean anything?

Only if the session sees what the dispatcher checked. `deniedInCloud` runs
against the files tracked at our branch and commit on origin. The prototype
refuses to send unless the session:

- mounts exactly one GitHub repository, and it is this project's origin;
- has that repository checked out at our branch name, or at our commit when it
  was pinned to a commit.

Even then, the check is weaker than on the create path. A branch-name match
doesn't mean the same commit. The session cloned whenever it started, and the
owner's turns may have changed or fetched files since. `deny_paths` then
describes origin at our commit, not the session's working tree. Treat it as a
filter on what we point the session at, not a guarantee about what it can read.

Three member settings can't be enforced on a session we didn't create, and the
prototype handles each one explicitly:

| Setting | Why it can't hold | Prototype |
| :- | :- | :- |
| `isolation: read-only` | The session's tool set was chosen by its owner | Refuses when `bash`, `write`, `edit` or any MCP server is enabled; `"session_allow_tools": true` overrides |
| `cloud_max_cost_usd` | A budget can be lowered but "never added after creation" ([budgets](https://platform.claude.com/docs/en/managed-agents/budgets)), and lowering someone else's cap is not ours to do | Warns on stderr when the session has no budget |
| `model` | The session keeps the agent it was created with | Warns that the member's model is ignored |

Config only allows `session_id` on `read-only` members. A shared session's
working tree isn't ours to push a branch from.

### Cost and teardown

`session.usage` is a cumulative snapshot, emitted "immediately before it goes
idle" ([budgets](https://platform.claude.com/docs/en/managed-agents/budgets)).
The prototype reports the difference between the last snapshot before our event
and the last one in our turn, both read from the same event list after the turn
ends, so a turn that lands between our idle check and our POST isn't counted.

The create path interrupts and archives its session on timeout. A joined session
belongs to someone else, so the prototype does neither. On timeout it stops
watching and says the session is still working, which also means it keeps
billing its owner. That's a real cost of this design, and the reason the
pre-flight idle wait exists.

### Prototype

- `src/config.js`: `session_id` (must be a `sesn_` id on a `claude-cloud`,
  `read-only` member) and `session_allow_tools`.
- `src/resolve.js`, `src/dispatch.js`: pass both through on `brief.cloud`.
- `adapters/claude-cloud`: `joinSession()`, entered when `brief.cloud.session_id`
  is set. The create path is unchanged.
- `src/cloud.js`: `joinRefusal()` and `writeToolsOn()`, moved out of the adapter
  so `scripts/verify-join.mjs` runs the same refusal code.
- `test/live-session.test.js`: 15 tests against a fake API whose session already
  holds the owner's finished turn. They cover answer selection past the owner's
  idle, a queued event, a busy then idle session, a never-idle session, timeout
  without interrupt or archive, each refusal, budget and confirmation stops, and
  a foreign message inside our turn.

- `scripts/verify-join.mjs` and `test/verify-join.test.js`: see
  [Verifying against a real session](#verifying-against-a-real-session).

`npm test`: 391 pass, 0 fail.

### Recommendation: build

The API supports this, and every gap found has a safe answer: refuse, warn, or
report. What remains is the race between our idle check and our POST, which we
can detect but not prevent. That's acceptable for read-only lookups and not
acceptable for anything that writes, which is why the prototype only allows
read-only members.

Before merging, three behaviours the code depends on need one check against a
real session, because the docs don't state them outright:

- `processed_at` on a sent event fills in when its turn starts.
- `agent.tools` on `GET /v1/sessions/{id}` uses the `agent_toolset_*` shape the
  adapter sends on create. If it doesn't, the write-tool refusal silently passes.
- The event list comes back in `processed_at` order. `joinSession()` takes the
  turn by list position. The docs say the list is ordered by `processed_at`, but
  a fake that listed events in insertion order made a queued message pick up the
  previous turn's answer, so this is worth confirming rather than assuming.

### Verifying against a real session

`scripts/verify-join.mjs` checks those behaviours and the questions the docs
leave open. It needs an API key, so it has not been run. Use a throwaway session
in a test workspace with read-only tools, this repo mounted, and a small budget:
every step costs a model turn.

`scripts/create-scratch-session.mjs` creates one with the adapter's own request
bodies and prints its id. A key that isn't scoped to one workspace also needs
`ANTHROPIC_WORKSPACE_ID`.

```bash
SID=$(GITHUB_TOKEN=... node scripts/create-scratch-session.mjs) && node scripts/verify-join.mjs --session "$SID" --repo https://github.com/bmcreations/agent-team --ref main
```

The default run reads the session, checks the tool and checkout shapes, runs
`joinRefusal()` against `--repo`/`--ref`, sends one short message, and checks
that its answer is found by position, that `processed_at` fills in, and that the
list is in `processed_at` order. Optional steps:

| Flag | What it settles |
|---|---|
| `--mid-turn` | Whether a message posted while running joins the current turn or queues as its own, and where a queued event sits in the list |
| `--second-key` | Whether another key in the same workspace (`ANTHROPIC_API_KEY_2`) can read and post |
| `--project <dir> --member <m>` | An end-to-end delegation through agent-team; checks the answer, that the session wasn't archived, and that the result names the session |
| `--archive` | The status code for posting to an archived session. Archives the session, can't be undone, runs last |

It prints PASS, FAIL or INFO per check and exits 1 on any failure. Raw responses
go to `test/fixtures/live-session/` for use as fixtures in `test/live-session.test.js`.
They hold the session's metadata, repo URLs and model output, so review them
before committing.

`test/verify-join.test.js` runs the script against a simulated session, so its
logic is tested without a key. The simulation encodes the same reading of the docs as the adapter, so
a pass there says nothing about the real API.

### Results from a real session (2026-10-09)

Runs against a scratch session (Haiku 4.5, read-only tools, this repo at `main`,
created with `scripts/create-scratch-session.mjs`). The first default run passed
10 checks and failed the cost check. After the cost fix below, a run with
`--mid-turn` passed all 11.

Confirmed:

- `agent.tools` comes back in the shape the adapter sends: one
  `agent_toolset_20260401` entry with `default_config` and named `configs[]`.
  Each config also carries `type` and `permission_policy`, which
  `joinRefusal()` ignores. It reported no write tools, as expected.
- `checkout` is `{"type":"branch","name":"main"}`, and `joinRefusal()` accepted
  the session for this repo at `main`.
- The POST response returns the `user.message` with its `sevt_` id and no
  `processed_at` field. In the event list, the field was null on first sight and
  filled in once the turn ran.
- The list came back in `processed_at` order. The reply was the `agent.message`
  between our event and the next `session.status_idle`, ending on `end_turn`.

Found:

- `session.usage` nests the cost at `usage.list_cost`, not at the top level. The
  adapter read the top level, so `cost_usd` would always have been null, in
  the create path from PR 16 as well as the join path. Fixed, and the fakes now
  use the real shape.
- A turn also emits `session.thread_status_running`/`_idle`, `agent.thinking` and
  `span.model_request_*` events, and `session.status_running` lands just before
  our `user.message` in the list. None of these affect how the turn is found.

- A message posted while a turn is running is not a separate turn. In the run,
  B was posted while A was running. It was processed right after A's
  `agent.message` (15:17:42.92, then B at 15:17:43.05), and both ended on a
  single `session.status_idle` with no idle between them. A client waiting on A
  would see B's answer as the last `agent.message`. The join path's wait for
  idle before posting is required, not just cautious.
- Cost amounts are whole cents. The cumulative `usage.list_cost.amount` went
  0, 1, 3 over three short Haiku turns, which can't be dollars, so dividing by
  100 is right. Whole-cent rounding means a small turn's cost reads as 0 or 1.
- A message still queued (null `processed_at`) is listed after every processed
  event.

- Archiving returns 200 and sets both `archived_at` and `status: "terminated"`.
  A later POST to `/events` gets a 400 `invalid_request_error`, "Cannot send
  events to archived session". `joinRefusal()` checks both fields, so a member
  pointed at an archived session is refused before anything is sent.

- A full delegation through agent-team works. A read-only `claude-cloud` member
  with `session_id` set was asked for the version in `package.json` and returned
  `0.4.0`, which is correct for `main`. The adapter left the session open, the
  result named the joined session, and `cost_usd` was 0.01, matching the
  session's own `usage.list_cost` going from 0 to 1 cent over that turn.

Still open:

- `--second-key` has not been run, so access from a second key in the same
  workspace is still unconfirmed.

### What is documented and callable

**List: `claude agents --json`.** "`claude agents --json` is the supported way
to read session state from outside Claude Code"
([agent view](https://code.claude.com/docs/en/agent-view)). Each entry has `cwd`,
`kind` (`interactive` or `background`), `sessionId`, `pid`, `status`
(`busy`, `waiting`, `idle`) and, for background sessions, `state` and a short
`id`. It runs without a TTY. The desktop docs say the desktop app's own session
surface doesn't see terminal CLI sessions. The agent-view page doesn't say
whether `claude agents` lists desktop Code tab sessions.

**Send to a claude.ai/code cloud session: `claude -p "msg" --cloud <session-id>`.**
"The CLI queues the message into the session and exits without waiting for a
reply" ([cloud](https://code.claude.com/docs/en/claude-code-on-the-web)).
`--output-format json` gives `{ok, session_id, url}`. It needs `claude auth
login` and an org policy toggle, and no documented command reads the reply back.
For delegation, which needs the answer, this is fire-and-forget.

### What exists but doesn't fit a plain Node process

**`claude --resume <session> "prompt"`** sends the prompt to a running
background session as its next turn, then attaches the terminal. Claude Code
won't open the session with "Piped or redirected input or output", or with
`--output-format json` ([sessions](https://code.claude.com/docs/en/sessions)).
A Node `child_process` with pipes hits the first condition. It also only reaches
background sessions, and returns no reply.

**The session inbox socket.** Each session binds a per-user Unix socket, and the
docs describe it for "when you want a script or hook to post into a session"
([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)).
What's documented stops short of a usable client:

- The path is exposed in the session's `/status` and as
  `CLAUDE_CODE_MESSAGING_SOCKET` to that session's own hooks and Bash commands.
  `claude agents --json` doesn't list it.
- The only frame documented is the auth line,
  `{"type":"auth","token":"<token>"}`. The message frame that follows isn't.
- The verified case is a session's own child posting back to that session. A
  post from another process goes through the receiver's `crossSessionInbound`
  setting, and replies go to a reply address a plain process doesn't have.

Writing a client would mean guessing the message format. That's the private
internals this spike was scoped to avoid, so it stops here.

**Channels** are the exception, and have their own section below.

**The desktop app's session tools** (list, read, message other Code tab
sessions) are documented only as something "Claude can" do from inside a desktop
session ([desktop](https://code.claude.com/docs/en/desktop)). No external
endpoint is documented.

### Channels: a documented two-way route, opted in at session start

A channel is an MCP server that "pushes events into your running Claude Code
session" ([channels](https://code.claude.com/docs/en/channels)), and it can be
two-way: the server exposes a tool that Claude calls to send messages back
([channels reference](https://code.claude.com/docs/en/channels-reference)). That
covers both halves agent-team needs, using only documented contracts:

- **Sending.** The server emits `notifications/claude/channel` with `content`
  and a `meta` map. Each `meta` entry "becomes an attribute on the `<channel>`
  tag", so a `task_id` travels with the task.
- **Matching the reply.** The `reply` tool takes that `task_id` back, so replies
  match by id. That is stronger than Managed Agents, where the only link is
  position in the event stream.
- **Addressing a session.** `CLAUDE_CODE_SESSION_ID` is set in "stdio MCP
  server subprocesses" ([env vars](https://code.claude.com/docs/en/env-vars)),
  so the server can register under the same `sessionId` that
  `claude agents --json` reports.
- **Shipping it.** A plugin declares a channel with a `channels` entry bound to
  one of its `mcpServers`
  ([plugins reference](https://code.claude.com/docs/en/plugins-reference)), and
  agent-team is already a plugin.

The limits:

- **Opt-in at session start, behind a warning.** "Events only arrive while the
  session is open," and only if the session loaded the channel. During the
  research preview, custom channels aren't on the allowlist, so the session has
  to start with `--dangerously-load-development-channels`, which asks for
  confirmation. Team and Enterprise orgs must also enable channels.
- **No delivery acknowledgement.** If the session didn't load the channel,
  Claude Code "drops the events silently and returns no error to your server."
  The caller only finds out from a timeout. That is also why the prototype
  doesn't add the server to `plugin.json` yet: every session would start it and
  register, including sessions that will drop every task.
- **Busy sessions batch.** "If several notifications arrive while Claude is
  busy, they're delivered together on the next turn". Matching by `task_id`
  survives that, but the task waits for whatever the owner is doing.
- **Nothing is enforced, only requested.** The task runs inside someone's own
  interactive session, with that session's permissions, tools, working tree and
  context budget. `deny_paths`, `isolation` and cost caps can't be applied; the
  most agent-team can do is ask in the channel's `instructions`. The task and
  its answer also stay in the owner's conversation history.
- **Answering through `reply` is up to the model.** The instructions say to
  call `reply` exactly once with the `task_id`. If Claude answers in the
  transcript instead, the caller times out.
- **Desktop app sessions.** The channels pages only describe CLI sessions
  started with a flag. Nothing documents loading a channel into a desktop Code
  tab session.

### Channel prototype

- `channel/server.js`: a dependency-free stdio MCP server. It declares
  `claude/channel`, exposes `reply(task_id, text)`, and listens on a Unix
  socket at `~/.cache/agent-team/channels/<session-id>.sock` in a `0700`
  directory, which is the only access control. It writes a registry entry
  (`session_id`, `cwd`, `pid`, `socket`) next to the socket and removes both
  when its stdin closes. It doesn't declare `claude/channel/permission`, so tool
  approvals stay in the owner's terminal.
- `src/channel.js`: `listChannels()` reads the registry and skips dead pids;
  `askSession(id, text)` sends `{task_id, text}` and waits for the matching
  reply or the timeout.
- `scripts/ask-session.mjs`: `--list`, or `--session <id> "task"`.
- `test/channel.test.js`: 5 tests that drive the server over stdio the way
  Claude Code does, including two tasks answered out of order and a late reply
  to an abandoned task. They prove the plumbing only. No fake can show that a
  real session calls `reply` rather than answering in its transcript; that
  needs the supervised run below.

Not wired into the dispatcher. A `claude-local` adapter would need a decision on
workspaces: the session works in its own checkout, so agent-team's worktree and
`deny_paths` checks don't apply.

### Supervised run (not yet done)

1. In a scratch directory with a `.mcp.json` naming `channel/server.js` under
   the key `agent-team`, start a fresh session (never one in use):
   `claude --dangerously-load-development-channels server:agent-team`, and
   accept the prompt.
2. From another terminal, `node scripts/ask-session.mjs --list` should show the
   session, and `--session <id> "What version is in package.json?"` should
   print the answer.
3. Check in the session that the task arrived as a `<channel>` event and that
   Claude answered with the `reply` tool.

### Recommendation

- **Local CLI sessions: build as experimental**, if it's acceptable for the
  target session to start with `--dangerously-load-development-channels` until
  channels leave research preview. If that flag is not acceptable to ship, wait
  for the allowlist to open. Either way, the supervised run comes first.
- **Desktop app sessions, and CLI sessions started without the channel: wait.**
  Listing alone doesn't make a delegation target. Revisit if the inbox socket's
  message frame and reply path are documented for non-child senders, or if
  `--cloud <session-id>` gains a documented way to read the reply.

# Adapters

An adapter is an executable in `adapters/`, named after the agent it runs. A member's
`agent` field picks it: `"agent": "codex"` runs `adapters/codex`. The dispatcher talks to it
only through argv, stdin and stdout, so an adapter can be written in anything.

## The contract

Every adapter handles three subcommands, passed as its only argument. Its working directory
for `run` is the member's workspace.

| Subcommand | stdin | Must |
|---|---|---|
| `probe` | none | Exit `0` within 30 seconds if the agent can run. Any other outcome means unavailable, and the member falls back to `on_unavailable`. |
| `capabilities` | none | Print a JSON object with `write`, `workspace`, `structured_output` and `tool_dialect`. |
| `run` | the brief, as JSON | Print a JSON result object and exit. |

The dispatcher reads only the **last non-empty line** of stdout, so an adapter may log above
it. That line must be a JSON object; anything else becomes `status: "failed"` with the first
2,000 characters of stdout in `raw`. A non-zero exit becomes `status: "failed"` regardless of
stdout. The shipped adapters exit `0` and report failure through `status` instead, and exit `2`
on an unknown subcommand.

A `run` result needs `status`, one of `ok`, `failed`, `timeout` or `delegating`, and on `ok`,
a string `summary`. An optional `usage` object is copied into the run log. The claude adapter
sets `cost_usd` in it and a codex session sets `tokens`; codex `run` and grok set none, so those
members show `—` in the report. `delegating` also needs `delegations`; see
[Delegation](how-it-works.md#delegation). Everything else in the object is passed through to
the caller. The brief's fields are listed in [The brief](how-it-works.md#the-brief).

`tool_dialect` names a file in `references/`: `codex` loads `references/codex-tools.md` and
puts it at the top of the brief. `claude` means no dialect file.

The adapter runs in its own process group. When the dispatch timeout expires, the whole group
is sent `SIGKILL` and the result is `status: "timeout"`.

## Session adapters (protocol 2)

A v1 adapter is called once per `run`. A v2 adapter is a long-lived process that a human or
another member can steer while it works. An adapter opts in by reporting `"protocol": 2` from
`capabilities`, and implements `<adapter> session`. Its working directory is the member's
workspace, as for `run`. `probe` and `capabilities` are unchanged. An adapter that reports
anything else, or nothing, stays v1.

The supervisor enforces the run's timeout on a session by counting only the time it is working:
time blocked in `wait_for` or `ask_human`, or idle between turns, does not count, and a resumed
session starts a fresh count. Past the timeout it sends `interrupt` and fails the member.

An adapter that can hand its sessions to a human also reports `takeover: {notice}` from
`capabilities` (`notice` is a string, or null; `{cwd}` is filled in) and implements
`<adapter> attach <resume>`. `agent-team attach` runs `[<adapter>, 'attach', <resume>]` in the
member's workspace with the terminal inherited, after the member's session has ended. The
subcommand runs the harness's own interactive session on that resume id and exits with its
status; exit `3` means the harness never started, so the handback does not say the human drove
it. The supervisor offers take-over for any member whose adapter declares the capability.
`claude` and `codex` do; see each adapter below.

`session` speaks newline-delimited JSON on stdin and stdout.

| Direction | Message | Meaning |
|---|---|---|
| in | `start {brief, resume, note, cost_usd?, tokens?}` | Begin. `resume` is null for a fresh start; otherwise it is the string this adapter sent in `session {resume}`, and `note` is the first user turn to send after resuming. With a `resume`, `cost_usd` is what the supervisor has recorded for this member so far; an adapter whose harness reports cost cumulatively across a resumed session takes each `idle`'s `cost_usd` from it. Adapters that report per-turn cost ignore it. `tokens` is the same for a harness that reports tokens: the member's recorded total, the baseline for the first `idle`'s `tokens`. |
| in | `message {id, from, text}` | Inbox delivery. |
| in | `stop` | Finish after the current turn. |
| in | `interrupt` | End the turn now and exit: send `idle {interrupted: true}` and no `result`. |
| out | `session {harness_id, resume}` | The harness session id and how to resume it. Sent first. |
| out | `event {kind, ...}` | Text, tool call, tool result, or turn end, normalized across harnesses. |
| out | `ack {message_id}` | The harness consumed the message. For `claude`, that is the user message echoed back by `--replay-user-messages`. Writing it to stdin is not enough. |
| out | `idle {interrupted?, cost_usd?, tokens?}` | The turn ended. `cost_usd` is this turn's cost in dollars, if the harness reports one; the supervisor sums it against `max_cost_usd`. `tokens` is this turn's tokens (a non-negative integer), for a harness that reports no dollar figure. The supervisor records it on the member and the run but it counts toward no cap. |
| out | `result {status, summary, usage}` | Final outcome. |

Adapter output is untrusted, and the supervisor shape-checks every line.

### Message delivery

A message is delivered once, by one of two paths:

- If the member is blocked in `wait_for`, the supervisor reclaims the message and returns it
  as the tool result. The harness may also surface it in its own context.
- Otherwise the supervisor sends it as a `message` and counts it delivered when the adapter
  sends `ack`. Ack means consumed, not written.

`ask_human` reclaims messages from a human or the member's manager the same way: the question
is closed and the call returns `{answer: null, timed_out: false, messages, note}`. A report's
progress is not reclaimed; it is offered on stdin and read after the answer.

A message that was offered and not acked is put back in the queue at the second `idle`, or
when the process exits. A single `idle` does not requeue it, because the offer can still be in
flight when the turn ends.

A member is done when a turn ends (`idle`) with nothing offered and no reports open. The
supervisor then sends `stop`. A member that has been sent `stop` counts as finished, and
`send` to it is rejected.

### Environment

The supervisor sets two variables for the session process:

| Variable | Value |
|---|---|
| `AGENT_TEAM_TEAM_SOCKET` | The supervisor's socket path. |
| `AGENT_TEAM_TEAM_TOKEN` | A token that identifies the member to the supervisor. |

A real harness is configured with `agent-team mcp` as an MCP server and passes both variables
through to it. `agent-team mcp` serves the five team tools (`delegate`, `send_to`, `wait_for`,
`report_progress`, `ask_human`) over stdio and forwards each call to the socket. It forwards
only those tool names. The socket also serves admin methods (`submit`, `wait_run`, `send`,
`answer`, `questions`, `pause`, `resume`, `cancel`, `takeover`, `handback`), which the bridge refuses. They are reachable by anything that can open the socket,
which is a directory created with mode `0700`. The token identifies a member; it does not
authenticate a user, and the socket is not an authentication boundary until the auth phase.

### Blocking calls

A member can have one blocking call (`wait_for` or `ask_human`) at a time. A second one is a
tool error. A question that times out, or whose member finishes, is closed, and `answer`
refuses it.

### Tool annotations

Every team tool declares `readOnlyHint: true`. None of them touch the member's workspace, and
`claude` in `--permission-mode plan`, which read-only members use, denies any MCP tool without
the hint, even one listed in `--allowedTools`.

### mock-live

`adapters/mock-live` is the reference implementation. It plays a harness: it runs a script,
calls the team tools over the socket the way `agent-team mcp` would, and accepts inbox messages
only between steps, which is where `claude` picks one up. It reads the script from
`AGENT_TEAM_MOCK_SCRIPT`, as the `mock` adapter does. A script with `by_member` picks the entry
by `brief.member`; otherwise the script is the entry.

| Entry field | Meaning |
|---|---|
| `steps` | Run in order. |
| `result` | `{status, summary}` for the final `result`. Defaults to `ok` and `done`. |

| Step field | Meaning |
|---|---|
| `say` | Emit a `text` event. |
| `sleep_ms` | Wait. |
| `tool`, `args` | Call a team tool. A tool error becomes `{error}` in the result instead of failing the run. |
| `save` | Keep the tool's result under this name. Later strings of the form `$name.field` are replaced by that field. |
| `until_finished` | With `tool: "wait_for"`: call it repeatedly until every listed report id has reported `finished`. |

Before each step it acks and records any queued message. After the last step it sends `idle`,
then keeps accepting messages until `stop` or `interrupt`, and ends with a `result` that also
carries `received` (the messages it saw) and `tool_results`.

A member's script entry can also set `on_resume.steps`, played instead of `steps` when the
session is started with a `resume` id, and `turn_cost_usd`, reported on every `idle`.

## Shipped adapters

The three vendor adapters share a shape. They run the CLI once with the brief's `task` as
the prompt, write its full output to `session.log` in a fresh `agent-team-<vendor>-*`
directory under the system temp directory, and return that path as `log_path`. After the run
they compute `artifacts.diff` and `artifacts.diff_stat` from the workspace, with new files included through a throwaway
git index so the workspace's own index is untouched.

When the brief has `can_delegate`, each vendor adapter also reads the CLI's final answer for a
delegation and reports `delegating`, `failed` for a malformed one, or `ok`. The rule is under
[How an answer is read as a delegation](how-it-works.md#how-an-answer-is-read-as-a-delegation).

### claude

| Brief field | Becomes |
|---|---|
| `task` | `-p <task> --output-format json` |
| `model` | `--model` |
| `effort` | `--effort` |
| `advisor` | `--settings '{"advisorModel":"<advisor>"}'` |
| `read_only` | `--permission-mode plan` |
| otherwise | `--permission-mode <permission_mode>`, default `auto` |

Binary: `claude` from `PATH`. There is no override variable.

`summary` is the `result` field of claude's JSON output. `permission_denials` lists the tools
claude refused; on a non-read-only member, any refusal turns the run into `failed` so its
workspace is kept.

`usage` is read from the same JSON output and feeds the [run log](how-it-works.md#the-run-log):

| Field | From |
|---|---|
| `duration_ms`, `turns`, `cost_usd`, `session_id` | `duration_ms`, `num_turns`, `total_cost_usd`, `session_id` |
| `models` | `modelUsage`, one entry per model with `input_tokens` (cache reads and writes included), `output_tokens` and `cost_usd`. An advisor's model appears here with its own cost. |
| `model` | The member's own model, from the session transcript's assistant lines. |
| `advisor_calls` | `server_tool_use` blocks named `advisor` in the session transcript. |

The transcript is `<session_id>.jsonl` under `$CLAUDE_CONFIG_DIR/projects` (default
`~/.claude/projects`). The envelope's `usage.iterations` lists only the run's last API call, so
it misses an advisor called mid-run. When the transcript cannot be found, `model` and
`advisor_calls` are `null`, not `0`. On a timeout or a non-JSON envelope, `usage` is `null`.

`AGENT_TEAM_CLAUDE_DIFF_MAX_BUFFER` raises the byte limit for capturing the diff. An invalid
value is ignored with a warning and sets `artifacts.diff_max_buffer_invalid_override`.

#### Session (protocol 2)

`adapters/claude session` runs the member as one long-lived process:

    claude -p --input-format stream-json --output-format stream-json --verbose
      --replay-user-messages --mcp-config <file> --allowedTools 'mcp__agent-team__*'
      --permission-mode <plan|permission_mode> [--resume <session>] [--model ...]

| Contract message | claude |
|---|---|
| `start {brief}` | The task as the first user turn. |
| `start {resume, note, cost_usd}` | `--resume <resume>`; the note as the first user turn. claude restores the session's `total_cost_usd` on resume, so `cost_usd` is the starting point for the next `idle`'s change. |
| `message {from, text}` | A user turn `[from: <from>] <text>`; content is always a list of blocks, since claude drops a plain string. |
| `ack` | Sent when claude replays the user line's `uuid` with `isReplay: true`. |
| `interrupt` | `control_request {subtype: "interrupt"}`; answered with `idle {interrupted: true}`, then the adapter ends claude and exits without a `result`. |
| `idle {cost_usd}` | Each `result` line; `cost_usd` is the change in claude's cumulative `total_cost_usd`, never negative. |
| `session {resume}` | The `session_id` of the first `system/init` line. |

The MCP config, written to a `0600` file so the member's token stays out of `ps`, runs
`agent-team mcp` with `AGENT_TEAM_TEAM_SOCKET` and `AGENT_TEAM_TEAM_TOKEN`. `MCP_TOOL_TIMEOUT`
is set to 7,260,000 ms so claude does not give up on an `ask_human` call before its 7200 s
maximum. A read-only member runs in plan mode; the team tools work there because each declares
`readOnlyHint`.

Resume works only on the same machine and in the same directory: claude keeps sessions per
working directory under `~/.claude/projects`.

`takeover` is `{notice: "claude may first ask whether to trust {cwd}."}`, and `adapters/claude attach <session>`
runs `claude --resume <session>` with the terminal inherited, exiting `3` if claude cannot be run.

If the adapter's stdin closes, its supervisor is gone. The adapter interrupts claude's open
turn, or closes claude's stdin if it is between turns, then sends claude SIGTERM after 2 seconds
and SIGKILL after 4 if it is still running. A restarted supervisor resumes the session, and
two claude processes must not write it at once.

### codex

`adapters/codex` speaks protocol 2: `session` runs the member as one long-lived
`codex app-server` over stdio (newline-delimited JSON-RPC, one app-server per member), and the
`run` form below is the one-shot path for a v1 caller.

| Contract message | codex app-server |
|---|---|
| `start {brief}` | `initialize`, then `thread/start` with `approvalPolicy: "never"`, `sandbox` (`read-only` for a read-only brief, else `workspace-write`), `model` and `model_reasoning_effort` from the brief, and the config below; the task is the first `turn/start`. |
| `start {resume, note, tokens}` | `thread/resume {threadId, excludeTurns: true, ...}` with the same config sent again, because it is not part of the thread's history and the team tools are missing without it. The note is the first turn. |
| `message {from, text}` | `turn/steer` into the running turn, or `turn/start` between turns. `[from: <from>] <text>`. A steer that loses the race with the end of the turn runs as the next turn. Acked once, when codex accepts it. |
| `interrupt` | `turn/interrupt`, then `idle {interrupted: true}`, then the adapter kills the app-server and exits without a `result`. `turn/interrupt` leaves shell commands the turn started running, so the process is ended to stop them. |
| `stop` | The app-server is ended after the current turn; the adapter then sends `result`. |
| `idle {tokens}` | Each `turn/completed`; `tokens` is the change in the thread's cumulative `totalTokens` (from `thread/tokenUsage/updated`) since the previous turn, omitted when zero. |
| `session {resume}` | The thread id. |

The member's team tools reach codex through per-thread config, not through its own environment
(the adapter removes `AGENT_TEAM_TEAM_SOCKET` and `AGENT_TEAM_TEAM_TOKEN` from the app-server's
env, so the token is only inside the `thread/start` and `thread/resume` params):

    config.mcp_servers['agent-team'] = {
      command: <node>, args: [<bin/agent-team.js>, 'mcp'],
      env: { AGENT_TEAM_TEAM_SOCKET, AGENT_TEAM_TEAM_TOKEN },
      default_tools_approval_mode: 'approve', tool_timeout_sec: 7500 }

`default_tools_approval_mode: 'approve'` is needed because under `approvalPolicy: "never"` every
MCP call otherwise fails with "MCP tool call requires approval". `tool_timeout_sec` is 7500
because codex's default of 300 s is shorter than `ask_human`'s 7200 s maximum. The user's own
`~/.codex/config.toml` servers still load. Server-initiated approval requests should not occur
under that policy; each is answered so a turn cannot hang, and none approves anything (the
`agent-team` MCP elicitation is accepted, commands and patches are declined).

Ending a session (stop, interrupt, a closed stdin, SIGTERM) also ends the shell commands its
app-server started, including ones in their own process group; the same holds for the take-over server.
So does an app-server that crashes mid-turn: while a turn runs, the adapter refreshes its list
of the server's descendants at the turn's start and as each command starts and ends, and kills
that list when the server exits. The list is dropped when the turn completes, and each ending
starts from a fresh look, so a pid recorded long ago (and perhaps reused since) is never
signalled. Each sweep is written to the session log. The list comes from `ps`; if `ps` is
missing, fails or takes over 2 s, the session log says so and the last list is kept.

**Tokens, not dollars.** codex reports no dollar figure. `idle.tokens` is the turn's tokens,
and `start.tokens` is the member's recorded total: `thread/resume` re-emits the restored total
once, and the baseline keeps it out of the first `idle`. The supervisor records both on the
member and the run (`members.tokens`, `runs.tokens`) and adds nothing to `max_cost_usd`.

If the adapter's stdin closes, its supervisor is gone: the open turn is interrupted and the
app-server is killed within a few seconds, so a recovering supervisor's resume is the only
writer.

**Take-over.** `capabilities` reports `takeover: {notice: null}`. `adapters/codex attach
<thread>` is run by `agent-team attach` after the member's app-server has exited. It starts a
private app-server on a loopback websocket
(`codex app-server --listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-file <file>`),
reads the port from its `listening on:` line on stderr, and runs
`codex resume <thread> --remote ws://127.0.0.1:<port> --remote-auth-token-env
AGENT_TEAM_CODEX_REMOTE_TOKEN` with the terminal inherited. The random token is in a `0600`
file in a `0700` temporary directory for the server and in the TUI's environment, never in argv.
The server runs in its own process group and is stopped, and the directory removed, however the
TUI ends, including SIGINT, SIGTERM and SIGHUP to `attach`. The exit status is the TUI's; `3`
means the server or the TUI never started. Because the thread never changes writer, a later
`thread/resume` in a fresh app-server works and recalls the human's turns, which the live test
checks.

Brief fields for the v1 `run` form:

| Brief field | Becomes |
|---|---|
| `task` | `exec --json --ephemeral --color never --skip-git-repo-check -C <cwd> <task>` |
| `model` | `-m` |
| `effort` | `-c model_reasoning_effort=<effort>`, unverified against a real codex run |
| `read_only` | `-s read-only` |
| otherwise | `-s workspace-write` |

Binary: `AGENT_TEAM_CODEX_BIN`, else `codex` from `PATH`.

`summary` is codex's last message, written with `-o` to `last-message.txt` beside the log.
`advisor` and `permission_mode` are ignored.

### grok

| Brief field | Becomes |
|---|---|
| `task` | `-p <task> --output-format json --cwd <cwd> --always-approve --disable-web-search` |
| `model` | `-m` |
| `effort` | `--reasoning-effort` |
| `read_only` | `--sandbox read-only` |
| otherwise | `--sandbox workspace` |

Binary: `AGENT_TEAM_GROK_BIN`, else `grok` from `PATH`.

The sandbox is set on both branches because grok's default is no sandbox. Web search is off so
a snippet of the filtered repository cannot leave through a search query. `summary` is the
`text` field of grok's JSON output; that parser has not been checked against a real successful
run.

On macOS with Docker Desktop installed, `--sandbox read-only` refuses to start because
`/var/run/docker.sock` is a symlink, so `read-only` grok members fail. They fail closed; grok
does not run unprotected.

### claude-session

Experimental. Sends the task to a running Claude Code session through the agent-team channel
(`channel/server.js`) and returns the session's reply as the summary. `probe` succeeds when
any session is running the channel; the run picks which one from the brief and fails if none
or several match. Capabilities declare `live_session: true`, so the dispatcher creates no
workspace and refuses delegations from another project. The result never carries a diff,
findings or a delegation. Setup and limits are under
[Live session members](configuration.md#live-session-members-experimental).

### mock

For tests. `run` reads a JSON script from `AGENT_TEAM_MOCK_SCRIPT` and prints it back with the
brief it received under `received`. A script with `by_member` answers per member, an array is
consumed one entry per call, and `{"hang": true}` never exits. It returns whatever `status` the
script gives it, so it can return `delegating` without the text parsing the vendor adapters do.

## Conformance

`test/conformance.js` exercises an adapter against the contract:

- `probe` exits `0` within 30 seconds.
- `capabilities` returns all four keys.
- `run` on a read-only brief leaves the git status, `HEAD` and refs of a git working directory
  unchanged. It cannot see a write that was reverted before the run ended.
- `run` returns a known `status`, a string `summary` on `ok`, and never `delegating` when
  `can_delegate` is false.
- A `delegating` result carries a non-empty `delegations` array whose entries each have a
  non-empty `to` and `task`.

A graceful `failed` passes, so a conformant adapter honours the contract; it has not
necessarily reached a model. To require a successful run against the real CLIs:

```bash
AGENT_TEAM_CONFORMANCE=codex,grok npm test
```

## Adding an adapter

1. Add an executable `adapters/<name>` that handles `probe`, `capabilities` and `run` as above,
   or `session` as well if it reports protocol 2.
2. Map `read_only` to the CLI's strongest read-only mode, and set the write mode explicitly
   rather than relying on the CLI's default.
3. If the CLI's tool names differ from Claude Code's, add `references/<name>-tools.md` and
   return `"tool_dialect": "<name>"` from `capabilities`.
4. Run the conformance suite against it.

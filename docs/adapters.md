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
a string `summary`. `delegating` also needs `delegations`; see
[Delegation](how-it-works.md#delegation). Everything else in the object is passed through to
the caller. The brief's fields are listed in [The brief](how-it-works.md#the-brief).

`tool_dialect` names a file in `references/`: `codex` loads `references/codex-tools.md` and
puts it at the top of the brief. `claude` means no dialect file.

The adapter runs in its own process group. When the dispatch timeout expires, the whole group
is sent `SIGKILL` and the result is `status: "timeout"`.

## Shipped adapters

The three vendor adapters share a shape. They run the CLI once with the brief's `task` as
the prompt, write its full output to `session.log` in a fresh `agent-team-<vendor>-*`
directory under the system temp directory, and return that path as `log_path`. After the run
they compute `artifacts.diff` from the workspace, with new files included through a throwaway
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

`AGENT_TEAM_CLAUDE_DIFF_MAX_BUFFER` raises the byte limit for capturing the diff. An invalid
value is ignored with a warning and sets `artifacts.diff_max_buffer_invalid_override`.

### codex

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

1. Add an executable `adapters/<name>` that handles `probe`, `capabilities` and `run` as above.
2. Map `read_only` to the CLI's strongest read-only mode, and set the write mode explicitly
   rather than relying on the CLI's default.
3. If the CLI's tool names differ from Claude Code's, add `references/<name>-tools.md` and
   return `"tool_dialect": "<name>"` from `capabilities`.
4. Run the conformance suite against it.

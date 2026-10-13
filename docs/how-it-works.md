# How it works

`/delegate <member> <task>` runs `bin/agent-team.js --member <member> --task <task>` in the
project. One dispatch does the following for the named member:

1. Load and validate `.claude/agent-team.json`.
2. Resolve which agent runs the member, falling back if its CLI is missing.
3. Build a workspace for the member.
4. Build a brief and hand it to that agent's adapter.
5. If the member answers with delegations, run each one against its direct reports, then
   call the member again with their results.
6. Return one JSON result, and delete the workspace if the run succeeded.

## Live runs

`agent-team serve` runs the supervisor in the foreground until SIGINT or SIGTERM. When the
root member's adapter reports [protocol 2](adapters.md#session-adapters-protocol-2),
`agent-team --member ...` runs it through the supervisor: it submits to a running one, or
starts an in-process one if none is listening. An in-process supervisor listens on a
private `inproc-<pid>-<n>.sock` beside the shared socket, so another CLI never submits to it;
only `serve` listens on the shared path. The `claude` adapter speaks protocol 2, so a claude root member always runs this way; a v1 root's claude reports still run one-shot. For a v2 member, `--timeout` counts only the time the member is working, not time blocked in
`wait_for` or `ask_human` or idle between turns; past it the supervisor interrupts the session
and fails the member. A working member with no events for `defaults.stall_minutes` (default
10) is reported to its manager as `stalled`. `defaults.max_cost_usd` (default none) caps what a
run may spend, summed from the costs harnesses report; past it the whole run is paused, and
`resume` needs a higher cap. A member that has finished its work and does not exit within
10 seconds of being told to stop is ended and fails. Its reports are
started with the `delegate` tool and run in parallel, each in its own workspace. A v1 member
keeps the `{"status":"delegating"}` loop described under [Delegation](#delegation).

| What | Where | Override |
|---|---|---|
| Store | `~/.cache/agent-team/supervisor/supervisor.db` | `AGENT_TEAM_SUPERVISOR_DB` |
| Socket | `~/.cache/agent-team/supervisor/supervisor.sock` | `AGENT_TEAM_SUPERVISOR_SOCK` |

The cache root is `$XDG_CACHE_HOME` when set. The default `supervisor/` directory is set to
mode `0700` on every start, and the store file to `0600`, since it holds member tokens. A
socket directory named through `AGENT_TEAM_SUPERVISOR_SOCK` keeps its mode unless the
supervisor created it. Socket paths longer than 103 bytes are refused.

When `serve` starts, it adopts every run still marked running whose supervisor no longer
listens: its own runs from before a restart, and a CLI's run whose in-process supervisor
died. Members that were working are relaunched from their harness sessions in their own
workspaces, within the caps, with a note that their last turn was cut off; a manager is also
given its reports' states. A one-shot (v1) member cannot be resumed and fails. A run whose
project config can no longer be read fails with the reason. `serve` does not watch for
in-process supervisors that die while it runs; it adopts their runs at its next start.
A pause, cancel, or timeout that is still in progress when a supervisor stops is recorded as
it would have ended, so the restart does not relaunch that member. A claude member's adapter
that loses its supervisor interrupts claude's turn and kills claude within 4 seconds, so a
restarted supervisor never resumes a session that the old claude is still writing.
A run recorded before runs had an owner (written by an older agent-team) is failed, not
relaunched.

`defaults.max_parallel` (default 3) caps how many of one manager's reports run at once; the
rest queue. It is per manager, not per run, so a run with several managers can have more
members running. `serve` also caps running members across all runs at 6.

### Steering a live run

These verbs reach only a supervisor started with `agent-team serve`; a run that a CLI started
in-process cannot be steered from another terminal. Members are named by run id and name.

```
agent-team pause <run> <member> [--now] [--subtree]
agent-team resume <run> <member> [--subtree] [--note <text>] [--max-cost-usd <usd>]
agent-team cancel <run> <member> [--subtree]
agent-team questions [<run>] [--json]
agent-team answer <question-id> <answer>
agent-team attach <run> <member>
agent-team handback <run> <member>
```

`pause` lets the current turn finish, and that turn still counts toward the timeout: one that
runs past it fails the member as timed out. `--now` interrupts the turn, so a command it
started may have partly run. A member that has finished its work and is stopping cannot be
paused, but `cancel` still ends it. `resume` starts the member again from its harness session in the same workspace
and delivers anything sent to it while paused. `cancel` keeps the workspace. `--subtree`
applies the verb to the member and every report under it. Cancelling a manager also cancels
its unfinished reports, and a root member that finishes, fails, or is cancelled cancels every
unfinished member of its run, queued ones included. Pausing a manager alone leaves its reports
working. A one-shot (v1) report that is already running cannot be cancelled and runs until it
finishes. Each verb is signed with your OS
user name, which is what the member and its manager are told.

`attach` hands a claude member to you: its turn is interrupted, and once its process has
exited, `claude --resume <session>` starts in its workspace in your terminal. Its manager is
told it was taken over. Claude may first ask whether to trust the workspace folder. When you
exit claude, however you exit, the member resumes headless and is told that you drove the
session; your turns are in its history. While you have it, `pause` refuses it and a
supervisor restart leaves it alone. If `attach` dies before it can hand back (a closed
terminal, a stopped supervisor), the member stays taken over: run `attach` again to reopen the
same session, or `agent-team handback <run> <member>` to resume it headless. If the run is
at its `max_cost_usd` cap when you hand back (your turns cost too), the member stays paused
and `attach` or `handback` says so; resume it with `--max-cost-usd`. Taking over a codex member comes in a later plan.

## Resolving the agent

The dispatcher runs `adapters/<agent> probe`. A zero exit within 30 seconds means the agent is
available. For the vendor adapters, the probe runs `<cli> --version`, so it proves the binary
starts, not that it is logged in. The first real run is what proves credentials.

If the probe fails, the member runs on `defaults.on_unavailable` instead, and the result carries
a `warning` like `agent "codex" unavailable; fell back to "claude"`. If the fallback also fails
its probe, the dispatch is refused.

`distinct_from` is checked after fallback. See
[Configuration](configuration.md#distinct_from).

## Workspaces

A rival CLI sends whatever it reads to its vendor, so no member runs in your checkout.

A [`claude-cloud`](configuration.md#cloud-members) member is the exception: it gets no local
workspace, and the dispatcher checks `deny_paths` against what the session will clone instead.

**`none`** gets an empty temporary directory and no repository.

**`read-only`** and **`workspace`** get a filtered clone, built like this:

1. `git clone --depth 1 --single-branch --no-hardlinks file://<repo>`. This copies the
   last commit on your checked-out branch. Uncommitted changes are not in it, and a
   repository with no commits is refused.
2. Every tracked file matching `deny_paths` is deleted, along with any directory left empty.
   If every tracked file is denied, the dispatch is refused.
3. Submodules, `.gitmodules`, and every tracked symlink are removed.
4. What is left becomes a single orphan commit on branch `agent-team/<member>-<id>`. Other
   branches, the `origin` remote, remote refs and reflogs are deleted and the clone is
   garbage-collected. A denied file cannot be recovered from `HEAD~1` or the object store.

If any step fails, the partial clone is removed before the error is reported, since a
half-built clone is an unfiltered copy of the repository.

Clones live outside the repository, at:

```
${AGENT_TEAM_WORKSPACE_ROOT:-${XDG_CACHE_HOME:-~/.cache}}/agent-team/workspaces/<repo-hash>/<member>-<id>
```

`<repo-hash>` is the first 12 hex characters of the SHA-256 of the repository's absolute path.
Keeping clones out of the repository means the brief never reveals where the real repository is
through a relative path, and a `git add -A` in your checkout cannot pick one up. It does not stop
a CLI that already knows your repository's path from reading it directly.

### What happens to the workspace afterwards

| Outcome | Workspace |
|---|---|
| `status: "ok"` | Deleted, including for `workspace` members. The change survives only as `artifacts.diff` in the result. |
| `failed` or `timeout` | Kept, and its path returned in `workspace.dir` for you to inspect. |
| The dispatcher throws, such as a delegation outside the reporting line | Deleted, then the error is reported. |

## The brief

The adapter receives the brief as JSON on stdin. Its `task` field is the text the CLI is
prompted with, built from these sections in order, each present only when it applies:

1. The tool dialect, from `references/<dialect>-tools.md`. It maps Claude Code tool names to the
   vendor's own, so a skill written for Claude still reads correctly to Codex or Grok.
2. `# Your charter`, from `charter`.
3. `# How you work`, from `persona`.
4. The bound skill's `SKILL.md`, from `skill`.
5. `# Delegating`, for a member with reports.
6. `# Results from your reports`, when the member is called back after delegating.
7. `# Task`.

The brief also carries `cwd`, `read_only`, `deliverable`, `output_path`, `model`, `effort`,
`advisor`, `permission_mode`, `timeout_s`, `deny_paths`, `reports`, `can_delegate`, `depth` and
`max_depth` for the adapter to act on.

## Delegation

A member whose `reports_to` names another member is that member's direct report. When a manager
is below `max_depth`, its brief lists its reports and tells it to answer with this instead of a
deliverable when the work belongs to them:

```json
{"status":"delegating","delegations":[{"to":"<report>","task":"<their whole brief>"}]}
```

The dispatcher then:

- refuses a delegation to anyone who is not a direct report, and fails the whole dispatch;
- fails the manager's run if it delegates with an empty list, or at `max_depth`;
- runs each report in turn, each in its own fresh workspace, at one level deeper;
- calls the manager again with each report's `member`, `status` and `summary`;
- repeats until the manager returns something other than `delegating`.

Every adapter run, including each call back to a manager, spends one unit of
`max_delegations`. When the budget runs out, the current run fails with
`delegation budget exhausted`.

### Other teams

A report that is a [`team` member](configuration.md#other-teams) runs another project's team.
The dispatcher loads that project's config and runs its entry member at depth 0 of that
team, so the other team's `max_depth` bounds the tree below it. Each of its members works in
a filtered clone of its own repository, built with its own `deny_paths`.

Its runs still spend this dispatch's `max_delegations`. The other team starts with whichever
is smaller, its own `max_delegations` or what this dispatch has left, and what it uses comes
off this dispatch's budget.

The manager gets the entry member's `status` and `summary` back, like any report. The full
tree, including a worker's `artifacts.diff` in the other repository, is in the result under
the team member's `delegated`. Nothing is written to either checkout.

A delegation that reaches a project already in its chain, such as an iOS team delegating
back to the orchestrator that called it, is refused and fails the dispatch.

A team named by GitHub repository runs differently: no workspace is built, and its entry
member runs as one [cloud session](configuration.md#cloud-members) that cannot delegate. It
counts as one run against `max_delegations`.

### How an answer is read as a delegation

A vendor CLI returns plain text, so each vendor adapter reads the manager's final answer for
a delegation, and only when the brief allows delegating (`src/delegation.js`). After
trimming, the whole answer has to be the object above, either bare or as the only content of
one fenced block. Every entry needs a non-empty `to` and `task`.

Anything else is a deliverable, with one exception: an answer that contains
`"status":"delegating"` but does not meet that shape is reported as `failed` with a
`malformed delegation:` summary. A manager that wraps its delegation in prose is reported
rather than handed back as finished work. The cost is that a deliverable quoting that exact
string also fails.

The adapter only checks the shape. Whether each `to` names a direct report is checked by the
dispatcher, which refuses the whole dispatch when it does not.

## The result

`bin/agent-team.js` prints one JSON object and exits `0` if `status` is `ok`, `1` otherwise.
Config errors and dispatcher refusals come back in the same shape,
`{"status":"failed","summary":"<reason>"}`, rather than as a stack trace.

| Field | From | Meaning |
|---|---|---|
| `status` | adapter | `ok`, `failed`, or `timeout`. The dispatcher turns every `delegating` answer into more runs or a failure. |
| `summary` | adapter | The member's answer, or why the run failed. |
| `member`, `agent` | dispatcher | Who was asked and which agent actually ran it. |
| `warning` | dispatcher | Set when the member fell back to another agent. Otherwise `null`. |
| `artifacts.diff` | vendor adapter | `git diff HEAD` of the workspace after the run, including new files. Capped at 200,000 characters. |
| `artifacts.diff_truncated`, `diff_full_length` | vendor adapter | Whether the cap was hit, and the untruncated length. |
| `artifacts.diff_unreadable` | vendor adapter | The diff was too large for git's output buffer to capture at all. |
| `artifacts.branch` | vendor adapter | The workspace's branch. On an `ok` run the clone holding it has already been deleted. |
| `permission_denials` | claude adapter | Tools claude refused. On a `workspace` member any entry makes the run `failed`. |
| `findings`, `checked_sound` | vendor adapter | Always empty arrays from the shipped adapters. |
| `log_path` | vendor adapter | The CLI's full output, under a `agent-team-<vendor>-*` directory in the system temp directory. Large; search it rather than reading it whole. |
| `stderr` | runtime | The adapter's stderr. |
| `workspace` | dispatcher | `dir`, `branch`, `id`, `kind`. `dir` no longer exists after an `ok` run. |
| `unmatchedDenyPaths` | dispatcher | `deny_paths` entries that won no file. See [Configuration](configuration.md#deny_paths). |
| `droppedSymlinks` | dispatcher | Tracked symlinks removed from the workspace. If the task needed one, this is why it failed. |
| `depth` | dispatcher | `0` for the member you dispatched. |
| `model`, `advisor` | dispatcher | The member's configured `model` and `advisor`, or `null`. |
| `usage` | claude adapter | Duration, turns, cost, per-model tokens and advisor calls. A manager's rounds are summed. See [claude](adapters.md#claude). |
| `elapsed_ms` | dispatcher | Wall time for the member, including the reports it waited on. |
| `delegated` | dispatcher | Full results of every report that ran, in order. |

A v1 adapter is killed, with its whole process group, when `--timeout` expires (900 seconds by
default), and the result is `status: "timeout"`. A v2 member's timeout counts only its
working time; past it the supervisor interrupts the session, kills the adapter if it has not
exited 5 seconds later, and fails the member. See [Live runs](#live-runs).

## The run log

Each top-level dispatch appends one line to
`~/.cache/agent-team/runs/<repo-key>.jsonl` (under `$XDG_CACHE_HOME` or
`$AGENT_TEAM_WORKSPACE_ROOT` when set). The key is a hash of the repository's shared git
directory, so every worktree and subdirectory of a repo writes to the same log, and a report
run from the main checkout includes delegations started in a desktop-app worktree.

Another team's runs are logged in the dispatching project's log, nested under the `team`
member, whose row shows `team` in the model column. They are not also written to the other
project's log.

A line holds `v`, `at` (when the dispatch started), `project`, `task` (first 200
characters) and `tree`. Each node of `tree` keeps `member`, `agent`, `model`, `advisor`,
`status`, `summary` (first 300 characters), `depth`, `elapsed_ms`, `usage` and `delegated`.
Diffs, stderr and workspace paths are left out. A dispatch that throws, for example on a
config error, is logged as a `failed` node. If the log cannot be written, the run still
returns its result and a warning goes to stderr.

`agent-team report` reads the log:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-team.js" report [--project <dir>] [--all] [--json]
```

With no flags it prints the last delegation as a tree. Turns, cost and advisor calls on each
row are that member's own; `elapsed` includes the reports it waited on. `--all` prints
per-member totals: runs, failures (any status other than `ok`), median elapsed, total cost,
and runs that called the advisor out of runs whose transcript could be read. A manager whose
rounds mixed a readable and an unreadable transcript counts as readable, so the advisor rate is
approximate. `--json` prints the raw records.

Only delegations started through agent-team are logged. A member played by your own
interactive session, usually the orchestrator, never appears.

`/delegation` runs `report` from a hooks module (`hooks/register.ts`) and prints the output
without a model turn. `/agent-team:report` runs it from a skill.

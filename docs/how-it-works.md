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

The adapter is killed, with its whole process group, when `--timeout` expires (900 seconds by
default), and the result is `status: "timeout"`.

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

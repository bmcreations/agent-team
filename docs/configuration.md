# Configuration

agent-team reads one file per project: `.claude/agent-team.json`. `/agent-team-init` writes a
starter version. `src/config.js` validates it every time a member is dispatched and refuses the
whole file on the first error, naming the member and field.

```json
{
  "members": {
    "orchestrator": {
      "agent": "claude", "model": "claude-opus-5-5", "effort": "high",
      "charter": "Break an objective into scoped tasks for your reports, then combine their results into one decision. Does not implement.",
      "isolation": "read-only", "deliverable": "decision"
    },
    "worker": {
      "agent": "claude", "model": "sonnet", "reports_to": "orchestrator",
      "charter": "Make one scoped change and run the narrowest check that proves it.",
      "isolation": "workspace", "deliverable": "diff"
    },
    "reviewer": {
      "agent": "codex", "reports_to": "orchestrator",
      "isolation": "read-only", "deliverable": "review",
      "distinct_from": ["worker"]
    }
  },
  "deny_paths": ["**/.env*", "*.pem", "credentials/"],
  "defaults": { "on_unavailable": "claude", "max_depth": 1, "max_delegations": 12 }
}
```

## `members`

Required. An object keyed by member name. A name must start with a letter or digit, contain
only letters, digits, `_` or `-`, and be at most 64 characters, because it becomes part of a
directory name and a git branch name.

| Field | Required | Default | What it does |
|---|---|---|---|
| `agent` | yes | | Which adapter runs the member: `claude`, `codex`, `grok`, or `mock`. Any name with an executable in `adapters/` works. |
| `isolation` | no | `read-only` | What the member can see and change. See [Isolation](#isolation). |
| `deliverable` | no | depends on `isolation` | One of `diff`, `review`, `document`, `decision`. Told to the member in its brief. Defaults to `document` for `none`, `review` for `read-only`, `diff` for `workspace`. |
| `charter` | no | | What the member is for. Sent as the brief's `# Your charter` section. |
| `persona` | no | | How the member works. Sent as the brief's `# How you work` section. |
| `title` | no | the member name | Display name passed in the brief. |
| `skill` | no | | Name of a skill in this plugin's `skills/` directory. Its `SKILL.md` is inlined into the brief. |
| `output_path` | no | | A path, relative to the workspace, for the member to write its deliverable to. Absolute paths and `.` or `..` segments are refused. |
| `reports_to` | no | | The member this one reports to. Builds the [reporting tree](how-it-works.md#delegation). Unknown managers and cycles are refused at load. |
| `distinct_from` | no | | Array of member names this member must not share an agent with. See [`distinct_from`](#distinct_from). |
| `model` | no | the CLI's default | Passed to the CLI as written. An alias like `sonnet` follows the CLI's own resolution; a full model ID pins it. |
| `effort` | no | the CLI's default | Reasoning effort, passed to the CLI as written. See [Effort](#effort). |
| `advisor` | no | the user's `advisorModel` | Claude only. See [Advisor](#advisor). |
| `permission_mode` | no | `auto` | Claude only, and only on `workspace` members. See [Permission mode](#permission_mode). |

The loader checks the type of `model`, `effort`, `advisor` and `permission_mode` (a
non-empty string), not whether the value exists. A bad value fails on the member's first
run, not at load.

### Isolation

| Value | What the member gets | Can it write? |
|---|---|---|
| `none` | An empty temporary directory. No repository at all. | Yes, to the scratch directory. |
| `read-only` | A filtered clone of the repository. | No. The adapter runs the CLI in its read-only mode. |
| `workspace` | A filtered clone on its own branch. | Yes. Changes come back as a diff. |

`read-only` and `workspace` build the same filtered clone. The difference is the `read_only`
flag in the brief, which each adapter turns into its CLI's sandbox or permission setting (see
[Adapters](adapters.md)). Nothing is ever written back to your checkout. How the clone is built
is in [How it works](how-it-works.md#workspaces).

`worktree` is not a valid value. It was renamed to `workspace` before this config shape shipped.

### `distinct_from`

`distinct_from` compares agents, not members. A reviewer with `"distinct_from": ["worker"]` is
refused if it would run on the same agent the worker ran on, including when `on_unavailable`
fell the reviewer back to that agent. The check runs after fallback, against members already
resolved earlier in the same dispatch.

That timing is why two members on the same agent in a manager/report pair should not name each
other. The dispatcher records the manager's agent before its reports run, so a report with
`distinct_from: ["<its manager>"]` on the same agent is refused every time it is delegated to.

The value must be an array. `"distinct_from": "worker"` is refused with a suggestion, and a name
that is not a configured member is refused rather than ignored.

### Effort

`effort` levels are the vendor's, not this config's:

| agent | flag | levels |
|---|---|---|
| claude | `--effort` | low, medium, high, xhigh, max |
| grok | `--reasoning-effort` | none, minimal, low, medium, high, xhigh, max, or a per-model menu id |
| codex | `-c model_reasoning_effort=<level>` | unverified against a real codex run |

A model may accept only part of its vendor's range.

### Advisor

`advisor` sets Claude Code's `advisorModel` for this member's run, through
`--settings '{"advisorModel":"<value>"}'`. Without it, a claude member inherits whatever the
user's `~/.claude/settings.json` sets. `fable`, `opus` and `sonnet` are values Claude Code
accepts. A claude member with `advisor` set also gets an `# Advisor` section in its brief,
just before the task, telling it to call the advisor before its first edit and again before its
final answer.

Claude Code skips the advisor, without failing the run, when it is less capable than the
member's model, when the account does not have the feature, or on a third-party provider. A
codex or grok member may carry `advisor`; it only takes effect if `on_unavailable` falls that
member back to claude.

The `advisor` column of `/delegation` shows how many times each claude member called it.

### `permission_mode`

Sets `--permission-mode` for a claude member with `isolation: "workspace"`. It defaults to
`auto`, because headless `claude -p` refuses every tool call that would prompt, and a member with
no mode cannot edit its clone. `acceptEdits` allows file edits but no shell commands.

The loader refuses `permission_mode` on `read-only` and `none` members, which always run in
`plan`. If claude refuses any of a workspace member's tool calls, the run reports
`status: "failed"` with the refused tools in `permission_denials`, and the workspace is kept.

## `deny_paths`

Required, and must be a non-empty array. The loader refuses an empty list rather than
defaulting one, because a rival CLI runs in the member's tree and ships context to a third
party.

Entries use gitignore syntax and are matched against tracked files by `git check-ignore`, so a
bare name matches at any depth, `dir/` matches a directory, and globs work. Matching follows the
clone's `core.ignorecase`, and each path is also tried in its NFC-normalised form.

Three forms are refused at load because they would not do what they look like:

| Entry | Why it is refused | Write instead |
|---|---|---|
| `./secrets` or `../secrets` | A leading `./` or `../` never matches under gitignore rules. | `secrets` |
| `#notes` | A leading `#` makes the line a comment. | `\#notes` |
| `!keep.pem` | Negation is not supported. The entry would be booked as a deny hit and delete the path, not exempt it. | Narrow the other entries instead. |

An entry that matches no tracked file is not an error, since one config is often reused across
projects. Each run lists it in `unmatchedDenyPaths` and prints a warning. An entry can also land
there when it matches files but a more specific entry wins every one of them, because
`check-ignore` reports only the winning pattern per path.

Tracked symlinks are always removed from the clone, whatever `deny_paths` says. A name-based
denylist cannot see where a symlink points.

## `defaults`

Optional.

| Field | Default | What it does |
|---|---|---|
| `on_unavailable` | `claude` | The agent to use when a member's agent fails its probe. The run carries a `warning` saying so. If the fallback also fails its probe, the run is refused. |
| `max_depth` | `3` | How many levels below the dispatched member can be delegated to. `0` turns delegation off. |
| `max_delegations` | `20` | Total adapter runs allowed across one dispatch, counting the dispatched member and every call back to a manager. Minimum `1`. |

`/agent-team-init` writes `max_depth: 1` and `max_delegations: 12`, which lets the orchestrator
delegate and stops its reports from delegating further.

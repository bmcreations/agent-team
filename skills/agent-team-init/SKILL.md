---
name: agent-team-init
description: Use when setting up agent-team in a project for the first time — writes .claude/agent-team.json with a starter member table and a seeded denylist.
user-invocable: true
allowed-tools: [Bash, Read, Write, Glob]
---

# Initialise agent-team for this project

## Step 1 — refuse to overwrite

If `.claude/agent-team.json` exists, show it and stop. Ask before changing a working config.

## Step 2 — find what must never leave the repo

Search the project for credential-shaped paths and list what you find to the user:

```bash
git ls-files | grep -iE '(credential|secret|keystore|\.jks$|\.p8$|\.p12$|\.pem$|\.mobileprovision$|\.env)' | head -50
```

Everything found goes in `deny_paths`. A rival CLI runs in this tree and ships context to a third
party, so a missed path is a credential disclosure. The loader rejects a config with an empty
denylist; do not work around that.

## Step 3 — probe which agents are actually available

```bash
for a in claude codex grok; do "${CLAUDE_PLUGIN_ROOT}/adapters/$a" probe >/dev/null 2>&1 \
  && echo "$a: binary found" || echo "$a: unavailable"; done
```

This checks only that the adapter's binary exists and starts cleanly — via `PATH`, or for codex
and grok the `AGENT_TEAM_CODEX_BIN` / `AGENT_TEAM_GROK_BIN` override. It does not check whether the CLI is authenticated. Report it to
the user as exactly that: "binary found" means the binary was found, not that a run against it will
succeed. There is no separate authentication probe to add here — there isn't a general one, and each
vendor CLI signals a login failure differently — so say plainly that the first real `/delegate` run
against a member is what actually proves its credentials.

Assign unavailable agents anyway if the user wants them — `on_unavailable` degrades to Claude with a
warning — but tell the user which members will not run as configured, and which only passed the
binary-found check above.

The claude probe does not check the advisor either. An installed CLI that does not rank a member's
model for the advisor runs the member without one, and the run still succeeds. If the user wants
to confirm the advisor is used, a one-line run shows it:

```bash
claude -p "Reply with the single word: ok" --model claude-opus-5-5 \
  --settings '{"advisorModel":"fable"}' --debug-file /tmp/advisor.log
grep '\[AdvisorTool\]' /tmp/advisor.log
```

"Server-side tool enabled with ... as the advisor model" means the advisor is on; a line starting
"Skipping advisor - " gives the reason it is not.

## Step 4 — write the config

```json
{
  "members": {
    "orchestrator": {
      "agent": "claude", "model": "claude-opus-5-5", "effort": "high", "advisor": "fable",
      "charter": "Break an objective into scoped tasks for your reports, then combine their results into one decision. Does not implement.",
      "isolation": "read-only", "deliverable": "decision"
    },
    "explorer": {
      "agent": "claude", "model": "sonnet", "effort": "medium", "advisor": "fable",
      "reports_to": "orchestrator",
      "charter": "Locate code and report it as path:line. Never edits.",
      "isolation": "read-only", "deliverable": "document"
    },
    "worker": {
      "agent": "claude", "model": "sonnet", "effort": "medium", "advisor": "fable",
      "reports_to": "orchestrator",
      "charter": "Make one scoped change and run the narrowest check that proves it.",
      "isolation": "workspace", "deliverable": "diff"
    },
    "researcher": {
      "agent": "claude", "model": "sonnet", "effort": "medium", "advisor": "fable",
      "reports_to": "orchestrator",
      "charter": "Answer from outside sources, with a cited URL next to each claim.",
      "isolation": "none", "deliverable": "document"
    }
  },
  "deny_paths": ["<everything found in step 2>", "**/.env*"],
  "defaults": { "on_unavailable": "claude", "max_depth": 1, "max_delegations": 12 }
}
```

`max_depth: 1` lets the orchestrator delegate and stops its reports from delegating further.

`isolation` is one of `none` (no repo at all — a scratch directory), `read-only` (a filtered clone
the result is read from, not written back), `workspace` (a filtered clone on its own branch). It is
never `worktree` — that isolation level was renamed before this config shape shipped.

Every starter member runs on claude. To get a second vendor's review of the worker's diff, offer
the user a member like this one, added under `members`:

```json
"reviewer": {
  "agent": "codex", "reports_to": "orchestrator",
  "isolation": "read-only", "deliverable": "review",
  "distinct_from": ["worker"]
}
```

`distinct_from` compares agents, not members: it refuses to run the reviewer on the same agent the
worker ran on, including when `on_unavailable` falls the reviewer back to claude. That is also why
`worker` does not carry `distinct_from: ["orchestrator"]` — both run on claude, and the dispatcher
records the orchestrator's agent before its reports run, so the worker would be refused every time
the orchestrator delegated to it.

`model` and `effort` are optional and passed to the member's CLI as written. Leave either out to
get that CLI's default. A model alias such as `sonnet` follows the CLI's own resolution and can
change when the CLI updates; a full model ID pins it. `effort` levels are the vendor's, not this
config's:

| agent  | flag                                | levels                                                  |
|--------|-------------------------------------|---------------------------------------------------------|
| claude | `--effort`                          | low, medium, high, xhigh, max                           |
| grok   | `--reasoning-effort`                | none, minimal, low, medium, high, xhigh, max, or a per-model menu id |
| codex  | `-c model_reasoning_effort=<level>` | unverified against a real codex run                     |

A model may accept only part of its vendor's range. The loader checks that `effort` is a string,
not that the level exists, so a bad level fails on the member's first run.

`advisor` is optional and only used when the member runs on claude. It sets Claude Code's
`advisorModel` for that member's run, so a member can get a different advisor from the one in
the user's `~/.claude/settings.json`, which every claude member already inherits. The starter sets
it on every member so the team gets an advisor whether or not the user's settings name one.
`fable`, `opus`, and `sonnet` are valid values. Claude Code skips
the advisor, without failing the run, when it is less capable than the member's model, when the
account does not have the feature, or on a third-party provider. A codex or grok member with an
advisor ignores it unless `on_unavailable` falls it back to claude.

`permission_mode` is optional and sets `--permission-mode` for a claude member with
`isolation: "workspace"`. It defaults to `auto`; without a mode, headless `claude -p` refuses every
tool call that would prompt, so the member cannot edit its clone. Set it to `acceptEdits` to allow
file edits but no shell commands. The loader refuses it on `read-only` and `none` members, which
always run in `plan`. If claude refuses any of a workspace member's tool calls, the run reports
`status: failed` with the refused tools listed in `permission_denials`, and its workspace is kept.

## Step 5 — confirm it loads

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/config.js').then(m=>console.log(m.loadConfig(process.cwd())))"
```

Then add `.claude/workspaces/` to `.gitignore` if it is not already there. Workspaces are created
outside the repository, under the cache root, so nothing under `.claude/workspaces/` should ever
exist to be committed — this line is belt-and-braces, not a fix for a real leak.

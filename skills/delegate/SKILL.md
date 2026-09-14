---
name: delegate
description: Use when a task should be handled by a specific team member rather than inline — implementation, review, research, red-teaming, or QA. Routes the task to whichever agent the project's config assigns to that member.
user-invocable: true
argument-hint: "<member> <task description>"
allowed-tools: [Bash, Read]
---

# Delegate to a member

Run the task through the project's member configuration rather than picking an agent yourself.

## Step 1 — check the project is configured

Read `.claude/agent-team.json`. If it is missing, stop and tell the user to run `/agent-team-init`.

## Step 2 — dispatch

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-team.js" --member <member> --task "<task>"
```

## Step 3 — report

The command returns one JSON object. Report to the user:

- `summary`, and `findings` if present
- `checked_sound` if present — a red-team run reporting only problems gives no coverage signal
- `warning` if the member fell back to another agent, stated plainly
- `agent`, so the user knows who did the work
- `artifacts.branch` — the work is on a branch and is **not merged**
- `unmatchedDenyPaths`, if present and non-empty — these deny_paths entries matched nothing in
  this repo — confirm you meant them. Expected when a config is reused across projects.
- `droppedSymlinks`, if present and non-empty — these tracked symlinks were removed from the
  workspace; if the member's task needed one, that is why it failed.

Read `log_path` only if `status` is not `ok`, and grep it rather than reading it whole. It holds the
agent's full session output and will swamp your context.

## Do not

- Merge the branch. The user reviews it.
- Re-run a member that failed a `distinct_from` check by editing the config to get past it. The
  constraint exists so an agent does not review its own work.
- Name a member that is not in the config. Run `agent-team org` to see who exists.

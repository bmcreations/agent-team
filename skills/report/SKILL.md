---
name: report
description: Use when the user asks how a delegation went — which members ran, on which models, how long, what it cost, and whether they called the advisor. Prints the last delegation as a tree, or per-member totals.
user-invocable: true
argument-hint: "[--all]"
allowed-tools: [Bash]
---

# Delegation report

Run the report for the current project. Pass `--all` through if the user asked for totals across runs.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-team.js" report $ARGUMENTS
```

Show the output to the user in a code block, unchanged. Then add at most two sentences on anything that stands out: a failed or timed-out member, a member far costlier than the rest, or advisor calls at zero for a member that has an advisor set.

Do not:
- Recompute or reformat the table.
- Read the run log file directly. The CLI handles torn lines and finds the log for every worktree of the repo.
- Treat a missing row as a member that did nothing. Only delegations run through agent-team are logged; a member played by an interactive session never appears.

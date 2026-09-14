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

This checks only that the adapter's binary exists and starts cleanly — via `PATH` or its
`AGENT_TEAM_<VENDOR>_BIN` override. It does not check whether the CLI is authenticated. Report it to
the user as exactly that: "binary found" means the binary was found, not that a run against it will
succeed. There is no separate authentication probe to add here — there isn't a general one, and each
vendor CLI signals a login failure differently — so say plainly that the first real `/delegate` run
against a member is what actually proves its credentials.

Assign unavailable agents anyway if the user wants them — `on_unavailable` degrades to Claude with a
warning — but tell the user which members will not run as configured, and which only passed the
binary-found check above.

## Step 4 — write the config

```json
{
  "members": {
    "coo": {
      "title": "COO",
      "agent": "claude",
      "charter": "Decompose an objective into work for the team. Does not implement.",
      "isolation": "none",
      "deliverable": "decision"
    },
    "eng-lead":    { "agent": "claude", "reports_to": "coo", "isolation": "read-only" },
    "implementer": { "agent": "codex",  "reports_to": "eng-lead", "isolation": "workspace" },
    "reviewer":    { "agent": "grok",   "reports_to": "eng-lead", "isolation": "read-only",
                     "distinct_from": ["implementer"] },
    "qa":          { "agent": "claude", "reports_to": "eng-lead", "isolation": "workspace" },
    "designer":    { "agent": "claude", "reports_to": "coo", "isolation": "none",
                     "deliverable": "document", "output_path": "docs/design" },
    "marketer":    { "agent": "claude", "reports_to": "coo", "isolation": "none",
                     "deliverable": "document", "output_path": "docs/marketing" }
  },
  "deny_paths": ["<everything found in step 2>", "**/.env*"],
  "defaults": { "on_unavailable": "claude", "max_depth": 3, "max_delegations": 20 }
}
```

`isolation` is one of `none` (no repo at all — a scratch directory), `read-only` (a filtered clone
the result is read from, not written back), `workspace` (a filtered clone on its own branch). It is
never `worktree` — that isolation level was renamed before this config shape shipped.

`coo`, `designer`, and `marketer` are the non-engineering members in this starter table. They exist
to show the shape a member outside the implementation chain takes — a `none` isolation, a `document`
or `decision` deliverable, no repo access at all — not because every project needs a COO, a designer,
and a marketer. Tell the user these three are placeholders: edit their charters to fit the project,
or delete them outright, rather than leaving them in place unexamined.

## Step 5 — confirm it loads

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/config.js').then(m=>console.log(m.loadConfig(process.cwd())))"
```

Then add `.claude/workspaces/` to `.gitignore` if it is not already there. Workspaces are created
outside the repository, under the cache root, so nothing under `.claude/workspaces/` should ever
exist to be committed — this line is belt-and-braces, not a fix for a real leak.

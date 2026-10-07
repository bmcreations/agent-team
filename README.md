# agent-team

Delegate a task to a named team member and let a per-project config decide which agent
CLI runs it — Codex, Grok, or Claude.

A member is more than a vendor pick. It carries a charter, a deliverable kind, and a place
in a reporting tree. A member with reports can answer with delegations instead of a
deliverable; the dispatcher runs those against its direct reports only, then calls the
member back with the results so it can synthesise. Tree depth and total adapter runs are
capped separately. A manager delegates by answering with nothing but a JSON object; the
exact rule is under [Delegation](docs/how-it-works.md#delegation).

A rival CLI ships whatever it can read to a third party, so every member runs in a filtered
clone: a shallow clone with the denied paths deleted and history flattened to one orphan
commit, so a secret is not recoverable from `HEAD~1` either. A config with an empty denylist
is refused rather than defaulted.

## Requirements

- Claude Code, to load the plugin and run `/agent-team-init` and `/delegate`.
- Node 22 or later.
- git, which builds every member's workspace.
- The CLI for each vendor you route a member to: `claude`, `codex`, or `grok`.

## Install

agent-team is a Claude Code plugin served from its own marketplace in this repository:

```
/plugin marketplace add bmcreations/agent-team
/plugin install agent-team@agent-team
```

The plugin runs from Claude Code's plugin cache, not from a checkout. There is no npm
package and no `agent-team` command on `PATH`.

## Quick start

In the project you want a team for:

1. Run `/agent-team-init`. It searches the repository for credential-shaped paths, probes
   which vendor CLIs are installed, and writes `.claude/agent-team.json` with an
   orchestrator and three reports.
2. Read the `deny_paths` it wrote. Anything missing from that list can be sent to a third
   party.
3. Run `/delegate <member> <task>`, for example
   `/delegate explorer where is the retry policy configured?`.

`/delegate` reports the member's summary, which agent ran it, and any fallback warning.
For a `workspace` member the change comes back as a diff in `artifacts.diff`; nothing is
written to your checkout.

To see how the last delegation went, run `/delegation` (or `/delegation --all` for
per-member totals across runs):

```
2026-10-07T12:00:00.000Z  Implement Slice 2 (Edit Profile)

member        model              status  elapsed  turns   cost  advisor
orchestrator  claude-opus-5-5    ok       15m00s     18  $1.84        2
├ worker      claude-sonnet-5-5  ok        6m40s     37  $1.12        0
└ reviewer    claude-opus-5-5    ok        2m55s     21  $0.97        2

total 15m00s  $3.93  advisor calls 4
```

`/delegation` prints straight into the transcript without a model turn. `/agent-team:report`
prints the same table through a skill, for surfaces that do not load plugin hooks modules.

To see the reporting tree for a config:

```bash
node ~/.claude/plugins/cache/agent-team/agent-team/<version>/bin/agent-team.js org
```

## Documentation

- [Configuration](docs/configuration.md): every member field, `defaults`, and `deny_paths`
  rules.
- [How it works](docs/how-it-works.md): workspaces, delegation, fallback, the result
  a run returns, and the run log behind `/delegation`.
- [Adapters](docs/adapters.md): the contract a vendor adapter implements, each shipped
  adapter's flags, and the conformance suite.
- [Design spec](docs/superpowers/specs/2026-09-14-agent-team-design.md): the original
  design, its rejected alternatives, and open questions. It predates the JSON config
  and the rename of `worktree` isolation to `workspace`.

## Adapter status

The runtime ships four adapters: claude, codex, grok, and mock. Each is checked against a
conformance suite, but the suite accepts a graceful failure as conformant, so passing it
proves the adapter honours the contract rather than that it works end to end. Codex has been
exercised against a run that reached the model; grok has not, so its success-response parser
is still unverified against a real payload.

Two things to know about grok before routing a member to it. Its `--sandbox read-only`
profile is what backs `isolation: read-only`, and it refuses to start when it cannot resolve
a deny path — which includes `/var/run/docker.sock` as Docker Desktop installs it, as a
symlink. That is a failure closed, not open: the member's run fails rather than proceeding
unprotected. And its prompt must be passed with `-p`; a bare positional argument opens the
interactive interface instead and dies outside a terminal with an error naming neither cause.

The codex and grok adapters resolve their CLI from `PATH`, with `AGENT_TEAM_CODEX_BIN` and
`AGENT_TEAM_GROK_BIN` as overrides. That override is not decoration — neither Codex nor Grok
necessarily installs onto a login shell's `PATH`, and Codex may expose its binary only from
inside the app bundle. The claude adapter has no override and always runs `claude` from
`PATH`.

## Development

```bash
npm test
```

The suite uses `node --test` and needs git. It runs the vendor adapters against fake
binaries; set `AGENT_TEAM_CONFORMANCE=codex,grok` to also require a successful run against
the real CLIs.

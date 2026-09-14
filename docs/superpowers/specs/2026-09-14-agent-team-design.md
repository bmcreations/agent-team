# agent-team: role-based delegation across rival agent CLIs

Date: 2026-09-14
Status: approved, unimplemented

## The problem

Claude Code can already vary the model per subagent, but that is one vendor and
one set of blind spots. An agent reviewing work produced by the same model family
shares the failure modes it is supposed to catch. The interesting version of a
"team" is cross-vendor: Codex writes, Grok attacks, Claude coordinates.

Nothing on this machine supports that today. There is no `codex`, `gemini`,
`cursor-agent`, `aider`, `opencode`, `goose`, or `llm` on `PATH`, and the only
provider variable in the environment is `ANTHROPIC_BASE_URL`. Meanwhile
`CLAUDE_CODE_SUBAGENT_MODEL: sonnet` pins every subagent globally, so task
specialisation is currently a single knob with a single setting.

The second half of the problem is distribution. There are roughly a dozen
projects under `~/dev/bmcreations/`, spanning Android, iOS, Solana, and web. A
delegation setup that lives in one repo's `.claude/` is not a capability, it is a
snowflake. Five third-party plugin marketplaces are already installed, so the
mechanism for sharing this is proven and unused for anything home-grown.

## Decisions

### Roles, not vendors

Skills and briefs name a role. A per-project config maps the role to an agent.

```toml
# .claude/agent-team.toml
[roles.implementer]  agent = "claude"  model = "opus"
[roles.reviewer]     agent = "codex"   isolation = "read-only"
[roles.red-team]     agent = "grok"    skill = "red-team"  distinct_from = ["implementer"]
[defaults]           on_unavailable = "claude"
```

Chosen over explicit `/codex` and `/grok` commands, which were simpler but bind
every skill to a vendor and therefore do not survive a move to a project where
that vendor is not set up. Chosen over heuristic auto-routing, which cannot be
reproduced or audited after the fact.

`on_unavailable` carries the reproducibility guarantee. A clone on a machine
with no xAI credentials still runs every skill, on Claude, with a warning. That
is the difference between a portable tool and one that only works here.

### `distinct_from` is a hard stop

The resolver refuses to assign a role to the agent that filled a role listed in
`distinct_from`. An unsatisfiable constraint warns and stops. It does not fall
back, because falling back silently produces exactly the self-review the
constraint exists to prevent, while reporting success.

### Each delegation gets its own git worktree

Rival CLIs edit files. Two agents in one checkout is a race, and a bad edit lands
on the branch you are on. Worktrees at `.claude/worktrees/<role>-<shortid>/`,
matching a convention several repos already use.

The `red-team` role turns this from hygiene into a requirement. Its procedure
instructs the agent to "break the thing deliberately and watch it catch that,
then restore". Deliberate sabotage is only safe in a throwaway tree.

Output is a branch and a diff. Nothing auto-merges.

### The adapter contract

One executable per vendor, three subcommands:

```
adapters/<vendor>  probe         exit 0 if installed AND authed; prints version
adapters/<vendor>  capabilities  {"write":true,"worktree":true,"structured_output":true}
adapters/<vendor>  run           brief on stdin, one result object on stdout
```

```json
// brief
{"role":"red-team","task":"…","cwd":"/…/worktrees/red-team-a1b2",
 "read_only":false,"timeout_s":900,"deny_paths":["…"]}

// result
{"status":"ok","summary":"…","findings":[…],"checked_sound":[…],
 "artifacts":{"branch":"…","diff":"…","handoff_path":"…"},"log_path":"…"}
```

Three properties the contract exists to enforce:

**The adapter owns vendor flags.** Callers never write `--json`, `-p`, or
`--ephemeral`. Both CLIs support structured headless output already — `codex exec
--json` streams JSONL turn and item events, `grok -p` runs headless — but those
spellings stay inside one file each. Adding Gemini later touches one file and no
skills.

**stdout is the contract; logs go to `log_path`.** A rival agent's build log must
never reach Claude's context. The failure is already familiar from Gradle: a raw
`./gradlew` run puts a whole build log into a subagent's context and it
summarises badly. Same failure, new vendors. Claude reads the summary, and greps
the log only when something failed.

**The dispatcher creates the worktree, not the adapter.** Isolation is then
identical across vendors and cannot be forgotten by a careless adapter.

`checked_sound` exists because the `red-team` procedure requires reporting what
was examined and found sound. Findings-only output gives no coverage signal.

### Secrets are excluded by construction

Repositories routinely hold a credentials directory, keystores, provisioning
profiles, and `.env` files that project instructions tell an agent never to read
or echo. Today that is a rule addressed to Claude. Once a rival CLI runs in the
same tree, it is signing keys read by a process that ships context to xAI or
OpenAI.

So the brief carries a mandatory `deny_paths`, and the dispatcher enforces it by
building the worktree without those paths rather than by passing a vendor sandbox
flag. The check becomes a fact about the filesystem, assertable in a test, rather
than trust in four vendors' security documentation read correctly.

`/agent-team init` seeds a default denylist and refuses to write a config without
one.

### Roles bind to skill files

A role may name a skill. The dispatcher inlines that `SKILL.md` into the brief.

This extends a principle that already holds inside Claude Code: a skill is
markdown instructions, so a subagent can read the `SKILL.md` and follow it even
when the slash command is not registered. The same holds past Claude, which turns
an installed skill library into vendor-portable assets.

The snag is vocabulary. Skills say `TodoWrite`, `Read`, `Skill`. Superpowers
already ships `references/codex-tools.md`, `gemini-tools.md`, and
`copilot-tools.md` mapping these per platform — `TodoWrite` to `update_plan`,
`Task` to `spawn_agent`. Each adapter declares a `tool_dialect`; the dispatcher
prepends the matching table to the brief. The format is reused rather than
reinvented, and `grok-tools.md` gets written because none ships.

## Roles

| Role | Job | Isolation |
|---|---|---|
| `implementer` | writes code, runs the build, iterates on failure | worktree, write |
| `reviewer` | reads a diff, returns structured findings | read-only |
| `researcher` | explores a codebase or corpus, returns a report | read-only |
| `red-team` | attacks the change, then writes a handoff document | worktree, write |
| `qa` | builds, drives the app, adds tests, reproduces the bug | worktree, write |

The registry is open. `[roles.anything]` resolves without a plugin change, so
five defaults do not become a ceiling.

`reviewer` and `red-team` are separate because the success criteria differ. A
reviewer asks whether the change is correct. A red-team run that reports "looks
fine" without having attempted an attack has failed, regardless of the diff.

`qa` has precedent already. Skills that build, install, and drive an app on a
simulator, and agents that hunt untested code, are this role today, written
Claude-only.

The `red-team` skill ships inside this plugin. It has no other home on disk, and
vendoring it keeps the procedure installable wherever the runtime that dispatches
it is installed.

## Failure modes

| Failure | Behaviour |
|---|---|
| CLI missing or unauthed | `probe` fails, fall back per `on_unavailable`, warn |
| `distinct_from` unsatisfiable | warn and stop |
| Timeout | kill the process group, `status:"timeout"`, keep the worktree |
| Adapter emits non-JSON | `status:"failed"`, retain `log_path`, do not crash the caller |
| Work left incomplete | capture the diff, never auto-merge |
| Success | prune the worktree; keep it on any failure |

## Testing

Real adapters cost money and return different text every run, so the logic worth
testing cannot depend on them.

A `mock` adapter is a shipped component, not a fixture. It reads a brief and
replays scripted responses, which makes resolution, `distinct_from`, fallback,
worktree lifecycle, denylist enforcement, timeout handling, and malformed output
testable offline and deterministically.

Real vendors get an opt-in conformance suite: an adapter must complete the
`probe` / `capabilities` / `run` round-trip against a fixture brief before it
counts as installed.

The denylist is asserted as a fact — the denied path is absent from the
constructed worktree.

## Phasing

**Phase 0, ACP spike, timeboxed.** The question is whether the Agent Client
Protocol removes per-vendor code or relocates it. Grok Build speaks ACP natively;
Codex's support is a community Rust bridge, so per-agent setup may survive the
move while becoming harder to debug.

Kill criterion: one Node script drives both `codex` and `grok` through a full
prompt-to-completion cycle, returning the final message and file changes, with
permission callbacks auto-approved, inside one working day. Missing it records
ACP as rejected with reasons and Phase 1 proceeds unchanged.

Two risks are expected. ACP is designed for interactive editors, so headless use
means implementing `session/request_permission` and the `fs/*` callbacks, which
is the UI-shaped work headless delegation does not need. And `codex exec --json`
already supplies turn and item events without a protocol layer.

**Phase 1, the runtime.** Role resolver, adapter contract, worktree lifecycle,
denylist, tool-dialect injection, and adapters for `claude`, `codex`, `grok`,
plus `mock`.

**Phase 2, packaging.** Marketplace repo, `/agent-team init`, the role skills,
the vendored `red-team` skill, `grok-tools.md`.

**Phase 3, MCP front-end, optional.** A thin server over the same scripts,
deliberately last. If the adapter contract is right this is a wrapper; if it is
wrong, building it early conceals that.

## Open questions

- **Neither CLI is installed or paid for.** Grok Build needs SuperGrok or X
  Premium+, or an xAI API key. Codex needs ChatGPT Plus or Pro, or an OpenAI key.
  Nothing past Phase 0 runs end to end until both exist. No subscription decision
  has been made.
- **No cost control is designed.** Nothing caps concurrency or spend across a
  fan-out of paid agents. This was not discussed and needs an answer before
  anything resembling a council role exists.
- **Grok Build ships its own git worktree integration.** Whether it cooperates
  with a dispatcher-created worktree or fights it is unverified, and it is the
  most likely Phase 1 surprise.
- **Per-role model pinning is unspecified.** The config accepts `model`, but
  which model each role should use has not been decided for any vendor.
- **The first consumer repo is not the owner.** Which roles a given project
  defines is left to that project's own config.

## Rejected

**Explicit `/codex` and `/grok` commands.** Simplest to build and read, but every
skill would hardcode a vendor, which defeats installing the same skill in a
project where that vendor is absent.

**Heuristic auto-routing.** Least typing, but routing decisions become
unreproducible and cost varies run to run.

**API-level adapters instead of CLIs.** Uniform and cheap, but models reached
over a bare API have no tools. They cannot run a build or iterate on a failure,
which removes most of the value of a second vendor.

**Read-only rival agents returning patches.** Tightest control, but a one-shot
patch from an agent that never ran the test suite is a guess, and the `red-team`
procedure is impossible without write access.

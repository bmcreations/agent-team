# agent-team

Delegate a task to a named team member and let a per-project config decide which agent
CLI runs it — Codex, Grok, or Claude.

A member is more than a vendor pick. It carries a charter, a deliverable kind, and a place
in a reporting tree. A member with reports can answer with delegations instead of a
deliverable; the dispatcher runs those against its direct reports only, then calls the
member back with the results so it can synthesise. Tree depth and total adapter runs are
capped separately.

A rival CLI ships whatever it can read to a third party, so every member runs in a filtered
clone: a shallow clone with the denied paths deleted and history flattened to one orphan
commit, so a secret is not recoverable from `HEAD~1` either. A config with an empty denylist
is refused rather than defaulted.

The runtime ships four adapters: claude, codex, grok, and mock. Codex is conformant against
a run that reached the model. Grok's adapter is built and passes the conformance contract,
but only on a failure path — grok is not authenticated on this machine, so its
success-response parser has never run against a real payload, and its `--sandbox read-only`
profile (the mechanism behind `isolation: read-only`) cannot be applied on a machine with
Docker Desktop installed, so grok fails closed rather than running unprotected.

Each vendor adapter resolves its CLI from `PATH`, with `AGENT_TEAM_<VENDOR>_BIN` as the
override for an install that is not on `PATH` — not hypothetical: on this machine codex
resolves only from inside the Codex app's plugin directory, and grok only from
`~/.grok/bin`.

The design, its rejected alternatives, and the open questions are in
[docs/superpowers/specs/2026-09-14-agent-team-design.md](docs/superpowers/specs/2026-09-14-agent-team-design.md).

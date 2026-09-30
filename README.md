# agent-team

Delegate a task to a named team member and let a per-project config decide which agent
CLI runs it — Codex, Grok, or Claude.

A member is more than a vendor pick. It carries a charter, a deliverable kind, and a place
in a reporting tree. A member with reports can answer with delegations instead of a
deliverable; the dispatcher runs those against its direct reports only, then calls the
member back with the results so it can synthesise. Tree depth and total adapter runs are
capped separately.

A vendor CLI returns plain text, so each vendor adapter reads the manager's final answer for
that delegation, and only when the brief allows delegating. After trimming, the whole answer
has to be the object `{"status":"delegating","delegations":[{"to":…,"task":…}]}`, either bare
or as the only content of one fenced block. Every entry needs a non-empty `to` and `task`.
Anything else is a deliverable, with one exception: an answer that contains
`"status":"delegating"` but does not meet that shape fails, so a manager that wraps its
delegation in prose is reported rather than handed back as finished work. The cost is that a
deliverable quoting that exact string also fails. Whether `to` names a direct report is still
checked by the dispatcher, which refuses the run outright when it does not.

A rival CLI ships whatever it can read to a third party, so every member runs in a filtered
clone: a shallow clone with the denied paths deleted and history flattened to one orphan
commit, so a secret is not recoverable from `HEAD~1` either. A config with an empty denylist
is refused rather than defaulted.

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

Each vendor adapter resolves its CLI from `PATH`, with `AGENT_TEAM_<VENDOR>_BIN` as the
override. That override is not decoration — neither Codex nor Grok necessarily installs onto
a login shell's `PATH`, and Codex may expose its binary only from inside the app bundle.

The design, its rejected alternatives, and the open questions are in
[docs/superpowers/specs/2026-09-14-agent-team-design.md](docs/superpowers/specs/2026-09-14-agent-team-design.md).

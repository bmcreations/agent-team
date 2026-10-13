# Task 8 report: restart recovery

Implemented as specified: store migration 2 (runs.owner), createRun owner, setRunOwner, runsWithStatus, requeueOffered; supervisor recover()/#recoverMember/#failRun/#owned, submit/#delegate/#launch persistence; serve calls recover(); test helper `store` option; docs.

Adaptations: `#launch` one-shot branch uses `run.budget.runs` (the `run` var already in scope) rather than `ctx.budget`; #target edits applied to the current Task 5 code. Otherwise snippets applied unchanged.

TDD: RED (before implementation) `node --import ./test/helpers/guard.js --test test/store.test.js test/recovery.test.js` failed with `sup.recover is not a function` (x4) and `store.setRunOwner is not a function`. GREEN: same command, 18/18 pass. Full `npm test`: pass 475, fail 0 (470 + 5 new; the brief's "473" was a plan-time estimate).

Files: src/store.js, src/supervisor.js, bin/agent-team.js, test/helpers/live.js, test/store.test.js, test/recovery.test.js, docs/how-it-works.md.
Polling loop in recovery tests has a 15 s deadline.

## Fix round 1
- Critical: recover() adopts runs whose owner is its own socketPath (serve listens before recovering). Test "a restart on the same socket path..." was RED first (recovered [] instead of [runId]; `supervise()` now takes `socketPath` and returns it), now green.
- Atomic adoption: new `store.claimRun(id, from, to)` (`UPDATE ... WHERE owner IS ?`, true when a row changed); recover() adopts only when it returns true, after the isListening check.
- Legacy runs with owner NULL are failed ("left by an older agent-team; start it again") rather than relaunched; test added; one sentence in docs/how-it-works.md.
- #failRun now closes the failed members' open questions (asserted in the legacy-run test).
- `npm test`: pass 477, fail 0 (RED before the fix: 2 failing of 6 in test/recovery.test.js).

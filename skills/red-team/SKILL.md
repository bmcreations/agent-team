---
name: red-team
description: Use when work is nominally complete and about to be handed off, reviewed, or merged — adversarially hunt for blind spots, unverified assumptions and silent failure modes, then produce a self-contained handoff document for the next reviewer. Also use when the user says "red team", "poke holes", "what are we missing", or asks for a handoff or review document.
---

# Red team, then hand off

Two passes over work that looks finished. The first tries to break it. The second writes down what
another agent needs in order to judge it without asking you anything.

Do them in order. The handoff is only honest if the red team ran first.

## Pass 1 — red team

You are looking for the things that will be true and undiscovered at 3am six months from now. Not
style, not preferences, not hypotheticals nobody will hit.

### The highest-yield question

**Which of your assertions have you watched fail?**

A guard, check, test or assertion is *unverified* until you have seen it go red. Verifying the
mechanism is not verifying the wiring — a check that is correct but never invoked, or invoked on the
wrong target, or that passes on an empty result set, reads as coverage while providing none. This is
the single most common defect in nominally-complete work, it is invisible in a green build, and it
tends to appear more than once in the same codebase.

For each one, establish concretely:

- Is it actually invoked? Inspect the real task graph, hooks or CI config — not the intent.
- Does it cover what it claims? Attaching to the wrong type or path silently skips the target.
- Does it fail closed? Finding nothing and reporting success is the same as being disabled.
- Prove it: break the thing deliberately and watch it catch that, then restore.

### Then work outward

- **Tests that cannot observe what they assert.** The classic is a test whose own act of observation
 creates the condition it checks. Ask what the test would do if the behaviour were absent.
- **Claims stronger than their evidence.** Headline numbers that describe a different environment
 than the reader assumes; "validated" where you mean "self-consistent"; guarantees the primitive
 does not actually provide.
- **Silent-and-wrong beats loud-and-broken.** Where does a failure return a plausible value rather
 than raise? Wrong-but-consistent is the expensive kind.
- **Supply chain.** Mutable pins (tags, branches, floating versions), unverified downloads, generated
 inputs that live outside version control and can change underneath you.
- **Diagnostics that destroy themselves.** Failure paths where the second occurrence is less
 informative than the first, so the reports you receive are the useless ones.
- **State left plausible but wrong.** Consumed, wiped, closed or moved-from objects that still answer
 questions instead of refusing.
- **Coverage asymmetry.** What runs on the developer's machine but not on the target? What runs on
 one platform, variant or path but not its sibling?
- **Unvalidated seams.** Interfaces designed against a specification rather than a caller. If nothing
 consumes it yet, say so — the shape is a guess until something does.
- **Decisions resting on open questions.** Anything already hardcoded while the question that governs
 it is unanswered.

### Reporting

Order by what you would fix first, not by category. Each finding states the concrete failure — inputs
or conditions, and what goes wrong — so the reader can judge it without re-deriving your reasoning.
Separate what you verified from what you suspect, and say which is which.

Include what you checked and found sound. A red team that reports only problems gives no signal about
coverage.

If you find nothing serious, say that plainly. Do not manufacture findings to look thorough.

## Pass 2 — handoff document

Write for an agent or engineer with **no prior context**: no access to the conversation, no knowledge
of what was tried and abandoned, no way to ask a follow-up question. Everything needed to review the
work must be in the document.

Cover, in whatever structure suits the work:

**What and why.** The problem being solved and why it matters. Enough that a reader can tell whether
a decision was reasonable without already knowing the answer.

**Key decisions and their reasoning.** Each significant choice, what it was chosen over, and the
evidence behind it — certificate numbers, measurements, file and line references, benchmark results.
A decision recorded without its reasoning is one the next person will silently re-litigate or
reverse. Include decisions that were reversed, and what changed your mind.

**Current state.** What is done, what is verified and by what evidence, what is stubbed, what has
never been run. Be exact about the difference between "implemented" and "tested" and "tested on the
real target".

**Open questions.** What is unresolved, who or what can resolve it, and what is blocked behind it.
Distinguish "we chose not to do this" from "we have not decided".

**Known risks.** Everything from pass 1 that is not fixed, plus structural risks a reader would not
see from the diff. State them plainly — a risk you soften is one the reviewer will not weigh.

### Rules

- **Self-contained.** No "as discussed", no unexplained internal shorthand, no links standing in for
 content the reader needs.
- **Evidence over assertion.** "999/999 vectors pass, JUnit XML in build/test-results" beats "well
 tested". Cite where a claim can be checked.
- **Uncertainty stays visible.** Where you are unsure, say so and say what would settle it. A handoff
 that reads as more confident than the work deserves is worse than no handoff.
- **Nothing invented.** If something was not verified, it goes under what has not been run.

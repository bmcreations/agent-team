# Codex Tool Mapping

Skills in this library are written against Claude Code's tool names. Use your
native equivalent for each.

| Skill references | What to use |
|---|---|
| `Read`, `Write`, `Edit` | your native file tools |
| `Bash` | your native shell tool |
| `Grep`, `Glob` | your native search tools |
| `TodoWrite` | `update_plan` |
| `Skill` (invoke a skill) | the skill text is already inlined below; just follow it |
| `Task` / subagent dispatch | `spawn_agent` / `wait_agent` / `close_agent` |

If a skill instructs you to use a tool you do not have, do the equivalent work
with what you do have and record the substitution in your result summary. Do not
silently skip the step.

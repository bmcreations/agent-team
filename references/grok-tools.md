# Grok Tool Mapping

Skills in this library are written against Claude Code's tool names. Use your
native equivalent for each.

| Skill references | What to use |
|---|---|
| `Read`, `Write`, `Edit` | your native file tools |
| `Bash` | your native shell tool |
| `Grep`, `Glob` | your native search tools |
| `TodoWrite` | your native plan or task-tracking tool, if you have one |
| `Skill` (invoke a skill) | the skill text is already inlined below; just follow it |
| `Task` / subagent dispatch | your native subagent mechanism, if you have one; otherwise do the work inline and say so |

If a skill instructs you to use a tool you do not have, do the equivalent work
with what you do have and record the substitution in your result summary. Do not
silently skip the step.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { resolveMember } from './resolve.js';
import { createWorkspace, pruneWorkspace } from './workspace.js';
import { buildBrief, loadDialect } from './brief.js';
import { runAdapter, DEFAULT_TIMEOUT_MS } from './adapter.js';

const adapterPath = (dir, agent) => join(dir, agent);

function makeProbe(adapterDir, env) {
  return (agent) => {
    const p = adapterPath(adapterDir, agent);
    if (!existsSync(p)) return false;
    try {
      // probe must be cheap; a non-zero exit means the agent is unusable, not an error
      execFileSync(p, ['probe'], { stdio: 'pipe', env: { ...process.env, ...env }, timeout: 30_000 });
      return true;
    } catch { return false; }
  };
}

async function readCapabilities(adapterDir, agent, env) {
  const res = await runAdapter(adapterPath(adapterDir, agent), 'capabilities', { env });
  return res.status === 'failed' ? {} : res;
}

export async function dispatch({
  projectRoot, member, task, adapterDir, assignments = {},
  skillsDir = null, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const config = loadConfig(projectRoot);
  const budget = { runs: config.defaults.max_delegations };
  return runMember({
    config, projectRoot, member, task, adapterDir,
    assignments: { ...assignments }, skillsDir, env, timeoutMs, budget, depth: 0
  });
}

async function runMember(ctx) {
  const { config, projectRoot, member, task, adapterDir, assignments,
          skillsDir, env, timeoutMs, budget, depth } = ctx;

  const probe = makeProbe(adapterDir, env);
  const resolved = resolveMember(config, member, { probe, assignments });  // throws before side effects
  assignments[member] = resolved.agent;

  const caps = await readCapabilities(adapterDir, resolved.agent, env);
  const dialectText = loadDialect(caps.tool_dialect ?? resolved.agent);

  let skillText = null;
  if (resolved.skill) {
    if (!skillsDir) {
      throw new Error(`member "${member}" binds skill "${resolved.skill}" but no skillsDir was provided`);
    }
    const p = join(skillsDir, resolved.skill, 'SKILL.md');
    if (!existsSync(p)) {
      throw new Error(`member "${member}" binds skill "${resolved.skill}" but ${p} is missing`);
    }
    skillText = readFileSync(p, 'utf8');
  }

  const workspace = createWorkspace(projectRoot, member, config.deny_paths, resolved.isolation);
  // The same agent-team.json commonly gets reused across projects, so a deny_paths entry
  // matching nothing in this particular repo is not itself an error (see workspace.js).
  // But it is worth an operator's attention — it may mean the entry was meant to match
  // here and doesn't (e.g. a rename, or a scope narrower than intended) — so surface it
  // loudly rather than leaving it reachable only via workspace.unmatchedDenyPaths.
  const unmatchedDenyPaths = workspace.unmatchedDenyPaths ?? [];
  if (unmatchedDenyPaths.length > 0) {
    // Not necessarily "matched nothing": check-ignore -v reports only the winning pattern
    // per path, so an entry lands here either because it truly matched no tracked file, or
    // because a more specific overlapping entry won arbitration for every file it would
    // otherwise have caught (e.g. `credentials/**` losing every case to `*.pem` — see
    // matchedDenyPaths in workspace.js). The wording below has to stay true for both.
    console.warn(
      `agent-team: member "${member}": deny_paths entries did not win arbitration for any file ` +
      `in this repo (either none matched, or a more specific overlapping entry won instead) — ` +
      `check whether you meant these to match: ${unmatchedDenyPaths.join(', ')}`
    );
  }
  // A name-based deny_paths boundary cannot see through a symlink, so createWorkspace drops
  // every tracked one unconditionally (see dropSymlinks in workspace.js) — worth an
  // operator's attention the same way an unmatched deny entry is, since it can delete a
  // symlink some member genuinely relied on.
  const droppedSymlinks = workspace.droppedSymlinks ?? [];
  if (droppedSymlinks.length > 0) {
    console.warn(
      `agent-team: member "${member}": dropped tracked symlinks from the workspace — ` +
      `a name-based deny_paths boundary cannot see through them: ${droppedSymlinks.join(', ')}`
    );
  }
  // The two warnings above report true, independent facts, but an operator has to join them
  // manually to see when they are actually the SAME defeated intent: a deny_paths entry with
  // a trailing slash (a directory-only pattern) does not match a symlink entry of the same
  // name, so the symlink survives arbitration unmatched — and is then dropped anyway by
  // dropSymlinks' unconditional policy, for an unrelated reason. The entry reads "matched
  // nothing" and the symlink reads "dropped" as two unrelated lines; call out when they are
  // one story. This does not replace either warning above or either list on the result — it
  // is strictly additional, and it does not attempt to resolve the symlink's target (see
  // dropSymlinks in workspace.js for why that was rejected).
  const stripTrailingSlashes = (p) => p.replace(/\/+$/, '');
  for (const linkName of droppedSymlinks) {
    const matchingEntry = unmatchedDenyPaths.find((entry) => stripTrailingSlashes(entry) === linkName);
    if (matchingEntry) {
      console.warn(
        `agent-team: member "${member}": deny_paths entry "${matchingEntry}" did not win arbitration ` +
        `for any file, but a tracked symlink named "${linkName}" was dropped — the entry probably did ` +
        `not cover what you intended`
      );
    }
  }
  const maxDepth = config.defaults.max_depth;
  const delegated = [];
  let priorResults = null;
  let result;

  try {
    for (;;) {
      if (budget.runs <= 0) {
        result = { status: 'failed', summary: `delegation budget exhausted (max_delegations)` };
        break;
      }
      budget.runs -= 1;

      const brief = buildBrief({
        resolved, task, cwd: workspace.dir, denyPaths: config.deny_paths,
        skillText, dialectText, timeoutSec: Math.floor(timeoutMs / 1000),
        depth, maxDepth, priorResults
      });

      result = await runAdapter(adapterPath(adapterDir, resolved.agent), 'run', {
        brief, timeoutMs, env, cwd: workspace.dir
      });

      if (result.status !== 'delegating') break;

      const requests = result.delegations ?? [];
      if (requests.length === 0) {
        result = { ...result, status: 'failed', summary: 'answered "delegating" with no delegations' };
        break;
      }
      // max_depth exhaustion is a budget: it degrades to status: 'failed' like any other
      // ordinary outcome, because a manager can legitimately run into it during normal use.
      // The reporting-line check just below is a boundary, not a budget — delegating outside
      // it is treated as a security violation and stays a throw (see finding 3's CLI
      // wrapping for why that surfaces as clean JSON instead of a stack trace).
      if (depth >= maxDepth) {
        result = { ...result, status: 'failed', summary: `delegation refused: already at max_depth ${maxDepth}` };
        break;
      }

      const round = [];
      for (const req of requests) {
        // delegations comes straight off adapter stdout, which this project's threat model
        // treats as untrusted — guard the shape before trusting req.to, so a malformed
        // entry (null, or a "to" that isn't a non-empty string) gets a clear error instead
        // of a raw TypeError reading .to off it.
        if (req === null || typeof req !== 'object' || Array.isArray(req) ||
            typeof req.to !== 'string' || req.to === '') {
          throw new Error(
            `member "${member}" answered "delegating" with a malformed delegation entry — ` +
            `"to" must be a non-empty string naming a direct report, got ${JSON.stringify(req)}`
          );
        }
        // The reporting line is a hard boundary: a manager may reach its own reports and no one else.
        if (!resolved.reports.includes(req.to)) {
          throw new Error(
            `member "${member}" may not delegate to "${req.to}" — not a direct report ` +
            `(reports: ${resolved.reports.join(', ') || 'none'})`
          );
        }
        const sub = await runMember({
          ...ctx, member: req.to, task: req.task, depth: depth + 1, priorResults: null
        });
        round.push(sub);
        delegated.push(sub);
      }
      priorResults = round.map((r) => ({
        member: r.member, status: r.status, summary: r.summary ?? null
      }));
    }

    if (result.status === 'ok') pruneWorkspace(workspace);

    return {
      ...result,
      member, agent: resolved.agent, warning: resolved.warning,
      workspace, unmatchedDenyPaths, droppedSymlinks, depth, delegated
    };
  } catch (err) {
    // A throw here (e.g. a reporting-line violation) means this frame's workspace
    // holds no work product and nothing can ever reach it again — prune it. This is
    // NOT the keep-on-failure pattern: a `failed`/`timeout` RESULT returns normally,
    // above, with `workspace` still attached for a human to inspect. The cleanup runs
    // in its own try/catch so a failure while pruning can never mask or replace the
    // original error.
    try {
      pruneWorkspace(workspace);
    } catch {
      // ignore — the original error is what must propagate
    }
    throw err;
  }
}

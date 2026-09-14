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
      if (depth >= maxDepth) {
        result = { ...result, status: 'failed', summary: `delegation refused: already at max_depth ${maxDepth}` };
        break;
      }

      const round = [];
      for (const req of requests) {
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
      workspace, depth, delegated
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

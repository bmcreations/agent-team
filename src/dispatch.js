import { existsSync, readFileSync, appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadConfig, parseConfig, CONFIG_RELPATH, CLOUD_AGENT } from './config.js';
import { cloudTarget, deniedInCloud, localRepoKey, parseGithubRepo, remoteTeamSource } from './cloud.js';
import { resolveMember } from './resolve.js';
import { createWorkspace, pruneWorkspace, runLogPath, mainCheckoutRoot } from './workspace.js';
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
  const startedAt = new Date();
  try {
    const result = await runMember({
      config, projectRoot, member, task, adapterDir,
      assignments: { ...assignments }, skillsDir, env, timeoutMs, budget, depth: 0,
      teams: teamKeys(projectRoot)
    });
    recordRun(projectRoot, startedAt, task, runNode(result));
    return result;
  } catch (err) {
    recordRun(projectRoot, startedAt, task, {
      member, status: 'failed', summary: clip(err.message, 300), depth: 0, delegated: []
    });
    throw err;
  }
}

const clip = (text, n) => (typeof text === 'string' && text.length > n ? `${text.slice(0, n)}…` : text ?? null);

// The run log keeps what the report shows and nothing else: no diff, stderr, or workspace
// path, which would make each line as large as the run's output.
function runNode(r) {
  return {
    member: r.member, ...(r.team ? { team: r.team } : {}),
    agent: r.agent ?? null, model: r.model ?? null, advisor: r.advisor ?? null,
    status: r.status, summary: clip(r.summary, 300), depth: r.depth ?? 0,
    elapsed_ms: r.elapsed_ms ?? null, usage: r.usage ?? null,
    delegated: (r.delegated ?? []).map(runNode)
  };
}

// A run that cannot be logged still returns its result: the log is for the report, and a
// read-only cache directory must not fail the delegation it describes.
function recordRun(projectRoot, startedAt, task, tree) {
  const path = runLogPath(projectRoot);
  const line = JSON.stringify({
    v: 1, at: startedAt.toISOString(), project: resolve(projectRoot), task: clip(task, 200), tree
  });
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + '\n');
  } catch (err) {
    console.warn(`agent-team: could not write the run log at ${path}: ${err.message}`);
  }
}

// A manager runs once to delegate and again to synthesize, so its usage is the sum of its
// own rounds. Its reports' usage stays on their own nodes.
function addUsage(total, u) {
  if (!u) return total;
  if (!total) return { ...u, models: { ...(u.models ?? {}) } };
  const sum = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  const models = { ...total.models };
  for (const [name, m] of Object.entries(u.models ?? {})) {
    const prev = models[name];
    models[name] = prev
      ? { input_tokens: prev.input_tokens + m.input_tokens, output_tokens: prev.output_tokens + m.output_tokens,
          cost_usd: sum(prev.cost_usd, m.cost_usd) }
      : m;
  }
  return {
    duration_ms: sum(total.duration_ms, u.duration_ms),
    turns: sum(total.turns, u.turns),
    cost_usd: sum(total.cost_usd, u.cost_usd),
    session_id: total.session_id,
    session_ids: [...(total.session_ids ?? [total.session_id]), u.session_id],
    advisor_calls: sum(total.advisor_calls, u.advisor_calls),
    models
  };
}

// A team path is absolute, under ~/, or relative to the project. A relative path that does
// not lead to a config from a linked worktree is retried from the main checkout, since
// sibling repositories sit next to the main checkout, not next to its worktrees.
function teamRoot(projectRoot, team) {
  const expanded = team === '~' || team.startsWith('~/') ? join(homedir(), team.slice(1)) : team;
  if (isAbsolute(expanded)) return expanded;
  const local = resolve(projectRoot, expanded);
  if (existsSync(join(local, CONFIG_RELPATH))) return local;
  const main = mainCheckoutRoot(projectRoot);
  const fromMain = main ? resolve(main, expanded) : null;
  return fromMain && existsSync(join(fromMain, CONFIG_RELPATH)) ? fromMain : local;
}

// What identifies a project in the cycle check: its real path, and the GitHub repository it
// pushes to, so a local team cannot reach itself again through its own GitHub name.
function teamKeys(root) {
  return [realpathSync(root), localRepoKey(root)].filter(Boolean);
}

function refuseCycle(member, team, keys, teams) {
  if (keys.some((k) => teams.includes(k))) {
    throw new Error(`member "${member}": team "${team}" is already in this delegation (${[...teams, keys[0]].join(' -> ')})`);
  }
}

// The member another team is entered through: the one named, else that team's only root.
function teamEntry(teamConfig, entry, root, member) {
  if (entry) return entry;
  if (teamConfig.org.roots.length !== 1) {
    throw new Error(
      `member "${member}": team at ${root} has ${teamConfig.org.roots.length} top-level members ` +
      `(${teamConfig.org.roots.join(', ')}) — set "member" to pick one`
    );
  }
  return teamConfig.org.roots[0];
}

// Delegating to a team member dispatches the other project's entry member under that
// project's own config: its deny_paths build the workspaces, its max_depth bounds the tree
// below it. Its runs still spend this dispatch's max_delegations, capped by its own.
async function runTeam(ctx, spec) {
  const { projectRoot, member, depth, budget, teams } = ctx;
  const repo = parseGithubRepo(spec.team);
  if (repo) return runCloudTeam(ctx, spec, repo);
  const started = Date.now();
  const root = teamRoot(projectRoot, spec.team);
  if (!existsSync(join(root, CONFIG_RELPATH))) {
    throw new Error(`member "${member}": no agent-team config for team "${spec.team}" at ${join(root, CONFIG_RELPATH)}`);
  }
  const keys = teamKeys(root);
  refuseCycle(member, spec.team, keys, teams);
  const config = loadConfig(root);
  const entry = teamEntry(config, spec.member, root, member);

  const teamBudget = { runs: Math.min(budget.runs, config.defaults.max_delegations) };
  const before = teamBudget.runs;
  const sub = await runMember({
    ...ctx, config, projectRoot: root, member: entry, depth: 0,
    assignments: {}, budget: teamBudget, teams: [...teams, ...keys]
  });
  budget.runs -= before - teamBudget.runs;

  return {
    status: sub.status, summary: sub.summary ?? null,
    member, team: { path: root, member: entry },
    elapsed_ms: Date.now() - started, depth, delegated: [sub]
  };
}

// A team named by GitHub repository has no checkout here, so it runs as one cloud session:
// its entry member, under its own config read through the GitHub API, on claude-cloud, with
// delegation off. Every further hop would be another clone and another billed session.
async function runCloudTeam(ctx, spec, repo) {
  const { member, depth, budget, teams } = ctx;
  const started = Date.now();
  refuseCycle(member, spec.team, [repo.key], teams);
  const source = remoteTeamSource(repo, spec.ref ?? null);
  const remote = parseConfig(source.raw, `${repo.url}@${source.ref}:${CONFIG_RELPATH}`);
  const entry = teamEntry(remote, spec.member, repo.url, member);
  const entrySpec = remote.members[entry];
  if (entrySpec.team) {
    throw new Error(`member "${member}": entry member "${entry}" of ${repo.url} is itself a team — set "member" to a member that runs an agent`);
  }
  const config = {
    ...remote,
    members: {
      ...remote.members,
      [entry]: { ...entrySpec, agent: CLOUD_AGENT, isolation: entrySpec.isolation === 'none' ? 'read-only' : entrySpec.isolation }
    },
    defaults: {
      ...remote.defaults,
      max_depth: 0,
      on_unavailable: CLOUD_AGENT,   // no local fallback: there is nothing local to run it on
      cloud_max_cost_usd: Math.min(remote.defaults.cloud_max_cost_usd, ctx.config.defaults.cloud_max_cost_usd)
    }
  };

  const teamBudget = { runs: Math.min(budget.runs, remote.defaults.max_delegations) };
  const before = teamBudget.runs;
  const sub = await runMember({
    ...ctx, config, projectRoot: null, member: entry, depth: 0,
    assignments: {}, budget: teamBudget, teams: [...teams, repo.key],
    cloudSource: { repo, ref: source.ref, sha: source.sha, dirty: false, tracked: source.tracked }
  });
  budget.runs -= before - teamBudget.runs;

  return {
    status: sub.status, summary: sub.summary ?? null,
    member, team: { repo: repo.url, ref: source.ref, member: entry },
    elapsed_ms: Date.now() - started, depth, delegated: [sub]
  };
}

// The stand-in for createWorkspace when a member runs in the cloud. Nothing is cloned here;
// the session clones origin itself, so deny_paths is checked against that commit instead and
// a match refuses the run. The local directory only gives the adapter a cwd.
function prepareCloud(ctx, resolved) {
  const { config, projectRoot, member } = ctx;
  if (resolved.isolation === 'none') {
    throw new Error(`member "${member}": a cloud member cannot run with isolation "none"`);
  }
  const target = ctx.cloudSource ?? cloudTarget(projectRoot);
  const denied = deniedInCloud(target.tracked, config.deny_paths);
  const where = `${target.repo.url} (${target.ref})`;
  if (denied.length > 0) {
    const shown = denied.slice(0, 10).join(', ') + (denied.length > 10 ? `, and ${denied.length - 10} more` : '');
    if (!resolved.cloud_allow_denied) {
      throw new Error(
        `member "${member}": deny_paths matches ${denied.length} file(s) in ${where}, which a ` +
        `cloud session would clone in full: ${shown} — untrack them, or set ` +
        `"cloud_allow_denied": true on "${member}" to send them anyway`
      );
    }
    console.warn(
      `agent-team: member "${member}": cloud_allow_denied is set — the cloud session clones ` +
      `${where} including ${denied.length} file(s) deny_paths matches: ${shown}`
    );
  }
  if (target.dirty) {
    console.warn(`agent-team: member "${member}": uncommitted changes here are not in ${where}, which is what the cloud session sees`);
  }
  const id = randomBytes(3).toString('hex');
  return {
    workspace: { dir: mkdtempSync(join(tmpdir(), `agent-team-${member}-`)), branch: null, id, kind: 'cloud' },
    cloud: {
      repo_url: target.repo.url,
      ref: target.ref,
      sha: target.sha,
      max_cost_usd: config.defaults.cloud_max_cost_usd,
      push_branch: resolved.isolation === 'workspace' ? `agent-team/${member}-${id}` : null,
      denied_files_sent: denied.length,
      // Spike: set, the adapter joins this session instead of creating one.
      session_id: resolved.session_id ?? null,
      session_allow_tools: resolved.session_allow_tools === true
    }
  };
}

async function runMember(ctx) {
  const { config, projectRoot, member, task, adapterDir, assignments,
          skillsDir, env, timeoutMs, budget, depth } = ctx;

  const spec = config.members[member];
  if (spec?.team) return runTeam(ctx, spec);

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

  let workspace;
  let cloud = null;
  if (caps.remote === true) {
    ({ workspace, cloud } = prepareCloud(ctx, resolved));
  } else if (ctx.cloudSource) {
    throw new Error(`member "${member}": a team named by GitHub repository can only run on "${CLOUD_AGENT}", got "${resolved.agent}"`);
  } else {
    workspace = createWorkspace(projectRoot, member, config.deny_paths, resolved.isolation);
  }
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
  let usage = null;
  const started = Date.now();

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
        depth, maxDepth, priorResults, cloud
      });

      result = await runAdapter(adapterPath(adapterDir, resolved.agent), 'run', {
        brief, timeoutMs, env, cwd: workspace.dir
      });
      usage = addUsage(usage, result.usage);

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
      member, agent: resolved.agent, model: resolved.model, advisor: resolved.advisor,
      usage, elapsed_ms: Date.now() - started, warning: resolved.warning,
      workspace, unmatchedDenyPaths, droppedSymlinks, depth, delegated,
      ...(cloud ? { cloud } : {})
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

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { arbitrateDenyPaths } from './workspace.js';

// A cloud member runs against a clone the cloud makes from GitHub, not against a workspace
// built here, so none of createWorkspace's filtering reaches it. What stands in for it is a
// refusal: before a session starts, the commit the cloud will check out is checked against
// deny_paths, and a match stops the run unless the member sets cloud_allow_denied.

// "github:owner/repo", "https://github.com/owner/repo(.git)", "git@github.com:owner/repo(.git)"
// and "ssh://git@github.com/owner/repo(.git)". `key` is what the cycle check compares, so a
// local team and the GitHub form of the same repo cannot call each other.
export function parseGithubRepo(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^github:([\w.-]+)\/([\w.-]+?)$/) ??
    text.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/) ??
    text.match(/^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  const [, owner, repo] = m;
  return {
    owner, repo,
    url: `https://github.com/${owner}/${repo}`,
    key: `github.com/${owner}/${repo}`.toLowerCase()
  };
}

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', resolve(dir), ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? '').toString().trim() };
}

// The GitHub repository a local checkout pushes to, or null when origin is not on GitHub.
export function localRepoKey(projectRoot) {
  const r = git(projectRoot, 'config', '--get', 'remote.origin.url');
  return r.ok ? parseGithubRepo(r.out.toString().trim())?.key ?? null : null;
}

// What a cloud session started from this checkout would see: origin's copy of the current
// branch. Refused when that is not what is checked out here, since the cloud would silently
// work on different code than the manager that delegated to it.
export function cloudTarget(projectRoot) {
  const branch = git(projectRoot, 'symbolic-ref', '--short', '-q', 'HEAD');
  if (!branch.ok) {
    throw new Error('cloud member: HEAD is detached — check out a branch that is pushed to GitHub');
  }
  const ref = branch.out.toString().trim();
  const origin = git(projectRoot, 'config', '--get', 'remote.origin.url');
  const repo = origin.ok ? parseGithubRepo(origin.out.toString().trim()) : null;
  if (!repo) {
    throw new Error(
      `cloud member: origin ${origin.ok ? `(${origin.out.toString().trim()}) ` : ''}is not a ` +
      'GitHub repository — a cloud session can only clone from GitHub'
    );
  }
  const remote = git(projectRoot, 'ls-remote', 'origin', `refs/heads/${ref}`);
  if (!remote.ok) throw new Error(`cloud member: git ls-remote origin failed: ${remote.err}`);
  const remoteSha = remote.out.toString().split('\t')[0].trim();
  if (!remoteSha) {
    throw new Error(`cloud member: branch "${ref}" is not on origin — push it first`);
  }
  const head = git(projectRoot, 'rev-parse', 'HEAD').out.toString().trim();
  if (head !== remoteSha) {
    throw new Error(
      `cloud member: local "${ref}" is at ${head.slice(0, 12)} but origin has ` +
      `${remoteSha.slice(0, 12)} — the cloud would clone origin's; push or pull first`
    );
  }
  const dirty = git(projectRoot, 'status', '--porcelain').out.toString().trim() !== '';
  const tracked = git(projectRoot, 'ls-tree', '-r', '-z', '--name-only', head);
  if (!tracked.ok) throw new Error(`cloud member: git ls-tree ${head} failed: ${tracked.err}`);
  return { repo, ref, sha: head, dirty, tracked: tracked.out };
}

// The tracked paths a deny_paths entry matches in a commit the cloud will clone. The
// container's filesystem is case-sensitive, whatever this machine's filesystem does.
export function deniedInCloud(tracked, denyPaths) {
  return arbitrateDenyPaths(tracked, denyPaths, false).denied
    .map((p) => (Buffer.isBuffer(p) ? p.toString('utf8') : p));
}

const ghBin = () => process.env.AGENT_TEAM_GH_BIN || 'gh';

function gh(path) {
  const r = spawnSync(ghBin(), ['api', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`cloud team: could not run gh: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`cloud team: gh api ${path} failed: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout);
}

// A team named by GitHub repository has no checkout here. Its config and file list are read
// through the GitHub API with the operator's own gh login, which never leaves this machine.
export function remoteTeamSource(repo, ref = null) {
  const base = `repos/${repo.owner}/${repo.repo}`;
  const branch = ref ?? gh(base).default_branch;
  const tree = gh(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (tree.truncated) {
    throw new Error(
      `cloud team ${repo.key}: GitHub truncated the file list for "${branch}", so deny_paths ` +
      'cannot be checked against all of it'
    );
  }
  const file = gh(`${base}/contents/.claude/agent-team.json?ref=${encodeURIComponent(branch)}`);
  let raw;
  try {
    raw = JSON.parse(Buffer.from(file.content ?? '', file.encoding ?? 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`cloud team ${repo.key}: .claude/agent-team.json on "${branch}": ${err.message}`);
  }
  const paths = tree.tree.filter((e) => e.type === 'blob').map((e) => e.path);
  return {
    ref: branch, sha: null, raw,
    tracked: Buffer.from(paths.length ? `${paths.join('\0')}\0` : '')
  };
}

// --- Spike: joining a session someone else created (docs/spikes/live-sessions.md) ---

const WRITE_TOOLS = ['bash', 'write', 'edit'];

// The agent snapshot on GET /v1/sessions/{id}: which write-capable built-in tools are on,
// and whether any MCP server is attached (its tools are unknown to us).
export function writeToolsOn(agent) {
  const on = new Set();
  for (const t of agent?.tools ?? []) {
    if (!/^agent_toolset/.test(t.type ?? '')) continue;
    const byDefault = t.default_config?.enabled !== false;
    const configs = new Map((t.configs ?? []).map((c) => [c.name, c.enabled !== false]));
    for (const name of WRITE_TOOLS) if (configs.get(name) ?? byDefault) on.add(name);
  }
  if ((agent?.mcp_servers ?? []).length > 0) on.add('mcp');
  return [...on];
}

// What makes it unsafe to hand this session a member's task. The dispatcher checked
// deny_paths against brief.cloud.repo_url at brief.cloud.ref, so the session must have that
// repo mounted at that branch for the check to describe what it can read.
export function joinRefusal(session, brief) {
  const id = session.id;
  if (session.archived_at || session.status === 'terminated') return `session ${id} is ${session.archived_at ? 'archived' : 'terminated'}`;
  const want = parseGithubRepo(brief.cloud.repo_url)?.key;
  const repos = (session.resources ?? []).filter((r) => r.type === 'github_repository');
  const ours = repos.find((r) => parseGithubRepo(r.url)?.key === want);
  if (!ours) return `session ${id} does not mount ${brief.cloud.repo_url}, so deny_paths was checked against a repo it cannot see`;
  if (repos.length > 1) return `session ${id} mounts ${repos.length} repositories; deny_paths only covers ${brief.cloud.repo_url}`;
  const co = ours.checkout;
  if (co?.type === 'branch' && co.name !== brief.cloud.ref) {
    return `session ${id} has branch "${co.name}" checked out, but deny_paths was checked on "${brief.cloud.ref}"`;
  }
  if (co?.type === 'commit' && brief.cloud.sha && co.sha !== brief.cloud.sha) {
    return `session ${id} has commit ${co.sha} checked out, but deny_paths was checked on ${brief.cloud.sha}`;
  }
  if (!co) return `session ${id} reports no checkout for ${brief.cloud.repo_url}`;
  const writes = writeToolsOn(session.agent);
  if (writes.length > 0 && !brief.cloud.session_allow_tools) {
    return `session ${id} has ${writes.join(', ')} enabled, which a read-only member must not get — ` +
      'set "session_allow_tools": true on the member to send the task anyway';
  }
  return null;
}

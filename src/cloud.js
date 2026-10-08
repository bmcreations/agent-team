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

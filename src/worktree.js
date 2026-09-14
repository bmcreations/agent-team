import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString();

export function createWorktree(repoRoot, role, denyPaths) {
  const id = randomBytes(3).toString('hex');
  const dir = join(repoRoot, '.claude', 'worktrees', `${role}-${id}`);
  const branch = `agent-team/${role}-${id}`;

  git(repoRoot, 'worktree', 'add', '-q', '-b', branch, dir, 'HEAD');

  // Non-cone mode: take everything, then subtract the denied patterns.
  git(dir, 'sparse-checkout', 'init', '--no-cone');
  const patterns = ['/*', ...denyPaths.map((p) => `!${p}`)];
  git(dir, 'sparse-checkout', 'set', '--no-cone', ...patterns);

  return { dir, branch, id };
}

export function pruneWorktree(repoRoot, dir) {
  git(repoRoot, 'worktree', 'remove', '--force', dir);
}

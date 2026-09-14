import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, pruneWorktree } from '../src/worktree.js';

function repoWithSecrets() {
  const root = mkdtempSync(join(tmpdir(), 'at-wt-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'export const ok = 1;\n');
  writeFileSync(join(root, 'credentials', 'signing.p8'), 'PRIVATE KEY\n');
  writeFileSync(join(root, '.env.production'), 'TOKEN=hunter2\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

const DENY = ['credentials/**', '**/.env*'];

test('the worktree contains ordinary source', () => {
  const root = repoWithSecrets();
  const wt = createWorktree(root, 'red-team', DENY);
  assert.ok(existsSync(join(wt.dir, 'src', 'app.js')));
});

test('denied paths are ABSENT from the worktree', () => {
  const root = repoWithSecrets();
  const wt = createWorktree(root, 'red-team', DENY);
  assert.equal(existsSync(join(wt.dir, 'credentials', 'signing.p8')), false);
  assert.equal(existsSync(join(wt.dir, '.env.production')), false);
});

test('the worktree is on its own branch, not the caller tree', () => {
  const root = repoWithSecrets();
  const wt = createWorktree(root, 'qa', DENY);
  const branch = execFileSync('git', ['-C', wt.dir, 'branch', '--show-current'])
    .toString().trim();
  assert.equal(branch, wt.branch);
  assert.match(wt.branch, /^agent-team\/qa-[0-9a-f]{6}$/);
});

test('two worktrees for the same role do not collide', () => {
  const root = repoWithSecrets();
  const a = createWorktree(root, 'qa', DENY);
  const b = createWorktree(root, 'qa', DENY);
  assert.notEqual(a.dir, b.dir);
});

test('prune removes the worktree directory', () => {
  const root = repoWithSecrets();
  const wt = createWorktree(root, 'qa', DENY);
  pruneWorktree(root, wt.dir);
  assert.equal(existsSync(wt.dir), false);
});

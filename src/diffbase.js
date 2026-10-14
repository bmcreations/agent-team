import { execFileSync } from 'node:child_process';

// A workspace clone starts from one parentless snapshot commit with this subject (see
// createWorkspace). Both sides use these, so the commit and the check that finds it agree.
export const WORKSPACE_COMMIT_PREFIX = 'workspace: ';
export const workspaceCommitSubject = (member) => `${WORKSPACE_COMMIT_PREFIX}${member}`;

const git = (cwd, args, opts = {}) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', ...opts });

// What a member's work is measured against. In a workspace clone that is the snapshot root
// commit: a member that COMMITS inside its clone moves HEAD, and `git diff HEAD` then reports
// nothing. Anywhere else (the real project root, a plain repo) it stays HEAD, so a root commit
// that merely exists in the history is never mistaken for a base. Only a lone parentless commit
// carrying the workspace subject counts.
export function diffBase(cwd) {
  try {
    const roots = git(cwd, ['rev-list', '--max-parents=0', 'HEAD']).toString().trim().split('\n').filter(Boolean);
    if (roots.length !== 1) return 'HEAD';
    const subject = git(cwd, ['log', '-1', '--format=%s', roots[0]]).toString();
    return subject.startsWith(WORKSPACE_COMMIT_PREFIX) ? roots[0] : 'HEAD';
  } catch { return 'HEAD'; }
}

// The unified diff of commits + working tree + untracked files against diffBase(cwd).
// `git diff HEAD` never shows an untracked path, so a member that CREATES a file would hand
// back an empty diff while reporting success. Intent-to-add (`add -A -N`) makes a new file
// visible to diff. It is staged into a THROWAWAY index (`indexFile`), never the workspace's
// own: a read_only brief's conformance check compares `git status --porcelain` from before the
// run to after it, and touching the real index would turn "?? new.txt" into "A  new.txt" and
// report a read-only violation that never happened. Throws on failure (ENOBUFS when too big).
export function gitDiff(cwd, indexFile, { args = [], maxBuffer, timeout } = {}) {
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  git(cwd, ['read-tree', 'HEAD'], { env });
  git(cwd, ['add', '-A', '-N'], { env });
  return git(cwd, ['diff', ...args, diffBase(cwd)], { env, maxBuffer, timeout }).toString();
}

// One entry per file of a unified diff: its path (the new side), how it changed, and the
// +/- line counts. Counting only inside hunks keeps the `+++`/`---` headers out of the totals.
export function diffFiles(diff) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2], status: 'modified', added: 0, removed: 0 };
      files.push(cur);
      inHunk = false;
    } else if (!cur) {
      continue;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith('+')) cur.added++;
      else if (line.startsWith('-')) cur.removed++;
    } else if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename to ')) cur.status = 'renamed';
  }
  return files;
}

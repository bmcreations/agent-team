// Process-tree helpers for ending a codex app-server together with the shell commands it started.
// codex runs each command in its own process group, so signalling the server alone (or its group)
// leaves them behind. Stdlib only; `ps -A -o pid=,ppid=,pgid=` is the same on macOS and Linux.
import { spawnSync } from 'node:child_process';

// Every live descendant of `pid` (not `pid` itself) as [{ pid, pgid }]. When `ps` is missing or
// fails, nothing can be found; `warn` is told why, so the caller can say so instead of sweeping
// nothing in silence.
export function descendants(pid, warn = () => {}) {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (ps.status !== 0 || typeof ps.stdout !== 'string') {
    warn(`ps failed: ${ps.error?.message ?? (ps.stderr?.trim() || `exit ${ps.status ?? ps.signal}`)}`);
    return [];
  }
  const rows = ps.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 3 && r.every(Number.isInteger));
  const kids = new Map();
  for (const [p, pp, pg] of rows) {
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push({ pid: p, pgid: pg });
  }
  const found = [];
  const seen = new Set([pid]);
  const todo = [pid];
  while (todo.length) {
    for (const c of kids.get(todo.pop()) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      found.push(c);
      todo.push(c.pid);
    }
  }
  return found;
}

// Union by pid, so a later snapshot adds what started since the earlier one.
export const merge = (a, b) => [...new Map([...a, ...b].map((d) => [d.pid, d])).values()];

// What to signal: each pid, and `-pgid` for every group a descendant leads (pgid equals some
// descendant's pid). That can never be our own group: its leader is us or an ancestor, not a
// descendant.
export function targets(list) {
  const pids = new Set(list.map((d) => d.pid));
  const out = new Set([...pids]);
  for (const d of list) if (pids.has(d.pgid)) out.add(-d.pgid);
  return [...out];
}

export function endTree(list, signal) {
  for (const t of targets(list)) {
    try { process.kill(t, signal); } catch { /* gone (ESRCH) or not ours (EPERM) */ }
  }
}

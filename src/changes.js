import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDiff, diffFiles } from './diffbase.js';

// The same cap the adapters keep in a result, so a live view and the final report agree.
const KEEP_CHARS = 200_000;
const MAX_BUFFER = 20_000_000;
const GIT_TIMEOUT_MS = 15_000;
const TTL_MS = 1500;
const NONE = { files: [], diff: '', truncated: false, live: false };

const shape = (diff, live) => ({
  files: diffFiles(diff), diff: diff.slice(0, KEEP_CHARS), truncated: diff.length > KEEP_CHARS, live
});

// What a member has changed so far. A member still working in a workspace clone is diffed now
// (commits + working tree + untracked, against the clone's base); a finished one is served from
// the artifacts its result stored, since the clone is pruned when it is done. A member with no
// workspace, or whose clone is not a git repo, has no changes: an empty answer, not a 404.
export function changesReader({ now = Date.now } = {}) {
  const cache = new Map();   // member id -> { at, value }: repeated page refreshes cost one git run
  return function changesOf(m) {
    const stored = m.result?.artifacts;
    if (m.state === 'done' || !m.workspace || !existsSync(m.workspace)) {
      return typeof stored?.diff === 'string' ? shape(stored.diff, false) : NONE;
    }
    const hit = cache.get(m.id);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    const scratch = mkdtempSync(join(tmpdir(), 'agent-team-changes-'));
    let value;
    try {
      value = shape(gitDiff(m.workspace, join(scratch, 'index'), { maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS }), m.state === 'running');
    } catch {
      value = typeof stored?.diff === 'string' ? shape(stored.diff, false) : NONE;   // not a repo, or too big to read
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    cache.set(m.id, { at: now(), value });
    return value;
  };
}

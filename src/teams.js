import { lstatSync, realpathSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { loadConfig, CONFIG_RELPATH } from './config.js';
import { teamRoot, teamKeys } from './dispatch.js';
import { isRemoteTeam } from './cloud.js';

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
// A regular file only: a symlink would let a member point the supervisor at any file it can name.
const hasConfig = (root) => { try { return lstatSync(join(root, CONFIG_RELPATH)).isFile(); } catch { return false; } };
const looksLikePath = (s) => s.startsWith('~') || s.startsWith('.') || isAbsolute(s) || s.includes('/');

// The teams a member can name: every project the supervisor has run, and the caller's peers.
// Open by default: any directory with a config can also be named by path.
export function knownTeams({ store, projectRoot, config }) {
  const out = new Map();   // real root -> entry
  for (const p of store.projects()) {
    out.set(real(p), { name: basename(p), root: real(p), source: 'supervisor', ...(hasConfig(p) ? {} : { missing: true }) });
  }
  for (const peer of config.peers ?? []) {
    const root = teamRoot(projectRoot, peer);
    const ok = hasConfig(root);
    const key = ok ? real(root) : root;
    out.set(key, { name: basename(root), root: key, source: 'peer', ...(ok ? {} : { missing: true }) });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}

// The project a member works in: its own entry's, else its nearest entering ancestor's, else
// its run's.
export function scopeProject(store, m) {
  for (let cur = m; cur; cur = cur.parent_id == null ? null : store.member(cur.parent_id)) {
    if (cur.project != null) return cur.project;
  }
  return store.run(m.run_id).project;
}

export function resolveTeam({ store, projectRoot, config, team }) {
  if (typeof team !== 'string' || !team.trim()) throw new Error('name a team: a known team\'s name or a path');
  if (isRemoteTeam(team)) {
    throw new Error(`team "${team}" is a GitHub repository — threads and team_status are for local teams`);
  }
  let root;
  if (looksLikePath(team)) {
    root = teamRoot(projectRoot, team);
  } else {
    const hits = knownTeams({ store, projectRoot, config }).filter((t) => t.name === team);
    if (hits.length > 1) throw new Error(`team "${team}" is ambiguous: ${hits.map((t) => t.root).join(', ')} — name it by path`);
    root = hits[0]?.root ?? teamRoot(projectRoot, team);
  }
  if (!hasConfig(root)) throw new Error(`team "${team}" not found: no agent-team config at ${join(root, CONFIG_RELPATH)}`);
  const r = real(root);
  let teamConfig;
  try { teamConfig = loadConfig(r); } catch { throw new Error(`team "${team}": its config could not be read`); }
  return {
    name: basename(r), root: r, config: teamConfig, keys: teamKeys(r),
    source: (config.peers ?? []).some((p) => real(teamRoot(projectRoot, p)) === r) ? 'peer' : 'supervisor'
  };
}

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_RELPATH = join('.claude', 'agent-team.json');

export function loadConfig(projectRoot) {
  const path = join(projectRoot, CONFIG_RELPATH);
  if (!existsSync(path)) {
    throw new Error(`no agent-team config at ${path} — run /agent-team-init`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));

  if (!raw.roles || typeof raw.roles !== 'object' || Array.isArray(raw.roles)) {
    throw new Error(`${path}: "roles" is required and must be an object`);
  }
  if (!Array.isArray(raw.deny_paths) || raw.deny_paths.length === 0) {
    throw new Error(
      `${path}: "deny_paths" is required and must be a non-empty array — ` +
      `a rival CLI runs in this tree and ships context to a third party`
    );
  }

  return {
    roles: raw.roles,
    deny_paths: raw.deny_paths,
    defaults: { on_unavailable: 'claude', ...(raw.defaults ?? {}) }
  };
}

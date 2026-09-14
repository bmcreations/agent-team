import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrg } from './org.js';

export const CONFIG_RELPATH = join('.claude', 'agent-team.json');

export const ISOLATIONS = ['none', 'read-only', 'workspace'];
export const DELIVERABLES = ['diff', 'review', 'document', 'decision'];

const DELIVERABLE_FOR = { none: 'document', 'read-only': 'review', workspace: 'diff' };

// Member names are interpolated into a filesystem path (workspace.js joins them under
// .claude/workspaces/<name>-<id>, and path.join happily normalizes ../ segments) and
// into a git branch name (agent-team/<name>-<id>). One shape check keeps both safe:
// no path traversal, no whitespace/NUL/newline, no leading dash, no slash.
const MEMBER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const MEMBER_NAME_MAX_LENGTH = 64;

function validateMemberName(name, path) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MEMBER_NAME_MAX_LENGTH ||
    !MEMBER_NAME_RE.test(name)
  ) {
    throw new Error(
      `${path}: member name ${JSON.stringify(name)} is invalid — names must start with a letter ` +
      `or digit and contain only letters, digits, "_" or "-" (matching ${MEMBER_NAME_RE}), ` +
      `at most ${MEMBER_NAME_MAX_LENGTH} characters`
    );
  }
}

function validateDenyPath(entry, path) {
  if (typeof entry !== 'string' || entry === '') {
    throw new Error(
      `${path}: "deny_paths" entries must be non-empty strings — got ${JSON.stringify(entry)}`
    );
  }
  if (entry.startsWith('./') || entry.startsWith('../')) {
    const suggestion = entry.replace(/^\.{1,2}\//, '');
    throw new Error(
      `${path}: "deny_paths" entry ${JSON.stringify(entry)} can never match — a leading "./" or ` +
      `"../" is inert under gitignore semantics; write ${JSON.stringify(suggestion)}, not ` +
      `${JSON.stringify(entry)}`
    );
  }
}

export function loadConfig(projectRoot) {
  const path = join(projectRoot, CONFIG_RELPATH);
  if (!existsSync(path)) {
    throw new Error(`no agent-team config at ${path} — run /agent-team-init`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }

  if (!raw.members || typeof raw.members !== 'object' || Array.isArray(raw.members)) {
    throw new Error(`${path}: "members" is required and must be an object`);
  }
  if (!Array.isArray(raw.deny_paths) || raw.deny_paths.length === 0) {
    throw new Error(
      `${path}: "deny_paths" is required and must be a non-empty array — ` +
      `a rival CLI runs in this tree and ships context to a third party`
    );
  }
  for (const entry of raw.deny_paths) {
    validateDenyPath(entry, path);
  }

  const members = {};
  for (const [name, m] of Object.entries(raw.members)) {
    validateMemberName(name, path);
    if (typeof m.agent !== 'string' || m.agent === '') {
      throw new Error(`${path}: member "${name}": "agent" is required`);
    }
    const isolation = m.isolation ?? 'read-only';
    if (!ISOLATIONS.includes(isolation)) {
      throw new Error(
        `${path}: member "${name}": isolation "${isolation}" is not one of ${ISOLATIONS.join(', ')}`
      );
    }
    const deliverable = m.deliverable ?? DELIVERABLE_FOR[isolation];
    if (!DELIVERABLES.includes(deliverable)) {
      throw new Error(
        `${path}: member "${name}": deliverable "${deliverable}" is not one of ${DELIVERABLES.join(', ')}`
      );
    }
    members[name] = { ...m, isolation, deliverable };
  }

  // Throws on an unknown manager or a cycle. Doing it here means a broken chart
  // is a config error, not something discovered three delegations deep.
  const org = buildOrg(members);

  return {
    members,
    org,
    deny_paths: raw.deny_paths,
    defaults: {
      on_unavailable: 'claude',
      max_depth: 3,
      max_delegations: 20,
      ...(raw.defaults ?? {})
    }
  };
}

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

// Shared shape check for anything that gets interpolated into a filesystem path the same
// way a member name does (currently: member names themselves, and `skill`, which
// dispatch.js joins as skillsDir/<skill>/SKILL.md). One regex, one length cap, one message
// shape — `subject` supplies the noun phrase so each caller's error reads naturally.
function validateNameShape(value, subject, path) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MEMBER_NAME_MAX_LENGTH ||
    !MEMBER_NAME_RE.test(value)
  ) {
    throw new Error(
      `${path}: ${subject} ${JSON.stringify(value)} is invalid — must start with a letter ` +
      `or digit and contain only letters, digits, "_" or "-" (matching ${MEMBER_NAME_RE}), ` +
      `at most ${MEMBER_NAME_MAX_LENGTH} characters`
    );
  }
}

function validateMemberName(name, path) {
  validateNameShape(name, 'member name', path);
}

// title/charter/persona pass through untouched into the brief's prompt text — a non-string
// still "works" but renders as JSON-ish garbage (e.g. an array joined into a sentence).
function validateStringField(value, name, field, path) {
  if (typeof value !== 'string') {
    throw new Error(
      `${path}: member "${name}": "${field}" must be a string — got ${JSON.stringify(value)}`
    );
  }
}

// output_path is a path a member writes to (relative to its workspace), so unlike
// title/charter/persona it also gets the traversal treatment: no absolute path, no ".."
// segment that could walk it out of the workspace directory.
function validateOutputPath(value, name, path) {
  validateStringField(value, name, 'output_path', path);
  if (value === '') {
    throw new Error(`${path}: member "${name}": "output_path" must be a non-empty string`);
  }
  const segments = value.split('/');
  if (value.startsWith('/') || segments.includes('..') || segments.includes('.')) {
    throw new Error(
      `${path}: member "${name}": "output_path" ${JSON.stringify(value)} must be a relative ` +
      `path with no ".." or "." segments and no leading "/"`
    );
  }
}

// A non-number maxDepth makes `depth < maxDepth` in src/brief.js false forever, silently
// turning every manager with reports into a non-manager — no thrown error, no warning, the
// run still reports status: ok. Number.isInteger rules out NaN, 1.5 and Infinity, which
// `typeof v === 'number'` would let straight through.
function validateBoundedInteger(value, field, minimum, path) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${path}: "defaults.${field}" must be an integer >= ${minimum} — got ${JSON.stringify(value)}`
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
  if (raw.defaults !== undefined && raw.defaults !== null) {
    if (typeof raw.defaults !== 'object' || Array.isArray(raw.defaults)) {
      throw new Error(`${path}: "defaults" must be an object — got ${JSON.stringify(raw.defaults)}`);
    }
  }

  const members = {};
  for (const [name, m] of Object.entries(raw.members)) {
    validateMemberName(name, path);
    // A string/number/boolean member value already lands on the "agent" is required message
    // below (property access on a primitive returns undefined, it doesn't throw). Only null
    // and arrays need a guard here: null throws reading .agent off it, and an array's .agent
    // is silently undefined too, but calling that out explicitly beats a misleading
    // "agent is required" for a value that was never going to have one.
    if (m === null || Array.isArray(m)) {
      throw new Error(`${path}: member "${name}" must be an object — got ${JSON.stringify(m)}`);
    }
    if (typeof m.agent !== 'string' || m.agent === '') {
      throw new Error(`${path}: member "${name}": "agent" is required`);
    }
    if (m.skill !== undefined && m.skill !== null) {
      validateNameShape(m.skill, `member "${name}": "skill"`, path);
    }
    if (m.title !== undefined && m.title !== null) {
      validateStringField(m.title, name, 'title', path);
    }
    if (m.charter !== undefined && m.charter !== null) {
      validateStringField(m.charter, name, 'charter', path);
    }
    if (m.persona !== undefined && m.persona !== null) {
      validateStringField(m.persona, name, 'persona', path);
    }
    if (m.output_path !== undefined && m.output_path !== null) {
      validateOutputPath(m.output_path, name, path);
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

  const defaults = {
    on_unavailable: 'claude',
    max_depth: 3,
    max_delegations: 20,
    ...(raw.defaults ?? {})
  };
  // Checked after the merge, not on raw.defaults, so a bad value baked into the hardcoded
  // default would be caught too — not just a bad override. max_depth's floor is 0, not 1:
  // 0 is a real, intentional setting meaning "no delegation at all" (see test/dispatch.test.js
  // "max_depth stops a manager from delegating past the limit"), so it must stay legal.
  // max_delegations has no such use for 0 — it would exhaust the run budget before the root
  // member's first call, which is never a usable configuration.
  validateBoundedInteger(defaults.max_depth, 'max_depth', 0, path);
  validateBoundedInteger(defaults.max_delegations, 'max_delegations', 1, path);

  return {
    members,
    org,
    deny_paths: raw.deny_paths,
    defaults
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, CONFIG_RELPATH } from '../src/config.js';

function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, CONFIG_RELPATH), JSON.stringify(config));
  return root;
}

const OK = {
  members: {
    coo: { agent: 'claude', isolation: 'none' },
    'eng-lead': { agent: 'claude', reports_to: 'coo' },
    implementer: { agent: 'codex', reports_to: 'eng-lead', isolation: 'workspace' }
  },
  deny_paths: ['credentials/**']
};

test('a missing config names the init skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  assert.throws(() => loadConfig(root), /agent-team-init/);
});

test('members is required', () => {
  const root = project({ deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /"members" is required/);
});

test('a config with no denylist is refused, and the message says why', () => {
  const root = project({ members: OK.members });
  assert.throws(() => loadConfig(root), /third party/);
});

test('an empty denylist is refused too', () => {
  const root = project({ members: OK.members, deny_paths: [] });
  assert.throws(() => loadConfig(root), /"deny_paths" is required/);
});

test('every member must name an agent', () => {
  const root = project({ members: { designer: { title: 'Designer' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /member "designer": "agent" is required/);
});

test('an unknown isolation level is refused', () => {
  const root = project({ members: { a: { agent: 'x', isolation: 'sandbox' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /isolation "sandbox" is not one of/);
});

test('an empty-string isolation is refused, not silently defaulted', () => {
  // "" is falsy but not nullish — this is what distinguishes `??` (correct: keeps ""
  // and rejects it) from `||` (bug: replaces it with 'read-only' and loads fine).
  const root = project({ members: { a: { agent: 'x', isolation: '' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /isolation "" is not one of/);
});

test('an unknown deliverable is refused', () => {
  const root = project({ members: { a: { agent: 'x', deliverable: 'vibes' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /deliverable "vibes" is not one of/);
});

test('a reporting cycle is refused at load time', () => {
  const root = project({
    members: { a: { agent: 'x', reports_to: 'b' }, b: { agent: 'x', reports_to: 'a' } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), /reporting cycle/);
});

test('isolation defaults to read-only and deliverable follows isolation', () => {
  const cfg = loadConfig(project(OK));
  assert.equal(cfg.members['eng-lead'].isolation, 'read-only');
  assert.equal(cfg.members['eng-lead'].deliverable, 'review');
  assert.equal(cfg.members.coo.deliverable, 'document');
  assert.equal(cfg.members.implementer.deliverable, 'diff');
});

test('an explicit deliverable overrides the one isolation would imply', () => {
  const cfg = loadConfig(project({
    members: { coo: { agent: 'claude', isolation: 'none', deliverable: 'decision' } },
    deny_paths: ['x']
  }));
  assert.equal(cfg.members.coo.deliverable, 'decision');
});

test('the org chart is built and returned alongside the members', () => {
  const cfg = loadConfig(project(OK));
  assert.deepEqual(cfg.org.roots, ['coo']);
  assert.deepEqual(cfg.org.reportsOf['eng-lead'], ['implementer']);
});

test('delegation caps have defaults a config can override', () => {
  const bare = loadConfig(project(OK));
  assert.equal(bare.defaults.on_unavailable, 'claude');
  assert.equal(bare.defaults.max_depth, 3);
  assert.equal(bare.defaults.max_delegations, 20);

  const tuned = loadConfig(project({ ...OK, defaults: { max_depth: 1 } }));
  assert.equal(tuned.defaults.max_depth, 1);
  assert.equal(tuned.defaults.on_unavailable, 'claude');
  assert.equal(tuned.defaults.max_delegations, 20);
});

test('an explicit null isolation or deliverable falls back to the default, rather than throwing', () => {
  const cfg = loadConfig(project({
    members: {
      a: { agent: 'claude', isolation: null },
      b: { agent: 'claude', deliverable: null }
    },
    deny_paths: ['x']
  }));
  assert.equal(cfg.members.a.isolation, 'read-only');
  assert.equal(cfg.members.a.deliverable, 'review');
  assert.equal(cfg.members.b.isolation, 'read-only');
  assert.equal(cfg.members.b.deliverable, 'review');
});

test('a falsy max_depth of 0 is preserved, not treated as absent', () => {
  const cfg = loadConfig(project({ ...OK, defaults: { max_depth: 0 } }));
  assert.equal(cfg.defaults.max_depth, 0);
  assert.equal(cfg.defaults.on_unavailable, 'claude');
  assert.equal(cfg.defaults.max_delegations, 20);
});

test('a malformed config names the file in the JSON parse error', () => {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  const path = join(root, CONFIG_RELPATH);
  writeFileSync(path, '{ "members": {, }');
  assert.throws(() => loadConfig(root), (err) => {
    assert.ok(err.message.startsWith(`${path}: `), err.message);
    assert.match(err.message, /Expected|JSON/);
    return true;
  });
});

// --- A1: member names are validated (path traversal via workspace dir names) ---

function memberProject(name, extra = {}) {
  return project({ members: { [name]: { agent: 'claude', ...extra } }, deny_paths: ['x'] });
}

test('a member name that path-traverses is refused', () => {
  const root = memberProject('../../../escaped');
  assert.throws(() => loadConfig(root), /\.\.\/\.\.\/\.\.\/escaped/);
});

test('a member name with ".." in the middle is refused', () => {
  const root = memberProject('a..b');
  assert.throws(() => loadConfig(root), /a\.\.b/);
});

test('a member name with a space is refused', () => {
  const root = memberProject('has space');
  assert.throws(() => loadConfig(root), /has space/);
});

test('a member name starting with a dash is refused', () => {
  const root = memberProject('-x');
  assert.throws(() => loadConfig(root), /-x/);
});

test('a member name shaped like a ref path is refused', () => {
  const root = memberProject('refs/heads/x');
  assert.throws(() => loadConfig(root), /refs\/heads\/x/);
});

test('a member name starting with a dot is refused', () => {
  const root = memberProject('.hidden');
  assert.throws(() => loadConfig(root), /\.hidden/);
});

test('an empty-string member name is refused', () => {
  const root = memberProject('');
  assert.throws(() => loadConfig(root), /member name/);
});

test('a member name over 64 characters is refused', () => {
  const root = memberProject('a'.repeat(65));
  assert.throws(() => loadConfig(root), /64/);
});

test('a member name with a NUL byte is refused', () => {
  const root = memberProject('bad\0name');
  assert.throws(() => loadConfig(root), /member name/);
});

test('a member name with a newline is refused', () => {
  const root = memberProject('bad\nname');
  assert.throws(() => loadConfig(root), /member name/);
});

test('ordinary member names still load', () => {
  const root = project({
    members: {
      qa: { agent: 'claude' },
      'eng-lead': { agent: 'claude' },
      impl_2: { agent: 'claude' },
      Designer: { agent: 'claude' }
    },
    deny_paths: ['x']
  });
  const cfg = loadConfig(root);
  assert.deepEqual(Object.keys(cfg.members).sort(), ['Designer', 'eng-lead', 'impl_2', 'qa']);
});

test('a member named toString still works — prototype-chain hardening depends on it staying legal', () => {
  const root = memberProject('toString');
  const cfg = loadConfig(root);
  assert.ok(cfg.members.toString);
  assert.equal(cfg.members.toString.agent, 'claude');
});

// --- A2: deny_paths entries that can never match under gitignore semantics ---

function denyProject(deny_paths) {
  return project({ members: { a: { agent: 'claude' } }, deny_paths });
}

test('a deny_paths entry with a leading ./ is refused', () => {
  const root = denyProject(['./credentials/**']);
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /\.\/credentials\/\*\*/);
    assert.match(err.message, /credentials\/\*\*/);
    return true;
  });
});

test('a deny_paths entry with a leading ../ is refused', () => {
  const root = denyProject(['../foo']);
  assert.throws(() => loadConfig(root), /\.\.\/foo/);
});

test('a non-string deny_paths entry is refused', () => {
  const root = denyProject([42]);
  assert.throws(() => loadConfig(root), /deny_paths/);
});

test('an empty-string deny_paths entry is refused', () => {
  const root = denyProject(['']);
  assert.throws(() => loadConfig(root), /deny_paths/);
});

test('deny_paths entries that do work still load', () => {
  const root = denyProject(['credentials/**', '/credentials/**', 'credentials/', '**/.env*', '!credentials/public.txt']);
  const cfg = loadConfig(root);
  assert.deepEqual(cfg.deny_paths, ['credentials/**', '/credentials/**', 'credentials/', '**/.env*', '!credentials/public.txt']);
});

// --- Group B: a member field of the wrong type crashed with a raw TypeError ---

test('a member whose value is null is refused, not crashed on with a raw TypeError', () => {
  const root = project({ members: { gamma: null }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /member "gamma" must be an object/);
});

test('a member whose value is an array is refused', () => {
  const root = project({ members: { gamma: ['agent'] }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /member "gamma" must be an object/);
});

test('a member whose value is a string is still handled by the existing "agent" is required message', () => {
  const root = project({ members: { gamma: 'claude' }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), /member "gamma": "agent" is required/);
});

test('a non-string skill is refused, not handed to path.join', () => {
  const root = memberProject('a', { skill: 42 });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /"skill"/);
    assert.match(err.message, /42/);
    return true;
  });
});

test('a skill name that path-traverses is refused, the same as a member name', () => {
  const root = memberProject('a', { skill: '../../etc/passwd' });
  assert.throws(() => loadConfig(root), /"skill"/);
});

test('a skill name with a slash is refused', () => {
  const root = memberProject('a', { skill: 'foo/bar' });
  assert.throws(() => loadConfig(root), /"skill"/);
});

test('an ordinary skill name still loads', () => {
  const root = memberProject('a', { skill: 'red-team' });
  const cfg = loadConfig(root);
  assert.equal(cfg.members.a.skill, 'red-team');
});

test('a member agent that path-traverses is refused, the same as a member name', () => {
  const root = project({ members: { a: { agent: '../../somewhere/evil' } }, deny_paths: ['x'] });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /"agent"/);
    assert.match(err.message, /\.\.\/\.\.\/somewhere\/evil/);
    return true;
  });
});

test('an on_unavailable fallback agent that path-traverses is refused', () => {
  const root = project({
    members: { a: { agent: 'claude' } },
    deny_paths: ['x'],
    defaults: { on_unavailable: '../../somewhere/evil' }
  });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /on_unavailable/);
    assert.match(err.message, /\.\.\/\.\.\/somewhere\/evil/);
    return true;
  });
});

// --- Group C: title, charter, persona, output_path, defaults must be the documented types ---

test('a non-string title is refused', () => {
  const root = memberProject('a', { title: ['Lead'] });
  assert.throws(() => loadConfig(root), /"title"/);
});

test('a non-string charter is refused', () => {
  const root = memberProject('a', { charter: 42 });
  assert.throws(() => loadConfig(root), /"charter"/);
});

test('a non-string persona is refused', () => {
  const root = memberProject('a', { persona: {} });
  assert.throws(() => loadConfig(root), /"persona"/);
});

test('a non-string output_path is refused', () => {
  const root = memberProject('a', { output_path: 42 });
  assert.throws(() => loadConfig(root), /"output_path"/);
});

test('an output_path that escapes with .. is refused', () => {
  const root = memberProject('a', { output_path: '../escape' });
  assert.throws(() => loadConfig(root), /"output_path"/);
});

test('an absolute output_path is refused', () => {
  const root = memberProject('a', { output_path: '/etc/passwd' });
  assert.throws(() => loadConfig(root), /"output_path"/);
});

test('an ordinary relative output_path still loads', () => {
  const root = memberProject('a', { output_path: 'docs/design' });
  const cfg = loadConfig(root);
  assert.equal(cfg.members.a.output_path, 'docs/design');
});

test('a non-object defaults block is refused', () => {
  const root = project({ ...OK, defaults: 'nope' });
  assert.throws(() => loadConfig(root), /"defaults" must be an object/);
});

test('an array defaults block is refused', () => {
  const root = project({ ...OK, defaults: [] });
  assert.throws(() => loadConfig(root), /"defaults" must be an object/);
});

// --- A1: max_depth and max_delegations must be integers, not just truthy values ---
//
// src/brief.js computes `canDelegate = hasReports && depth < maxDepth`. A non-number
// maxDepth makes that comparison false forever — a manager with reports silently loses
// the ability to delegate, with no thrown error and no warning. That is a behavioural
// regression, not a crash, so these assert on the eventual boolean, not on a throw.

test('a string max_depth is refused, naming the field and the value', () => {
  const root = project({ ...OK, defaults: { max_depth: 'three' } });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /max_depth/);
    assert.match(err.message, /"three"/);
    return true;
  });
});

test('a null max_depth is refused', () => {
  const root = project({ ...OK, defaults: { max_depth: null } });
  assert.throws(() => loadConfig(root), /max_depth/);
});

test('a negative max_depth is refused', () => {
  const root = project({ ...OK, defaults: { max_depth: -1 } });
  assert.throws(() => loadConfig(root), /max_depth/);
});

test('a non-integer (fractional) max_depth is refused', () => {
  const root = project({ ...OK, defaults: { max_depth: 1.5 } });
  assert.throws(() => loadConfig(root), /max_depth/);
});

test('a max_depth of 0 is accepted — it means "no delegation at all", a real, tested setting', () => {
  // src/brief.js: canDelegate = hasReports && depth < maxDepth. At depth 0, max_depth 0
  // deterministically refuses delegation for every member, which is a valid, intentional
  // configuration (see test/dispatch.test.js: "max_depth stops a manager from delegating
  // past the limit", which configures exactly this and asserts it works). Rejecting 0
  // here would break that real, currently-passing behaviour.
  const cfg = loadConfig(project({ ...OK, defaults: { max_depth: 0 } }));
  assert.equal(cfg.defaults.max_depth, 0);
});

test('a string max_delegations is refused, naming the field and the value', () => {
  const root = project({ ...OK, defaults: { max_delegations: 'lots' } });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /max_delegations/);
    assert.match(err.message, /"lots"/);
    return true;
  });
});

test('a null max_delegations is refused', () => {
  const root = project({ ...OK, defaults: { max_delegations: null } });
  assert.throws(() => loadConfig(root), /max_delegations/);
});

test('a negative max_delegations is refused', () => {
  const root = project({ ...OK, defaults: { max_delegations: -1 } });
  assert.throws(() => loadConfig(root), /max_delegations/);
});

test('a non-integer (fractional) max_delegations is refused', () => {
  const root = project({ ...OK, defaults: { max_delegations: 1.5 } });
  assert.throws(() => loadConfig(root), /max_delegations/);
});

test('a max_delegations of 0 is refused — zero runs is not a usable budget', () => {
  const root = project({ ...OK, defaults: { max_delegations: 0 } });
  assert.throws(() => loadConfig(root), /max_delegations/);
});

test('valid max_depth and max_delegations still load', () => {
  const cfg = loadConfig(project({ ...OK, defaults: { max_depth: 5, max_delegations: 50 } }));
  assert.equal(cfg.defaults.max_depth, 5);
  assert.equal(cfg.defaults.max_delegations, 50);
});

// --- A2: reports_to accepts a single-element array and coerces it to an object key ---

test('an array reports_to is refused, not silently coerced to a string key', () => {
  const root = project({
    members: { boss: { agent: 'claude' }, worker: { agent: 'claude', reports_to: ['boss'] } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /"reports_to"/);
    assert.match(err.message, /worker/);
    return true;
  });
});

test('a numeric reports_to is refused by the explicit type check, not by accident', () => {
  const root = project({
    members: { worker: { agent: 'claude', reports_to: 7 } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), /"reports_to"/);
});

test('an ordinary string reports_to still loads', () => {
  const cfg = loadConfig(project(OK));
  assert.equal(cfg.members['eng-lead'].reports_to, 'coo');
});

// --- A3: model is handed to the vendor CLI verbatim via spawnSync, which stringifies ---

test('an object model is refused before it reaches the vendor CLI', () => {
  const root = memberProject('a', { model: { size: 'big' } });
  assert.throws(() => loadConfig(root), /"model"/);
});

test('an array model is refused', () => {
  const root = memberProject('a', { model: ['x', 'y'] });
  assert.throws(() => loadConfig(root), /"model"/);
});

test('a numeric model is refused', () => {
  const root = memberProject('a', { model: 7 });
  assert.throws(() => loadConfig(root), /"model"/);
});

test('an empty-string model is refused', () => {
  const root = memberProject('a', { model: '' });
  assert.throws(() => loadConfig(root), /"model"/);
});

test('an ordinary string model still loads', () => {
  const root = memberProject('a', { model: 'claude-opus-4' });
  const cfg = loadConfig(root);
  assert.equal(cfg.members.a.model, 'claude-opus-4');
});

// --- B1: distinct_from of any non-array type threw a raw, unhelpful TypeError ---

test('a string distinct_from is refused, and the message suggests the array form', () => {
  const root = project({
    members: { a: { agent: 'claude' }, b: { agent: 'claude', distinct_from: 'a' } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /"distinct_from"/);
    assert.match(err.message, /\["a"\]/);
    return true;
  });
});

test('a numeric distinct_from is refused', () => {
  const root = project({
    members: { a: { agent: 'claude' }, b: { agent: 'claude', distinct_from: 3 } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), /"distinct_from"/);
});

test('an object distinct_from is refused', () => {
  const root = project({
    members: { a: { agent: 'claude' }, b: { agent: 'claude', distinct_from: {} } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), /"distinct_from"/);
});

test('a distinct_from entry naming no configured member is refused, not silently accepted', () => {
  // A typo'd name here silently disables the self-review guard distinct_from exists to
  // enforce, so it must be a load-time error, not a no-op.
  const root = project({
    members: { a: { agent: 'claude' }, b: { agent: 'claude', distinct_from: ['ghost'] } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /"distinct_from"/);
    assert.match(err.message, /ghost/);
    return true;
  });
});

test('a non-string entry inside a distinct_from array is refused', () => {
  const root = project({
    members: { a: { agent: 'claude' }, b: { agent: 'claude', distinct_from: [3] } },
    deny_paths: ['x']
  });
  assert.throws(() => loadConfig(root), /"distinct_from"/);
});

test('a distinct_from array naming a real member still loads', () => {
  const root = project({
    members: { a: { agent: 'claude' }, b: { agent: 'claude', distinct_from: ['a'] } },
    deny_paths: ['x']
  });
  const cfg = loadConfig(root);
  assert.deepEqual(cfg.members.b.distinct_from, ['a']);
});

// --- defaults.on_unavailable: the last unvalidated field in defaults ---
// It is only read when a vendor CLI is actually down (src/resolve.js:19), so a wrong type
// sits harmless until the worst possible moment and then reports "no usable fallback",
// blaming the outage rather than the typo that made the fallback unusable.
test('a non-string on_unavailable is refused at load, not at the moment a fallback is needed', () => {
  const root = project({ ...OK, defaults: { on_unavailable: 7 } });
  assert.throws(() => loadConfig(root), (err) => {
    assert.match(err.message, /on_unavailable/);
    assert.match(err.message, /must be a non-empty string/);
    assert.match(err.message, /7/);
    return true;
  });
});

test('an empty-string on_unavailable is refused', () => {
  assert.throws(() => loadConfig(project({ ...OK, defaults: { on_unavailable: '' } })),
    /on_unavailable/);
});

test('a string on_unavailable still loads', () => {
  const cfg = loadConfig(project({ ...OK, defaults: { on_unavailable: 'mock' } }));
  assert.equal(cfg.defaults.on_unavailable, 'mock');
});

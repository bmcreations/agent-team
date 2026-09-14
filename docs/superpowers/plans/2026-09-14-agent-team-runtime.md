# agent-team Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the role resolver, adapter protocol, worktree isolation, and plugin packaging so a skill can delegate a task to Codex, Grok, or Claude by naming a role rather than a vendor.

**Architecture:** A Node dispatcher resolves a team member to an agent using a per-project JSON config, builds an isolated workspace with denied paths excluded from the object store, assembles a brief (tool-dialect table + skill markdown + task), and runs a per-vendor adapter executable that takes the brief on stdin and returns one JSON result on stdout. A `mock` adapter makes every piece of that testable offline.

**Tech Stack:** Node 26 (zero runtime dependencies: `node:test`, `node:assert`, `node:util.parseArgs`, `node:child_process`), git 2.46 filtered clones, POSIX-executable adapters.

> **Read [Revision 2](#revision-2--team-members-hierarchy-and-real-isolation) at the end of this
> document before implementing anything.** It replaces Tasks 2, 3, 4, 7 and 8 with Tasks R1-R6:
> roles become definable team members in a reporting tree, and worktree isolation is replaced by
> filtered clones after review showed the original exclusion was bypassable.

---

## Scope

Covers spec Phase 1 (runtime) and Phase 2 (packaging).

**Phase 0 (ACP spike) is BLOCKED and not in this plan.** It requires `codex` and `grok` installed and authenticated, which is a purchase decision: Grok Build needs SuperGrok or X Premium+ (or an xAI API key); Codex needs ChatGPT Plus or Pro (or an OpenAI key). Neither is installed. The spike's kill criterion is recorded in the spec and must run before Task 11 and Task 12 are trusted, because if ACP wins those two adapters get rewritten.

**Phase 3 (MCP front-end) is out of scope by design.** It wraps the same scripts and must not be built until the adapter contract has survived real use.

## Deviation from the spec

The spec illustrates config as TOML. This plan uses **JSON** at `.claude/agent-team.json`.

Reason: `require('node:toml')` fails with `ERR_UNKNOWN_BUILTIN_MODULE` on Node 26, so TOML costs a runtime dependency in a plugin whose value proposition is being trivially installable. JSON also matches the files this audience already hand-edits (`settings.json`, `plugin.json`, `marketplace.json`). Every other spec decision is implemented as written.

## File structure

| File | Responsibility |
|---|---|
| `package.json` | zero-dep module manifest, `node --test` wiring |
| `src/config.js` | load and validate `.claude/agent-team.json`; reject a config with no denylist |
| `src/resolve.js` | role to agent, `on_unavailable` fallback, `distinct_from` hard stop |
| `src/adapter.js` | spawn an adapter, feed the brief, enforce timeout, parse one result |
| `src/worktree.js` | create and prune worktrees; exclude denied paths by sparse-checkout |
| `src/brief.js` | assemble dialect table + skill markdown + task into one brief |
| `src/dispatch.js` | orchestrate the above; decide prune-vs-keep |
| `adapters/mock` | scripted responses, no network, no cost |
| `adapters/claude` | delegate to a Claude subagent |
| `adapters/codex` | `codex exec --json` |
| `adapters/grok` | `grok -p` |
| `references/grok-tools.md` | tool-dialect table for Grok (none ships upstream) |
| `references/codex-tools.md` | tool-dialect table for Codex |
| `bin/agent-team.js` | CLI entry point the `delegate` skill shells out to |
| `test/conformance.js` | the round-trip every adapter must pass |
| `skills/delegate/SKILL.md` | the skill that calls the dispatcher by role |
| `skills/agent-team-init/SKILL.md` | writes a starter config with a seeded denylist |
| `.claude-plugin/plugin.json` | plugin manifest |
| `.claude-plugin/marketplace.json` | marketplace manifest |
| `test/*.test.js` | one test file per `src/` module |

---

### Task 1: Scaffold the package and prove the test runner works

**Files:**
- Create: `package.json`
- Create: `test/smoke.test.js`

- [ ] **Step 1: Write the failing test**

`test/smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version } from '../src/version.js';

test('package exposes a version string', () => {
  assert.equal(typeof version, 'string');
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/version.js'`

- [ ] **Step 3: Write the minimal implementation**

`package.json`:

```json
{
  "name": "@bmcreations/agent-team",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": { "test": "node --test 'test/**/*.test.js'" }
}
```

`src/version.js`:

```js
export const version = '0.1.0';
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test`
Expected: PASS, `# pass 1`

- [ ] **Step 5: Commit**

```bash
git add package.json src/version.js test/smoke.test.js
git commit -m "chore: scaffold zero-dependency node package with built-in test runner"
```

---

### Task 2: Config loader that refuses a config with no denylist

> **SUPERSEDED by Task R2.** The denylist rule survives there unchanged.


The spec requires that `init` refuse to write a config without a denylist. The loader enforces the same rule, so a hand-edited config cannot quietly drop it.

**Files:**
- Create: `src/config.js`
- Create: `test/config.test.js`

- [ ] **Step 1: Write the failing tests**

`test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function projectWith(config) {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify(config));
  return root;
}

const VALID = {
  roles: { reviewer: { agent: 'codex', isolation: 'read-only' } },
  deny_paths: ['**/.env*']
};

test('loads roles and deny_paths', () => {
  const cfg = loadConfig(projectWith(VALID));
  assert.equal(cfg.roles.reviewer.agent, 'codex');
  assert.deepEqual(cfg.deny_paths, ['**/.env*']);
});

test('defaults on_unavailable to claude', () => {
  const cfg = loadConfig(projectWith(VALID));
  assert.equal(cfg.defaults.on_unavailable, 'claude');
});

test('explicit defaults override the built-in', () => {
  const cfg = loadConfig(projectWith({ ...VALID, defaults: { on_unavailable: 'mock' } }));
  assert.equal(cfg.defaults.on_unavailable, 'mock');
});

test('rejects a config with no deny_paths', () => {
  assert.throws(
    () => loadConfig(projectWith({ roles: VALID.roles })),
    /deny_paths/
  );
});

test('rejects a config with an empty deny_paths', () => {
  assert.throws(
    () => loadConfig(projectWith({ ...VALID, deny_paths: [] })),
    /deny_paths/
  );
});

test('rejects a config with no roles', () => {
  assert.throws(() => loadConfig(projectWith({ deny_paths: ['x'] })), /roles/);
});

test('reports the path when the file is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'at-cfg-'));
  assert.throws(() => loadConfig(root), /agent-team\.json/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/config.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/config.js`:

```js
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
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): load agent-team.json and refuse a config with no denylist"
```

---

### Task 3: Role resolution, fallback, and the distinct_from hard stop

> **SUPERSEDED by Task R3.** The fallback and `distinct_from` ordering survive there unchanged.


The ordering here is the whole point: `distinct_from` is checked **after** fallback, so a fallback cannot smuggle in the self-review the constraint exists to prevent. An unsatisfiable constraint throws; it never degrades.

**Files:**
- Create: `src/resolve.js`
- Create: `test/resolve.test.js`

- [ ] **Step 1: Write the failing tests**

`test/resolve.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole } from '../src/resolve.js';

const CONFIG = {
  roles: {
    implementer: { agent: 'codex', model: 'gpt-5-codex', isolation: 'worktree' },
    reviewer:    { agent: 'codex', isolation: 'read-only' },
    'red-team':  { agent: 'grok', skill: 'red-team', isolation: 'worktree',
                   distinct_from: ['implementer'] }
  },
  deny_paths: ['**/.env*'],
  defaults: { on_unavailable: 'claude' }
};

const all = () => true;
const none = (a) => a === 'claude';

test('resolves a role to its configured agent', () => {
  const r = resolveRole(CONFIG, 'implementer', { probe: all });
  assert.equal(r.agent, 'codex');
  assert.equal(r.model, 'gpt-5-codex');
  assert.equal(r.isolation, 'worktree');
  assert.equal(r.warning, null);
});

test('carries the skill binding through', () => {
  const r = resolveRole(CONFIG, 'red-team', { probe: all });
  assert.equal(r.skill, 'red-team');
});

test('falls back when the agent is unavailable, and warns', () => {
  const r = resolveRole(CONFIG, 'reviewer', { probe: none });
  assert.equal(r.agent, 'claude');
  assert.match(r.warning, /codex.*unavailable.*claude/);
});

test('isolation defaults to read-only when unset', () => {
  const cfg = { ...CONFIG, roles: { researcher: { agent: 'claude' } } };
  assert.equal(resolveRole(cfg, 'researcher', { probe: all }).isolation, 'read-only');
});

test('model and skill default to null when the role omits them', () => {
  const cfg = { ...CONFIG, roles: { researcher: { agent: 'claude' } } };
  const r = resolveRole(cfg, 'researcher', { probe: all });
  assert.equal(r.model, null);
  assert.equal(r.skill, null);
});

test('distinct_from stops a self-review instead of falling back', () => {
  assert.throws(
    () => resolveRole(CONFIG, 'red-team', {
      probe: all,
      assignments: { implementer: 'grok' }
    }),
    /distinct_from/
  );
});

test('distinct_from also blocks a violation introduced BY the fallback', () => {
  // grok is unavailable so red-team falls back to claude, but claude
  // already implemented — the fallback must not be allowed to stand.
  assert.throws(
    () => resolveRole(CONFIG, 'red-team', {
      probe: none,
      assignments: { implementer: 'claude' }
    }),
    /distinct_from/
  );
});

test('throws when neither the agent nor the fallback is available', () => {
  assert.throws(
    () => resolveRole(CONFIG, 'reviewer', { probe: () => false }),
    /no usable fallback/
  );
});

test('throws on an unknown role', () => {
  assert.throws(() => resolveRole(CONFIG, 'nope', { probe: all }), /unknown role/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/resolve.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/resolve.js`:

```js
export function resolveRole(config, roleName, { probe, assignments = {} } = {}) {
  const role = config.roles[roleName];
  if (!role) {
    throw new Error(`unknown role: ${roleName} (configured: ${Object.keys(config.roles).join(', ')})`);
  }

  let agent = role.agent;
  let warning = null;

  if (!probe(agent)) {
    const fallback = config.defaults?.on_unavailable;
    if (!fallback || !probe(fallback)) {
      throw new Error(
        `role "${roleName}": agent "${agent}" is unavailable and no usable fallback ` +
        `(on_unavailable: ${fallback ?? 'unset'})`
      );
    }
    warning = `agent "${agent}" unavailable; fell back to "${fallback}"`;
    agent = fallback;
  }

  // Checked AFTER fallback: a fallback must not create the self-review
  // that distinct_from exists to prevent.
  const conflicts = (role.distinct_from ?? []).filter((other) => assignments[other] === agent);
  if (conflicts.length > 0) {
    throw new Error(
      `role "${roleName}": distinct_from forbids "${agent}", already assigned to ` +
      `${conflicts.join(', ')} — refusing to let an agent review its own work` +
      (warning ? ` (reached via fallback: ${warning})` : '')
    );
  }

  return {
    role: roleName,
    agent,
    model: role.model ?? null,
    skill: role.skill ?? null,
    isolation: role.isolation ?? 'read-only',
    warning
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 9 new tests

- [ ] **Step 5: Commit**

```bash
git add src/resolve.js test/resolve.test.js
git commit -m "feat(resolve): map roles to agents with fallback and a distinct_from hard stop"
```

---

### Task 4: Worktree creation with denied paths excluded by construction

> **SUPERSEDED by Task R4.** The premise of this task was disproved by its own review:
> sparse-checkout hides denied files from the working tree but leaves them readable via
> `git show`, `git cat-file`, and `git archive`. Do not implement this task.


This is the security boundary. The test asserts a **fact about the filesystem** — the denied file is not there — rather than trusting any vendor's sandbox flag.

Note a property worth keeping: `git worktree add` materialises only tracked files, so an untracked local `.env` never appears in the worktree at all. Sparse-checkout covers the tracked case.

**Files:**
- Create: `src/worktree.js`
- Create: `test/worktree.test.js`

- [ ] **Step 1: Write the failing tests**

`test/worktree.test.js`:

```js
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
  git('config', 'commit.gpgsign', 'false');   // global commit.gpgsign=true would break the fixture
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/worktree.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/worktree.js`:

```js
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
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 5 new tests

If "denied paths are ABSENT" fails, the sparse pattern syntax is wrong — inspect with `git -C <wt.dir> sparse-checkout list` and confirm negations are present. Do not proceed past a red test here; this is the security boundary.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.js test/worktree.test.js
git commit -m "feat(worktree): isolate each delegation and exclude denied paths by sparse-checkout"
```

---

### Task 5: The mock adapter

Shipped as a real component, not a fixture: every later test uses it, so the runtime is testable offline and free.

**Files:**
- Create: `adapters/mock`
- Create: `test/mock-adapter.test.js`

- [ ] **Step 1: Write the failing tests**

`test/mock-adapter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER = new URL('../adapters/mock', import.meta.url).pathname;

const run = (args, { input, env } = {}) =>
  execFileSync(ADAPTER, args, { input, env: { ...process.env, ...env } }).toString();

test('probe succeeds', () => {
  assert.match(run(['probe']), /mock/);
});

test('capabilities reports a writable, worktree-capable agent', () => {
  const caps = JSON.parse(run(['capabilities']));
  assert.equal(caps.write, true);
  assert.equal(caps.worktree, true);
  assert.equal(caps.tool_dialect, 'claude');
});

test('run replays the scripted result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-mock-'));
  const script = join(dir, 'script.json');
  writeFileSync(script, JSON.stringify({
    status: 'ok', summary: 'scripted', findings: [{ title: 'f1' }], checked_sound: ['c1']
  }));
  const out = JSON.parse(run(['run'], {
    input: JSON.stringify({ role: 'reviewer', task: 't', cwd: dir }),
    env: { AGENT_TEAM_MOCK_SCRIPT: script }
  }));
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.checked_sound, ['c1']);
});

test('run echoes the received brief so the dispatcher can be asserted on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-mock-'));
  const script = join(dir, 'script.json');
  writeFileSync(script, JSON.stringify({ status: 'ok', summary: 's' }));
  const out = JSON.parse(run(['run'], {
    input: JSON.stringify({ role: 'red-team', task: 'BRIEF-BODY', cwd: dir }),
    env: { AGENT_TEAM_MOCK_SCRIPT: script }
  }));
  assert.equal(out.received.role, 'red-team');
  assert.equal(out.received.task, 'BRIEF-BODY');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `ENOENT` spawning `adapters/mock`

- [ ] **Step 3: Write the minimal implementation**

`adapters/mock`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const sub = process.argv[2];

if (sub === 'probe') {
  process.stdout.write('mock 0.1.0\n');
  process.exit(0);
}

if (sub === 'capabilities') {
  process.stdout.write(JSON.stringify({
    write: true, worktree: true, structured_output: true, tool_dialect: 'claude'
  }) + '\n');
  process.exit(0);
}

if (sub === 'run') {
  const brief = JSON.parse(readFileSync(0, 'utf8'));
  const scriptPath = process.env.AGENT_TEAM_MOCK_SCRIPT;
  if (!scriptPath) {
    process.stderr.write('AGENT_TEAM_MOCK_SCRIPT is not set\n');
    process.exit(2);
  }
  const scripted = JSON.parse(readFileSync(scriptPath, 'utf8'));

  if (scripted.hang) {
    // never exits; the caller's timeout has to kill the process group. Task 8 exercises this.
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(JSON.stringify({ ...scripted, received: brief }) + '\n');
    process.exit(0);
  }
}

process.stderr.write(`unknown subcommand: ${sub}\n`);
process.exit(2);
```

Make it executable:

```bash
chmod +x adapters/mock
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 4 new tests

- [ ] **Step 5: Commit**

```bash
git add adapters/mock test/mock-adapter.test.js
git commit -m "feat(adapters): add the mock adapter so the runtime is testable offline"
```

---

### Task 6: The adapter runner — timeout, process groups, and non-JSON output

**Files:**
- Create: `src/adapter.js`
- Create: `test/adapter.test.js`
- Create: `test/fixtures/hang`, `test/fixtures/garbage`, `test/fixtures/crash`

- [ ] **Step 1: Write the failing tests**

`test/adapter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdapter } from '../src/adapter.js';

const p = (n) => new URL(`../${n}`, import.meta.url).pathname;

test('returns the parsed result object', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-ad-'));
  const script = join(dir, 's.json');
  writeFileSync(script, JSON.stringify({ status: 'ok', summary: 'done' }));
  const res = await runAdapter(p('adapters/mock'), 'run', {
    brief: { role: 'reviewer', task: 't', cwd: dir },
    env: { AGENT_TEAM_MOCK_SCRIPT: script }
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.summary, 'done');
});

test('a timeout kills the adapter and reports status timeout', async () => {
  const res = await runAdapter(p('test/fixtures/hang'), 'run', {
    brief: { task: 't' }, timeoutMs: 300
  });
  assert.equal(res.status, 'timeout');
  assert.match(res.summary, /300/);
});

test('non-JSON on stdout becomes a failure, not a crash', async () => {
  const res = await runAdapter(p('test/fixtures/garbage'), 'run', { brief: { task: 't' } });
  assert.equal(res.status, 'failed');
  assert.match(res.summary, /non-JSON/);
  assert.match(res.raw, /not json/);
});

test('a non-zero exit becomes a failure carrying stderr', async () => {
  const res = await runAdapter(p('test/fixtures/crash'), 'run', { brief: { task: 't' } });
  assert.equal(res.status, 'failed');
  assert.match(res.summary, /exited 3/);
  assert.match(res.stderr, /boom/);
});

test('only the LAST stdout line is parsed, so chatter is tolerated', async () => {
  const res = await runAdapter(p('test/fixtures/chatty'), 'run', { brief: { task: 't' } });
  assert.equal(res.status, 'ok');
});
```

`test/fixtures/hang`:

```sh
#!/bin/sh
cat > /dev/null
sleep 30
```

`test/fixtures/garbage`:

```sh
#!/bin/sh
cat > /dev/null
echo "this is not json"
```

`test/fixtures/crash`:

```sh
#!/bin/sh
cat > /dev/null
echo "boom" >&2
exit 3
```

`test/fixtures/chatty`:

```sh
#!/bin/sh
cat > /dev/null
echo "downloading model..."
echo "thinking..."
echo '{"status":"ok","summary":"fine"}'
```

```bash
chmod +x test/fixtures/hang test/fixtures/garbage test/fixtures/crash test/fixtures/chatty
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/adapter.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/adapter.js`:

```js
import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 900_000;

export function runAdapter(execPath, subcommand, {
  brief = null, timeoutMs = DEFAULT_TIMEOUT_MS, env = {}, cwd = undefined
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(execPath, [subcommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,               // own process group, so the whole tree dies on timeout
      env: { ...process.env, ...env },
      cwd
    });

    let out = '', err = '', timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: 'failed', summary: `could not spawn adapter: ${e.message}`, stderr: err });
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        return resolve({
          status: 'timeout',
          summary: `adapter timed out after ${timeoutMs}ms`,
          stderr: err
        });
      }
      if (code !== 0) {
        return resolve({ status: 'failed', summary: `adapter exited ${code}`, stderr: err });
      }

      const lines = out.trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1] ?? '';
      try {
        const parsed = JSON.parse(last);
        resolve({ ...parsed, stderr: err });
      } catch {
        resolve({
          status: 'failed',
          summary: 'adapter emitted non-JSON on stdout',
          raw: out.slice(0, 2000),
          stderr: err
        });
      }
    });

    child.stdin.end(brief ? JSON.stringify(brief) : '');
  });
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 5 new tests. The timeout test should complete in well under a second, not 30 — if it takes 30s, `detached` or the negative-pid kill is wrong.

- [ ] **Step 5: Commit**

```bash
git add src/adapter.js test/adapter.test.js test/fixtures
git commit -m "feat(adapter): run adapters with process-group timeouts and tolerant result parsing"
```

---

### Task 7: Brief assembly with tool-dialect translation

> **SUPERSEDED by Task R5.** The dialect loader and section ordering survive there unchanged;
> the brief gains charter, persona, deliverable, and the delegation protocol.


A skill written for Claude says `TodoWrite` and `Read`. Superpowers already ships dialect tables for Codex, Gemini, and Copilot; Grok has none, so this task writes one.

**Files:**
- Create: `src/brief.js`
- Create: `references/grok-tools.md`
- Create: `references/codex-tools.md`
- Create: `test/brief.test.js`

- [ ] **Step 1: Write the failing tests**

`test/brief.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, loadDialect } from '../src/brief.js';

const RESOLVED = {
  role: 'red-team', agent: 'grok', model: null,
  skill: 'red-team', isolation: 'worktree', warning: null
};

test('the brief carries role, cwd, and deny_paths', () => {
  const b = buildBrief({
    resolved: RESOLVED, task: 'Attack the parser.', cwd: '/tmp/wt',
    denyPaths: ['**/.env*'], skillText: null, dialectText: null
  });
  assert.equal(b.role, 'red-team');
  assert.equal(b.cwd, '/tmp/wt');
  assert.deepEqual(b.deny_paths, ['**/.env*']);
});

test('read_only is derived from isolation', () => {
  const ro = buildBrief({
    resolved: { ...RESOLVED, isolation: 'read-only' },
    task: 't', cwd: '/tmp', denyPaths: ['x']
  });
  assert.equal(ro.read_only, true);

  const rw = buildBrief({ resolved: RESOLVED, task: 't', cwd: '/tmp', denyPaths: ['x'] });
  assert.equal(rw.read_only, false);
});

test('the task body carries dialect, then skill, then the task itself, in order', () => {
  const b = buildBrief({
    resolved: RESOLVED, task: 'THE-TASK', cwd: '/tmp', denyPaths: ['x'],
    skillText: 'THE-SKILL', dialectText: 'THE-DIALECT'
  });
  const iDialect = b.task.indexOf('THE-DIALECT');
  const iSkill = b.task.indexOf('THE-SKILL');
  const iTask = b.task.indexOf('THE-TASK');
  assert.ok(iDialect >= 0 && iSkill > iDialect && iTask > iSkill,
    `expected dialect < skill < task, got ${iDialect}/${iSkill}/${iTask}`);
});

test('a task with no skill binding is just the task', () => {
  const b = buildBrief({
    resolved: { ...RESOLVED, skill: null }, task: 'ONLY', cwd: '/tmp', denyPaths: ['x']
  });
  assert.match(b.task, /ONLY/);
});

test('the claude dialect is empty, because no translation is needed', () => {
  assert.equal(loadDialect('claude'), null);
});

test('the grok dialect exists and mentions skills', () => {
  assert.match(loadDialect('grok'), /skill/i);
});

test('an unknown dialect is null rather than an error', () => {
  assert.equal(loadDialect('nonesuch'), null);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/brief.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/brief.js`:

```js
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REFS = join(dirname(fileURLToPath(import.meta.url)), '..', 'references');

export function loadDialect(dialect) {
  if (!dialect || dialect === 'claude') return null;   // native vocabulary, nothing to translate
  const path = join(REFS, `${dialect}-tools.md`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function buildBrief({
  resolved, task, cwd, denyPaths, skillText = null, dialectText = null, timeoutSec = 900
}) {
  const sections = [];
  if (dialectText) sections.push(dialectText);
  if (skillText) sections.push(skillText);
  sections.push(`# Task\n\n${task}`);

  return {
    role: resolved.role,
    task: sections.join('\n\n---\n\n'),
    cwd,
    read_only: resolved.isolation === 'read-only',
    model: resolved.model,
    timeout_s: timeoutSec,
    deny_paths: denyPaths
  };
}
```

`references/grok-tools.md`:

```markdown
# Grok Tool Mapping

Skills in this library are written against Claude Code's tool names. Use your
native equivalent for each.

| Skill references | What to use |
|---|---|
| `Read`, `Write`, `Edit` | your native file tools |
| `Bash` | your native shell tool |
| `Grep`, `Glob` | your native search tools |
| `TodoWrite` | your native plan or task-tracking tool, if you have one |
| `Skill` (invoke a skill) | the skill text is already inlined below; just follow it |
| `Task` / subagent dispatch | your native subagent mechanism, if you have one; otherwise do the work inline and say so |

If a skill instructs you to use a tool you do not have, do the equivalent work
with what you do have and record the substitution in your result summary. Do not
silently skip the step.
```

`references/codex-tools.md`: same table, with `TodoWrite` mapped to `update_plan` and `Task` mapped to `spawn_agent` / `wait_agent` / `close_agent`, matching the mapping Superpowers already publishes.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 7 new tests

- [ ] **Step 5: Commit**

```bash
git add src/brief.js references test/brief.test.js
git commit -m "feat(brief): assemble briefs with tool-dialect translation for non-Claude agents"
```

---

### Task 8: The dispatcher

> **SUPERSEDED by Task R6.** Kept as the record of the flat, non-recursive dispatcher.


Ties the pieces together and owns the prune-vs-keep decision: keep the worktree on any failure so it can be inspected, prune it on success.

**Files:**
- Create: `src/dispatch.js`
- Create: `test/dispatch.test.js`

- [ ] **Step 1: Write the failing tests**

`test/dispatch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';

function project(scripted) {
  const root = mkdtempSync(join(tmpdir(), 'at-dsp-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');   // global commit.gpgsign=true would break the fixture
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, 'app.js'), 'ok\n');
  writeFileSync(join(root, 'credentials', 'key.p8'), 'SECRET\n');
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    roles: { 'red-team': { agent: 'mock', skill: null, isolation: 'worktree' } },
    deny_paths: ['credentials/**'],
    defaults: { on_unavailable: 'mock' }
  }));
  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify(scripted));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, script };
}

const adapterDir = new URL('../adapters/', import.meta.url).pathname;

`{ hang: true }` is the never-exit branch of the mock from Task 5. The kill itself is already covered
by `test/fixtures/hang` in Task 6; this test asserts the dispatcher's prune decision on a timeout.

test('a successful run returns the result and prunes the worktree', async () => {
  const { root, script } = project({ status: 'ok', summary: 'clean', findings: [] });
  const r = await dispatch({
    projectRoot: root, role: 'red-team', task: 'look',
    adapterDir, env: { AGENT_TEAM_MOCK_SCRIPT: script }
  });
  assert.equal(r.status, 'ok');
  assert.equal(existsSync(r.worktree.dir), false, 'worktree should be pruned on success');
});

test('a failed run KEEPS the worktree for inspection', async () => {
  const { root, script } = project({ status: 'failed', summary: 'exploded' });
  const r = await dispatch({
    projectRoot: root, role: 'red-team', task: 'look',
    adapterDir, env: { AGENT_TEAM_MOCK_SCRIPT: script }
  });
  assert.equal(r.status, 'failed');
  assert.equal(existsSync(r.worktree.dir), true, 'worktree should survive a failure');
});

test('the adapter is handed a worktree with the secret removed', async () => {
  const { root, script } = project({ status: 'ok', summary: 's' });
  const r = await dispatch({
    projectRoot: root, role: 'red-team', task: 'look',
    adapterDir, env: { AGENT_TEAM_MOCK_SCRIPT: script }
  });
  // the mock echoes its brief back
  assert.ok(r.received.cwd.includes('worktrees'));
  assert.equal(existsSync(join(r.received.cwd, 'credentials', 'key.p8')), false);
});

test('a timed-out run also keeps the worktree', async () => {
  const { root, script } = project({ hang: true });
  const r = await dispatch({
    projectRoot: root, role: 'red-team', task: 'look', adapterDir,
    env: { AGENT_TEAM_MOCK_SCRIPT: script }, timeoutMs: 1500
  });
  assert.equal(r.status, 'timeout');
  assert.equal(existsSync(r.worktree.dir), true, 'a timeout is a failure; keep the evidence');
});

test('an unknown role fails before any worktree is created', async () => {
  const { root, script } = project({ status: 'ok', summary: 's' });
  await assert.rejects(
    () => dispatch({ projectRoot: root, role: 'nope', task: 't', adapterDir,
                     env: { AGENT_TEAM_MOCK_SCRIPT: script } }),
    /unknown role/
  );
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/dispatch.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/dispatch.js`:

```js
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { resolveRole } from './resolve.js';
import { createWorktree, pruneWorktree } from './worktree.js';
import { buildBrief, loadDialect } from './brief.js';
import { runAdapter, DEFAULT_TIMEOUT_MS } from './adapter.js';

const adapterPath = (dir, agent) => join(dir, agent);

function makeProbe(adapterDir, env) {
  return (agent) => {
    const p = adapterPath(adapterDir, agent);
    if (!existsSync(p)) return false;
    try {
      // probe must be cheap; a non-zero exit means the agent is unusable, not an error
      execFileSync(p, ['probe'], { stdio: 'pipe', env: { ...process.env, ...env }, timeout: 30_000 });
      return true;
    } catch { return false; }
  };
}

async function readCapabilities(adapterDir, agent, env) {
  const res = await runAdapter(adapterPath(adapterDir, agent), 'capabilities', { env });
  return res.status === 'failed' ? {} : res;
}

export async function dispatch({
  projectRoot, role, task, adapterDir, assignments = {},
  skillsDir = null, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const config = loadConfig(projectRoot);
  const probe = makeProbe(adapterDir, env);
  const resolved = resolveRole(config, role, { probe, assignments });   // throws before any side effect

  const caps = await readCapabilities(adapterDir, resolved.agent, env);
  const dialectText = loadDialect(caps.tool_dialect ?? resolved.agent);

  let skillText = null;
  if (resolved.skill && skillsDir) {
    const p = join(skillsDir, resolved.skill, 'SKILL.md');
    if (!existsSync(p)) throw new Error(`role "${role}" binds skill "${resolved.skill}" but ${p} is missing`);
    skillText = readFileSync(p, 'utf8');
  }

  const worktree = createWorktree(projectRoot, role, config.deny_paths);

  const brief = buildBrief({
    resolved, task, cwd: worktree.dir, denyPaths: config.deny_paths,
    skillText, dialectText, timeoutSec: Math.floor(timeoutMs / 1000)
  });

  const result = await runAdapter(adapterPath(adapterDir, resolved.agent), 'run', {
    brief, timeoutMs, env, cwd: worktree.dir
  });

  if (result.status === 'ok') {
    pruneWorktree(projectRoot, worktree.dir);
  }

  return { ...result, role, agent: resolved.agent, warning: resolved.warning, worktree };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 4 new tests

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.js test/dispatch.test.js
git commit -m "feat(dispatch): orchestrate resolve, isolate, brief, and run"
```

---

### Task 9: The claude adapter

The only adapter buildable and testable end to end today, since Claude Code is already installed and authenticated.

**Files:**
- Create: `adapters/claude`
- Create: `test/claude-adapter.test.js`

- [ ] **Step 1: Write the failing tests**

`test/claude-adapter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ADAPTER = new URL('../adapters/claude', import.meta.url).pathname;

test('probe reports availability without making a network call', () => {
  // probe must be cheap: it checks the binary exists, it does not run a turn
  const started = Date.now();
  try { execFileSync(ADAPTER, ['probe'], { stdio: 'pipe' }); } catch { /* absent is fine */ }
  assert.ok(Date.now() - started < 5000, 'probe must not run an inference turn');
});

test('capabilities declares the claude dialect', () => {
  const caps = JSON.parse(execFileSync(ADAPTER, ['capabilities']).toString());
  assert.equal(caps.tool_dialect, 'claude');
  assert.equal(caps.write, true);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `ENOENT` spawning `adapters/claude`

- [ ] **Step 3: Write the minimal implementation**

`adapters/claude`:

```js
#!/usr/bin/env node
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sub = process.argv[2];

if (sub === 'probe') {
  const r = spawnSync('claude', ['--version'], { stdio: 'pipe' });
  if (r.status !== 0) { process.stderr.write('claude not on PATH\n'); process.exit(1); }
  process.stdout.write(r.stdout.toString().trim() + '\n');
  process.exit(0);
}

if (sub === 'capabilities') {
  process.stdout.write(JSON.stringify({
    write: true, worktree: true, structured_output: true, tool_dialect: 'claude'
  }) + '\n');
  process.exit(0);
}

if (sub === 'run') {
  const brief = JSON.parse(readFileSync(0, 'utf8'));
  const logDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-'));
  const logPath = join(logDir, 'session.log');

  const args = ['-p', brief.task, '--output-format', 'json'];
  if (brief.model) args.push('--model', brief.model);
  if (brief.read_only) args.push('--permission-mode', 'plan');

  const r = spawnSync('claude', args, {
    cwd: brief.cwd, stdio: 'pipe', timeout: (brief.timeout_s ?? 900) * 1000
  });

  writeFileSync(logPath, (r.stdout ?? '').toString() + (r.stderr ?? '').toString());

  if (r.status !== 0) {
    process.stdout.write(JSON.stringify({
      status: 'failed', summary: `claude exited ${r.status}`, log_path: logPath
    }) + '\n');
    process.exit(0);
  }

  let summary = '';
  try { summary = JSON.parse(r.stdout.toString()).result ?? ''; }
  catch { summary = r.stdout.toString().slice(0, 4000); }

  let diff = '';
  try { diff = execFileSync('git', ['-C', brief.cwd, 'diff', 'HEAD'], { stdio: 'pipe' }).toString(); }
  catch { /* no repo, no diff */ }

  let branch = null;
  try { branch = execFileSync('git', ['-C', brief.cwd, 'branch', '--show-current'], { stdio: 'pipe' }).toString().trim(); }
  catch { /* ignore */ }

  process.stdout.write(JSON.stringify({
    status: 'ok',
    summary,
    findings: [],
    checked_sound: [],
    artifacts: { branch, diff: diff.slice(0, 200_000) },
    log_path: logPath
  }) + '\n');
  process.exit(0);
}

process.stderr.write(`unknown subcommand: ${sub}\n`);
process.exit(2);
```

```bash
chmod +x adapters/claude
```

Note the shape every adapter must follow: the full session output goes to `log_path`; only the summary and the diff cross the stdout boundary.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 2 new tests

- [ ] **Step 5: Commit**

```bash
git add adapters/claude test/claude-adapter.test.js
git commit -m "feat(adapters): add the claude adapter"
```

---

### Task 10: The conformance suite

Any adapter must pass the same round-trip before it counts as installed. Opt-in, because real vendors cost money.

**Files:**
- Create: `test/conformance.js`
- Create: `test/conformance.test.js`

- [ ] **Step 1: Write the failing test**

`test/conformance.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conformanceReport } from './conformance.js';

const adapterDir = new URL('../adapters/', import.meta.url).pathname;

test('the mock adapter is conformant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-conf-'));
  const script = join(dir, 's.json');
  writeFileSync(script, JSON.stringify({ status: 'ok', summary: 'fine' }));
  const report = await conformanceReport(join(adapterDir, 'mock'), {
    env: { AGENT_TEAM_MOCK_SCRIPT: script }, cwd: dir
  });
  assert.equal(report.conformant, true, JSON.stringify(report.failures));
});

test('an adapter missing capabilities is reported non-conformant', async () => {
  const report = await conformanceReport(
    new URL('./fixtures/crash', import.meta.url).pathname, {}
  );
  assert.equal(report.conformant, false);
  assert.ok(report.failures.length > 0);
});

// Opt-in: AGENT_TEAM_CONFORMANCE=codex,grok npm test
const targets = (process.env.AGENT_TEAM_CONFORMANCE ?? '').split(',').filter(Boolean);
for (const agent of targets) {
  test(`real adapter "${agent}" is conformant`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'at-conf-real-'));
    const report = await conformanceReport(join(adapterDir, agent), { cwd: dir });
    assert.equal(report.conformant, true, JSON.stringify(report.failures, null, 2));
  });
}
```

`test/conformance.js`:

```js
import { runAdapter } from '../src/adapter.js';

const REQUIRED_CAPS = ['write', 'worktree', 'structured_output', 'tool_dialect'];

export async function conformanceReport(execPath, { env = {}, cwd = undefined } = {}) {
  const failures = [];

  const probe = await runAdapter(execPath, 'probe', { env, cwd, timeoutMs: 30_000 });
  if (probe.status === 'failed' || probe.status === 'timeout') {
    failures.push({ step: 'probe', detail: probe.summary });
  }

  const caps = await runAdapter(execPath, 'capabilities', { env, cwd, timeoutMs: 30_000 });
  if (caps.status === 'failed') {
    failures.push({ step: 'capabilities', detail: caps.summary });
  } else {
    for (const k of REQUIRED_CAPS) {
      if (!(k in caps)) failures.push({ step: 'capabilities', detail: `missing key: ${k}` });
    }
  }

  const run = await runAdapter(execPath, 'run', {
    env, cwd, timeoutMs: 120_000,
    brief: {
      role: 'researcher',
      task: 'Reply with a one-sentence summary of what directory you are in. Change nothing.',
      cwd: cwd ?? process.cwd(), read_only: true, timeout_s: 120, deny_paths: ['**/.env*']
    }
  });
  if (!['ok', 'failed', 'timeout'].includes(run.status)) {
    failures.push({ step: 'run', detail: `status must be ok|failed|timeout, got ${run.status}` });
  }
  if (run.status === 'ok' && typeof run.summary !== 'string') {
    failures.push({ step: 'run', detail: 'a successful run must carry a string summary' });
  }

  return { conformant: failures.length === 0, failures };
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './conformance.js'`

- [ ] **Step 3: Implement** — the two files above are the implementation.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 2 new tests. The opt-in vendor tests should not run.

- [ ] **Step 5: Commit**

```bash
git add test/conformance.js test/conformance.test.js
git commit -m "test: add an adapter conformance suite, opt-in for real vendors"
```

---

### Task 11: The codex adapter

**Previously marked BLOCKED, wrongly.** The block said "`codex` installed and authenticated". That
determination came from `command -v` in a non-interactive shell and was incorrect: codex-cli
0.154.0-alpha.6.2 is installed and authenticated (`~/.codex/auth.json`, mode 600), it is simply not
on that shell's PATH. It resolves only at `~/.codex/plugins/.plugin-appserver/codex`, an internal
path inside the Codex app that must not be hardcoded — the adapter resolves from PATH with
`AGENT_TEAM_CODEX_BIN` as the override for a non-PATH install.

The Phase 0 ACP dependency still stands: if ACP wins, this adapter is rewritten against the protocol.

**Flag surface read off the binary**, not from documentation: `exec` runs non-interactively;
`-C/--cd <DIR>`; `--json` emits JSONL; `--ephemeral` skips session files; `-s/--sandbox` takes
`read-only|workspace-write|danger-full-access`; `-m/--model`; and `-o/--output-last-message <FILE>`
writes the final assistant message to a file. That last flag removes this task's original Step 1
question about which JSONL event carries the final message — read the file instead of guessing an
event-type name that can change on a version bump.

**Files:**
- Create: `adapters/codex`

- [ ] **Step 1: Verify the CLI surface before writing anything**

```bash
codex exec --help
```

Confirm, and write the observed answers into a comment at the top of the adapter: the flag that selects the working directory, that `--json` emits JSONL events, that `--ephemeral` skips writing session rollout files, and which event type carries the final assistant message.

Do not write the adapter from the flags assumed below without running this first. They come from published documentation, not from this machine.

- [ ] **Step 2: Write the adapter**

`adapters/codex`, following exactly the shape of `adapters/claude` (Task 9) — same three subcommands, same result schema, full output to `log_path`, only summary and diff on stdout. The differences:

```js
// capabilities
{ write: true, worktree: true, structured_output: true, tool_dialect: 'codex' }

// probe
spawnSync('codex', ['--version'])

// run
const args = ['exec', '--json', '--ephemeral', '-C', brief.cwd, brief.task];
if (brief.read_only) args.push('--sandbox', 'read-only');
```

Parse the JSONL stream line by line; keep the last `turn.completed` or final assistant message as `summary`, write every line to `log_path`, and derive `artifacts.diff` from `git -C brief.cwd diff HEAD` exactly as the claude adapter does.

- [ ] **Step 3: Verify conformance**

Run: `AGENT_TEAM_CONFORMANCE=codex npm test`
Expected: PASS for `real adapter "codex" is conformant`

- [ ] **Step 4: Commit**

```bash
git add adapters/codex
git commit -m "feat(adapters): add the codex adapter"
```

---

### Task 12: The grok adapter

**Previously marked BLOCKED, wrongly**, for the same reason as Task 11. grok 1.0.30 is installed at
`~/.grok/bin/grok`; `~/.bashrc` puts it on the interactive PATH and `~/.bash_profile` does not, which
is why a non-interactive shell missed it. Same Phase 0 ACP dependency as Task 11.

**This task's assumed invocation below is wrong.** There is no `-p` flag. Read off the binary:
the prompt is a bare positional argument, with `--output-format <plain|json|streaming-json>`,
`--cwd <CWD>`, `-m/--model`, `--always-approve` (required, or it blocks on an interactive approval
prompt until the dispatcher's SIGKILL), `--sandbox <PROFILE>`, `--disallowed-tools`, `--deny/--allow`,
and `--disable-web-search`.

**The worktree question this task raises is answered: grok only creates a worktree when passed
`-w/--worktree`.** It is opt-in, so there is no worktree-inside-a-workspace problem to disable.

**Files:**
- Create: `adapters/grok`

- [ ] **Step 1: Verify the CLI surface, and settle the worktree question**

```bash
grok --help
```

Grok Build ships its own git worktree integration. The spec records this as the most likely Phase 1 surprise, so establish before writing the adapter: does `grok -p` run against the directory it is given, or does it create a worktree of its own? If it creates its own, the adapter must disable that — a worktree inside a worktree breaks the diff and branch this runtime returns. Record the answer in a comment at the top of the adapter.

- [ ] **Step 2: Write the adapter**

`adapters/grok`, same shape as Task 9. Differences:

```js
// capabilities
{ write: true, worktree: true, structured_output: true, tool_dialect: 'grok' }

// probe — must also confirm auth, not just the binary
spawnSync('grok', ['--version'])   // plus a check that GROK_CODE_XAI_API_KEY or a session exists

// run
spawnSync('grok', ['-p', brief.task], { cwd: brief.cwd, ... })
```

- [ ] **Step 3: Verify conformance**

Run: `AGENT_TEAM_CONFORMANCE=grok npm test`
Expected: PASS for `real adapter "grok" is conformant`

- [ ] **Step 4: Commit**

```bash
git add adapters/grok
git commit -m "feat(adapters): add the grok adapter"
```

---

### Task 13: Plugin and marketplace manifests

Makes `claude plugin marketplace add bmcreations/agent-team` work, which it does not today.

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `test/manifest.test.js`

- [ ] **Step 1: Write the failing tests**

`test/manifest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

test('the plugin manifest names the plugin and its version', () => {
  const m = read('.claude-plugin/plugin.json');
  assert.equal(m.name, 'agent-team');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
});

test('the plugin version matches package.json', () => {
  assert.equal(read('.claude-plugin/plugin.json').version, read('package.json').version);
});

test('the marketplace lists the plugin at the repo root', () => {
  const m = read('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'agent-team');
  const entry = m.plugins.find((p) => p.name === 'agent-team');
  assert.ok(entry, 'marketplace must list the agent-team plugin');
  assert.equal(entry.source, './');
});

test('every skill the marketplace ships actually exists', () => {
  for (const skill of ['red-team', 'delegate', 'agent-team-init']) {
    assert.ok(existsSync(join(ROOT, 'skills', skill, 'SKILL.md')), `missing skills/${skill}/SKILL.md`);
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `ENOENT .claude-plugin/plugin.json`

- [ ] **Step 3: Write the manifests**

`.claude-plugin/plugin.json`:

```json
{
  "name": "agent-team",
  "version": "0.1.0",
  "description": "Role-based delegation across rival agent CLIs",
  "author": { "name": "bmcreations" }
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "agent-team",
  "owner": { "name": "bmcreations" },
  "plugins": [
    {
      "name": "agent-team",
      "source": "./",
      "description": "Delegate a task to Codex, Grok, or Claude by naming a role rather than a vendor"
    }
  ]
}
```

The "every skill exists" test will stay red until Task 14. That is intentional: it is the checklist item that stops the plugin shipping a manifest that promises skills it does not have.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: three manifest tests PASS, `every skill the marketplace ships actually exists` FAILS pending Task 14.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin test/manifest.test.js
git commit -m "feat(plugin): add plugin and marketplace manifests"
```

---

### Task 14: The `delegate` and `agent-team-init` skills

**Files:**
- Create: `skills/delegate/SKILL.md`
- Create: `skills/agent-team-init/SKILL.md`
- Create: `bin/agent-team.js`

- [ ] **Step 1: Write the CLI entry point**

`bin/agent-team.js`:

```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dispatch } from '../src/dispatch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  options: {
    role: { type: 'string' },
    task: { type: 'string' },
    project: { type: 'string', default: process.cwd() },
    timeout: { type: 'string', default: '900' }
  }
});

if (!values.role || !values.task) {
  process.stderr.write('usage: agent-team --role <role> --task <text> [--project <dir>]\n');
  process.exit(2);
}

const result = await dispatch({
  projectRoot: values.project,
  role: values.role,
  task: values.task,
  adapterDir: join(ROOT, 'adapters'),
  skillsDir: join(ROOT, 'skills'),
  timeoutMs: Number(values.timeout) * 1000
});

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.status === 'ok' ? 0 : 1);
```

```bash
chmod +x bin/agent-team.js
```

- [ ] **Step 2: Write `skills/delegate/SKILL.md`**

```markdown
---
name: delegate
description: Use when a task should be handled by a specific role rather than inline — implementation, review, research, red-teaming, or QA. Routes the task to whichever agent the project's config assigns to that role.
user-invocable: true
argument-hint: "<role> <task description>"
allowed-tools: [Bash, Read]
---

# Delegate by role

Run the task through the project's role configuration rather than picking an agent yourself.

## Step 1 — check the project is configured

Read `.claude/agent-team.json`. If it is missing, stop and tell the user to run `/agent-team-init`.

## Step 2 — dispatch

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-team.js" --role <role> --task "<task>"
```

## Step 3 — report

The command returns one JSON object. Report to the user:

- `summary`, and `findings` if present
- `checked_sound` if present — a red-team run reporting only problems gives no coverage signal
- `warning` if the role fell back to another agent, stated plainly
- `agent`, so the user knows who did the work
- `artifacts.branch` — the work is on a branch and is **not merged**

Read `log_path` only if `status` is not `ok`, and grep it rather than reading it whole. It holds the
agent's full session output and will swamp your context.

## Do not

- Merge the branch. The user reviews it.
- Re-run a role that failed a `distinct_from` check by editing the config to get past it. The
  constraint exists so an agent does not review its own work.
```

- [ ] **Step 3: Write `skills/agent-team-init/SKILL.md`**

```markdown
---
name: agent-team-init
description: Use when setting up agent-team in a project for the first time — writes .claude/agent-team.json with a starter role table and a seeded denylist.
user-invocable: true
allowed-tools: [Bash, Read, Write, Glob]
---

# Initialise agent-team for this project

## Step 1 — refuse to overwrite

If `.claude/agent-team.json` exists, show it and stop. Ask before changing a working config.

## Step 2 — find what must never leave the repo

Search the project for credential-shaped paths and list what you find to the user:

```bash
git ls-files | grep -iE '(credential|secret|keystore|\.jks$|\.p8$|\.p12$|\.pem$|\.mobileprovision$|\.env)' | head -50
```

Everything found goes in `deny_paths`. A rival CLI runs in this tree and ships context to a third
party, so a missed path is a credential disclosure. The loader rejects a config with an empty
denylist; do not work around that.

## Step 3 — probe which agents are actually available

```bash
for a in claude codex grok; do "${CLAUDE_PLUGIN_ROOT}/adapters/$a" probe >/dev/null 2>&1 \
  && echo "$a: available" || echo "$a: unavailable"; done
```

Assign unavailable agents anyway if the user wants them — `on_unavailable` degrades to Claude with a
warning — but tell the user which roles will not run as configured.

## Step 4 — write the config

```json
{
  "roles": {
    "implementer": { "agent": "claude", "model": "opus", "isolation": "worktree" },
    "reviewer":    { "agent": "codex", "isolation": "read-only" },
    "researcher":  { "agent": "claude", "isolation": "read-only" },
    "red-team":    { "agent": "grok", "skill": "red-team", "isolation": "worktree",
                     "distinct_from": ["implementer"] },
    "qa":          { "agent": "claude", "isolation": "worktree" }
  },
  "deny_paths": ["<everything found in step 2>", "**/.env*"],
  "defaults": { "on_unavailable": "claude" }
}
```

## Step 5 — confirm it loads

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/config.js').then(m=>console.log(m.loadConfig(process.cwd())))"
```

Then add `.claude/worktrees/` to `.gitignore` if it is not already there.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, including `every skill the marketplace ships actually exists` from Task 13.

- [ ] **Step 5: Commit**

```bash
git add bin skills/delegate skills/agent-team-init
git commit -m "feat(skills): add delegate and agent-team-init, and the CLI entry point"
```

---

## Definition of done

- `npm test` is green with no vendor CLI installed.
- `AGENT_TEAM_CONFORMANCE=codex,grok npm test` is green once both are installed and authenticated.
- `claude plugin marketplace add bmcreations/agent-team` then `claude plugin install agent-team` succeeds in a scratch project.
- `/agent-team-init` in a fresh repo produces a config whose `deny_paths` covers every credential-shaped tracked file.
- A `/delegate red-team <task>` run against the `mock` agent returns findings and leaves a branch.

## Carried-forward open questions

These come from the spec and are **not** resolved by this plan:

- **Cost control is undesigned.** Nothing here caps concurrency or spend. The timeout is the only limit, and it is per-run.
- **Per-role model pinning is unspecified** for every vendor. The config accepts `model` and every adapter forwards it; which model each role should use is undecided.
- **Grok Build's own worktree integration** may conflict with dispatcher-created worktrees. Task 12 Step 1 is where that gets settled.
- **Phase 0 (ACP) has not run.** If it succeeds, Tasks 11 and 12 are rewritten against the protocol rather than the CLIs.

---

# Revision 2 — team members, hierarchy, and real isolation

Two changes land together, both from decisions taken after Task 6.

**1. A role becomes a team member.** The flat `roles` table only answered "which vendor runs
this". It could not express a designer, a marketer, or a COO, because those are defined by what
they own and what they hand back, not by which CLI executes them. `roles` becomes `members`, and a
member carries a charter, a persona, a deliverable kind, and a place in a reporting tree.

**2. Isolation moves from sparse-checkout to a filtered clone.** The Task 4 review disproved the
premise the module was built on. `git sparse-checkout` sets the `skip-worktree` bit; it does not
remove objects. From inside a worktree built by `createWorktree`, every denied file was still
enumerable by name (`git ls-files -v` marks them `S`) and readable verbatim:

```
$ git show HEAD:credentials/signing.p8      → PRIVATE KEY   (exit 0)
$ git cat-file -p :credentials/signing.p8   → PRIVATE KEY   (exit 0)
$ git archive HEAD | tar -tvf -             → lists every denied path
```

A delegated CLI has `git` on its PATH by construction, so `git log -p` or `git archive` would
surface those secrets without anyone attacking anything. The five original tests passed because
they asserted `existsSync === false`, which is true and insufficient.

**Superseded tasks.** Tasks 2, 3, 4, 7 and 8 are replaced by R2, R3, R4, R5 and R6 below. Their
original text stays in this document as the record of what was built and why it changed. Commits
`22c49b9`, `f9e0f85`, `4eb5863` and `8741071` are superseded in place — the R-tasks rewrite those
files rather than reverting them. Tasks 1, 5, 6, 9–14 stand; the deltas they need are listed at
the end of this revision.

## Revised architecture

A member is resolved from `.claude/agent-team.json`, given a workspace sized to its `isolation`,
handed a brief carrying its charter and its direct reports, and run through its vendor adapter. A
member with reports may answer `status: "delegating"` instead of a deliverable; the dispatcher
runs those sub-briefs against its direct reports only, then calls the manager again with the
results so it can synthesise. Depth and total adapter runs are both capped.

## Revised config shape

```json
{
  "members": {
    "coo": {
      "title": "COO",
      "agent": "claude",
      "charter": "Decompose an objective into work for the team. Does not implement.",
      "isolation": "none",
      "deliverable": "decision"
    },
    "eng-lead":    { "agent": "claude", "reports_to": "coo", "isolation": "read-only" },
    "implementer": { "agent": "codex",  "reports_to": "eng-lead", "isolation": "workspace" },
    "reviewer":    { "agent": "grok",   "reports_to": "eng-lead", "isolation": "read-only",
                     "distinct_from": ["implementer"] },
    "qa":          { "agent": "claude", "reports_to": "eng-lead", "isolation": "workspace" },
    "designer":    { "agent": "claude", "reports_to": "coo", "isolation": "none",
                     "deliverable": "document", "output_path": "docs/design" },
    "marketer":    { "agent": "claude", "reports_to": "coo", "isolation": "none",
                     "deliverable": "document", "output_path": "docs/marketing" }
  },
  "deny_paths": ["credentials/**", "**/.env*"],
  "defaults": { "on_unavailable": "claude", "max_depth": 3, "max_delegations": 20 }
}
```

`isolation` is one of `none` (no repo at all — a scratch directory), `read-only` (a filtered clone
the result is read from, not written back), `workspace` (a filtered clone on its own branch).
`deliverable` is one of `diff`, `review`, `document`, `decision`, and defaults from `isolation`:
`none` → `document`, `read-only` → `review`, `workspace` → `diff`.

`reports_to` is the only hierarchy field stored. The inverse (`reports`) is derived, so the two
cannot drift apart. A member with no `reports_to` is a root; multiple roots are allowed.

## Revised file structure

| File | Responsibility |
|---|---|
| `src/org.js` | build the reporting tree from `reports_to`; reject cycles; render it |
| `src/config.js` | load and validate `.claude/agent-team.json`; reject a config with no denylist |
| `src/resolve.js` | member to agent, `on_unavailable` fallback, `distinct_from` hard stop |
| `src/workspace.js` | filtered clone per isolation level; **replaces `src/worktree.js`** |
| `src/brief.js` | dialect + charter + persona + skill + delegation protocol + task |
| `src/dispatch.js` | orchestrate; recursive delegation under depth and budget caps |

---

### Task R1: The org chart

`reports_to` is a string on each member. Everything hierarchical — who may delegate to whom, how
deep a delegation has gone, where a blocked member escalates — is derived from it here, so no
other module walks the tree by hand.

**Files:**
- Create: `src/org.js`
- Create: `test/org.test.js`

- [ ] **Step 1: Write the failing tests**

`test/org.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrg, depthOf, directReports, canDelegate, renderOrg } from '../src/org.js';

const MEMBERS = {
  coo: { agent: 'claude' },
  'eng-lead': { agent: 'claude', reports_to: 'coo' },
  implementer: { agent: 'codex', reports_to: 'eng-lead' },
  reviewer: { agent: 'grok', reports_to: 'eng-lead' },
  designer: { agent: 'claude', reports_to: 'coo' }
};

test('reports are derived from reports_to, sorted, and roots have no parent', () => {
  const org = buildOrg(MEMBERS);
  assert.deepEqual(org.roots, ['coo']);
  assert.equal(org.parentOf.coo, null);
  assert.deepEqual(org.reportsOf['eng-lead'], ['implementer', 'reviewer']);
  assert.deepEqual(org.reportsOf.coo, ['designer', 'eng-lead']);
  assert.deepEqual(org.reportsOf.implementer, []);
});

test('more than one root is allowed', () => {
  const org = buildOrg({ coo: { agent: 'a' }, advisor: { agent: 'b' } });
  assert.deepEqual(org.roots, ['advisor', 'coo']);
});

test('an unknown manager is a config error', () => {
  assert.throws(
    () => buildOrg({ a: { agent: 'x', reports_to: 'ghost' } }),
    /reports_to "ghost" is not a configured member/
  );
});

test('reporting to yourself is a config error', () => {
  assert.throws(() => buildOrg({ a: { agent: 'x', reports_to: 'a' } }), /reports_to itself/);
});

test('a reporting cycle is a config error', () => {
  assert.throws(
    () => buildOrg({
      a: { agent: 'x', reports_to: 'b' },
      b: { agent: 'x', reports_to: 'c' },
      c: { agent: 'x', reports_to: 'a' }
    }),
    /reporting cycle/
  );
});

test('depthOf counts ancestors', () => {
  const org = buildOrg(MEMBERS);
  assert.equal(depthOf(org, 'coo'), 0);
  assert.equal(depthOf(org, 'eng-lead'), 1);
  assert.equal(depthOf(org, 'implementer'), 2);
});

test('only a member with reports can delegate', () => {
  const org = buildOrg(MEMBERS);
  assert.equal(canDelegate(org, 'eng-lead'), true);
  assert.equal(canDelegate(org, 'reviewer'), false);
  assert.deepEqual(directReports(org, 'reviewer'), []);
});

test('renderOrg indents each level under its manager', () => {
  const out = renderOrg(buildOrg(MEMBERS));
  assert.match(out, /^coo$/m);
  assert.match(out, /^ {2}eng-lead$/m);
  assert.match(out, /^ {4}implementer$/m);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/org.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/org.js`:

```js
export function buildOrg(members) {
  const names = Object.keys(members).sort();
  const parentOf = {};

  for (const name of names) {
    const parent = members[name].reports_to ?? null;
    if (parent === name) {
      throw new Error(`member "${name}": reports_to itself`);
    }
    if (parent !== null && !members[parent]) {
      throw new Error(`member "${name}": reports_to "${parent}" is not a configured member`);
    }
    parentOf[name] = parent;
  }

  for (const name of names) {
    const seen = [name];
    let cur = parentOf[name];
    while (cur) {
      if (seen.includes(cur)) {
        throw new Error(`reporting cycle: ${seen.join(' -> ')} -> ${cur}`);
      }
      seen.push(cur);
      cur = parentOf[cur];
    }
  }

  const reportsOf = Object.fromEntries(names.map((n) => [n, []]));
  for (const name of names) {
    if (parentOf[name]) reportsOf[parentOf[name]].push(name);
  }

  return {
    names,
    roots: names.filter((n) => parentOf[n] === null),
    parentOf,
    reportsOf
  };
}

export function directReports(org, name) {
  return org.reportsOf[name] ?? [];
}

export function canDelegate(org, name) {
  return directReports(org, name).length > 0;
}

export function depthOf(org, name) {
  let depth = 0;
  let cur = org.parentOf[name];
  while (cur) {
    depth += 1;
    cur = org.parentOf[cur];
  }
  return depth;
}

export function renderOrg(org) {
  const lines = [];
  const walk = (name, indent) => {
    lines.push(`${' '.repeat(indent)}${name}`);
    for (const child of directReports(org, name)) walk(child, indent + 2);
  };
  for (const root of org.roots) walk(root, 0);
  return lines.join('\n');
}
```

`names` is sorted once at the top, so `roots` and every `reportsOf` list inherit that order and
the rendered chart is stable between runs.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 8 new tests

- [ ] **Step 5: Commit**

```bash
git add src/org.js test/org.test.js
git commit -m "feat(org): derive the reporting tree from reports_to and reject cycles"
```

---

### Task R2: Config loader for members — replaces Task 2

Rewrites `src/config.js` and `test/config.test.js` in place. The denylist rule survives unchanged;
everything about `roles` becomes `members`, and the config now validates the reporting tree at
load time so a cycle cannot surface halfway through a delegation.

**Files:**
- Modify: `src/config.js` (full rewrite)
- Modify: `test/config.test.js` (full rewrite)

- [ ] **Step 1: Write the failing tests**

`test/config.test.js` — replace the whole file:

```js
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
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — the old loader still returns `roles`, so the member-shaped assertions fail.

- [ ] **Step 3: Write the minimal implementation**

`src/config.js` — replace the whole file:

```js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrg } from './org.js';

export const CONFIG_RELPATH = join('.claude', 'agent-team.json');

export const ISOLATIONS = ['none', 'read-only', 'workspace'];
export const DELIVERABLES = ['diff', 'review', 'document', 'decision'];

const DELIVERABLE_FOR = { none: 'document', 'read-only': 'review', workspace: 'diff' };

export function loadConfig(projectRoot) {
  const path = join(projectRoot, CONFIG_RELPATH);
  if (!existsSync(path)) {
    throw new Error(`no agent-team config at ${path} — run /agent-team-init`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));

  if (!raw.members || typeof raw.members !== 'object' || Array.isArray(raw.members)) {
    throw new Error(`${path}: "members" is required and must be an object`);
  }
  if (!Array.isArray(raw.deny_paths) || raw.deny_paths.length === 0) {
    throw new Error(
      `${path}: "deny_paths" is required and must be a non-empty array — ` +
      `a rival CLI runs in this tree and ships context to a third party`
    );
  }

  const members = {};
  for (const [name, m] of Object.entries(raw.members)) {
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
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS for `test/config.test.js` (12 tests). `test/resolve.test.js` and
`test/worktree.test.js` still fail — R3 and R4 fix those. Do not patch them here.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): define team members with a charter, a deliverable, and a manager"
```

---

### Task R3: Member resolution — replaces Task 3

Same fallback and the same `distinct_from` hard stop in the same order. What changes is the
vocabulary and the shape of what comes back: a resolved member carries the identity fields the
brief needs and its direct reports.

**Files:**
- Modify: `src/resolve.js` (full rewrite)
- Modify: `test/resolve.test.js` (full rewrite)

- [ ] **Step 1: Write the failing tests**

`test/resolve.test.js` — replace the whole file:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrg } from '../src/org.js';
import { resolveMember } from '../src/resolve.js';

function config(members, defaults = { on_unavailable: 'claude' }) {
  const withDefaults = Object.fromEntries(Object.entries(members).map(([k, m]) => [
    k, { isolation: 'read-only', deliverable: 'review', ...m }
  ]));
  return { members: withDefaults, org: buildOrg(withDefaults), deny_paths: ['x'], defaults };
}

const CONFIG = config({
  'eng-lead': { agent: 'claude' },
  implementer: { agent: 'codex', reports_to: 'eng-lead', isolation: 'workspace', deliverable: 'diff' },
  reviewer: { agent: 'grok', reports_to: 'eng-lead', distinct_from: ['implementer'] }
});

const all = () => true;
const none = () => false;
const only = (...ok) => (a) => ok.includes(a);

test('an unknown member names what is configured', () => {
  assert.throws(() => resolveMember(CONFIG, 'ghost', { probe: all }), /unknown member: ghost/);
  assert.throws(() => resolveMember(CONFIG, 'ghost', { probe: all }), /implementer/);
});

test('an available agent is used as written, with no warning', () => {
  const r = resolveMember(CONFIG, 'implementer', { probe: all });
  assert.equal(r.agent, 'codex');
  assert.equal(r.warning, null);
});

test('an unavailable agent falls back to on_unavailable, with a warning', () => {
  const r = resolveMember(CONFIG, 'implementer', { probe: only('claude') });
  assert.equal(r.agent, 'claude');
  assert.match(r.warning, /codex/);
  assert.match(r.warning, /claude/);
});

test('no usable fallback is an error, not a silent skip', () => {
  assert.throws(() => resolveMember(CONFIG, 'implementer', { probe: none }), /no usable fallback/);
});

test('distinct_from is checked AFTER fallback, so a fallback cannot smuggle in self-review', () => {
  assert.throws(
    () => resolveMember(CONFIG, 'reviewer', {
      probe: only('claude'),
      assignments: { implementer: 'claude' }
    }),
    /refusing to let an agent review its own work/
  );
});

test('the distinct_from error says the conflict was reached through a fallback', () => {
  assert.throws(
    () => resolveMember(CONFIG, 'reviewer', {
      probe: only('claude'),
      assignments: { implementer: 'claude' }
    }),
    /reached via fallback/
  );
});

test('distinct_from does not fire when the agents genuinely differ', () => {
  const r = resolveMember(CONFIG, 'reviewer', { probe: all, assignments: { implementer: 'codex' } });
  assert.equal(r.agent, 'grok');
});

test('the resolved member carries its identity fields', () => {
  const cfg = config({
    designer: {
      agent: 'claude', title: 'Designer', charter: 'Own the visual system.',
      persona: 'Work from the design tokens.', isolation: 'none',
      deliverable: 'document', output_path: 'docs/design'
    }
  });
  const r = resolveMember(cfg, 'designer', { probe: all });
  assert.equal(r.title, 'Designer');
  assert.equal(r.charter, 'Own the visual system.');
  assert.equal(r.persona, 'Work from the design tokens.');
  assert.equal(r.isolation, 'none');
  assert.equal(r.deliverable, 'document');
  assert.equal(r.output_path, 'docs/design');
});

test('identity fields the member omits come back null, and title falls back to the name', () => {
  const r = resolveMember(CONFIG, 'eng-lead', { probe: all });
  assert.equal(r.title, 'eng-lead');
  assert.equal(r.charter, null);
  assert.equal(r.persona, null);
  assert.equal(r.model, null);
  assert.equal(r.skill, null);
  assert.equal(r.output_path, null);
});

test('the resolved member carries its direct reports and its manager', () => {
  const lead = resolveMember(CONFIG, 'eng-lead', { probe: all });
  assert.deepEqual(lead.reports, ['implementer', 'reviewer']);
  assert.equal(lead.reports_to, null);

  const impl = resolveMember(CONFIG, 'implementer', { probe: all });
  assert.deepEqual(impl.reports, []);
  assert.equal(impl.reports_to, 'eng-lead');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `resolve.js` exports `resolveRole`, not `resolveMember`.

- [ ] **Step 3: Write the minimal implementation**

`src/resolve.js` — replace the whole file:

```js
import { directReports } from './org.js';

export function resolveMember(config, name, { probe, assignments = {} } = {}) {
  const member = config.members[name];
  if (!member) {
    throw new Error(
      `unknown member: ${name} (configured: ${Object.keys(config.members).join(', ')})`
    );
  }

  let agent = member.agent;
  let warning = null;

  if (!probe(agent)) {
    const fallback = config.defaults?.on_unavailable;
    if (!fallback || !probe(fallback)) {
      throw new Error(
        `member "${name}": agent "${agent}" is unavailable and no usable fallback ` +
        `(on_unavailable: ${fallback ?? 'unset'})`
      );
    }
    warning = `agent "${agent}" unavailable; fell back to "${fallback}"`;
    agent = fallback;
  }

  // Checked AFTER fallback: a fallback must not create the self-review
  // that distinct_from exists to prevent.
  const conflicts = (member.distinct_from ?? []).filter((other) => assignments[other] === agent);
  if (conflicts.length > 0) {
    throw new Error(
      `member "${name}": distinct_from forbids "${agent}", already assigned to ` +
      `${conflicts.join(', ')} — refusing to let an agent review its own work` +
      (warning ? ` (reached via fallback: ${warning})` : '')
    );
  }

  return {
    member: name,
    title: member.title ?? name,
    agent,
    model: member.model ?? null,
    skill: member.skill ?? null,
    charter: member.charter ?? null,
    persona: member.persona ?? null,
    isolation: member.isolation,
    deliverable: member.deliverable,
    output_path: member.output_path ?? null,
    reports_to: member.reports_to ?? null,
    reports: directReports(config.org, name),
    warning
  };
}
```

`isolation` and `deliverable` are read straight off the member because `loadConfig` already
defaulted and validated them. Resolving must not be a second place those defaults live.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS for `test/resolve.test.js` (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolve.js test/resolve.test.js
git commit -m "feat(resolve): resolve a member with its charter, deliverable, and direct reports"
```

---

### Task R4: Workspaces by filtered clone — replaces Task 4

This is the task the Task 4 review sent back. Read the finding at the top of Revision 2 before
starting: the mechanism being replaced passed its tests and did not do its job.

**Why a clone and not a worktree.** A linked worktree shares the parent repository's object
database. That is the whole point of a worktree and it is exactly what makes it unusable here —
nothing is ever absent, only unmaterialised. A `--depth 1` clone over `file://` starts a fresh
object database containing one commit. Deleting the denied files and re-committing is not enough
on its own, because the original commit is still reachable and `git show HEAD~1:<path>` would
work. Committing on an **orphan** branch and deleting every other ref makes the original commit
unreachable, and `gc --prune=now` then removes its blobs for real.

`git remote remove origin` matters as much as the gc: a clone that keeps its origin can simply
`git fetch` the secrets back.

**Files:**
- Create: `src/workspace.js`
- Create: `test/workspace.test.js`
- Delete: `src/worktree.js`, `test/worktree.test.js`

- [ ] **Step 1: Write the failing tests**

`test/workspace.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, pruneWorkspace } from '../src/workspace.js';

const DENY = ['credentials/**', '**/.env*'];

function repoWithSecrets() {
  const root = mkdtempSync(join(tmpdir(), 'at-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');   // global commit.gpgsign=true would break the fixture
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'credentials'), { recursive: true });
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'ok\n');
  writeFileSync(join(root, 'credentials', 'signing.p8'), 'PRIVATE KEY\n');
  writeFileSync(join(root, '.env.production'), 'TOKEN=hunter2\n');
  writeFileSync(join(root, 'a', 'b', '.env'), 'NESTED=1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

// Run a git command in the workspace and report exit status rather than throwing.
const tryGit = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

test('ordinary source is present in the workspace', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.equal(existsSync(join(ws.dir, 'src', 'app.js')), true);
});

test('denied paths are absent from the working tree, at every depth', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.equal(existsSync(join(ws.dir, 'credentials', 'signing.p8')), false);
  assert.equal(existsSync(join(ws.dir, '.env.production')), false);
  assert.equal(existsSync(join(ws.dir, 'a', 'b', '.env')), false);
});

test('denied paths are not even enumerable — git ls-files does not list them', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const listed = tryGit(ws.dir, 'ls-files').stdout;
  assert.match(listed, /src\/app\.js/);
  assert.doesNotMatch(listed, /credentials/);
  assert.doesNotMatch(listed, /\.env/);
});

test('git show cannot recover a denied file — the regression Task 4 shipped', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const shown = tryGit(ws.dir, 'show', 'HEAD:credentials/signing.p8');
  assert.notEqual(shown.status, 0, 'git show must fail, not print the key');
  assert.doesNotMatch(shown.stdout, /PRIVATE KEY/);
});

test('git archive does not carry a denied file out of the workspace', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const archived = spawnSync('git', ['-C', ws.dir, 'archive', 'HEAD'], { encoding: 'buffer' });
  assert.equal(archived.status, 0);
  assert.doesNotMatch(archived.stdout.toString('latin1'), /signing\.p8/);
});

test('the denied blob is gone from the object database, not merely unreferenced', () => {
  const root = repoWithSecrets();
  const blob = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD:credentials/signing.p8'],
    { encoding: 'utf8' }).trim();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  const read = tryGit(ws.dir, 'cat-file', '-p', blob);
  assert.notEqual(read.status, 0, `blob ${blob} is still readable in the workspace`);
});

test('no remote survives, so the secrets cannot be fetched back', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.equal(tryGit(ws.dir, 'remote').stdout.trim(), '');
});

test('the workspace is on its own branch and two for one member do not collide', () => {
  const root = repoWithSecrets();
  const a = createWorkspace(root, 'qa', DENY, 'workspace');
  const b = createWorkspace(root, 'qa', DENY, 'workspace');
  assert.match(a.branch, /^agent-team\/qa-[0-9a-f]{6}$/);
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(a.branch, b.branch);
});

test('isolation none gives a scratch directory with no repository at all', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'marketer', DENY, 'none');
  assert.equal(existsSync(ws.dir), true);
  assert.equal(existsSync(join(ws.dir, '.git')), false);
  assert.equal(ws.branch, null);
  assert.equal(ws.kind, 'none');
});

test('pruning removes the workspace directory', () => {
  const root = repoWithSecrets();
  const ws = createWorkspace(root, 'qa', DENY, 'workspace');
  pruneWorkspace(ws);
  assert.equal(existsSync(ws.dir), false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/workspace.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/workspace.js`:

```js
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();

// Let git's own ignore engine decide what matches, so deny_paths keep gitignore
// semantics (a bare `credentials` matches the directory at any depth). --no-index
// is required: without it, check-ignore reports tracked files as not ignored.
function deniedFiles(dir, denyPaths) {
  writeFileSync(join(dir, '.git', 'info', 'exclude'), `${denyPaths.join('\n')}\n`);
  const tracked = execFileSync('git', ['-C', dir, 'ls-files', '-z']);
  if (tracked.length === 0) return [];
  const matched = spawnSync(
    'git', ['-C', dir, 'check-ignore', '--no-index', '--stdin', '-z'],
    { input: tracked }
  );
  // exit 1 means nothing matched, which is not an error
  return matched.stdout.toString().split('\0').filter(Boolean);
}

function otherBranches(dir, keep) {
  return git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .map((s) => s.trim())
    .filter((b) => b && b !== keep);
}

export function createWorkspace(repoRoot, member, denyPaths, isolation) {
  const id = randomBytes(3).toString('hex');

  if (isolation === 'none') {
    return {
      dir: mkdtempSync(join(tmpdir(), `agent-team-${member}-`)),
      branch: null, id, kind: 'none'
    };
  }

  const dir = join(repoRoot, '.claude', 'workspaces', `${member}-${id}`);
  const branch = `agent-team/${member}-${id}`;
  mkdirSync(dirname(dir), { recursive: true });

  // file:// forces the transport path: no hardlinked objects and no
  // objects/info/alternates pointing back at the parent repository.
  execFileSync('git', [
    'clone', '-q', '--depth', '1', '--single-branch', '--no-hardlinks',
    `file://${repoRoot}`, dir
  ], { stdio: 'pipe' });

  git(dir, 'config', 'user.email', 'agent-team@localhost');
  git(dir, 'config', 'user.name', 'agent-team');
  git(dir, 'config', 'commit.gpgsign', 'false');

  for (const rel of deniedFiles(dir, denyPaths)) {
    rmSync(join(dir, rel), { force: true });
  }

  // The orphan commit is what does the work. A plain `git rm` commit leaves the
  // secret readable at HEAD~1; an orphan root commit makes the cloned commit
  // unreachable so gc can prune its blobs.
  git(dir, 'checkout', '-q', '--orphan', branch);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `workspace: ${member}`);
  for (const stale of otherBranches(dir, branch)) git(dir, 'branch', '-q', '-D', stale);
  git(dir, 'remote', 'remove', 'origin');
  git(dir, 'reflog', 'expire', '--expire=now', '--all');
  git(dir, 'gc', '-q', '--prune=now');

  return { dir, branch, id, kind: isolation };
}

export function pruneWorkspace(workspace) {
  rmSync(workspace.dir, { recursive: true, force: true });
}
```

`pruneWorkspace` takes the workspace object rather than a repo root and a path: a clone is not
registered with the parent repository, so there is no `git worktree remove` to run and no reason
for the caller to hold the root.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 10 tests in `test/workspace.test.js`.

If the blob test fails, `gc --prune=now` did not reach the object — check that every other branch
and the origin remote are gone before the gc runs, and that the clone did not bring an
`objects/info/alternates` file (`cat .git/objects/info/alternates` should not exist).

- [ ] **Step 5: Delete the superseded module**

```bash
git rm -q src/worktree.js test/worktree.test.js
npm test
```

Expected: PASS. Nothing imports `worktree.js` yet — `src/dispatch.js` does not exist until R6.

- [ ] **Step 6: Commit**

```bash
git add src/workspace.js test/workspace.test.js
git commit -m "fix(workspace): exclude denied paths from the object store, not just the working tree"
```

---

### Task R5: Brief assembly with identity and the delegation protocol — replaces Task 7

The brief gains two jobs. It tells a member who they are (charter, persona, deliverable), and for
a member with reports it carries the protocol by which they delegate. Keep the dialect loader and
the section-ordering guarantee from Task 7 unchanged.

**Files:**
- Modify: `src/brief.js` (full rewrite)
- Modify: `test/brief.test.js` (full rewrite)
- Create: `references/grok-tools.md`, `references/codex-tools.md` (unchanged from Task 7 — copy
  the content from that task verbatim; it is not reproduced here because it did not change)

- [ ] **Step 1: Write the failing tests**

`test/brief.test.js` — replace the whole file:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, loadDialect } from '../src/brief.js';

const IMPL = {
  member: 'implementer', title: 'Implementer', agent: 'codex', model: null, skill: null,
  charter: null, persona: null, isolation: 'workspace', deliverable: 'diff',
  output_path: null, reports_to: 'eng-lead', reports: [], warning: null
};

const LEAD = {
  ...IMPL, member: 'eng-lead', title: 'Engineering lead', agent: 'claude',
  isolation: 'read-only', deliverable: 'decision', reports_to: null,
  reports: ['implementer', 'reviewer']
};

const base = { task: 't', cwd: '/tmp/ws', denyPaths: ['**/.env*'] };

test('the brief carries member, cwd, and deny_paths', () => {
  const b = buildBrief({ resolved: IMPL, ...base });
  assert.equal(b.member, 'implementer');
  assert.equal(b.title, 'Implementer');
  assert.equal(b.cwd, '/tmp/ws');
  assert.deepEqual(b.deny_paths, ['**/.env*']);
});

test('read_only is derived from isolation', () => {
  assert.equal(buildBrief({ resolved: IMPL, ...base }).read_only, false);
  assert.equal(buildBrief({ resolved: LEAD, ...base }).read_only, true);
  assert.equal(
    buildBrief({ resolved: { ...IMPL, isolation: 'none' }, ...base }).read_only, true
  );
});

test('the deliverable and its destination reach the adapter as fields', () => {
  const b = buildBrief({
    resolved: { ...IMPL, deliverable: 'document', output_path: 'docs/design' }, ...base
  });
  assert.equal(b.deliverable, 'document');
  assert.equal(b.output_path, 'docs/design');
});

test('sections run dialect, charter, persona, skill, then the task', () => {
  const b = buildBrief({
    resolved: { ...IMPL, charter: 'THE-CHARTER', persona: 'THE-PERSONA', skill: 'x' },
    ...base, task: 'THE-TASK', skillText: 'THE-SKILL', dialectText: 'THE-DIALECT'
  });
  const at = (s) => b.task.indexOf(s);
  assert.ok(at('THE-DIALECT') >= 0);
  assert.ok(at('THE-CHARTER') > at('THE-DIALECT'), 'charter after dialect');
  assert.ok(at('THE-PERSONA') > at('THE-CHARTER'), 'persona after charter');
  assert.ok(at('THE-SKILL') > at('THE-PERSONA'), 'skill after persona');
  assert.ok(at('THE-TASK') > at('THE-SKILL'), 'task last');
});

test('a member with no charter, persona, or skill gets just the task', () => {
  const b = buildBrief({ resolved: IMPL, ...base, task: 'ONLY' });
  assert.match(b.task, /ONLY/);
  assert.doesNotMatch(b.task, /Your charter/);
  assert.doesNotMatch(b.task, /How you work/);
});

test('a member with no reports is told nothing about delegating', () => {
  const b = buildBrief({ resolved: IMPL, ...base });
  assert.equal(b.can_delegate, false);
  assert.deepEqual(b.reports, []);
  assert.doesNotMatch(b.task, /delegating/i);
});

test('a manager is given the protocol, named reports, and its depth budget', () => {
  const b = buildBrief({ resolved: LEAD, ...base, depth: 1, maxDepth: 3 });
  assert.equal(b.can_delegate, true);
  assert.deepEqual(b.reports, ['implementer', 'reviewer']);
  assert.equal(b.depth, 1);
  assert.equal(b.max_depth, 3);
  assert.match(b.task, /"status":"delegating"/);
  assert.match(b.task, /implementer, reviewer/);
  assert.match(b.task, /depth 1 of a maximum of 3/);
});

test('a manager at the depth limit is told not to delegate', () => {
  const b = buildBrief({ resolved: LEAD, ...base, depth: 3, maxDepth: 3 });
  assert.equal(b.can_delegate, false);
  assert.match(b.task, /cannot delegate any further/);
});

test('results from reports appear before the task, on a synthesis round', () => {
  const b = buildBrief({
    resolved: LEAD, ...base, task: 'SYNTHESISE',
    priorResults: [{ member: 'implementer', status: 'ok', summary: 'SUB-RESULT' }]
  });
  assert.ok(b.task.indexOf('SUB-RESULT') < b.task.indexOf('SYNTHESISE'));
  assert.match(b.task, /Results from your reports/);
});

test('the claude dialect is empty, because no translation is needed', () => {
  assert.equal(loadDialect('claude'), null);
});

test('the grok dialect exists and mentions skills', () => {
  assert.match(loadDialect('grok'), /skill/i);
});

test('an unknown dialect is null rather than an error', () => {
  assert.equal(loadDialect('nonesuch'), null);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/brief.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/brief.js`:

```js
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REFS = join(dirname(fileURLToPath(import.meta.url)), '..', 'references');

export function loadDialect(dialect) {
  if (!dialect || dialect === 'claude') return null;   // native vocabulary, nothing to translate
  const path = join(REFS, `${dialect}-tools.md`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function delegationSection(reports, depth, maxDepth) {
  return [
    '# Delegating',
    '',
    `Your direct reports are: ${reports.join(', ')}.`,
    `You are at depth ${depth} of a maximum of ${maxDepth}.`,
    '',
    'If this work belongs to your reports, answer with delegations instead of a deliverable:',
    '',
    '    {"status":"delegating","delegations":[{"to":"<report>","task":"<their whole brief>"}]}',
    '',
    `You may only delegate to the reports named above. Each task you write is the entire`,
    'brief that report receives — they cannot see this one, so it must stand alone.',
    '',
    'You will then be called again with their results, and must produce your own',
    'deliverable from them.'
  ].join('\n');
}

function depthLimitSection(maxDepth) {
  return [
    '# Delegating',
    '',
    `You cannot delegate any further: depth ${maxDepth} is the configured maximum.`,
    'Produce your deliverable yourself.'
  ].join('\n');
}

export function buildBrief({
  resolved, task, cwd, denyPaths, skillText = null, dialectText = null,
  timeoutSec = 900, depth = 0, maxDepth = 3, priorResults = null
}) {
  const hasReports = resolved.reports.length > 0;
  const canDelegate = hasReports && depth < maxDepth;

  const sections = [];
  if (dialectText) sections.push(dialectText);
  if (resolved.charter) sections.push(`# Your charter\n\n${resolved.charter}`);
  if (resolved.persona) sections.push(`# How you work\n\n${resolved.persona}`);
  if (skillText) sections.push(skillText);
  if (canDelegate) sections.push(delegationSection(resolved.reports, depth, maxDepth));
  else if (hasReports) sections.push(depthLimitSection(maxDepth));
  if (priorResults) {
    sections.push(
      `# Results from your reports\n\n\`\`\`json\n${JSON.stringify(priorResults, null, 2)}\n\`\`\``
    );
  }
  sections.push(`# Task\n\n${task}`);

  return {
    member: resolved.member,
    title: resolved.title,
    task: sections.join('\n\n---\n\n'),
    cwd,
    read_only: resolved.isolation !== 'workspace',
    deliverable: resolved.deliverable,
    output_path: resolved.output_path,
    model: resolved.model,
    timeout_s: timeoutSec,
    deny_paths: denyPaths,
    reports: resolved.reports,
    can_delegate: canDelegate,
    depth,
    max_depth: maxDepth
  };
}
```

`read_only` is `isolation !== 'workspace'` rather than `=== 'read-only'`, so `none` is read-only
too. A scratch directory with no repository is not somewhere a member should be told to write
code.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 12 tests in `test/brief.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/brief.js test/brief.test.js references/
git commit -m "feat(brief): carry a member's charter, deliverable, and delegation protocol"
```

---

### Task R6: The recursive dispatcher — replaces Task 8

Owns four decisions: resolve before any side effect, keep a workspace on failure and prune it on
success, refuse a delegation that crosses the reporting line, and stop when either cap is hit.

**Two caps, each stopping a different runaway.** `max_depth` bounds how far down the tree one
objective can reach. `max_delegations` bounds the total number of adapter runs in a single
dispatch, which is what stops a manager that keeps delegating sideways forever. The budget is one
shared counter for the whole dispatch, not per branch — a fan-out of five is five runs against the
same budget.

**Files:**
- Create: `src/dispatch.js`
- Create: `test/dispatch.test.js`
- Modify: `adapters/mock` (per-member scripting — see Step 0)

- [ ] **Step 0: Teach the mock to answer differently per member**

Recursive tests need one member to delegate and another to do the work. Extend the mock's `run`
branch so a script containing `by_member` selects on the brief's `member`, falling back to the
top-level object when there is no entry:

```sh
# inside adapters/mock, in the `run` branch, after the brief is read into $BRIEF
# and the script into $SCRIPT — replace the single-response lookup with:
node -e '
  const brief = JSON.parse(process.argv[1]);
  const script = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
  const picked = (script.by_member && script.by_member[brief.member]) || script;
  if (picked.hang) { setInterval(() => {}, 1000); }
  else { process.stdout.write(JSON.stringify({ ...picked, received: brief })); }
' "$BRIEF" "$SCRIPT"
```

Keep the existing behaviour for a script with no `by_member` key — every Task 6 test depends on it.

- [ ] **Step 1: Write the failing tests**

`test/dispatch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';

const TEAM = {
  'eng-lead': { agent: 'mock', isolation: 'read-only', deliverable: 'decision' },
  implementer: { agent: 'mock', reports_to: 'eng-lead', isolation: 'workspace' },
  reviewer: { agent: 'mock', reports_to: 'eng-lead', isolation: 'read-only' },
  marketer: { agent: 'mock', isolation: 'none' }
};

function project(scripted, { members = TEAM, defaults = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'at-dsp-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');   // global commit.gpgsign=true would break the fixture
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, 'app.js'), 'ok\n');
  writeFileSync(join(root, 'credentials', 'key.p8'), 'SECRET\n');
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members,
    deny_paths: ['credentials/**'],
    defaults: { on_unavailable: 'mock', ...defaults }
  }));
  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify(scripted));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, script };
}

const adapterDir = new URL('../adapters/', import.meta.url).pathname;
const run = (root, script, member, extra = {}) => dispatch({
  projectRoot: root, member, task: 'go', adapterDir,
  env: { AGENT_TEAM_MOCK_SCRIPT: script }, ...extra
});

test('a successful run returns the result and prunes the workspace', async () => {
  const { root, script } = project({ status: 'ok', summary: 'clean' });
  const r = await run(root, script, 'implementer');
  assert.equal(r.status, 'ok');
  assert.equal(existsSync(r.workspace.dir), false, 'workspace should be pruned on success');
});

test('a failed run KEEPS the workspace for inspection', async () => {
  const { root, script } = project({ status: 'failed', summary: 'exploded' });
  const r = await run(root, script, 'implementer');
  assert.equal(r.status, 'failed');
  assert.equal(existsSync(r.workspace.dir), true, 'workspace should survive a failure');
});

test('a timed-out run also keeps the workspace', async () => {
  const { root, script } = project({ hang: true });
  const r = await run(root, script, 'implementer', { timeoutMs: 1500 });
  assert.equal(r.status, 'timeout');
  assert.equal(existsSync(r.workspace.dir), true, 'a timeout is a failure; keep the evidence');
});

test('the adapter is handed a workspace it cannot read the secret from', async () => {
  const { root, script } = project({ status: 'ok', summary: 's' });
  const r = await run(root, script, 'implementer');
  assert.ok(r.received.cwd.includes('workspaces'));
  assert.equal(existsSync(join(r.received.cwd, 'credentials', 'key.p8')), false);
});

test('an unknown member fails before any workspace is created', async () => {
  const { root, script } = project({ status: 'ok', summary: 's' });
  await assert.rejects(() => run(root, script, 'nope'), /unknown member/);
});

test('an isolation-none member runs without a repository', async () => {
  const { root, script } = project({ status: 'ok', summary: 'copy written' });
  const r = await run(root, script, 'marketer');
  assert.equal(r.status, 'ok');
  assert.equal(r.received.read_only, true);
  assert.equal(existsSync(join(r.received.cwd, '.git')), false);
});

test('a manager delegates, its report runs, and the manager synthesises', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'implementer', task: 'build it' }] },
      implementer: { status: 'ok', summary: 'built' }
    }
  });
  const r = await run(root, script, 'eng-lead');
  assert.equal(r.status, 'ok');
  assert.equal(r.delegated.length, 1);
  assert.equal(r.delegated[0].member, 'implementer');
  assert.equal(r.delegated[0].status, 'ok');
  // the second call to the manager carried the report's result
  assert.match(r.received.task, /Results from your reports/);
  assert.match(r.received.task, /built/);
});

test('delegating outside your direct reports is refused', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'marketer', task: 'x' }] }
    }
  });
  await assert.rejects(() => run(root, script, 'eng-lead'), /not a direct report/);
});

test('delegating with an empty list is a protocol error, not an infinite loop', async () => {
  const { root, script } = project({
    by_member: { 'eng-lead': { status: 'delegating', delegations: [] } }
  });
  const r = await run(root, script, 'eng-lead');
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /no delegations/);
});

test('max_depth stops a manager from delegating past the limit', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'implementer', task: 'x' }] },
      implementer: { status: 'ok', summary: 'built' }
    }
  }, { defaults: { max_depth: 0 } });
  const r = await run(root, script, 'eng-lead');
  // at depth 0 of max 0 the brief forbids delegating, and the dispatcher enforces it too
  assert.equal(r.received.can_delegate, false);
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /max_depth/);
});

test('max_delegations bounds the total number of adapter runs', async () => {
  const { root, script } = project({
    by_member: {
      'eng-lead': { status: 'delegating', delegations: [{ to: 'implementer', task: 'x' }] },
      implementer: { status: 'ok', summary: 'built' }
    }
  }, { defaults: { max_delegations: 2 } });
  const r = await run(root, script, 'eng-lead');
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /budget/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/dispatch.js'`

- [ ] **Step 3: Write the minimal implementation**

`src/dispatch.js`:

```js
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { resolveMember } from './resolve.js';
import { createWorkspace, pruneWorkspace } from './workspace.js';
import { buildBrief, loadDialect } from './brief.js';
import { runAdapter, DEFAULT_TIMEOUT_MS } from './adapter.js';

const adapterPath = (dir, agent) => join(dir, agent);

function makeProbe(adapterDir, env) {
  return (agent) => {
    const p = adapterPath(adapterDir, agent);
    if (!existsSync(p)) return false;
    try {
      // probe must be cheap; a non-zero exit means the agent is unusable, not an error
      execFileSync(p, ['probe'], { stdio: 'pipe', env: { ...process.env, ...env }, timeout: 30_000 });
      return true;
    } catch { return false; }
  };
}

async function readCapabilities(adapterDir, agent, env) {
  const res = await runAdapter(adapterPath(adapterDir, agent), 'capabilities', { env });
  return res.status === 'failed' ? {} : res;
}

export async function dispatch({
  projectRoot, member, task, adapterDir, assignments = {},
  skillsDir = null, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const config = loadConfig(projectRoot);
  const budget = { runs: config.defaults.max_delegations };
  return runMember({
    config, projectRoot, member, task, adapterDir,
    assignments: { ...assignments }, skillsDir, env, timeoutMs, budget, depth: 0
  });
}

async function runMember(ctx) {
  const { config, projectRoot, member, task, adapterDir, assignments,
          skillsDir, env, timeoutMs, budget, depth } = ctx;

  const probe = makeProbe(adapterDir, env);
  const resolved = resolveMember(config, member, { probe, assignments });  // throws before side effects
  assignments[member] = resolved.agent;

  const caps = await readCapabilities(adapterDir, resolved.agent, env);
  const dialectText = loadDialect(caps.tool_dialect ?? resolved.agent);

  let skillText = null;
  if (resolved.skill && skillsDir) {
    const p = join(skillsDir, resolved.skill, 'SKILL.md');
    if (!existsSync(p)) {
      throw new Error(`member "${member}" binds skill "${resolved.skill}" but ${p} is missing`);
    }
    skillText = readFileSync(p, 'utf8');
  }

  const workspace = createWorkspace(projectRoot, member, config.deny_paths, resolved.isolation);
  const maxDepth = config.defaults.max_depth;
  const delegated = [];
  let priorResults = null;
  let result;

  for (;;) {
    if (budget.runs <= 0) {
      result = { status: 'failed', summary: `delegation budget exhausted (max_delegations)` };
      break;
    }
    budget.runs -= 1;

    const brief = buildBrief({
      resolved, task, cwd: workspace.dir, denyPaths: config.deny_paths,
      skillText, dialectText, timeoutSec: Math.floor(timeoutMs / 1000),
      depth, maxDepth, priorResults
    });

    result = await runAdapter(adapterPath(adapterDir, resolved.agent), 'run', {
      brief, timeoutMs, env, cwd: workspace.dir
    });

    if (result.status !== 'delegating') break;

    const requests = result.delegations ?? [];
    if (requests.length === 0) {
      result = { ...result, status: 'failed', summary: 'answered "delegating" with no delegations' };
      break;
    }
    if (depth >= maxDepth) {
      result = { ...result, status: 'failed', summary: `delegation refused: already at max_depth ${maxDepth}` };
      break;
    }

    const round = [];
    for (const req of requests) {
      // The reporting line is a hard boundary: a manager may reach its own reports and no one else.
      if (!resolved.reports.includes(req.to)) {
        throw new Error(
          `member "${member}" may not delegate to "${req.to}" — not a direct report ` +
          `(reports: ${resolved.reports.join(', ') || 'none'})`
        );
      }
      const sub = await runMember({
        ...ctx, member: req.to, task: req.task, depth: depth + 1, priorResults: null
      });
      round.push(sub);
      delegated.push(sub);
    }
    priorResults = round.map((r) => ({
      member: r.member, status: r.status, summary: r.summary ?? null
    }));
  }

  if (result.status === 'ok') pruneWorkspace(workspace);

  return {
    ...result,
    member, agent: resolved.agent, warning: resolved.warning,
    workspace, depth, delegated
  };
}
```

`assignments` is one object threaded through the whole tree and mutated as each member resolves,
so `distinct_from` sees siblings that ran earlier in the same dispatch. That is the only reason
`dispatch` copies it up front — a caller's object must not be written into.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 11 tests in `test/dispatch.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.js test/dispatch.test.js adapters/mock
git commit -m "feat(dispatch): delegate down the reporting tree under depth and budget caps"
```

---

## Deltas to the tasks that still stand

**Task 5 (mock adapter)** — gains the `by_member` lookup, done as Step 0 of R6. No separate task.

**Task 9 (claude adapter)** — the brief now carries `deliverable`, `can_delegate` and `reports`.
The adapter passes them through; it does not interpret them. One added test: a brief with
`can_delegate: true` reaches the subagent with the delegation section intact.

**Task 10 (conformance suite)** — add two rows every adapter must satisfy: a `run` whose brief has
`can_delegate: false` never answers `status: "delegating"`, and a brief with `read_only: true`
leaves the workspace `git status --porcelain` empty.

**Task 13 (manifests)** — no change.

**Task 14 (skills and CLI)** — three changes:
- `/delegate` takes a member name, not a role name, and its "Do not" section gains: do not name a
  member that is not in the config; run `agent-team org` to see who exists.
- `bin/agent-team.js` gains an `org` subcommand printing `renderOrg(config.org)`, so a member list
  is discoverable without opening the JSON.
- `/agent-team-init` scaffolds the worked example from Revision 2's "Revised config shape" —
  `coo`, `eng-lead`, `implementer`, `reviewer`, `qa`, `designer`, `marketer` — commented so the
  non-engineering members are obviously meant to be edited or deleted rather than kept by default.

**Task R4 (workspace clone)** — a review found that `deniedFiles`' `check-ignore -v` call ran
against the workspace clone itself, so a repo's own tracked `.gitignore` naming or negating the
same path as a `deny_paths` entry could out-arbitrate the exclude file the function wrote there.
The reported match source came back as `.gitignore`, the `source === EXCLUDE_SOURCE` filter
dropped it, and the denied file shipped to the vendor CLI while `unmatchedDenyPaths` reported the
entry as if it had matched nothing. Arbitration now happens in a scratch git directory containing
only the `deny_paths` patterns, with `core.excludesFile=/dev/null` so a machine's global excludes
file cannot leak matches in either. An unexpected match source in that scratch directory now
throws instead of being silently dropped.

Separately, the cleanup `rmSync` in `createWorkspace`'s catch block could itself throw (a
read-only parent, an immutable file) and replace the original error with an unrelated one, while
still leaving the directory on disk. The cleanup now runs in its own try/catch: a cleanup failure
is reported via `console.warn` naming the directory, and the original error is always the one
that propagates.

**Task R6 (dispatcher)** — `workspace.unmatchedDenyPaths` had no reader outside test assertions.
`dispatch` now logs a `console.warn` naming the member and the unmatched entries when
`unmatchedDenyPaths` is non-empty, and returns `unmatchedDenyPaths` on the dispatch result
alongside `workspace`. An entry matching nothing in a given repo is still not an error — the same
`agent-team.json` is expected to be reused across projects.

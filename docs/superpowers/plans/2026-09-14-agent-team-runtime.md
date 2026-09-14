# agent-team Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the role resolver, adapter protocol, worktree isolation, and plugin packaging so a skill can delegate a task to Codex, Grok, or Claude by naming a role rather than a vendor.

**Architecture:** A Node dispatcher resolves a role to an agent using a per-project JSON config, builds a git worktree with denied paths excluded by sparse-checkout, assembles a brief (tool-dialect table + skill markdown + task), and runs a per-vendor adapter executable that takes the brief on stdin and returns one JSON result on stdout. A `mock` adapter makes every piece of that testable offline.

**Tech Stack:** Node 26 (zero runtime dependencies: `node:test`, `node:assert`, `node:util.parseArgs`, `node:child_process`), git 2.46 sparse-checkout, POSIX-executable adapters.

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

Run: `node --test test/`
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
  "scripts": { "test": "node --test test/" }
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
Expected: PASS, 8 new tests

- [ ] **Step 5: Commit**

```bash
git add src/resolve.js test/resolve.test.js
git commit -m "feat(resolve): map roles to agents with fallback and a distinct_from hard stop"
```

---

### Task 4: Worktree creation with denied paths excluded by construction

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

### Task 11: The codex adapter — BLOCKED

**Blocked on:** `codex` installed and authenticated (ChatGPT Plus/Pro, or an OpenAI API key). Also blocked behind the Phase 0 ACP spike: if ACP wins, this adapter is rewritten against the protocol instead of the CLI.

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

### Task 12: The grok adapter — BLOCKED

**Blocked on:** `grok` installed and authenticated (SuperGrok or X Premium+, or `GROK_CODE_XAI_API_KEY`). Same Phase 0 dependency as Task 11.

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrief } from '../src/brief.js';
import { runAdapter } from '../src/adapter.js';

// Every pre-existing diff test in test/claude-adapter.test.js seeds a TRACKED file and then
// modifies it, so all three adapters passed while `git diff HEAD` — which never shows an
// untracked path — silently dropped every file a member CREATED. A new Kotlin source, a new
// test file, a new migration: the run reports ok, the summary describes the work, and the
// diff handed back to the manager is empty. These tests cover the create case for all three
// real adapters, since the diff-capture block is duplicated in each.

const ADAPTERS = [
  { agent: 'claude', binName: 'claude', binEnv: null },
  { agent: 'codex', binName: 'codex', binEnv: 'AGENT_TEAM_CODEX_BIN' },
  { agent: 'grok', binName: 'grok', binEnv: 'AGENT_TEAM_GROK_BIN' }
];

function initGitFixtureRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.st'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'tracked.txt'), 'original\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

// One stub source serves all three adapters: it creates an untracked file in the cwd it was
// spawned in (every adapter spawns its vendor binary with cwd: brief.cwd), then emits an
// envelope carrying both claude's `.result` and grok's `.text`, and writes codex's
// -o/--output-last-message file when that flag is present.
function createStub(binName) {
  const stubDir = mkdtempSync(join(tmpdir(), `agent-team-${binName}-diffstub-`));
  const stubPath = join(stubDir, binName);
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.writeFileSync(path.join(process.cwd(), 'NEW.txt'), 'created by the member\\n');",
    "const i = process.argv.indexOf('-o');",
    "if (i !== -1 && process.argv[i + 1]) fs.writeFileSync(process.argv[i + 1], 'ok');",
    "process.stdout.write(JSON.stringify({ result: 'ok', text: 'ok' }) + '\\n');",
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return { stubDir, stubPath };
}

function briefForCwd(cwd, agent) {
  return buildBrief({
    resolved: {
      member: 'implementer', title: 'Implementer', agent, model: null, skill: null,
      charter: null, persona: null, isolation: 'workspace', deliverable: 'diff',
      output_path: null, reports_to: null, reports: [], warning: null
    },
    task: 'x', cwd, denyPaths: ['**/.env*']
  });
}

async function runWithStub({ agent, binName, binEnv }, cwd) {
  const { stubDir, stubPath } = createStub(binName);
  const env = binEnv
    ? { [binEnv]: stubPath }
    : { PATH: `${stubDir}:${process.env.PATH}` };
  const adapter = new URL(`../adapters/${agent}`, import.meta.url).pathname;
  return runAdapter(adapter, 'run', { brief: briefForCwd(cwd, agent), env });
}

for (const adapter of ADAPTERS) {
  test(`adapters/${adapter.agent}: a file the member CREATED appears in the diff`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `agent-team-${adapter.agent}-created-`));
    initGitFixtureRepo(cwd);

    const res = await runWithStub(adapter, cwd);

    assert.equal(res.status, 'ok');
    assert.ok(
      res.artifacts.diff.includes('NEW.txt'),
      `a created file must not vanish from the diff; got ${JSON.stringify(res.artifacts.diff)}`
    );
    assert.ok(
      res.artifacts.diff.includes('created by the member'),
      'the diff must carry the new file\'s contents, not just its name'
    );
    assert.equal(res.artifacts.diff_unreadable, false);
    assert.ok(res.artifacts.diff_full_length > 0);
  });

  test(`adapters/${adapter.agent}: capturing the diff does not stage anything in the real index`, async () => {
    // The fix stages intent-to-add to read the new file, which MUST happen in a throwaway
    // index. A read_only brief's conformance check compares `git status --porcelain` from
    // before the run to after it; mutating the workspace's real index would turn "?? NEW.txt"
    // into "A  NEW.txt" and report a read-only violation that never happened.
    const cwd = mkdtempSync(join(tmpdir(), `agent-team-${adapter.agent}-index-`));
    initGitFixtureRepo(cwd);

    await runWithStub(adapter, cwd);

    const status = execFileSync('git', ['status', '--porcelain'], { cwd, stdio: 'pipe' }).toString();
    assert.equal(status, '?? NEW.txt\n', 'the created file must still read as untracked afterwards');
  });

  test(`adapters/${adapter.agent}: a modified tracked file is still in the diff alongside the created one`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `agent-team-${adapter.agent}-both-`));
    initGitFixtureRepo(cwd);
    writeFileSync(join(cwd, 'tracked.txt'), 'modified\n');

    const res = await runWithStub(adapter, cwd);

    assert.ok(res.artifacts.diff.includes('NEW.txt'), 'the created file is missing');
    assert.ok(res.artifacts.diff.includes('tracked.txt'), 'the modified file is missing');
    assert.ok(res.artifacts.diff.includes('-original'), 'the modification itself is missing');
  });

  test(`adapters/${adapter.agent}: a cwd that is not a git repository still reports an empty, readable diff`, async () => {
    // The pre-fix behaviour for a non-repo cwd was diff '' with diff_unreadable false. Adding
    // index plumbing in front of the diff must not turn that into a spurious "unreadable".
    const cwd = mkdtempSync(join(tmpdir(), `agent-team-${adapter.agent}-norepo-`));

    const res = await runWithStub(adapter, cwd);

    assert.equal(res.status, 'ok');
    assert.equal(res.artifacts.diff, '');
    assert.equal(res.artifacts.diff_unreadable, false);
  });
}

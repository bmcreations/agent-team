import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrief } from '../src/brief.js';

// test/claude-adapter.test.js checks the claude adapter's argv. codex and grok build theirs
// separately, and each pins its sandbox on both branches because an unpinned run inherits
// whatever the user's own CLI config says — so their argv gets its own coverage here.

const ADAPTERS = [
  {
    agent: 'codex', binEnv: 'AGENT_TEAM_CODEX_BIN',
    model: ['-m'], effort: (level) => ['-c', `model_reasoning_effort=${level}`],
    sandbox: { readOnly: ['-s', 'read-only'], workspace: ['-s', 'workspace-write'] }
  },
  {
    agent: 'grok', binEnv: 'AGENT_TEAM_GROK_BIN',
    model: ['-m'], effort: (level) => ['--reasoning-effort', level],
    sandbox: { readOnly: ['--sandbox', 'read-only'], workspace: ['--sandbox', 'workspace'] }
  }
];

// Records its argv to the file named by STUB_RECORD, writes codex's -o last-message file when
// that flag is present, and prints an envelope carrying grok's `.text`, so each adapter takes
// its success path.
function createStub(agent) {
  const stubDir = mkdtempSync(join(tmpdir(), `agent-team-${agent}-argvstub-`));
  const stubPath = join(stubDir, agent);
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.STUB_RECORD, JSON.stringify(process.argv.slice(2)));",
    "const i = process.argv.indexOf('-o');",
    "if (i !== -1 && process.argv[i + 1]) fs.writeFileSync(process.argv[i + 1], 'ok');",
    "process.stdout.write(JSON.stringify({ text: 'ok' }) + '\\n');",
    ''
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return { stubPath, recordPath: join(stubDir, 'argv.json') };
}

function argvFor({ agent, binEnv }, resolvedOverrides) {
  const cwd = mkdtempSync(join(tmpdir(), `agent-team-${agent}-argv-`));
  const brief = buildBrief({
    resolved: {
      member: 'implementer', title: 'Implementer', agent, model: null, effort: null,
      skill: null, charter: null, persona: null, isolation: 'workspace', deliverable: 'diff',
      output_path: null, reports_to: null, reports: [], warning: null,
      ...resolvedOverrides
    },
    task: 'x', cwd, denyPaths: ['**/.env*']
  });
  const { stubPath, recordPath } = createStub(agent);
  const adapter = new URL(`../adapters/${agent}`, import.meta.url).pathname;
  execFileSync(adapter, ['run'], {
    input: JSON.stringify(brief),
    env: { ...process.env, [binEnv]: stubPath, STUB_RECORD: recordPath }
  });
  return JSON.parse(readFileSync(recordPath, 'utf8'));
}

// True when `pair` appears in argv as adjacent elements. Comparing slots rather than a joined
// string keeps a whitespace-splitting bug in the arg list from passing.
function hasAdjacent(argv, pair) {
  for (let i = 0; i + pair.length <= argv.length; i++) {
    if (pair.every((v, j) => argv[i + j] === v)) return true;
  }
  return false;
}

for (const a of ADAPTERS) {
  test(`adapters/${a.agent}: a resolved model is passed, and no model flag when it is null`, () => {
    const withModel = argvFor(a, { model: 'some-model' });
    assert.ok(hasAdjacent(withModel, [...a.model, 'some-model']), JSON.stringify(withModel));

    const without = argvFor(a, { model: null });
    assert.equal(without.includes(a.model[0]), false, JSON.stringify(without));
  });

  test(`adapters/${a.agent}: a resolved effort is passed, and no effort flag when it is null`, () => {
    const withEffort = argvFor(a, { effort: 'high' });
    assert.ok(hasAdjacent(withEffort, a.effort('high')), JSON.stringify(withEffort));

    const without = argvFor(a, { effort: null });
    const flag = a.effort('high')[0];
    assert.equal(without.includes(flag), false, JSON.stringify(without));
  });

  test(`adapters/${a.agent}: the sandbox is pinned on both the read-only and the workspace branch`, () => {
    const readOnly = argvFor(a, { isolation: 'read-only', deliverable: 'review' });
    assert.ok(hasAdjacent(readOnly, a.sandbox.readOnly), JSON.stringify(readOnly));

    const workspace = argvFor(a, { isolation: 'workspace' });
    assert.ok(hasAdjacent(workspace, a.sandbox.workspace), JSON.stringify(workspace));
  });
}

for (const a of ADAPTERS) {
  test(`adapters/${a.agent}: an advisor is ignored, since it is a Claude Code setting`, () => {
    const plain = argvFor(a, {});
    const withAdvisor = argvFor(a, { advisor: 'opus' });
    // The cwd differs per run, so compare with it masked out.
    const mask = (argv) => argv.map((v) => (v.startsWith(tmpdir()) || v.includes('agent-team-') ? '<tmp>' : v));
    assert.deepEqual(mask(withAdvisor), mask(plain));
  });
}

test('adapters/codex: the prompt is the last argument, after every flag', () => {
  // adapters/codex: "positional prompt LAST, after all flags". A new flag appended below that
  // line would break the order this test holds it to.
  const argv = argvFor(ADAPTERS[0], { model: 'm', effort: 'high' });
  assert.match(argv[argv.length - 1], /# Task\n\nx$/);
});

test('adapters/grok: the prompt is passed as -p, not as a bare positional', () => {
  // A bare positional opens grok's interactive UI, which dies outside a terminal.
  const argv = argvFor(ADAPTERS[1], {});
  const p = argv.indexOf('-p');
  assert.notEqual(p, -1, JSON.stringify(argv));
  assert.match(argv[p + 1], /# Task\n\nx$/);
});

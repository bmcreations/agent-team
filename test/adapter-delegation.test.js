import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrief } from '../src/brief.js';
import { parseDelegation } from '../src/delegation.js';

// Each vendor CLI returns the member's final text in its own envelope: claude's `.result`,
// codex's -o last-message file, grok's `.text`. These stubs put STUB_TEXT in that slot, so the
// same answers can be run through all three adapters' real success paths.
const ADAPTERS = [
  {
    agent: 'claude', binEnv: null,
    body: "process.stdout.write(JSON.stringify({ result: process.env.STUB_TEXT }) + '\\n');"
  },
  {
    agent: 'codex', binEnv: 'AGENT_TEAM_CODEX_BIN',
    body: [
      "const i = process.argv.indexOf('-o');",
      "fs.writeFileSync(process.argv[i + 1], process.env.STUB_TEXT);",
      "process.stdout.write('{\"type\":\"done\"}\\n');"
    ].join('\n')
  },
  {
    agent: 'grok', binEnv: 'AGENT_TEAM_GROK_BIN',
    body: "process.stdout.write(JSON.stringify({ text: process.env.STUB_TEXT }) + '\\n');"
  }
];

function createStub(agent, body) {
  const stubDir = mkdtempSync(join(tmpdir(), `agent-team-${agent}-delegstub-`));
  const stubPath = join(stubDir, agent);
  writeFileSync(stubPath, ['#!/usr/bin/env node', "const fs = require('node:fs');", body, ''].join('\n'));
  chmodSync(stubPath, 0o755);
  return { stubDir, stubPath };
}

function managerBrief(agent, { reports = ['implementer', 'reviewer'] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), `agent-team-${agent}-deleg-`));
  return buildBrief({
    resolved: {
      member: 'lead', title: 'Lead', agent, model: null, effort: null, skill: null,
      charter: null, persona: null, isolation: 'read-only', deliverable: 'text',
      output_path: null, reports_to: null, reports, warning: null
    },
    task: 'x', cwd, denyPaths: ['**/.env*']
  });
}

function run({ agent, binEnv, body }, brief, text) {
  const { stubDir, stubPath } = createStub(agent, body);
  const env = { ...process.env, STUB_TEXT: text };
  if (binEnv) env[binEnv] = stubPath;
  else env.PATH = `${stubDir}:${process.env.PATH}`;
  const out = execFileSync(new URL(`../adapters/${agent}`, import.meta.url).pathname, ['run'], {
    input: JSON.stringify(brief), env
  }).toString().trim().split('\n');
  return JSON.parse(out[out.length - 1]);
}

const DELEGATION = {
  status: 'delegating',
  delegations: [
    { to: 'implementer', task: 'Add the flag.' },
    { to: 'reviewer', task: 'Review the flag.' }
  ]
};

for (const a of ADAPTERS) {
  test(`adapters/${a.agent}: a bare JSON delegation answer is reported as delegating`, () => {
    const res = run(a, managerBrief(a.agent), JSON.stringify(DELEGATION, null, 2));
    assert.equal(res.status, 'delegating', res.summary);
    assert.deepEqual(res.delegations, DELEGATION.delegations);
  });

  test(`adapters/${a.agent}: a delegation in a single fenced block is reported as delegating`, () => {
    const text = '```json\n' + JSON.stringify(DELEGATION) + '\n```\n';
    const res = run(a, managerBrief(a.agent), text);
    assert.equal(res.status, 'delegating', res.summary);
    assert.deepEqual(res.delegations, DELEGATION.delegations);
  });

  test(`adapters/${a.agent}: a delegation wrapped in prose fails instead of passing as a deliverable`, () => {
    const text = `Here is my plan:\n${JSON.stringify(DELEGATION)}`;
    const res = run(a, managerBrief(a.agent), text);
    assert.equal(res.status, 'failed');
    assert.match(res.summary, /^malformed delegation: /);
    assert.equal(res.delegations, undefined);
  });

  test(`adapters/${a.agent}: a delegation entry without a task fails`, () => {
    const text = JSON.stringify({ status: 'delegating', delegations: [{ to: 'implementer' }] });
    const res = run(a, managerBrief(a.agent), text);
    assert.equal(res.status, 'failed');
    assert.match(res.summary, /delegations\[0\]\.task/);
  });

  test(`adapters/${a.agent}: a brief that cannot delegate reports the same text as ok`, () => {
    const brief = managerBrief(a.agent, { reports: [] });
    assert.equal(brief.can_delegate, false);
    const text = JSON.stringify(DELEGATION);
    const res = run(a, brief, text);
    assert.equal(res.status, 'ok');
    assert.equal(res.summary, text);
    assert.equal(res.delegations, undefined);
  });

  test(`adapters/${a.agent}: a manager's prose deliverable stays ok`, () => {
    const res = run(a, managerBrief(a.agent), 'Both reports finished; the flag is in.');
    assert.equal(res.status, 'ok');
    assert.equal(res.summary, 'Both reports finished; the flag is in.');
  });
}

const CAN = { can_delegate: true };

test('parseDelegation: a fenced block with no language tag is accepted', () => {
  const r = parseDelegation('```\n' + JSON.stringify(DELEGATION) + '\n```', CAN);
  assert.equal(r.kind, 'delegating');
});

test('parseDelegation: two fenced blocks are not one answer', () => {
  const block = '```json\n' + JSON.stringify(DELEGATION) + '\n```';
  assert.equal(parseDelegation(`${block}\n\n${block}`, CAN).kind, 'malformed');
});

test('parseDelegation: an empty or non-array delegations list is malformed', () => {
  assert.equal(parseDelegation('{"status":"delegating","delegations":[]}', CAN).kind, 'malformed');
  assert.equal(parseDelegation('{"status":"delegating","delegations":{}}', CAN).kind, 'malformed');
  assert.equal(parseDelegation('{"status":"delegating"}', CAN).kind, 'malformed');
});

test('parseDelegation: truncated JSON that tried to delegate is malformed', () => {
  assert.equal(parseDelegation('{"status": "delegating", "delegations": [{"to":"a"', CAN).kind, 'malformed');
});

test('parseDelegation: a JSON deliverable with another status is not a delegation', () => {
  assert.equal(parseDelegation('{"status":"ok","notes":"done"}', CAN).kind, 'none');
});

test('parseDelegation: extra keys are dropped from each delegation', () => {
  const r = parseDelegation(
    '{"status":"delegating","delegations":[{"to":"a","task":"t","priority":1}]}', CAN
  );
  assert.deepEqual(r.delegations, [{ to: 'a', task: 't' }]);
});

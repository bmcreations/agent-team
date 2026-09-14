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

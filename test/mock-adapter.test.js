import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER = new URL('../adapters/mock', import.meta.url).pathname;

const run = (args, { input, env } = {}) =>
  execFileSync(ADAPTER, args, { input, env: { ...process.env, ...env } }).toString();

test('probe succeeds', () => {
  assert.match(run(['probe']), /mock/);
});

test('capabilities reports a writable, workspace-capable agent', () => {
  const caps = JSON.parse(run(['capabilities']));
  assert.equal(caps.write, true);
  assert.equal(caps.workspace, true);
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

test('mock-live survives an {error} reply from wait_for and still sends its result', async () => {
  const { serveRpc } = await import('../src/rpc.js');
  const dir = mkdtempSync(join(tmpdir(), 'at-ml-'));
  const server = await serveRpc(join(dir, 's.sock'), async () => ({ error: 'member finished' }));
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify({ steps: [{ tool: 'wait_for', args: {}, until_finished: [2] }] }));
  try {
    const child = spawn(new URL('../adapters/mock-live', import.meta.url).pathname, ['session'], {
      env: { ...process.env, AGENT_TEAM_MOCK_SCRIPT: scriptPath, AGENT_TEAM_TEAM_SOCKET: join(dir, 's.sock'), AGENT_TEAM_TEAM_TOKEN: 't' }
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('"type":"idle"')) child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n');
    });
    child.stdin.write(JSON.stringify({ type: 'start', brief: { member: 'lead' } }) + '\n');
    const code = await new Promise((resolve) => child.on('close', resolve));
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(code, 0);
    assert.equal(lines.find((l) => l.kind === 'tool_result').result.error, 'member finished');
    assert.equal(lines.at(-1).type, 'result');
  } finally { await server.close(); }
});

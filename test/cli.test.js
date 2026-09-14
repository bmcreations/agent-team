import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;

function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'at-cli-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify(config));
  return root;
}

const GOOD = {
  members: {
    coo: { agent: 'mock', isolation: 'none' },
    marketer: { agent: 'mock', reports_to: 'coo', isolation: 'none' }
  },
  deny_paths: ['credentials/**'],
  defaults: { on_unavailable: 'mock' }
};

// A broken config that fails loadConfig's validation (no deny_paths) rather than one that
// crashes for some unrelated reason — this is what "org on a broken config" means here.
const BROKEN = {
  members: { coo: { agent: 'mock' } }
};

// Runs the real CLI as a subprocess (not an in-process import) so a raw, unhandled stack
// trace on stdout/stderr is actually observable the way an operator would see it.
function runCli(args) {
  return execFileAsync(process.execPath, [BIN, ...args]).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' })
  );
}

test('an unknown --member gives exit 1 and parseable JSON on stdout naming the member', async () => {
  const root = project(GOOD);
  const { code, stdout, stderr } = await runCli([
    '--member', 'ghost', '--task', 'go', '--project', root
  ]);
  assert.equal(code, 1);
  assert.doesNotMatch(stdout, /at Object|at async|\.js:\d+:\d+/, 'stdout must not carry a raw stack trace');
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, 'failed');
  assert.match(parsed.summary, /ghost/);
  assert.equal(stderr, '');
});

test('a missing --member gives exit 2 and the usage string on stderr', async () => {
  const root = project(GOOD);
  const { code, stdout, stderr } = await runCli(['--task', 'go', '--project', root]);
  assert.equal(code, 2);
  assert.match(stderr, /^usage: agent-team/);
  assert.equal(stdout, '');
});

test('"org" on a good config gives exit 0 and prints the tree', async () => {
  const root = project(GOOD);
  const { code, stdout, stderr } = await runCli(['org', '--project', root]);
  assert.equal(code, 0);
  assert.match(stdout, /coo/);
  assert.match(stdout, /marketer/);
  assert.equal(stderr, '');
});

test('"org" on a broken config gives exit 1 and parseable JSON, not a stack trace', async () => {
  const root = project(BROKEN);
  const { code, stdout, stderr } = await runCli(['org', '--project', root]);
  assert.equal(code, 1);
  assert.doesNotMatch(stdout, /at Object|at async|\.js:\d+:\d+/, 'stdout must not carry a raw stack trace');
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, 'failed');
  assert.match(parsed.summary, /deny_paths/);
  assert.equal(stderr, '');
});

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

test('a multi-byte character split across two stdout chunks is not corrupted', async () => {
  const res = await runAdapter(p('test/fixtures/split-multibyte'), 'run', { brief: { task: 't' } });
  assert.equal(res.status, 'ok');
  assert.equal(res.summary, 'a€b');
});

test('a run payload past the 64 KB pipe buffer survives intact through the real mock adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-ad-big-'));
  const script = join(dir, 's.json');
  const big = 'y'.repeat(100_000);
  writeFileSync(script, JSON.stringify({ status: 'ok', summary: big, findings: [], checked_sound: [] }));
  const res = await runAdapter(p('adapters/mock'), 'run', {
    brief: { role: 'reviewer', task: 't', cwd: dir },
    env: { AGENT_TEAM_MOCK_SCRIPT: script }
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.summary.length, 100_000);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { GUARD_EXIT } from './helpers/guard.js';

const live = process.env.AGENT_TEAM_LIVE_SMOKE === '1';
const adapter = (name) => new URL(`../adapters/${name}`, import.meta.url).pathname;

test('a test process cannot run the real claude or codex', { skip: live }, () => {
  for (const bin of ['claude', 'codex', process.env.AGENT_TEAM_CODEX_BIN]) {
    const r = spawnSync(bin, ['-p', 'hello'], { encoding: 'utf8' });
    assert.equal(r.status, GUARD_EXIT, `${bin} was not stopped by the guard`);
    assert.match(r.stderr, /agent-team test guard: refusing to run the real (claude|codex)/);
  }
});

test('adapter probes still pass behind the guard, so resolution is deterministic', { skip: live }, () => {
  assert.match(execFileSync(adapter('claude'), ['probe']).toString(), /agent-team test guard/);
  assert.match(execFileSync(adapter('codex'), ['probe']).toString(), /agent-team test guard/);
});

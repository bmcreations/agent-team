import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project, supervise } from './helpers/live.js';

const FAKE = new URL('./fixtures/fake-codex', import.meta.url).pathname;
const until = async (f, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A supervised codex member `solo` against test/fixtures/fake-codex.
async function setup(env = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'at-cs-')), 'codex.jsonl');
  const { root, script } = project({ solo: { agent: 'codex', isolation: 'none' } }, {});
  const { sup, store } = await supervise(script, { env: { AGENT_TEAM_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, ...env } });
  const calls = (method) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((e) => e.method === method);
  const serverPids = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((e) => e.argv?.[0] === 'app-server').map((e) => e.pid);
  const submit = (task) => sup.submit({ projectRoot: root, member: 'solo', task });
  return { sup, store, calls, serverPids, submit };
}

test('a codex member runs, is steered mid-turn, and its tokens are recorded without any cost', { timeout: 30_000 }, async () => {
  const { sup, store, calls, submit } = await setup();
  try {
    const { runId, memberId } = submit('HOLD this turn');
    await until(() => calls('turn/start').length === 1);
    sup.send({ member_id: memberId, text: 'RELEASE now' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.equal(calls('turn/steer').length, 1);
    assert.match(calls('turn/steer')[0].params.input[0].text, /RELEASE now/);
    assert.equal(store.member(memberId).tokens, 100);
    assert.equal(store.run(runId).tokens, 100);
    assert.equal(store.run(runId).cost_usd, 0);
    assert.equal(store.member(memberId).cost_usd, 0);
  } finally { await sup.close(); }
});

test('pause then resume relaunches the thread from the recorded tokens and adds only the new turn', { timeout: 30_000 }, async () => {
  const { sup, store, calls, submit } = await setup({ FAKE_CODEX_HOLD_MS: '400', FAKE_CODEX_RESUME_TOKENS: '100' });
  try {
    const { runId, memberId } = submit('HOLD for a moment');
    await until(() => calls('turn/start').length === 1);
    sup.pause({ member_id: memberId });
    await until(() => store.member(memberId).state === 'paused');
    assert.equal(store.member(memberId).tokens, 100);

    sup.resume({ member_id: memberId });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const [resumed] = calls('thread/resume');
    assert.equal(resumed.params.threadId, 'thr-1');
    assert.equal(store.member(memberId).tokens, 200);
    assert.equal(store.run(runId).tokens, 200);
    assert.equal(store.run(runId).cost_usd, 0);
  } finally { await sup.close(); }
});

test('pause --now interrupts a running turn and ends the app-server', { timeout: 30_000 }, async () => {
  const { sup, store, calls, serverPids, submit } = await setup();
  try {
    const { memberId } = submit('HOLD forever');
    await until(() => calls('turn/start').length === 1);
    sup.pause({ member_id: memberId, now: true });
    await until(() => store.member(memberId).state === 'paused');
    assert.ok(calls('turn/interrupt').length >= 1);
    await until(() => serverPids().every((p) => !alive(p)));
    assert.equal(serverPids().length, 1);
  } finally { await sup.close(); }
});

test('cancel during a running turn ends the member cancelled and the app-server', { timeout: 30_000 }, async () => {
  const { sup, store, calls, serverPids, submit } = await setup();
  try {
    const { memberId } = submit('HOLD forever');
    await until(() => calls('turn/start').length === 1);
    sup.cancel({ member_id: memberId });
    await until(() => store.member(memberId).state === 'cancelled');
    await until(() => serverPids().every((p) => !alive(p)));
    assert.equal(serverPids().length, 1);
  } finally { await sup.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { project, supervise, LIVE } from './helpers/live.js';
import { callRpc } from '../src/rpc.js';

const until = async (f, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// A root that blocks in wait_for, so it can be paused at a known point.
const blocked = (extra = {}) => ({ by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], ...extra } } });

test('resume relaunches the session in its workspace and delivers what was sent while paused', async () => {
  const { root, script } = project({ solo: LIVE({ isolation: 'workspace' }) }, blocked());
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const { workspace, resume: sid } = store.member(memberId);
    assert.match(sid, /^mock-session-solo-/);
    sup.pause({ member_id: memberId });
    await until(() => store.member(memberId).state === 'paused');

    assert.deepEqual(sup.send({ member_id: memberId, text: 'while you were out' }), { message_id: 1 });
    sup.resume({ member_id: memberId, note: 'carry on', by: 'ann' });
    const result = await sup.waitRun(runId);

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.received, [
      `[resume ${sid}] Resumed by ann.\nann: carry on`,
      '[from: local (human)] while you were out'
    ]);
    assert.equal(store.member(memberId).workspace, workspace, 'resume used a new workspace');
    assert.equal(store.member(memberId).resume, sid);
    assert.deepEqual(store.events(memberId).filter((e) => e.kind === 'resumed').map((e) => e.body), [{ by: 'ann' }]);
  } finally { await sup.close(); }
});

test('resume after pause --now warns that the interrupted turn may have partly run', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ say: 'working' }, { sleep_ms: 30_000 }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.events(memberId).some((e) => e.kind === 'text'));
    sup.pause({ member_id: memberId, now: true });
    await until(() => store.member(memberId).state === 'paused');
    sup.resume({ member_id: memberId });
    const [note] = (await sup.waitRun(runId)).received;
    assert.match(note, /Resumed by local\.\nYour last turn was interrupted: a command it started may have partly run\./);
  } finally { await sup.close(); }
});

test('resume fails the member clearly when its workspace was deleted', async () => {
  const { root, script } = project({ solo: LIVE({ isolation: 'workspace' }) }, blocked());
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    sup.pause({ member_id: memberId });
    await until(() => store.member(memberId).state === 'paused');
    const { workspace } = store.member(memberId);
    rmSync(workspace, { recursive: true, force: true });
    sup.resume({ member_id: memberId });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'failed');
    assert.equal(result.summary, `cannot resume "solo": its workspace ${workspace} is gone`);
    assert.equal(store.member(memberId).state, 'failed');
  } finally { await sup.close(); }
});

test('resume refuses a member that is not paused', async () => {
  const { root, script } = project({ solo: LIVE() }, blocked());
  const { sup, store } = await supervise(script);
  try {
    const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    assert.throws(() => sup.resume({ member_id: memberId }), /"solo" is not paused \(waiting\)/);
    assert.equal(store.member(memberId).state, 'waiting');
  } finally { await sup.close(); }
});

test('a paused subtree resumes together and the run finishes', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [
        { tool: 'delegate', args: { to: 'worker', task: 'w' }, save: 'r' },
        { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
      ] },
      worker: { steps: [{ tool: 'wait_for', args: {} }] }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.members(runId).length === 2 && store.members(runId).every((m) => m.state === 'waiting'));
    sup.pause({ member_id: leadId, subtree: true });
    await until(() => store.members(runId).every((m) => m.state === 'paused'));
    const res = await callRpc(sup.socketPath, { method: 'resume', params: { run_id: runId, member: 'lead', subtree: true } });
    assert.deepEqual(res.members.map((m) => m.name), ['lead', 'worker']);
    assert.equal((await sup.waitRun(runId)).status, 'ok');
    assert.deepEqual(store.members(runId).map((m) => m.state), ['done', 'done']);
  } finally { await sup.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { project, supervise, LIVE } from './helpers/live.js';
import { attach } from '../src/admin.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;
const ME = userInfo().username;
const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)); };

// fake-claude as `claude`: with -p it plays a stream-json session; without, it is the human's
// interactive session, which records its argv and cwd and exits.
const FAKE_BIN = mkdtempSync(join(tmpdir(), 'at-tob-'));
symlinkSync(new URL('./fixtures/fake-claude', import.meta.url).pathname, join(FAKE_BIN, 'claude'));
const PATH = `${FAKE_BIN}:${process.env.PATH}`;

function cli(args, sock, env = {}) {
  return promisify(execFile)(process.execPath, [BIN, ...args], {
    env: { ...process.env, AGENT_TEAM_SUPERVISOR_SOCK: sock, PATH, ...env }
  }).then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
          (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
}

test('attach hands a running claude member to a human and resumes it headless on exit', { timeout: 20_000 }, async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'at-tol-')), 'claude.jsonl');
  const { root, script } = project({ solo: { agent: 'claude', isolation: 'workspace' } }, {});
  const { sup, store } = await supervise(script, { env: { PATH, FAKE_CLAUDE_LOG: log } });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'HOLD the work' });
    await until(() => store.member(memberId).resume);
    const sid = store.member(memberId).resume;
    const workspace = realpathSync(store.member(memberId).workspace);   // pruned once the run is ok

    const { code, stdout, stderr } = await cli(['attach', String(runId), 'solo'], sup.socketPath, { FAKE_CLAUDE_LOG: log });
    assert.equal(code, 0, stderr);
    assert.match(stderr, /solo is paused and yours\. claude may first ask whether to trust /);
    assert.deepEqual(JSON.parse(stdout), { members: [{ id: memberId, name: 'solo' }], skipped: [] });

    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.match(result.summary, new RegExp(
      `^echo: Resumed by ${ME}\\.\\nYour last turn was interrupted: .*\\n` +
      `${ME} drove this session in a terminal while you were paused; their turns are in your history\\.`));

    const starts = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(starts.length, 3);
    const [, human, back] = starts;
    assert.deepEqual(human.argv, ['--resume', sid]);
    assert.equal(human.cwd, workspace);
    assert.ok(back.argv.includes('-p'));
    assert.equal(back.argv[back.argv.indexOf('--resume') + 1], sid);
    assert.deepEqual(store.events(memberId).filter((e) => ['paused', 'taken_over', 'handed_back', 'resumed'].includes(e.kind))
      .map((e) => [e.kind, e.body]),
      [['paused', { by: ME, now: true }], ['taken_over', { by: ME }], ['handed_back', { by: ME }], ['resumed', { by: ME }]]);
  } finally { await sup.close(); }
});

test('while a human drives, the manager is told and pause refuses; any exit hands back', { timeout: 20_000 }, async () => {
  const { root, script } = project({
    lead: LIVE(), solo: { agent: 'claude', isolation: 'workspace', reports_to: 'lead' }
  }, {
    by_member: { lead: { steps: [
      { tool: 'delegate', args: { to: 'solo', task: 'HOLD it' }, save: 'r' },
      { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
    ] } }
  });
  const { sup, store } = await supervise(script, { env: { PATH } });
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.children(leadId)[0]?.resume);
    const soloId = store.children(leadId)[0].id;
    const call = async (method, params) => (method === 'takeover' ? sup.takeover(params) : sup.handback(params));
    const run = () => {
      assert.equal(store.member(soloId).state, 'taken_over');
      assert.throws(() => sup.pause({ member_id: soloId }), /^Error: "solo" is taken over by a human$/);
      return { status: 7 };   // the human's claude exited non-zero
    };
    await attach({ member_id: soloId }, { call, run, log: () => {} });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const seen = result.tool_results.flatMap((t) => t.result.messages ?? []).map((m) => m.text);
    assert.ok(seen.includes(`taken over by ${ME}`), JSON.stringify(seen));
    assert.equal(store.member(soloId).state, 'done');
  } finally { await sup.close(); }
});

test('only claude members can be taken over', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } } });
  const { sup, store } = await supervise(script);
  try {
    const { memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    await assert.rejects(sup.takeover({ member_id: memberId }), /^Error: "solo" runs mock-live; only claude members can be taken over$/);
    assert.equal(store.member(memberId).state, 'waiting');
    assert.throws(() => sup.handback({ member_id: memberId }), /^Error: "solo" is not taken over \(waiting\)$/);
  } finally { await sup.close(); }
});

test('a restart leaves a taken-over member to its human', async () => {
  const { root, script } = project({ solo: LIVE() }, { by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }] } } });
  const first = await supervise(script);
  const { store } = first;
  const { runId, memberId } = first.sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
  await until(() => store.member(memberId).state === 'waiting');
  await first.sup.close();
  store.setState(memberId, 'taken_over');
  const { sup } = await supervise(script, { store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(store.member(memberId).state, 'taken_over');
  } finally { await sup.close(); }
});

test('a member stranded by a dead attach is recovered by re-attach or the handback verb', { timeout: 20_000 }, async () => {
  const { root, script } = project({
    lead: LIVE(), solo: { agent: 'claude', isolation: 'workspace', reports_to: 'lead' }
  }, {
    by_member: { lead: { steps: [
      { tool: 'delegate', args: { to: 'solo', task: 'HOLD it' }, save: 'r' },
      { tool: 'wait_for', args: {}, until_finished: ['$r.report_id'] }
    ] } }
  });
  const { sup, store } = await supervise(script, { env: { PATH } });
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.children(leadId)[0]?.resume);
    const soloId = store.children(leadId)[0].id;
    const first = await sup.takeover({ member_id: soloId });   // the attach CLI then dies
    assert.equal(store.member(soloId).state, 'taken_over');
    const again = await sup.takeover({ member_id: soloId });
    assert.deepEqual(again, first);
    assert.equal(store.events(soloId).filter((e) => e.kind === 'taken_over').length, 1);

    // a failed handback call says how to recover, and fails
    const logs = [];
    await assert.rejects(attach({ member_id: soloId }, {
      call: async (m) => { if (m === 'handback') throw new Error('no supervisor'); return first; },
      run: () => ({ status: 0 }), log: (s) => logs.push(s)
    }), /no supervisor/);
    assert.match(logs.join(''), /still taken over.*agent-team handback/s);

    const { code, stdout, stderr } = await cli(['handback', String(runId), 'solo'], sup.socketPath);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { members: [{ id: soloId, name: 'solo' }], skipped: [] });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const seen = result.tool_results.flatMap((t) => t.result.messages ?? []).map((m) => m.text);
    assert.ok(seen.includes(`handed back by ${ME}`), JSON.stringify(seen));
  } finally { await sup.close(); }
});

test('handback after a claude that never started carries no "drove" note', async () => {
  const { root, script } = project({ solo: { agent: 'claude', isolation: 'workspace' } }, {});
  const log = join(mkdtempSync(join(tmpdir(), 'at-tol-')), 'c.jsonl');
  const { sup, store } = await supervise(script, { env: { PATH, FAKE_CLAUDE_LOG: log } });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'HOLD the work' });
    await until(() => store.member(memberId).resume);
    const call = async (method, params) => (method === 'takeover' ? sup.takeover(params) : sup.handback(params));
    await attach({ member_id: memberId }, { call, run: () => ({ error: new Error('spawn claude ENOENT') }), log: () => {} });
    const result = await sup.waitRun(runId);
    assert.doesNotMatch(result.summary, /drove this session/);
  } finally { await sup.close(); }
});

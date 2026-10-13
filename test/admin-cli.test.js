import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { project, supervise, LIVE } from './helpers/live.js';

const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;
const ME = userInfo().username;
const until = async (f, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// Async on purpose: the supervisor runs in this process and must keep answering while the
// CLI waits on it.
function cli(args, sock) {
  return promisify(execFile)(process.execPath, [BIN, ...args], {
    env: { ...process.env, AGENT_TEAM_SUPERVISOR_SOCK: sock }
  }).then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
          (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
}

test('a steering verb with no supervisor listening says to start serve', async () => {
  const sock = join(mkdtempSync(join(tmpdir(), 'at-a-')), 'none.sock');
  const { code, stderr } = await cli(['pause', '1', 'lead'], sock);
  assert.equal(code, 1);
  assert.match(stderr, /^agent-team: no agent-team supervisor is listening on .*none\.sock\. Start one with `agent-team serve`/);
});

test('pause and resume a member from the CLI', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'wait_for', args: {} }], on_resume: { steps: [] } } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const paused = await cli(['pause', String(runId), 'solo'], sup.socketPath);
    assert.equal(paused.code, 0, paused.stderr);
    assert.deepEqual(JSON.parse(paused.stdout), { members: [{ id: memberId, name: 'solo' }], skipped: [] });
    await until(() => store.member(memberId).state === 'paused');
    assert.deepEqual(store.events(memberId).find((e) => e.kind === 'paused').body, { by: ME, now: false });

    const resumed = await cli(['resume', String(runId), 'solo', '--note', 'carry on'], sup.socketPath);
    assert.equal(resumed.code, 0, resumed.stderr);
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.match(result.received.at(-1), new RegExp(`Resumed by ${ME}\\.\\n${ME}: carry on$`));
  } finally { await sup.close(); }
});

test('cancel --subtree from the CLI ends the run cancelled', async () => {
  const { root, script } = project({ lead: LIVE(), worker: LIVE({ reports_to: 'lead' }) }, {
    by_member: {
      lead: { steps: [{ tool: 'delegate', args: { to: 'worker', task: 'w' } }, { tool: 'wait_for', args: {} }] },
      worker: { steps: [{ sleep_ms: 30_000 }] }
    }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId: leadId } = sup.submit({ projectRoot: root, member: 'lead', task: 'go' });
    await until(() => store.children(leadId)[0]?.state === 'running' && store.member(leadId).state === 'waiting');
    const { code, stderr } = await cli(['cancel', String(runId), 'lead', '--subtree'], sup.socketPath);
    assert.equal(code, 0, stderr);
    assert.deepEqual(await sup.waitRun(runId), { status: 'failed', summary: `cancelled by ${ME}` });
    assert.equal(store.run(runId).status, 'cancelled');
    await until(() => store.children(leadId)[0].state === 'cancelled');   // the report may exit after its manager
  } finally { await sup.close(); }
});

test('questions lists open questions and answer closes one', async () => {
  const { root, script } = project({ solo: LIVE() }, {
    by_member: { solo: { steps: [{ tool: 'ask_human', args: { question: 'Ship it?', options: ['yes', 'no'] } }] } }
  });
  const { sup, store } = await supervise(script);
  try {
    const { runId, memberId } = sup.submit({ projectRoot: root, member: 'solo', task: 'go' });
    await until(() => store.member(memberId).state === 'waiting');
    const [q] = sup.questions();
    const listed = await cli(['questions'], sup.socketPath);
    assert.equal(listed.stdout, `#${q.id}  run ${runId}  solo: Ship it? [yes | no]\n`);
    assert.equal(JSON.parse((await cli(['questions', String(runId), '--json'], sup.socketPath)).stdout)[0].id, q.id);
    const answered = await cli(['answer', String(q.id), 'yes,', 'ship'], sup.socketPath);
    assert.deepEqual(JSON.parse(answered.stdout), { ok: true });
    const result = await sup.waitRun(runId);
    assert.deepEqual(result.tool_results[0].result, { answer: 'yes, ship', answered_by: ME, timed_out: false });
    assert.equal((await cli(['questions'], sup.socketPath)).stdout, 'no open questions\n');
  } finally { await sup.close(); }
});

test('bad steering arguments fail before reaching the supervisor', async () => {
  const sock = join(mkdtempSync(join(tmpdir(), 'at-a-')), 'none.sock');
  assert.match((await cli(['pause', '1'], sock)).stderr, /^agent-team: name a member: <run-id> <member>/);
  assert.match((await cli(['resume', '1', 'lead', '--max-cost-usd', 'lots'], sock)).stderr,
    /^agent-team: --max-cost-usd must be a positive number of dollars, got "lots"/);
  assert.match((await cli(['answer', '7'], sock)).stderr, /^agent-team: usage: agent-team answer <question-id> <answer>/);
  assert.match((await cli(['answer', '0', 'yes'], sock)).stderr, /^agent-team: usage: agent-team answer <question-id> <answer>/);
  assert.match((await cli(['questions', 'abc'], sock)).stderr, /^agent-team: usage: agent-team questions \[<run>\]/);
});

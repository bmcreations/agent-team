// Opt-in: runs the real `claude` on Haiku and costs about $0.30. `npm run test:live`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER = new URL('../../adapters/claude', import.meta.url).pathname;
const skip = process.env.AGENT_TEAM_LIVE_SMOKE !== '1' && 'set AGENT_TEAM_LIVE_SMOKE=1 to run';

test('real claude: a session is steered between turns, interrupted, and resumed', { skip, timeout: 180_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at-live-claude-'));
  const brief = { task: 'Reply with the single word PONG.', cwd, read_only: true, model: 'haiku' };
  // A failed assertion leaves an adapter (and its claude) running, and the runner would wait on
  // it forever; the finally below kills every one started.
  const children = [];
  const run = (start) => {
    const child = spawn(ADAPTER, ['session'], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(child);
    const lines = [];
    const waiting = [];
    createInterface({ input: child.stdout }).on('line', (l) => { lines.push(JSON.parse(l)); for (const w of waiting.splice(0)) w(); });
    let seen = 0;
    const next = async (type) => {
      for (;;) {
        const i = lines.findIndex((m, k) => k >= seen && m.type === type);
        if (i >= 0) { seen = i + 1; return lines[i]; }
        await new Promise((r) => waiting.push(r));
      }
    };
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send(start);
    return { send, next, exit: new Promise((r) => child.on('close', r)) };
  };

  try {
    const a = run({ type: 'start', brief, resume: null, note: null });
    const { resume } = await a.next('session');
    const first = await a.next('idle');
    assert.ok(first.cost_usd > 0);
    a.send({ type: 'message', id: 1, from: 'ana (human)', text: 'Now reply with the single word PING.' });
    assert.deepEqual(await a.next('ack'), { type: 'ack', message_id: 1 });
    const second = await a.next('idle');
    a.send({ type: 'message', id: 2, from: 'ana (human)', text: 'Count slowly from 1 to 200, one number per line.' });
    await a.next('ack');
    a.send({ type: 'interrupt' });
    const third = await a.next('idle');
    assert.equal(third.interrupted, true);
    const spentBefore = [first, second, third].reduce((sum, idle) => sum + (idle.cost_usd ?? 0), 0);
    assert.equal(await a.exit, 0);

    // The supervisor passes the member's recorded spend, so the resumed turn's cost is taken
    // from it rather than from zero.
    const b = run({ type: 'start', brief, resume, note: 'What word did you reply with first? Answer with that word only.',
                   cost_usd: spentBefore });
    // Claude Code 2.1.296: `-p --resume <id>` keeps the session id.
    assert.equal((await b.next('session')).resume, resume);
    // The resumed turn's cost is that turn alone, not the earlier session's total again.
    const resumed = await b.next('idle');
    assert.ok(resumed.cost_usd > 0);
    assert.ok(resumed.cost_usd < spentBefore, `resumed turn cost ${resumed.cost_usd} >= earlier session ${spentBefore}`);
    b.send({ type: 'stop' });
    const result = await b.next('result');
    assert.equal(result.status, 'ok');
    assert.match(result.summary, /PONG/);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});

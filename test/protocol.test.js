import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, parseAdapterLine } from '../src/protocol.js';
import { MemberSession } from '../src/sessions.js';

const fixture = new URL('./fixtures/session-echo', import.meta.url).pathname;

test('parseAdapterLine accepts each well-formed message type', () => {
  for (const m of [
    { type: 'session', harness_id: 'x', resume: null },
    { type: 'event', kind: 'text', text: 'hi' },
    { type: 'ack', message_id: 3 },
    { type: 'idle' },
    { type: 'result', status: 'ok', summary: 'done' }
  ]) assert.deepEqual(parseAdapterLine(JSON.stringify(m)), m);
});

test('parseAdapterLine drops malformed or unknown lines', () => {
  for (const line of [
    'not json', '[]', 'null', '{"type":"start"}', '{"type":"ack","message_id":"3"}',
    '{"type":"result","status":"maybe","summary":"x"}', '{"type":"session"}'
  ]) assert.equal(parseAdapterLine(line), null, line);
});

test('encode writes one line', () => {
  assert.equal(encode({ type: 'stop' }), '{"type":"stop"}\n');
});

test('MemberSession frames lines both ways and reports the exit', async () => {
  const seen = [];
  const exited = new Promise((resolve) => {
    const s = new MemberSession({
      execPath: fixture, cwd: process.cwd(), env: {},
      onLine: (m) => {
        seen.push(m);
        if (m.type === 'event') s.send({ type: 'message', id: 7, from: 'x (human)', text: 'hi' });
        if (m.type === 'ack') s.send({ type: 'stop' });
      },
      onExit: (code, stderr) => resolve({ code, stderr })
    });
    s.send({ type: 'start', brief: { member: 'lead' } });
  });
  const { code, stderr } = await exited;
  assert.equal(code, 0);
  assert.match(stderr, /bye/);
  assert.deepEqual(seen.map((m) => m.type), ['session', 'event', 'ack', 'result']);
});

test('session.resume and the idle fields are shape-checked', () => {
  const ok = (m) => assert.ok(parseAdapterLine(JSON.stringify(m)), JSON.stringify(m));
  const bad = (m) => assert.equal(parseAdapterLine(JSON.stringify(m)), null, JSON.stringify(m));
  ok({ type: 'session', harness_id: 'h', resume: 'sid' });
  ok({ type: 'session', harness_id: 'h' });
  bad({ type: 'session', harness_id: 'h', resume: 42 });
  ok({ type: 'idle', interrupted: true, cost_usd: 0.01 });
  bad({ type: 'idle', interrupted: 'yes' });
  bad({ type: 'idle', cost_usd: -1 });
  bad({ type: 'idle', cost_usd: 'NaN' });
});

test('idle.tokens must be a non-negative integer', () => {
  const ok = (m) => assert.ok(parseAdapterLine(JSON.stringify(m)), JSON.stringify(m));
  const bad = (m) => assert.equal(parseAdapterLine(JSON.stringify(m)), null, JSON.stringify(m));
  ok({ type: 'idle', tokens: 5 });
  ok({ type: 'idle', tokens: 0 });
  ok({ type: 'idle', tokens: null });
  bad({ type: 'idle', tokens: -1 });
  bad({ type: 'idle', tokens: 1.5 });
  bad({ type: 'idle', tokens: '5' });
});

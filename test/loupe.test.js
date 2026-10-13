import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { loupeConfig, mentionedTargets } from '../src/loupe.js';
import { get } from './helpers/http.js';

const TOKEN = 'loupe-secret-7f3a';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const TARGETS = [{ id: 'sim:ABCD-1234', kind: 'simulator', label: 'iPhone 17', active: true },
                 { id: 'emulator-5554', kind: 'android', label: 'Pixel', active: false }];

// A stand-in for loupe over plain http: it answers only with the right bearer token.
async function fakeLoupe() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('no'); }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/targets') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(TARGETS)); }
    if (url.pathname === '/api/screenshot' && url.searchParams.get('target') === 'sim:ABCD-1234') {
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG);
    }
    res.writeHead(404); res.end(`no target ${url.searchParams.get('target')}`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

async function setup(env) {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't' });
  const m = store.addMember({ runId, parentId: null, name: 'qa', task: 't', depth: 0 });
  store.addEvent(m.id, 'tool_call', { name: 'Bash', args: { command: 'curl "https://localhost:18456/api/screenshot?target=sim:ABCD-1234"' } });
  const web = await startHttp({ store, port: 0, env });
  return { store, web, m, close: async () => { await web.close(); store.close(); } };
}

test('loupe is off unless configured, and must be on this machine', () => {
  assert.equal(loupeConfig({}), null);
  assert.throws(() => loupeConfig({ AGENT_TEAM_LOUPE_URL: 'https://loupe.example.com' }), /must be on this machine/);
  assert.throws(() => loupeConfig({ AGENT_TEAM_LOUPE_URL: 'file:///tmp/x' }), /http or https/);
  const dir = mkdtempSync(join(tmpdir(), 'at-lt-'));
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`);
  const cfg = loupeConfig({ AGENT_TEAM_LOUPE_URL: 'https://localhost:18456' }, { tokenFile: join(dir, 'token') });
  assert.equal(cfg.token(), TOKEN);
  assert.equal(loupeConfig({ AGENT_TEAM_LOUPE_URL: 'https://localhost:18456', LOUPE_TOKEN: 'env' }).token(), 'env');
});

test('targets a member named are found in its events', () => {
  assert.deepEqual(mentionedTargets(['open sim:ABCD-1234 then', 'nothing'], TARGETS).map((t) => t.id), ['sim:ABCD-1234']);
});

test('screenshots, the target list and the open link go through serve with the token', async () => {
  const loupe = await fakeLoupe();
  const s = await setup({ AGENT_TEAM_LOUPE_URL: loupe.url, LOUPE_TOKEN: TOKEN });
  try {
    const list = await get(s.web.url, '/api/loupe');
    assert.deepEqual(list.json, { enabled: true, targets: TARGETS });
    const mine = await get(s.web.url, `/api/members/${s.m.id}/devices`);
    assert.deepEqual(mine.json.targets.map((t) => t.id), ['sim:ABCD-1234']);
    const shot = await get(s.web.url, '/api/loupe/screenshot?target=sim:ABCD-1234');
    assert.equal(shot.status, 200);
    assert.equal(shot.headers['content-type'], 'image/png');
    assert.deepEqual(shot.buf, PNG);
    const open = await get(s.web.url, '/loupe/open?target=sim:ABCD-1234');
    assert.equal(open.status, 302);
    const to = new URL(open.headers.location);
    assert.equal(to.origin, loupe.url);
    assert.deepEqual([to.searchParams.get('target'), to.searchParams.get('token')], ['sim:ABCD-1234', TOKEN]);
    assert.equal(open.headers['referrer-policy'], 'no-referrer');
    // The token is in that Location header and nowhere else.
    for (const r of [list, mine, shot]) assert.ok(!r.buf.includes(TOKEN) && !JSON.stringify(r.headers).includes(TOKEN));
  } finally { await s.close(); loupe.close(); }
});

test('loupe errors, bad targets and cross-site opens never echo the token', async () => {
  const loupe = await fakeLoupe();
  const s = await setup({ AGENT_TEAM_LOUPE_URL: loupe.url, LOUPE_TOKEN: TOKEN });
  try {
    const missing = await get(s.web.url, '/api/loupe/screenshot?target=sim:NOPE');
    assert.equal(missing.status, 502);
    assert.match(missing.json.error, /loupe answered 404/);
    assert.ok(!missing.text.includes(TOKEN));
    assert.equal((await get(s.web.url, '/api/loupe/screenshot?target=a%20b')).status, 400);
    assert.equal((await get(s.web.url, '/loupe/open?target=sim:ABCD-1234', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.ok(loupe.seen.every((u) => !u.includes(TOKEN)), 'the token travels in a header, not the URL');
  } finally { await s.close(); loupe.close(); }
});

test('with loupe unset the device routes say how to turn it on', async () => {
  const s = await setup({});
  try {
    assert.deepEqual((await get(s.web.url, '/api/loupe')).json, { enabled: false, targets: [] });
    const shot = await get(s.web.url, '/api/loupe/screenshot?target=sim:ABCD-1234');
    assert.equal(shot.status, 404);
    assert.match(shot.json.error, /AGENT_TEAM_LOUPE_URL/);
  } finally { await s.close(); }
});

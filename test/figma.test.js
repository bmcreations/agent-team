import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { figmaRefs, figmaImage } from '../src/figma.js';
import { get } from './helpers/http.js';

const TOKEN = 'figd_secret_91';
const HOST = 'www.figma.com';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);

test('refs come from Figma links and from bare node ids with a default file', () => {
  const texts = [`see https://${HOST}/design/AbCdEf123456/App?node-id=12-34&t=x`, 'then node 56:78', 'and node 56:78 again'];
  assert.deepEqual(figmaRefs([`https://${HOST}/design/AbCdEf123456/App?node-id=1-3345`]), [{ file_key: 'AbCdEf123456', node_id: '1:3345' }]);
  assert.deepEqual(figmaRefs(texts, 'Default12345'), [
    { file_key: 'Default12345', node_id: '56:78' },
    { file_key: 'AbCdEf123456', node_id: '12:34' }
  ]);
  assert.deepEqual(figmaRefs(['node 56:78']), []);   // no file to look it up in
});

// fetch stand-in: the images endpoint, then the rendered image's own URL.
function fakeFetch(calls, { imageUrl = 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/render.png' } = {}) {
  return async (url, opts = {}) => {
    calls.push({ url: String(url), token: opts.headers?.['X-Figma-Token'] ?? null });
    const u = new URL(url);
    if (u.hostname === 'api.figma.com') {
      if (opts.headers?.['X-Figma-Token'] !== TOKEN) return new Response('{"err":"bad token"}', { status: 403 });
      const id = u.searchParams.get('ids');
      return Response.json({ err: null, images: { [id]: id === '12:34' ? imageUrl : null } });
    }
    return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
  };
}

async function setup(env, fetchOpts) {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't' });
  const m = store.addMember({ runId, parentId: null, name: 'designer', task: 't', depth: 0 });
  store.addEvent(m.id, 'text', { text: `matching https://${HOST}/design/AbCdEf123456/App?node-id=12-34` });
  const calls = [];
  const web = await startHttp({ store, port: 0, env, fetchImpl: fakeFetch(calls, fetchOpts) });
  return { store, web, m, calls, close: async () => { await web.close(); store.close(); } };
}

test('a member\'s Figma node renders through serve, with the token sent only to Figma', async () => {
  const s = await setup({ FIGMA_TOKEN: TOKEN });
  try {
    const refs = await get(s.web.url, `/api/members/${s.m.id}/designs`);
    assert.deepEqual(refs.json, { enabled: true, refs: [{ file_key: 'AbCdEf123456', node_id: '12:34' }] });
    const img = await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=12:34');
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal(img.headers['cross-origin-resource-policy'], 'same-origin');
    assert.deepEqual(img.buf, PNG);
    await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=12:34');
    assert.equal(s.calls.length, 2, 'the second request is served from the cache');
    assert.equal(s.calls[1].token, null, 'the rendered image URL never gets the token');
    const none = await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=99:1');
    assert.equal(none.status, 502);
    assert.ok(!none.text.includes(TOKEN) && !img.buf.includes(TOKEN) && !refs.text.includes(TOKEN));
    assert.equal((await get(s.web.url, '/api/figma/image?file=../x&node=1:2')).status, 400);
    assert.equal((await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=1:2:3')).status, 400);
  } finally { await s.close(); }
});

test('a rendered-image URL that is not https is refused without being fetched', async () => {
  const s = await setup({ FIGMA_TOKEN: TOKEN }, { imageUrl: 'http://127.0.0.1:9/internal' });
  try {
    const r = await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=12:34');
    assert.equal(r.status, 502);
    assert.equal(s.calls.length, 1);
    assert.ok(!r.text.includes(TOKEN));
  } finally { await s.close(); }
});

test('with no FIGMA_TOKEN the routes say how to turn previews on', async () => {
  const s = await setup({});
  try {
    assert.equal((await get(s.web.url, `/api/members/${s.m.id}/designs`)).json.enabled, false);
    const img = await get(s.web.url, '/api/figma/image?file=AbCdEf123456&node=12:34');
    assert.equal(img.status, 404);
    assert.match(img.json.error, /FIGMA_TOKEN/);
    assert.equal(s.calls.length, 0);
  } finally { await s.close(); }
});

const API = (u) => new URL(u).hostname === 'api.figma.com';
const apiReply = (id, src) => Response.json({ images: { [id]: src } });

test('an image host outside Figma\'s is refused without being fetched', async () => {
  const calls = [];
  const fetchImpl = async (u) => { calls.push(String(u)); return API(u) ? apiReply('1:2', 'https://evil.example/x.png') : new Response(PNG); };
  await assert.rejects(figmaImage({ token: TOKEN, fileKey: 'AbCdEf123456', nodeId: '1:2', fetchImpl }), /unexpected host/);
  assert.equal(calls.length, 1);
});

test('a body past the cap stops being read, even with no content-length', async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(4 * 1024 * 1024)); } });
  const fetchImpl = async (u) => API(u)
    ? apiReply('1:2', 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/a.png')
    : new Response(body);
  await assert.rejects(figmaImage({ token: TOKEN, fileKey: 'AbCdEf123456', nodeId: '1:2', fetchImpl }), /over 10 MiB/);
  assert.ok(pulled <= 5, `stopped early (pulled ${pulled})`);
});

test('the cache is bounded by bytes and evicts the oldest first', async () => {
  const cache = new Map();
  const fetchImpl = async (u) => {
    if (API(u)) return apiReply(new URL(u).searchParams.get('ids'), 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/a.png');
    return new Response(new Uint8Array(400));
  };
  for (const n of ['1:1', '1:2', '1:3']) {
    await figmaImage({ token: TOKEN, fileKey: 'AbCdEf123456', nodeId: n, fetchImpl, cache, maxCacheBytes: 1000 });
  }
  assert.deepEqual([...cache.keys()], ['AbCdEf123456/1:2', 'AbCdEf123456/1:3']);
});

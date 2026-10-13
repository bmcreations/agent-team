// Previews of Figma nodes a member mentions, rendered by Figma's REST images endpoint.
// Opt-in: FIGMA_TOKEN. The token goes to api.figma.com in a header and nowhere else; the
// rendered image is fetched without it and served from this process, so the page's CSP can
// stay img-src 'self'.
export const FILE_KEY_RE = /^[A-Za-z0-9]{10,64}$/;
export const NODE_RE = /^\d+:\d+$/;
const LINK = /figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]{10,64})\/[^\s?#]*\?[^\s#]*?node-id=(\d+)(?:-|:|%3A)(\d+)/gi;
const BARE = /\bnode[ -](?:id[ :]+)?(\d+):(\d+)\b/gi;
const TTL_MS = 10 * 60_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 200;
// Where the images endpoint's render URLs live: Figma's own hosts and the S3 bucket it renders to.
const IMAGE_HOSTS = ['figma-alpha-api.s3.us-west-2.amazonaws.com'];
const imageHostOk = (host) => host === 'figma.com' || host.endsWith('.figma.com') || IMAGE_HOSTS.includes(host);

async function readCapped(body, cap) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel().catch(() => {}); throw new Error('the rendered image is over 10 MiB'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function figmaRefs(texts, defaultFileKey = null) {
  const out = [];
  const seen = new Set();
  const add = (file_key, node_id) => {
    const k = `${file_key}/${node_id}`;
    if (!seen.has(k) && out.length < 12) { seen.add(k); out.push({ file_key, node_id }); }
  };
  for (const text of [...texts].reverse()) {
    for (const [, key, a, b] of text.matchAll(LINK)) add(key, `${a}:${b}`);
    if (defaultFileKey) for (const [, a, b] of text.matchAll(BARE)) add(defaultFileKey, `${a}:${b}`);
  }
  return out;
}

export async function figmaImage({ token, fileKey, nodeId, fetchImpl = fetch, cache = new Map(), maxCacheBytes = MAX_CACHE_BYTES }) {
  if (!FILE_KEY_RE.test(fileKey) || !NODE_RE.test(nodeId)) throw new Error('not a Figma file key and node id');
  const k = `${fileKey}/${nodeId}`;
  const hit = cache.get(k);
  if (hit && hit.until > Date.now()) return hit.png;
  const api = new URL(`https://api.figma.com/v1/images/${fileKey}`);
  api.searchParams.set('ids', nodeId);
  api.searchParams.set('format', 'png');
  api.searchParams.set('scale', '1');
  const r = await fetchImpl(api, { headers: { 'X-Figma-Token': token }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Figma answered ${r.status}`);
  const src = (await r.json()).images?.[nodeId];
  if (!src) throw new Error(`Figma has no image for node ${nodeId} in file ${fileKey}`);
  let srcUrl;
  try { srcUrl = new URL(src); } catch { throw new Error('Figma sent an image address that is not a URL'); }
  if (srcUrl.protocol !== 'https:') throw new Error('Figma sent an image address that is not https');
  if (!imageHostOk(srcUrl.hostname)) throw new Error('Figma sent an image address on an unexpected host');
  const img = await fetchImpl(srcUrl, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!img.ok) throw new Error(`the rendered image answered ${img.status}`);
  if (Number(img.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('the rendered image is over 10 MiB');
  const png = await readCapped(img.body, MAX_IMAGE_BYTES);
  cache.delete(k);
  cache.set(k, { png, until: Date.now() + TTL_MS });
  let bytes = 0;
  for (const e of cache.values()) bytes += e.png.length;
  for (const key of cache.keys()) {
    if (cache.size <= MAX_CACHE_ENTRIES && bytes <= maxCacheBytes) break;
    bytes -= cache.get(key).png.length;
    cache.delete(key);
  }
  return png;
}

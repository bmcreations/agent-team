import { request } from 'node:http';
import { supervise } from './live.js';
import { startHttp } from '../../src/http.js';

export const until = async (f, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// node:http rather than fetch: fetch will not let a test set Host, Origin or Sec-Fetch-Site.
export function call(base, method, path, { body, headers = {} } = {}) {
  const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), {
      method,
      headers: {
        ...(data != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, buf, json });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}
export const get = (base, path, headers) => call(base, 'GET', path, { headers });
export const post = (base, path, body, headers) => call(base, 'POST', path, { body, headers });

// A supervisor on mock-live adapters with the web view in front of it, on a free port.
export async function view(script, opts = {}) {
  const s = await supervise(script, opts);
  const web = await startHttp({ store: s.store, sup: s.sup, port: 0, ...(opts.http ?? {}) });
  return {
    ...s, web, base: web.url,
    close: async () => { await web.close(); await s.sup.close(); }
  };
}

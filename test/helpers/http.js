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

// Reads a text/event-stream response into frames: { event, id, data } with data parsed as
// JSON. Comment lines (": ping") are only counted.
export function stream(base, path, headers = {}) {
  const frames = [];
  let comments = 0;
  let ended = false;
  let response = null;
  const req = request(new URL(path, base), { headers: { Accept: 'text/event-stream', ...headers } });
  const ready = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      response = res;
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const frame = { event: 'message', id: null, data: null };
          const data = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) { comments++; continue; }
            const at = line.indexOf(':');
            const key = line.slice(0, at);
            const value = line.slice(at + 1).replace(/^ /, '');
            if (key === 'event') frame.event = value;
            else if (key === 'id') frame.id = value;
            else if (key === 'data') data.push(value);
          }
          if (data.length) {
            frame.data = JSON.parse(data.join('\n'));
            frames.push(frame);
          }
        }
      });
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
      resolve(res);
    });
    req.on('error', (err) => { ended = true; reject(err); });
  });
  req.end();
  return {
    frames, ready,
    comments: () => comments,
    ended: () => ended,
    async waitFor(pred, ms = 15_000) {
      await until(() => frames.some(pred), ms);
      return frames.find(pred);
    },
    pause: () => response.pause(),
    close: () => req.destroy()
  };
}

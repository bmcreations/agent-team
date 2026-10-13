import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { whoAmI } from './admin.js';
import { publicRun, publicMessage, clipEvent, runDetail, needsYou, streamState, READ_ONLY_NOTE } from './view.js';

// The web view: a JSON API over the store, server-sent events, and a static page. It binds to
// 127.0.0.1 and has no sign-in yet: anyone who can open a connection to the port on this
// machine can read every run and steer the ones serve owns. The auth plan adds sign-in.
export const DEFAULT_PORT = 4747;
const MAX = Number.MAX_SAFE_INTEGER;

const WEB_DIR = new URL('./web/', import.meta.url);
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/feed.js', ['feed.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendBody(res, status, type, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, status, value) => sendBody(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

export function positiveInt(v, what = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${what} must be a positive integer`);
  return n;
}

export function intParam(url, name, def, max) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`);
  return Math.min(n, max);
}

// A tail (the newest `limit`) unless the caller pages after or before a cursor. The cursor is
// what an SSE stream continues from.
function timelineView(store, scope, url) {
  const limit = intParam(url, 'limit', 200, 1000);
  const has = (n) => url.searchParams.has(n);
  let rows;
  let cursor;
  if (has('after_event') || has('after_message')) {
    const afterEvent = intParam(url, 'after_event', 0, MAX);
    const afterMessage = intParam(url, 'after_message', 0, MAX);
    rows = store.timeline({ ...scope, afterEvent, afterMessage, limit });
    cursor = { event: rows.events.at(-1)?.id ?? afterEvent, message: rows.messages.at(-1)?.id ?? afterMessage };
  } else {
    const top = store.maxIds();
    rows = store.timeline({
      ...scope, limit,
      beforeEvent: intParam(url, 'before_event', top.event + 1, MAX),
      beforeMessage: intParam(url, 'before_message', top.message + 1, MAX)
    });
    cursor = top;
  }
  return { events: rows.events.map((e) => clipEvent(e)), messages: rows.messages.map(publicMessage), cursor };
}

const BATCH = 500;

// Every open stream shares one timer. store.version() is one cheap pragma read; nothing else
// runs while it is unchanged, except for a client that still has a backlog to send.
class Hub {
  #clients = new Set();
  #timer = null;
  #version = null;

  constructor({ store, own, pollMs, heartbeatMs, stallMs }) {
    Object.assign(this, { store, own, pollMs, heartbeatMs, stallMs });
  }

  get size() { return this.#clients.size; }

  add(req, res, { runId, cursor }) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const c = { res, runId, cursor, state: null, more: false, blockedAt: null };
    // A full socket buffer pauses this client; it resumes from its cursor once drained.
    res.on('drain', () => { c.blockedAt = null; c.more = true; });
    c.heartbeat = setInterval(() => { if (c.blockedAt == null) c.res.write(': ping\n\n'); }, this.heartbeatMs);
    c.heartbeat.unref();
    this.#clients.add(c);
    req.on('close', () => this.#drop(c));
    res.on('error', () => this.#drop(c));
    try { this.#push(c); } catch (err) { c.res.destroy(); this.#drop(c); throw err; }
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#poll(), this.pollMs);
      this.#timer.unref();
    }
  }

  close() {
    for (const c of [...this.#clients]) { c.res.end(); this.#drop(c); }
  }

  #drop(c) {
    if (!this.#clients.delete(c)) return;
    clearInterval(c.heartbeat);
    if (this.#clients.size === 0) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #poll() {
    let changed = false;
    try {
      const v = this.store.version();
      changed = v !== this.#version;
      this.#version = v;
    } catch { return; }   // the store is closing
    for (const c of [...this.#clients]) {
      if (!(changed || c.more || c.blockedAt != null)) continue;
      try { this.#push(c); } catch { c.res.destroy(); this.#drop(c); }   // one bad client must not stop the rest
    }
  }

  #push(c) {
    if (c.blockedAt != null) {
      // A reader that has not drained for stallMs (a sleeping laptop, a stuck proxy) is cut;
      // EventSource reconnects with Last-Event-ID when it wakes.
      if (Date.now() - c.blockedAt >= this.stallMs) { c.res.destroy(); this.#drop(c); }
      return;
    }
    c.more = false;
    const state = JSON.stringify(streamState(this.store, c.runId, this.own));
    if (state !== c.state) {
      c.state = state;
      this.#send(c, `event: state\ndata: ${state}\n\n`);
    }
    if (c.blockedAt != null) return;
    const scope = c.runId != null ? { runId: c.runId } : {};
    const rows = this.store.timeline({ ...scope, afterEvent: c.cursor.event, afterMessage: c.cursor.message, limit: BATCH });
    if (!rows.events.length && !rows.messages.length) return;
    c.cursor = { event: rows.events.at(-1)?.id ?? c.cursor.event, message: rows.messages.at(-1)?.id ?? c.cursor.message };
    c.more = rows.events.length === BATCH || rows.messages.length === BATCH;
    const data = JSON.stringify({ events: rows.events.map((e) => clipEvent(e)), messages: rows.messages.map(publicMessage), cursor: c.cursor });
    this.#send(c, `id: ${c.cursor.event}.${c.cursor.message}\nevent: timeline\ndata: ${data}\n\n`);
  }

  #send(c, frame) {
    if (!c.res.write(frame)) c.blockedAt = Date.now();
  }
}

// "<event>.<message>", as the stream's ids are written.
function lastEventId(raw) {
  const m = /^(\d+)\.(\d+)$/.exec(raw ?? '');
  const cursor = m && { event: Number(m[1]), message: Number(m[2]) };
  return cursor && Number.isSafeInteger(cursor.event) && Number.isSafeInteger(cursor.message) ? cursor : null;
}

const MAX_BODY = 64 * 1024;

// Not auth: a check that the request came from this page and not from another site open in
// the same browser. application/json makes a cross-origin browser send a CORS preflight,
// which this server answers without CORS headers; Origin and Sec-Fetch-Site catch the rest.
function checkSameSite(req, bound) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'send Content-Type: application/json');
  const origin = req.headers.origin;
  if (origin != null && origin !== `http://127.0.0.1:${bound}` && origin !== `http://localhost:${bound}`) {
    throw new HttpError(403, 'requests from another site cannot steer');
  }
  const site = req.headers['sec-fetch-site'];
  if (site != null && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'requests from another site cannot steer');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'request body is over 64 KiB'));
      let value;
      try { value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch {
        return reject(new HttpError(400, 'request body is not JSON'));
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return reject(new HttpError(400, 'request body must be a JSON object'));
      }
      resolve(value);
    });
    req.on('error', reject);
  });
}

const text = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} must be non-empty text`);
  return v;
};
const flag = (v) => v === true;

export function startHttp({ store, sup = null, host = '127.0.0.1', port = DEFAULT_PORT, env = process.env,
                            by = null, pollMs = 250, heartbeatMs = 15_000, stallMs = 60_000, fetchImpl = fetch } = {}) {
  const own = sup?.socketPath ?? null;
  let bound = null;
  const hub = new Hub({ store, own, pollMs, heartbeatMs, stallMs });
  const found = (v, what) => { if (v == null) throw new HttpError(404, `unknown ${what}`); return v; };
  const member = (id) => found(store.member(id), `member ${id}`);
  const who = by ?? whoAmI();
  // The admin RPCs' operations, with their errors mapped to statuses. Supervisor messages
  // name members and runs, never tokens, so they are safe to return.
  const steer = (f) => {
    if (!sup) throw new HttpError(503, 'steering needs `agent-team serve`');
    try { return f(); } catch (err) {
      if (err instanceof HttpError) throw err;
      if (/run by another supervisor/.test(err.message)) throw new HttpError(409, `read-only: ${READ_ONLY_NOTE}`);
      if (/^(unknown |run \d+ has no member)/.test(err.message)) throw new HttpError(404, err.message);
      throw new HttpError(409, err.message);
    }
  };
  const cap = (v) => {
    if (v == null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new HttpError(400, 'max_cost_usd must be a positive number');
    return v;
  };

  // [method, path pattern, handler]. A handler returns a value to send as JSON, or undefined
  // when it wrote the response itself.
  const routes = [
    ['GET', /^\/api\/runs$/, ({ url }) => ({
      runs: store.listRuns({ project: url.searchParams.get('project') || null, limit: intParam(url, 'limit', 50, 500) })
        .map((r) => publicRun(store, r, own))
    })],
    ['GET', /^\/api\/runs\/(\d+)$/, ({ params }) => found(runDetail(store, params[0], own), `run ${params[0]}`)],
    ['GET', /^\/api\/runs\/(\d+)\/timeline$/, ({ params, url }) => {
      found(store.run(params[0]), `run ${params[0]}`);
      return timelineView(store, { runId: params[0] }, url);
    }],
    ['GET', /^\/api\/members\/(\d+)\/timeline$/, ({ params, url }) => {
      member(params[0]);
      return timelineView(store, { memberId: params[0] }, url);
    }],
    ['GET', /^\/api\/timeline$/, ({ url }) => timelineView(store, {}, url)],
    ['GET', /^\/api\/events\/(\d+)$/, ({ params }) => found(store.event(params[0]), `event ${params[0]}`)],
    ['GET', /^\/api\/needs-you$/, () => needsYou(store)],
    ['GET', /^\/api\/stream$/, ({ req, res, url }) => {
      const raw = url.searchParams.get('run');
      const runId = raw == null || raw === '' ? null : positiveInt(raw, 'run');
      if (runId != null) found(store.run(runId), `run ${runId}`);
      const top = store.maxIds();
      const cursor = lastEventId(req.headers['last-event-id']) ?? {
        event: intParam(url, 'after_event', top.event, MAX),
        message: intParam(url, 'after_message', top.message, MAX)
      };
      hub.add(req, res, { runId, cursor });
    }],
    ['POST', /^\/api\/members\/(\d+)\/message$/, ({ params, body }) =>
      steer(() => sup.send({ member_id: params[0], text: text(body.text, 'text'), from: who }))],
    ['POST', /^\/api\/members\/(\d+)\/pause$/, ({ params, body }) =>
      steer(() => sup.pause({ member_id: params[0], now: flag(body.now), subtree: flag(body.subtree), by: who }))],
    ['POST', /^\/api\/members\/(\d+)\/cancel$/, ({ params, body }) =>
      steer(() => sup.cancel({ member_id: params[0], subtree: flag(body.subtree), by: who }))],
    ['POST', /^\/api\/members\/(\d+)\/resume$/, ({ params, body }) => {
      const note = body.note == null || body.note === '' ? null : text(body.note, 'note');
      const maxCost = cap(body.max_cost_usd);
      return steer(() => sup.resume({ member_id: params[0], subtree: flag(body.subtree), note, max_cost_usd: maxCost, by: who }));
    }],
    ['POST', /^\/api\/questions\/(\d+)\/answer$/, ({ params, body }) =>
      steer(() => sup.answer({ question_id: params[0], answer: text(body.answer, 'answer'), by: who }))]
  ];

  function serveStatic(res, path) {
    const [file, type] = STATIC.get(path);
    let body;
    try { body = readFileSync(new URL(file, WEB_DIR)); } catch { throw new HttpError(404, 'not found'); }
    sendBody(res, 200, type, body);
  }

  const server = createServer(async (req, res) => {
    try {
      // Only names this server is reached by. A site that points its own name at 127.0.0.1
      // (DNS rebinding) sends that name as Host and is refused here.
      const h = req.headers.host;
      if (h !== `127.0.0.1:${bound}` && h !== `localhost:${bound}`) {
        throw new HttpError(403, `open the view at http://127.0.0.1:${bound}/`);
      }
      const url = new URL(req.url, `http://${h}`);
      if (req.method === 'GET' && STATIC.has(url.pathname)) return serveStatic(res, url.pathname);
      const hits = routes.map(([method, re, handler]) => [method, re.exec(url.pathname), handler]).filter(([, m]) => m);
      if (!hits.length) throw new HttpError(404, 'not found');
      const hit = hits.find(([method]) => method === req.method);
      if (!hit) throw new HttpError(405, 'method not allowed');
      const [, match, handler] = hit;
      const params = match.slice(1).map((s) => positiveInt(s));
      let body = null;
      if (req.method === 'POST') {
        checkSameSite(req, bound);
        body = await readJson(req);
      }
      const out = await handler({ req, res, url, params, body });
      if (out !== undefined) json(res, 200, out);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const status = err instanceof HttpError ? err.status : 500;
      // Never req.url: a loupe link carries a target, and later tasks proxy with secrets.
      if (status === 500) process.stderr.write(`agent-team: web request failed: ${err.stack ?? err}\n`);
      json(res, status, { error: status === 500 ? 'internal error' : err.message });
    }
  });

  function close() {
    hub.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        err.message = `port ${port} on ${host} is already in use; pass --port <n>, or --port 0 for any free port`;
      }
      reject(err);
    });
    server.listen(port, host, () => {
      bound = server.address().port;
      server.on('error', (err) => process.stderr.write(`agent-team: web server error: ${err.message}\n`));
      resolve({ port: bound, url: `http://${host}:${bound}/`, close, clients: () => hub.size });
    });
  });
}

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { whoAmI } from './admin.js';
import { publicRun, publicMessage, clipEvent, runDetail, needsYou } from './view.js';

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

export function startHttp({ store, sup = null, host = '127.0.0.1', port = DEFAULT_PORT, env = process.env,
                            by = null, pollMs = 250, heartbeatMs = 15_000, fetchImpl = fetch } = {}) {
  const own = sup?.socketPath ?? null;
  let bound = null;
  const found = (v, what) => { if (v == null) throw new HttpError(404, `unknown ${what}`); return v; };
  const member = (id) => found(store.member(id), `member ${id}`);

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
    ['GET', /^\/api\/needs-you$/, () => needsYou(store)]
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
      const out = await handler({ req, res, url, params, body: null });
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
      resolve({ port: bound, url: `http://${host}:${bound}/`, close, clients: () => 0 });
    });
  });
}

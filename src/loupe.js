import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Loupe (a local device viewer) behind the web view. Opt-in: AGENT_TEAM_LOUPE_URL names it.
// Its token is read when a request needs it and is sent only to loupe, in a header.
export const TARGET_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loupeConfig(env = process.env, { tokenFile = join(homedir(), 'Library', 'Caches', 'loupe', 'token') } = {}) {
  const raw = env.AGENT_TEAM_LOUPE_URL;
  if (!raw) return null;
  let base;
  try { base = new URL(raw); } catch { throw new Error(`AGENT_TEAM_LOUPE_URL is not a URL: "${raw}"`); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('AGENT_TEAM_LOUPE_URL must be an http or https URL');
  if (!LOOPBACK.has(base.hostname)) {
    throw new Error('AGENT_TEAM_LOUPE_URL must be on this machine (localhost, 127.0.0.1 or [::1]): serve sends it the loupe token');
  }
  return {
    base,
    token: () => {
      if (env.LOUPE_TOKEN) return env.LOUPE_TOKEN;
      try { return readFileSync(tokenFile, 'utf8').trim(); } catch {
        throw new Error('no loupe token: set LOUPE_TOKEN or start loupe once to create its token file');
      }
    }
  };
}

// Loupe on localhost serves a self-signed certificate, so a loopback https URL is accepted
// without verifying it. loupeConfig has already refused anything not on this machine.
export function loupeGet(cfg, path, query = {}) {
  const url = new URL(path, cfg.base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const https = url.protocol === 'https:';
  return new Promise((resolveRaw, rejectRaw) => {
    let deadline;
    const resolve = (v) => { clearTimeout(deadline); resolveRaw(v); };
    const reject = (e) => { clearTimeout(deadline); rejectRaw(e); };
    const req = (https ? httpsRequest : httpRequest)(url, {
      headers: { Authorization: `Bearer ${cfg.token()}` },
      ...(https ? { rejectUnauthorized: false } : {}),
      timeout: 10_000
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 32 * 1024 * 1024) req.destroy(new Error('loupe sent over 32 MiB')); else chunks.push(c); });
      // A loupe that drops the connection mid-body emits neither 'end' nor a request error.
      res.on('error', (err) => reject(new Error(`loupe is not reachable at ${cfg.base.origin}: ${err.message}`)));
      res.on('close', () => { if (!res.complete) reject(new Error('loupe cut its answer short')); });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: Buffer.concat(chunks) }));
    });
    deadline = setTimeout(() => req.destroy(new Error('loupe did not answer within 15s')), 15_000);
    deadline.unref();
    req.on('timeout', () => req.destroy(new Error('loupe did not answer within 10s')));
    req.on('error', (err) => reject(new Error(`loupe is not reachable at ${cfg.base.origin}: ${err.message}`)));
    req.end();
  });
}

// Loupe's own page: it reads ?target=, sets its cookie from ?token= and redirects the token
// out of the address bar.
export function openUrl(cfg, target) {
  const url = new URL('/', cfg.base);
  url.searchParams.set('target', target);
  url.searchParams.set('token', cfg.token());
  return url.toString();
}

export const mentionedTargets = (texts, targets) =>
  targets.filter((t) => texts.some((s) => s.includes(t.id)));

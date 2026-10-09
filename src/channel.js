// Spike (docs/spikes/live-sessions.md): the caller's side of channel/server.js. Finds the
// local Claude Code sessions that loaded the agent-team channel and hands one a task.

import { connect } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Kept short: a Unix socket path is limited to about 104 bytes on macOS.
export function channelDir(env = process.env) {
  return env.AGENT_TEAM_CHANNEL_DIR || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'agent-team', 'channels');
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Registry entries whose server is still running. A server that died without cleaning up
// leaves an entry behind; its pid gives it away.
export function listChannels(env = process.env) {
  const dir = channelDir(env);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).flatMap((n) => {
    try {
      const entry = JSON.parse(readFileSync(join(dir, n), 'utf8'));
      return alive(entry.pid) ? [entry] : [];
    } catch { return []; }
  });
}

// Sends `text` to the session and resolves with its reply. The channel gives no delivery
// acknowledgement: a session not started with the channel flag drops the task silently,
// so a missing reply only ever shows up as the timeout.
export function askSession(sessionId, text, { timeoutMs = 15 * 60_000, env = process.env } = {}) {
  const entry = listChannels(env).find((c) => c.session_id === sessionId);
  if (!entry) return Promise.reject(new Error(`no running agent-team channel for session ${sessionId}`));
  const taskId = `t_${randomBytes(6).toString('hex')}`;
  return new Promise((resolve, reject) => {
    const sock = connect(entry.socket);
    let buf = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); sock.destroy(); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error(`no reply to ${taskId} from session ${sessionId} within ${timeoutMs} ms`)), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ task_id: taskId, text }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        if (reply.task_id !== taskId) return finish(reject, new Error(`reply for ${reply.task_id}, expected ${taskId}`));
        finish(resolve, { task_id: taskId, text: reply.text, cwd: entry.cwd });
      } catch (e) { finish(reject, e); }
    });
    sock.on('error', (e) => finish(reject, e));
    sock.on('close', () => finish(reject, new Error(`channel for session ${sessionId} closed without a reply to ${taskId}`)));
  });
}

#!/usr/bin/env node
// Experimental: a Claude Code channel that lets an agent-team member hand a task to a
// running local session and get the answer back (docs/configuration.md, "Live session
// members"). A project opts in with `agent-team channel enable`; the session must then be
// started with --dangerously-load-development-channels server:agent-team.
//
// Claude Code spawns this as a stdio MCP server. It speaks just enough MCP for a two-way
// channel (https://code.claude.com/docs/en/channels-reference): the claude/channel
// capability, a `reply` tool, and notifications/claude/channel events. Tasks come in over
// a Unix socket named after CLAUDE_CODE_SESSION_ID, which Claude Code sets for stdio MCP
// servers, so a caller can match it against `claude agents --json`.
//
// Socket protocol: the caller writes one JSON line {task_id, text}, then reads one JSON
// line {task_id, text} when Claude calls `reply` with that task_id. Closing the connection
// abandons the wait, not the task: if Claude Code restarts this server mid-task (MCP reconnect,
// `claude --resume`), the caller reconnects to the same socket path and sends
// {task_id, resume: true}, which registers it for the reply without notifying Claude again.
// A reply for a task nobody is waiting on is kept for a while (KEEP_MAX entries, KEEP_MS) and
// handed over when that caller resumes.
//
// Dependency-free on purpose: Claude Code runs it straight from the plugin checkout, which
// has no npm install step.

import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { channelDir } from '../src/channel.js';

const SOURCE_NAME = 'agent-team';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
const pending = new Map();   // task_id -> socket waiting for the reply
const kept = new Map();      // task_id -> {text, at}: replies that arrived with no socket waiting
const KEEP_MAX = 50;
const KEEP_MS = 30 * 60_000;

function keep(taskId, text) {
  const now = Date.now();
  for (const [k, v] of kept) if (now - v.at > KEEP_MS) kept.delete(k);
  kept.delete(taskId);
  kept.set(taskId, { text, at: now });
  while (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value);   // oldest first
}

const instructions = [
  `Tasks from agent-team arrive as <channel source="${SOURCE_NAME}" task_id="...">.`,
  'Each one is a task delegated to you by another agent. Do the task, then answer it by calling',
  'the reply tool exactly once with the same task_id and your full answer as text.',
  'Only the reply tool reaches the sender; text you write in the session does not.'
].join(' ');

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const notify = (method, params) => send({ method, params });

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;   // notifications from the client need no answer
  switch (method) {
    case 'initialize':
      return send({ id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
        serverInfo: { name: SOURCE_NAME, version: VERSION },
        instructions
      } });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: [{
        name: 'reply',
        description: 'Answer an agent-team task. Call once per task, with the task_id from its <channel> tag.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task_id attribute of the task being answered' },
            text: { type: 'string', description: 'The full answer' }
          },
          required: ['task_id', 'text']
        }
      }] } });
    case 'tools/call': {
      const { name, arguments: args = {} } = params ?? {};
      if (name !== 'reply') return send({ id, error: { code: -32602, message: `unknown tool: ${name}` } });
      const sock = pending.get(args.task_id);
      const text = String(args.text ?? '');
      if (!sock) {
        // The caller may be between connections after a server restart, or may have given up.
        if (!/^\w+$/.test(args.task_id ?? '')) {
          return send({ id, result: { isError: true, content: [{ type: 'text', text: `no open agent-team task ${args.task_id}` }] } });
        }
        keep(args.task_id, text);
        return send({ id, result: { content: [{ type: 'text', text: 'no caller is connected for this task right now; your reply was kept and goes to the caller if it reconnects' }] } });
      }
      pending.delete(args.task_id);
      sock.end(JSON.stringify({ task_id: args.task_id, text }) + '\n');
      return send({ id, result: { content: [{ type: 'text', text: 'sent' }] } });
    }
    default:
      return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg);
}).on('close', cleanup);

// Without a session id there is nothing a caller could address, so serve MCP but no socket.
let sockPath = null;
let entryPath = null;
if (sessionId) {
  const dir = channelDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);   // the socket's only access control: same user only
  sockPath = `${dir}/${sessionId}.sock`;
  entryPath = `${dir}/${sessionId}.json`;
  rmSync(sockPath, { force: true });
  createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0 || sock.taskId) return;
      let task;
      try { task = JSON.parse(buf.slice(0, nl)); } catch { return sock.destroy(); }
      if (!/^\w+$/.test(task.task_id ?? '')) return sock.destroy();
      if (task.resume === true) {
        // A caller reconnecting after a restart: wait for (or collect) the reply, no notification.
        sock.taskId = task.task_id;
        const k = kept.get(task.task_id);
        if (k) {
          kept.delete(task.task_id);
          return sock.end(JSON.stringify({ task_id: task.task_id, text: k.text }) + '\n');
        }
        pending.set(task.task_id, sock);
        return;
      }
      if (typeof task.text !== 'string') return sock.destroy();
      sock.taskId = task.task_id;
      pending.set(task.task_id, sock);
      // meta keys must be identifiers; each becomes an attribute on the <channel> tag.
      notify('notifications/claude/channel', { content: task.text, meta: { task_id: task.task_id } });
    });
    sock.on('close', () => { if (pending.get(sock.taskId) === sock) pending.delete(sock.taskId); });
    sock.on('error', () => {});
  }).listen(sockPath, writeEntry);
}

// Registering says only that this server is running. Claude Code starts it in every session
// of an opted-in project, with or without the channel flag, and nothing documented tells it
// which, so a task sent to a session started without the flag is dropped silently.
function writeEntry() {
  writeFileSync(entryPath, JSON.stringify({ session_id: sessionId, cwd: process.cwd(), pid: process.pid, socket: sockPath }) + '\n');
}

function cleanup() {
  if (sockPath) rmSync(sockPath, { force: true });
  if (entryPath) rmSync(entryPath, { force: true });
  process.exit(0);
}
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

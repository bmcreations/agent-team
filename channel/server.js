#!/usr/bin/env node
// Spike (docs/spikes/live-sessions.md): a Claude Code channel that lets agent-team hand a
// task to a running local session and get the answer back.
//
// Claude Code spawns this as a stdio MCP server. It speaks just enough MCP for a two-way
// channel (https://code.claude.com/docs/en/channels-reference): the claude/channel
// capability, a `reply` tool, and notifications/claude/channel events. Tasks come in over
// a Unix socket named after CLAUDE_CODE_SESSION_ID, which Claude Code sets for stdio MCP
// servers, so a caller can match it against `claude agents --json`.
//
// Socket protocol: the caller writes one JSON line {task_id, text}, then reads one JSON
// line {task_id, text} when Claude calls `reply` with that task_id. Closing the connection
// abandons the task.

import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { channelDir } from '../src/channel.js';

const SOURCE_NAME = 'agent-team';
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
const pending = new Map();   // task_id -> socket waiting for the reply

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
  if (id === undefined) {   // notifications from the client need no answer
    if (method === 'notifications/initialized') markReady();
    return;
  }
  switch (method) {
    case 'initialize':
      return send({ id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
        serverInfo: { name: SOURCE_NAME, version: '0.0.0-spike' },
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
      if (!sock) {
        return send({ id, result: { isError: true, content: [{ type: 'text', text: `no open agent-team task ${args.task_id}` }] } });
      }
      pending.delete(args.task_id);
      sock.end(JSON.stringify({ task_id: args.task_id, text: String(args.text ?? '') }) + '\n');
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
      if (!/^\w+$/.test(task.task_id ?? '') || typeof task.text !== 'string') return sock.destroy();
      sock.taskId = task.task_id;
      pending.set(task.task_id, sock);
      // meta keys must be identifiers; each becomes an attribute on the <channel> tag.
      notify('notifications/claude/channel', { content: task.text, meta: { task_id: task.task_id } });
    });
    sock.on('close', () => { if (pending.get(sock.taskId) === sock) pending.delete(sock.taskId); });
    sock.on('error', () => {});
  }).listen(sockPath, writeEntry);
}

// `ready` means Claude Code finished the MCP handshake with this server. The server starts
// (and registers) before that, so an entry without it can't take tasks yet.
let ready = false;
function writeEntry() {
  if (!entryPath) return;
  writeFileSync(entryPath, JSON.stringify({ session_id: sessionId, cwd: process.cwd(), pid: process.pid, socket: sockPath, ready }) + '\n');
}
function markReady() {
  ready = true;
  if (existsSync(sockPath ?? '')) writeEntry();   // otherwise listen's callback writes it
}

function cleanup() {
  if (sockPath) rmSync(sockPath, { force: true });
  if (entryPath) rmSync(entryPath, { force: true });
  process.exit(0);
}
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

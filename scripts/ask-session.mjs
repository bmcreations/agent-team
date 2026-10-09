#!/usr/bin/env node
// Spike (docs/spikes/live-sessions.md): hand a task to a local Claude Code session that
// loaded the agent-team channel (channel/server.js), and print its reply.
//
//   node scripts/ask-session.mjs --list
//   node scripts/ask-session.mjs [--session <session-id>] [--timeout 300] "task text"
//
// Without --session, the task goes to the only ready session; with none or several ready,
// it lists them and exits. Progress goes to stderr and the answer to stdout.
//
// The session must have been started with the channel loaded, e.g. from a directory whose
// .mcp.json names channel/server.js under the key "agent-team":
//   claude --dangerously-load-development-channels server:agent-team

import { parseArgs } from 'node:util';
import { askSession, listChannels } from '../src/channel.js';

const { values: opt, positionals } = parseArgs({
  options: { list: { type: 'boolean' }, session: { type: 'string' }, timeout: { type: 'string', default: '300' } },
  allowPositionals: true
});

const short = (id) => id.slice(0, 8);
const describe = (c) => `${c.session_id}  ${c.ready ? 'ready  ' : 'waiting'}  ${c.cwd}`;
const channels = listChannels();

if (opt.list) {
  if (!channels.length) console.log('no running agent-team channels');
  for (const c of channels) console.log(describe(c));
  process.exit(0);
}

const task = positionals.join(' ');
if (!task) {
  console.error('usage: ask-session.mjs --list | [--session <id>] [--timeout <s>] "task"');
  process.exit(2);
}

let sessionId = opt.session;
if (!sessionId) {
  const ready = channels.filter((c) => c.ready);
  if (ready.length !== 1) {
    console.error(ready.length ? 'several sessions are ready; pick one with --session:' : 'no ready session; running channels:');
    for (const c of channels) console.error(`  ${describe(c)}`);
    process.exit(2);
  }
  sessionId = ready[0].session_id;
} else if (channels.find((c) => c.session_id === sessionId)?.ready === false) {
  console.error(`warning: ${short(sessionId)} hasn't finished starting; the task may be dropped`);
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
let ticker;
try {
  const r = await askSession(sessionId, task, {
    timeoutMs: Number(opt.timeout) * 1000,
    onSent: (taskId) => {
      console.error(`→ sent ${taskId} to session ${short(sessionId)}`);
      if (process.stderr.isTTY) ticker = setInterval(() => process.stderr.write(`\r… waiting ${elapsed()}`), 100);
    }
  });
  clearInterval(ticker);
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  console.error(`← reply to ${r.task_id} after ${elapsed()}`);
  console.log(r.text);
} catch (e) {
  clearInterval(ticker);
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  console.error(`ask-session: ${e.message}`);
  process.exit(1);
}

#!/usr/bin/env node
// Spike (docs/spikes/live-sessions.md): hand a task to a local Claude Code session that
// loaded the agent-team channel (channel/server.js), and print its reply.
//
//   node scripts/ask-session.mjs --list
//   node scripts/ask-session.mjs --session <session-id> [--timeout 300] "task text"
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

if (opt.list) {
  const channels = listChannels();
  if (!channels.length) console.log('no running agent-team channels');
  for (const c of channels) console.log(`${c.session_id}  ${c.cwd}`);
  process.exit(0);
}

const task = positionals.join(' ');
if (!opt.session || !task) {
  console.error('usage: ask-session.mjs --list | --session <id> [--timeout <s>] "task"');
  process.exit(2);
}

const started = Date.now();
try {
  const r = await askSession(opt.session, task, { timeoutMs: Number(opt.timeout) * 1000 });
  console.error(`reply to ${r.task_id} from ${r.cwd} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(r.text);
} catch (e) {
  console.error(`ask-session: ${e.message}`);
  process.exit(1);
}

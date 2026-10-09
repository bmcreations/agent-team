#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { loadConfig } from '../src/config.js';
import { renderOrg } from '../src/org.js';
import { readRuns, renderReport } from '../src/report.js';
import { spawnSync } from 'node:child_process';
import { askSession, listChannels, pickSession, START_COMMAND } from '../src/channel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    member: { type: 'string' },
    task: { type: 'string' },
    project: { type: 'string', default: process.cwd() },
    timeout: { type: 'string', default: '900' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    session: { type: 'string' }
  }
});

const USAGE =
  'usage: agent-team --member <member> --task <text> [--project <dir>] [--timeout <sec>]\n' +
  '       agent-team org [--project <dir>]\n' +
  '       agent-team report [--project <dir>] [--all] [--json]\n' +
  '       agent-team channel enable|disable [--project <dir>]\n' +
  '       agent-team channel list [--json]\n' +
  '       agent-team channel ask --task <text> [--session <id>] [--project <dir>] [--timeout <sec>]\n';

// Any throw here — a broken config, a bad org chart, a member resolution failure — must
// reach the caller (the delegate skill included) as the same JSON shape a normal run
// produces, on stdout, not as a raw Node stack trace on stderr with empty stdout. The
// message is kept; the stack is dropped.
function fail(err) {
  process.stdout.write(JSON.stringify({ status: 'failed', summary: err.message }, null, 2) + '\n');
  process.exit(1);
}

if (positionals[0] === 'org') {
  try {
    const config = loadConfig(values.project);
    process.stdout.write(renderOrg(config.org, config.members) + '\n');
    process.exit(0);
  } catch (err) {
    fail(err);
  }
}

// The last delegation as a tree, or with --all every member's totals. --json prints the raw
// run log records for anyone building on them.
if (positionals[0] === 'report') {
  try {
    const out = values.json
      ? JSON.stringify(values.all ? readRuns(values.project) : readRuns(values.project).slice(-1), null, 2)
      : renderReport(values.project, { all: values.all });
    process.stdout.write(out + '\n');
    process.exit(0);
  } catch (err) {
    fail(err);
  }
}

// Experimental live-session members (docs/configuration.md). enable registers the channel
// server for this project in Claude Code's local scope, private to you and kept out of the
// repo's .mcp.json, since its path points into this plugin's install directory.
if (positionals[0] === 'channel') {
  const action = positionals[1];
  const claude = (args) => spawnSync('claude', args, { cwd: values.project, encoding: 'utf8' });
  if (action === 'enable' || action === 'disable') {
    claude(['mcp', 'remove', '--scope', 'local', 'agent-team']);   // absent is fine
    if (action === 'enable') {
      const r = claude(['mcp', 'add', '--scope', 'local', 'agent-team', '--', process.execPath, join(ROOT, 'channel', 'server.js')]);
      if (r.error || r.status !== 0) {
        process.stderr.write(`agent-team: \`claude mcp add\` failed: ${r.error?.message ?? (r.stderr || r.stdout).trim()}\n`);
        process.exit(1);
      }
      process.stdout.write(
        `agent-team channel enabled for ${values.project}. Start the session members should use with:\n  ${START_COMMAND}\n` +
        'Run this again after updating the plugin: the registered path points at this version.\n'
      );
    } else {
      process.stdout.write(`agent-team channel disabled for ${values.project}.\n`);
    }
    process.exit(0);
  }
  if (action === 'list') {
    const sessions = listChannels();
    process.stdout.write(values.json
      ? JSON.stringify(sessions, null, 2) + '\n'
      : sessions.map((c) => `${c.session_id}  ${c.cwd}`).join('\n') + (sessions.length ? '\n' : 'no session is running the agent-team channel\n'));
    process.exit(0);
  }
  if (action === 'ask' && values.task) {
    try {
      const entry = pickSession({ sessionId: values.session ?? null, projectRoot: values.project });
      process.stderr.write(`agent-team: sending to session ${entry.session_id}\n`);
      const reply = await askSession(entry.session_id, values.task, { timeoutMs: Number(values.timeout) * 1000 });
      process.stdout.write(reply.text + '\n');
      process.exit(0);
    } catch (err) {
      process.stderr.write(`agent-team: ${err.message}\n`);
      process.exit(1);
    }
  }
  process.stderr.write(USAGE);
  process.exit(2);
}

if (!values.member || !values.task) {
  process.stderr.write(USAGE);
  process.exit(2);
}

try {
  const result = await dispatch({
    projectRoot: values.project,
    member: values.member,
    task: values.task,
    adapterDir: join(ROOT, 'adapters'),
    skillsDir: join(ROOT, 'skills'),
    timeoutMs: Number(values.timeout) * 1000
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.status === 'ok' ? 0 : 1);
} catch (err) {
  fail(err);
}

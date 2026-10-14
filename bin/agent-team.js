#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatch } from '../src/dispatch.js';
import { loadConfig } from '../src/config.js';
import { renderOrg } from '../src/org.js';
import { allRuns, renderReport } from '../src/report.js';
import { askSession, listChannels, pickSession, START_COMMAND } from '../src/channel.js';
import {
  loadExtensions, mergeOptions, extensionUsage, findCommand, routeDelegation, extensionRuns
} from '../src/extensions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Any throw here — a broken config, a bad org chart, a member resolution failure — must
// reach the caller (the delegate skill included) as the same JSON shape a normal run
// produces, on stdout, not as a raw Node stack trace on stderr with empty stdout. The
// message is kept; the stack is dropped.
function fail(err) {
  process.stdout.write(JSON.stringify({ status: 'failed', summary: err.message }, null, 2) + '\n');
  process.exit(1);
}

// Extensions add options, verbs and a way to take over a delegation (docs/extensions.md).
// They load before the arguments are parsed, since they can add options.
let extensions;
try {
  extensions = await loadExtensions({ root: ROOT });
} catch (err) {
  fail(err);
}

const { values, positionals, tokens } = parseArgs({
  allowPositionals: true,
  tokens: true,
  options: mergeOptions({
    member: { type: 'string' },
    task: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
    project: { type: 'string', default: process.cwd() },
    timeout: { type: 'string' },
    session: { type: 'string' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }
  }, extensions)
});

const USAGE =
  'usage: agent-team --member <member> --task <text> [--project <dir>] [--timeout <sec>]\n' +
  '       agent-team org [--project <dir>]\n' +
  '       agent-team report [--project <dir>] [--all] [--json]\n' +
  '       agent-team channel enable|disable [--project <dir>]\n' +
  '       agent-team channel list [--json]\n' +
  '       agent-team channel ask --task <text> [--session <id>] [--project <dir>] [--timeout <sec>]\n' +
  extensionUsage(extensions);

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
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
// run records for anyone building on them. Extensions' report sources add their own runs.
if (positionals[0] === 'report') {
  try {
    const extra = await extensionRuns(extensions, values.project);
    const out = values.json
      ? JSON.stringify(values.all ? allRuns(values.project, { extra }) : allRuns(values.project, { extra }).slice(-1), null, 2)
      : renderReport(values.project, { all: values.all, extra });
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
      const reply = await askSession(entry.session_id, values.task, { timeoutMs: Number(values.timeout ?? 900) * 1000 });
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

// A verb an extension added. The core's own verbs above win: an extension cannot replace
// them. A command that returns a number sets the exit code; otherwise the process exits 0.
const command = findCommand(extensions, positionals[0]);
if (command) {
  try {
    const code = await command({
      values, positionals, tokens, ROOT, fail,
      adapterDir: join(ROOT, 'adapters'), skillsDir: join(ROOT, 'skills')
    });
    process.stdout.write('', () => process.exit(typeof code === 'number' ? code : 0));
    await new Promise(() => {});
  } catch (err) {
    fail(err);
  }
}

if (!values.member || !values.task) {
  process.stderr.write(USAGE);
  process.exit(2);
}

try {
  const opts = {
    projectRoot: values.project,
    member: values.member,
    task: values.task,
    adapterDir: join(ROOT, 'adapters'),
    skillsDir: join(ROOT, 'skills'),
    timeoutMs: values.timeout == null ? undefined : Number(values.timeout) * 1000,
    values
  };
  const result = (await routeDelegation(extensions, opts, { dispatch })) ?? await dispatch(opts);

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.status === 'ok' ? 0 : 1);
} catch (err) {
  fail(err);
}

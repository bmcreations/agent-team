#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { loadConfig } from '../src/config.js';
import { renderOrg } from '../src/org.js';
import { readRuns, renderReport } from '../src/report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    member: { type: 'string' },
    task: { type: 'string' },
    project: { type: 'string', default: process.cwd() },
    timeout: { type: 'string', default: '900' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }
  }
});

const USAGE =
  'usage: agent-team --member <member> --task <text> [--project <dir>] [--timeout <sec>]\n' +
  '       agent-team org [--project <dir>]\n' +
  '       agent-team report [--project <dir>] [--all] [--json]\n';

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

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { loadConfig } from '../src/config.js';
import { renderOrg } from '../src/org.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    member: { type: 'string' },
    task: { type: 'string' },
    project: { type: 'string', default: process.cwd() },
    timeout: { type: 'string', default: '900' }
  }
});

const USAGE =
  'usage: agent-team --member <member> --task <text> [--project <dir>] [--timeout <sec>]\n' +
  '       agent-team org [--project <dir>]\n';

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
    process.stdout.write(renderOrg(config.org) + '\n');
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

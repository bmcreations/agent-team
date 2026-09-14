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

if (positionals[0] === 'org') {
  const config = loadConfig(values.project);
  process.stdout.write(renderOrg(config.org) + '\n');
  process.exit(0);
}

if (!values.member || !values.task) {
  process.stderr.write(USAGE);
  process.exit(2);
}

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

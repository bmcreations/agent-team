#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { loadConfig } from '../src/config.js';
import { renderOrg } from '../src/org.js';
import { allRuns, renderReport } from '../src/report.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runMcpServer } from '../src/mcp.js';
import { runThroughSupervisor, resolveRootMember } from '../src/client.js';
import { openStore } from '../src/store.js';
import { watchRun, plain } from '../src/watch.js';
import { threadsView, threadDetail } from '../src/view.js';
import { startHttp, DEFAULT_PORT } from '../src/http.js';
import { Supervisor, defaultSocketPath, defaultStorePath, lockSupervisorDir } from '../src/supervisor.js';
import { adminCall, attach, memberArgs, whoAmI, renderQuestions, handbackNotice } from '../src/admin.js';
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
    session: { type: 'string' },
    now: { type: 'boolean', default: false },
    subtree: { type: 'boolean', default: false },
    note: { type: 'string' },
    'max-cost-usd': { type: 'string' },
    port: { type: 'string', default: String(DEFAULT_PORT) },
    'max-running': { type: 'string', default: '6' }
  }
});

const USAGE =
  'usage: agent-team --member <member> --task <text> [--project <dir>] [--timeout <sec>]\n' +
  '       agent-team org [--project <dir>]\n' +
  '       agent-team report [--project <dir>] [--all] [--json]\n' +
  '       agent-team mcp\n' +
  '       agent-team serve [--port <n>] [--max-running <n>]\n' +
  '       agent-team channel enable|disable [--project <dir>]\n' +
  '       agent-team channel list [--json]\n' +
  '       agent-team channel ask --task <text> [--session <id>] [--project <dir>] [--timeout <sec>]\n' +
  '       agent-team pause <run> <member> [--now] [--subtree]\n' +
  '       agent-team resume <run> <member> [--subtree] [--note <text>] [--max-cost-usd <usd>]\n' +
  '       agent-team cancel <run> <member> [--subtree]\n' +
  '       agent-team send <run> <member> <text>\n' +
  '       agent-team watch <run> [--json]\n' +
  '       agent-team questions [<run>] [--json]\n' +
  '       agent-team answer <question-id> <answer>\n' +
  '       agent-team threads [--project <dir>] [--json]\n' +
  '       agent-team reply <thread> <text>\n' +
  '       agent-team attach <run> <member>\n' +
  '       agent-team handback <run> <member>\n';

// Any throw here — a broken config, a bad org chart, a member resolution failure — must
// reach the caller (the delegate skill included) as the same JSON shape a normal run
// produces, on stdout, not as a raw Node stack trace on stderr with empty stdout. The
// message is kept; the stack is dropped.
function fail(err) {
  process.stdout.write(JSON.stringify({ status: 'failed', summary: err.message }, null, 2) + '\n');
  process.exit(1);
}

// Spawned by a harness, one per live member; runs until the harness closes stdin.
if (positionals[0] === 'mcp') {
  await runMcpServer();
  await new Promise((resolve) => process.stdout.write('', resolve));   // let queued replies flush
  process.exit(0);
}

// The machine's supervisor, in the foreground until SIGINT/SIGTERM.
if (positionals[0] === 'serve') {
  const count = (v, flag, min) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > 65535) {
      process.stderr.write(`agent-team: ${flag} must be a whole number from ${min}, got "${v}"\n`);
      process.exit(2);
    }
    return n;
  };
  const port = count(values.port, '--port', 0);
  const maxRunning = count(values['max-running'], '--max-running', 1);
  lockSupervisorDir();
  const store = openStore(defaultStorePath());
  const sup = new Supervisor({
    store, adapterDir: join(ROOT, 'adapters'), skillsDir: join(ROOT, 'skills'),
    socketPath: defaultSocketPath(), maxRunning, shared: true
  });
  try {
    await sup.start();
  } catch (err) {
    store.close();
    fail(err);
  }
  process.stderr.write(`agent-team: supervisor listening on ${defaultSocketPath()}\n`);
  let web;
  try {
    web = await startHttp({ store, sup, port });
  } catch (err) {
    await sup.close().catch(() => {});
    store.close();
    process.stderr.write(`agent-team: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`agent-team: web view at ${web.url} (this machine only, no sign-in: ` +
                       'any local user who can reach the port can steer runs serve owns)\n');
  // Runs left behind by a previous serve, or by a CLI whose in-process supervisor died.
  const { recovered, failed } = await sup.recover();
  if (recovered.length || failed.length) {
    process.stderr.write(`agent-team: recovered runs [${recovered.join(', ')}]; could not recover [${failed.join(', ')}]\n`);
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    web.close().then(() => sup.close()).catch(() => {}).finally(() => { store.close(); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});   // the listening socket keeps the process alive; signals exit it
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
    // Open the store only if it exists, so `report` never creates one.
    const dbPath = defaultStorePath();
    const store = existsSync(dbPath) ? openStore(dbPath) : null;
    try {
      const out = values.json
        ? JSON.stringify(values.all ? allRuns(values.project, { store }) : allRuns(values.project, { store }).slice(-1), null, 2)
        : renderReport(values.project, { all: values.all, store });
      process.stdout.write(out + '\n');
    } finally { store?.close(); }
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

// Steering verbs: each is one admin RPC to the `agent-team serve` supervisor.
const usd = (v) => {
  if (v == null) return null;
  if (!(Number(v) > 0 && Number.isFinite(Number(v)))) throw new Error(`--max-cost-usd must be a positive number of dollars, got "${v}"`);
  return Number(v);
};
const ADMIN = {
  pause: (p) => ['pause', { ...memberArgs(p), now: values.now, subtree: values.subtree, by: whoAmI() }],
  cancel: (p) => ['cancel', { ...memberArgs(p), subtree: values.subtree, by: whoAmI() }],
  resume: (p) => ['resume', {
    ...memberArgs(p), subtree: values.subtree, by: whoAmI(), note: values.note ?? null,
    max_cost_usd: usd(values['max-cost-usd'])
  }],
  send: ([run, member, ...text]) => {
    if (!text.join(' ').trim()) throw new Error('usage: agent-team send <run> <member> <text>');
    return ['send', { ...memberArgs([run, member]), text: text.join(' '), from: whoAmI() }];
  },
  handback: (p) => ['handback', { ...memberArgs(p), by: whoAmI() }],
  questions: ([run]) => {
    if (run != null && !(Number.isInteger(Number(run)) && Number(run) > 0)) throw new Error('usage: agent-team questions [<run>]');
    return ['questions', { run_id: run == null ? null : Number(run) }];
  },
  reply: ([id, ...text]) => {
    if (!(id?.trim() && Number.isInteger(Number(id)) && Number(id) > 0) || !text.join(' ').trim()) throw new Error('usage: agent-team reply <thread> <text>');
    return ['thread_reply', { thread_id: Number(id), text: text.join(' '), by: whoAmI() }];
  },
  answer: ([id, ...text]) => {
    if (!(id?.trim() && Number.isInteger(Number(id)) && Number(id) > 0) || !text.length) throw new Error('usage: agent-team answer <question-id> <answer>');
    return ['answer', { question_id: Number(id), answer: text.join(' '), by: whoAmI() }];
  }
};
if (positionals[0] === 'watch') {
  const runId = Number(positionals[1]);
  if (!Number.isInteger(runId) || runId <= 0) {
    process.stderr.write('usage: agent-team watch <run> [--json]\n');
    process.exit(2);
  }
  // Open the store only if it exists, so `watch` never creates one.
  if (!existsSync(defaultStorePath())) {
    process.stderr.write(`agent-team: unknown run ${runId}\n`);
    process.exit(1);
  }
  const store = openStore(defaultStorePath());
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  let code = 0;
  try {
    const status = await watchRun({ store, runId, json: values.json, signal: stop.signal, write: (s) => process.stdout.write(s) });
    if (!values.json) process.stderr.write(`agent-team: run ${runId} ${status}\n`);
  } catch (err) {
    process.stderr.write(`agent-team: ${err.message}\n`);
    code = 1;
  } finally { store.close(); }
  // Exit once stdout has flushed: exiting straight after a large write can cut it off.
  process.stdout.write('', () => process.exit(code));
  await new Promise(() => {});
}

if (positionals[0] === 'threads') {
  // Like `watch`, read straight from the store, and never creating one.
  const dbPath = defaultStorePath();
  if (!existsSync(dbPath)) {
    process.stderr.write(`agent-team: no threads: there is no store at ${dbPath}\n`);
    process.exit(1);
  }
  const store = openStore(dbPath);
  let code = 0;
  try {
    const named = process.argv.some((a) => a === '--project' || a.startsWith('--project='));
    const view = threadsView(store, { project: named ? resolve(values.project) : null });
    if (values.json) process.stdout.write(JSON.stringify(view, null, 2) + '\n');
    else {
      const out = [];
      for (const { pair, threads } of view.pairs) {
        out.push(plain(pair));
        for (const t of threads) {
          const what = t.task ?? threadDetail(store, t.id)?.posts[0]?.text ?? '';
          out.push(`  #${t.id} ${plain(t.state)} ${plain(t.kind)} ${plain(t.from_member?.name ?? '-')} -> ${plain(t.owner?.name ?? '-')}: ${plain(what).slice(0, 80)}`);
        }
      }
      process.stdout.write(out.length ? out.join('\n') + '\n' : 'no threads\n');
    }
  } catch (err) {
    process.stderr.write(`agent-team: ${err.message}\n`);
    code = 1;
  } finally { store.close(); }
  process.stdout.write('', () => process.exit(code));
  await new Promise(() => {});
}

if (positionals[0] === 'attach') {
  try {
    const back = await attach(memberArgs(positionals.slice(1)));
    process.stdout.write(JSON.stringify(back, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`agent-team: ${err.message}\n`);
    process.exit(1);
  }
}

if (Object.hasOwn(ADMIN, positionals[0])) {
  try {
    const [method, params] = ADMIN[positionals[0]](positionals.slice(1));
    const result = await adminCall(method, params);
    if (method === 'handback') process.stderr.write(handbackNotice(result));
    process.stdout.write(method === 'questions' && !values.json
      ? renderQuestions(result)
      : JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`agent-team: ${err.message}\n`);
    process.exit(1);
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
    timeoutMs: Number(values.timeout) * 1000
  };
  const { live, preresolved } = await resolveRootMember(opts);
  const result = live
    ? await runThroughSupervisor(opts)
    : await dispatch({ ...opts, preresolved });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.status === 'ok' ? 0 : 1);
} catch (err) {
  fail(err);
}

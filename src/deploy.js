import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// A project's deploy command (`deploy` in agent-team.json), run by a human from the web page and
// by nothing else: members have no tool for it. One at a time per project. The state lives in
// memory while a deploy runs; each change is also written as a 'deploy' event on the run's root
// member, which is what wakes the page's event stream and what a restarted serve reads back.
const KEEP_CHARS = 64_000;      // output kept while running and returned to the page
const EVENT_CHARS = 8_000;      // output tail stored with the finishing event
const PROGRESS_MS = 3000;       // at most one progress event per this, and only if output grew
export const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 3000;

const view = (d) => ({
  state: d.state, command: d.command, by: d.by, started_at: d.started_at, finished_at: d.finished_at ?? null,
  exit: d.exit ?? null, timed_out: d.timed_out ?? false, output: d.output
});

export class Deployer {
  #runs = new Map();   // project -> the latest deploy in this process
  #children = new Map();

  constructor({ store, env = process.env, timeoutMs = DEPLOY_TIMEOUT_MS }) {
    Object.assign(this, { store, env, timeoutMs });
  }

  // The latest deploy for this project: in memory if this process ran it, else what the run's
  // root member recorded, else idle.
  status(project, run) {
    const d = this.#runs.get(project);
    if (d) return view(d);
    const last = run?.root_member == null ? null : this.store.lastEventOfKind(run.root_member, 'deploy');
    const b = last?.body;
    if (!b || b.state === 'running') return { state: 'idle', command: null, by: null, started_at: null, finished_at: null, exit: null, timed_out: false, output: '' };
    return view({ ...b, output: b.output ?? '' });
  }

  // Throws "a deploy is already running" (mapped to 409 by the caller) or on a missing project.
  start({ project, run, command, by }) {
    if (this.#runs.get(project)?.state === 'running') throw new Error('a deploy is already running for this project');
    if (!existsSync(project)) throw new Error(`the project folder ${project} is gone`);
    const d = { state: 'running', command, by, started_at: Date.now(), output: '', bytes: 0, timed_out: false };
    this.#runs.set(project, d);
    const note = (body) => { if (run.root_member != null) this.store.addEvent(run.root_member, 'deploy', body); };
    note({ state: 'running', command, by });

    // detached: the shell leads its own process group, so a timeout takes the whole tree.
    const child = spawn('/bin/sh', ['-c', command], { cwd: project, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.#children.set(project, child);
    let progressAt = Date.now();
    let sent = 0;
    const take = (chunk) => {
      d.bytes += chunk.length;
      d.output = (d.output + chunk.toString('utf8')).slice(-KEEP_CHARS);
      const t = Date.now();
      if (d.bytes !== sent && t - progressAt >= PROGRESS_MS) { progressAt = t; sent = d.bytes; note({ state: 'running', command, by, bytes: d.bytes }); }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      d.timed_out = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    }, this.timeoutMs);
    timer.unref();
    let ended = false;
    const end = (code, err) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      this.#children.delete(project);
      if (err) d.output += `\n${err.message}\n`;
      Object.assign(d, { state: code === 0 ? 'ok' : 'failed', exit: code, finished_at: Date.now() });
      if (d.timed_out) d.output += `\ntimed out after ${Math.round(this.timeoutMs / 1000)}s\n`;
      note({ state: d.state, command, by, exit: code, timed_out: d.timed_out, started_at: d.started_at, finished_at: d.finished_at,
             output: d.output.slice(-EVENT_CHARS) });
    };
    child.on('error', (err) => end(null, err));
    child.on('close', (code) => end(code));
    return view(d);
  }

  // serve is closing: a deploy it started does not outlive it half-watched.
  close() {
    for (const child of this.#children.values()) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
}

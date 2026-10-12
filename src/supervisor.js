import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { buildBrief } from './brief.js';
import { resolveCaps, prepareMember, runMember, teamKeys } from './dispatch.js';
import { pruneWorkspace } from './workspace.js';
import { MemberSession } from './sessions.js';
import { serveRpc } from './rpc.js';
import { TEAM_NOTE } from './team-tools.js';
import { DEFAULT_TIMEOUT_MS } from './adapter.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;
const ASK_DEFAULT_S = 1800;
const ASK_MAX_S = 7200;

const cacheRoot = (env) => env.XDG_CACHE_HOME || join(homedir(), '.cache');
export const defaultSocketPath = (env = process.env) =>
  env.AGENT_TEAM_SUPERVISOR_SOCK || join(cacheRoot(env), 'agent-team', 'supervisor.sock');
export const defaultStorePath = (env = process.env) =>
  env.AGENT_TEAM_SUPERVISOR_DB || join(cacheRoot(env), 'agent-team', 'supervisor.db');

const label = (m) => `${m.from_name} (${m.from_kind})`;
const render = (m) => ({ id: m.id, from: label(m), text: m.text, report_id: m.report_id });
const clampSeconds = (v, dflt, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : dflt);

export class Supervisor {
  #live = new Map();          // memberId -> runtime state of a launched, unfinished member
  #pending = [];              // memberIds waiting for a slot
  #runs = new Map();          // runId -> { projectRoot, config, budget }
  #runWaiters = new Map();    // runId -> [resolve]

  constructor({ store, adapterDir, skillsDir = null, socketPath, env = {}, maxRunning = 6, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    Object.assign(this, { store, adapterDir, skillsDir, socketPath, env, maxRunning, timeoutMs });
  }

  async start() {
    this.server = await serveRpc(this.socketPath, (req) => this.#handle(req));
  }

  async close() {
    await this.server?.close();
  }

  submit({ projectRoot, member, task }) {
    const config = loadConfig(projectRoot);
    if (!Object.hasOwn(config.members, member)) throw new Error(`unknown member "${member}"`);
    const runId = this.store.createRun({ project: projectRoot, task });
    this.#runs.set(runId, { projectRoot, config, budget: { runs: config.defaults.max_delegations } });
    const { id } = this.store.addMember({ runId, parentId: null, name: member, task, depth: 0 });
    this.store.setRunRoot(runId, id);
    this.#schedule(id);
    return { runId, memberId: id };
  }

  waitRun(runId) {
    const run = this.store.run(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.status !== 'running') return Promise.resolve(this.store.member(run.root_member).result);
    return new Promise((resolve) => {
      this.#runWaiters.set(runId, [...(this.#runWaiters.get(runId) ?? []), resolve]);
    });
  }

  send({ member_id, text, from = 'local' }) {
    const m = this.store.member(member_id);
    if (!m) throw new Error(`unknown member ${member_id}`);
    // A stopping member has been told to stop and will not read another message.
    if (TERMINAL.has(m.state) || this.#live.get(member_id)?.stopping) throw new Error(`"${m.name}" has finished — delegate a new task`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('a message needs text');
    const id = this.store.enqueue({ to: member_id, fromKind: 'human', fromName: from, text });
    this.#pump(member_id);
    return { message_id: id };
  }

  answer({ question_id, answer, by = 'local' }) {
    const q = this.store.question(question_id);
    if (!q || q.answer != null) throw new Error(`question ${question_id} is not open`);
    this.store.answerQuestion(question_id, answer, by);
    const rt = this.#live.get(q.member_id);
    if (rt?.question?.id === question_id) {
      this.#resolveQuestion(q.member_id, { answer, answered_by: by, timed_out: false });
    }
    return { ok: true };
  }

  // ---- scheduling ----

  #schedule(id) {
    this.#pending.push(id);
    this.#drain();
  }

  #drain() {
    for (const id of [...this.#pending]) {
      if (this.#live.size >= this.maxRunning) return;
      const m = this.store.member(id);
      if (m.parent_id != null) {
        const { config } = this.#runs.get(m.run_id);
        const running = this.store.children(m.parent_id).filter((c) => this.#live.has(c.id)).length;
        if (running >= config.defaults.max_parallel) continue;
      }
      this.#pending.splice(this.#pending.indexOf(id), 1);
      this.#launch(id).catch((err) => this.#finish(id, { status: 'failed', summary: err.message }));
    }
  }

  async #launch(id) {
    const m = this.store.member(id);
    const run = this.#runs.get(m.run_id);
    // Registered before any await, so #drain counts this member against the caps at once.
    const rt = { member: m, session: null, resolved: null, workspace: null, result: null,
                 offered: new Set(), staleOffers: new Set(), idle: false, stopping: false, waiter: null, question: null };
    this.#live.set(id, rt);
    this.store.setState(id, 'running');
    this.store.addEvent(id, 'started', {});

    const ctx = {
      config: run.config, projectRoot: run.projectRoot, member: m.name, task: m.task,
      adapterDir: this.adapterDir, assignments: {}, skillsDir: this.skillsDir, env: this.env,
      timeoutMs: this.timeoutMs, budget: run.budget, depth: m.depth,
      teams: teamKeys(run.projectRoot), originRoot: run.projectRoot
    };
    // Teams in other projects and v1 adapters keep today's one-shot loop.
    if (run.config.members[m.name].team) return this.#finish(id, await runMember(ctx));
    const { resolved, caps } = await resolveCaps(ctx);
    if (caps.protocol !== 2) return this.#finish(id, await runMember(ctx));

    rt.resolved = resolved;
    const prep = prepareMember(ctx, { resolved, caps });
    rt.workspace = prep.workspace;
    this.store.setWorkspace(id, prep.workspace.dir);
    const brief = buildBrief({
      resolved, task: m.task, cwd: prep.workspace.dir, denyPaths: run.config.deny_paths,
      skillText: prep.skillText, dialectText: prep.dialectText,
      timeoutSec: Math.floor(this.timeoutMs / 1000), depth: m.depth, maxDepth: run.config.defaults.max_depth
    });
    brief.task += TEAM_NOTE;
    rt.session = new MemberSession({
      execPath: join(this.adapterDir, resolved.agent), cwd: prep.workspace.dir,
      env: { ...this.env, AGENT_TEAM_TEAM_SOCKET: this.socketPath, AGENT_TEAM_TEAM_TOKEN: m.token },
      onLine: (msg) => this.#onLine(id, msg),
      onExit: (code, stderr) => this.#onExit(id, code, stderr)
    });
    rt.session.send({ type: 'start', brief });
    this.#pump(id);   // anything sent while the member was queued
  }

  // ---- adapter lines ----

  #onLine(id, msg) {
    const rt = this.#live.get(id);
    if (!rt) return;
    if (msg.type === 'session') this.store.setHarness(id, msg.harness_id);
    else if (msg.type === 'event') this.store.addEvent(id, msg.kind, msg);
    else if (msg.type === 'ack') {
      if (rt.offered.delete(msg.message_id)) this.store.ackMessage(msg.message_id);
      rt.staleOffers.delete(msg.message_id);
      if (rt.idle) this.#pump(id);
    } else if (msg.type === 'idle') {
      // An offer can still be in flight when the turn ends, so requeueing it now would write it
      // twice. Only an offer that is still unacked at a second idle is treated as lost.
      for (const mid of rt.staleOffers) {
        if (rt.offered.delete(mid)) this.store.requeue(mid);
      }
      rt.staleOffers = new Set(rt.offered);
      rt.idle = true;
      this.#pump(id);
    } else if (msg.type === 'result') rt.result = msg;
  }

  #onExit(id, code, stderr) {
    const rt = this.#live.get(id);
    if (!rt) return;
    this.#finish(id, rt.result ?? {
      status: 'failed',
      summary: `adapter exited with code ${code} before a result: ${stderr.trim().slice(-1000)}`
    });
  }

  #finish(id, result) {
    const rt = this.#live.get(id);
    if (!rt) return;
    this.#live.delete(id);
    for (const mid of rt.offered) this.store.requeue(mid);
    if (rt.waiter) clearTimeout(rt.waiter.timer);
    if (rt.question) clearTimeout(rt.question.timer);
    const state = result.status === 'ok' ? 'done' : 'failed';
    this.store.setState(id, state);
    this.store.setResult(id, result);
    this.store.addEvent(id, 'finished', { status: result.status });
    if (state === 'done' && rt.workspace) pruneWorkspace(rt.workspace);

    const m = rt.member;
    if (m.parent_id != null) {
      const stat = result.artifacts?.diff_stat ? `\n${result.artifacts.diff_stat}` : '';
      this.store.enqueue({
        to: m.parent_id, fromKind: 'report', fromName: m.name, reportId: id,
        text: `finished ${result.status}: ${result.summary ?? ''}${stat}`
      });
      this.#pump(m.parent_id);
    } else {
      this.store.finishRun(m.run_id, state);
      for (const resolve of this.#runWaiters.get(m.run_id) ?? []) resolve(this.store.member(id).result);
      this.#runWaiters.delete(m.run_id);
    }
    this.#drain();
  }

  // ---- inbox delivery ----

  #openReports(id) {
    return this.store.children(id).filter((c) => !TERMINAL.has(c.state)).length;
  }

  // Exactly one path delivers each message: a blocked wait_for takes it as its tool result;
  // otherwise it is offered to the adapter and counts as delivered only when acked.
  #pump(id) {
    const rt = this.#live.get(id);
    if (!rt || !rt.session) return;    // queued, finished, or a v1 member: messages wait
    if (rt.waiter) {
      const msgs = this.#claim(rt, id, rt.waiter.reportIds);
      if (msgs.length) this.#resolveWaiter(id, { messages: msgs.map(render), timed_out: false });
      return;
    }
    if (rt.stopping) return;
    const msgs = this.store.offerQueued(id);
    for (const m of msgs) {
      rt.offered.add(m.id);
      rt.session.send({ type: 'message', id: m.id, from: label(m), text: m.text });
    }
    if (msgs.length) { rt.idle = false; return; }
    if (rt.idle && rt.offered.size === 0 && this.#openReports(id) === 0) {
      rt.stopping = true;
      rt.session.send({ type: 'stop' });
    }
  }

  #claim(rt, id, reportIds) {
    const msgs = this.store.claimForWait(id, reportIds);
    for (const m of msgs) { rt.offered.delete(m.id); rt.staleOffers.delete(m.id); }
    return msgs;
  }

  #resolveWaiter(id, value) {
    const rt = this.#live.get(id);
    if (!rt?.waiter) return;
    clearTimeout(rt.waiter.timer);
    const { resolve } = rt.waiter;
    rt.waiter = null;
    this.store.setState(id, 'running');
    resolve(value);
  }

  #resolveQuestion(id, value) {
    const rt = this.#live.get(id);
    if (!rt?.question) return;
    clearTimeout(rt.question.timer);
    const { resolve } = rt.question;
    rt.question = null;
    this.store.setState(id, 'running');
    resolve(value);
  }

  // ---- RPC ----

  async #handle({ token, method, params }) {
    const admin = {
      submit: (p) => this.submit(p),
      wait_run: (p) => this.waitRun(p.run_id),
      send: (p) => this.send(p),
      answer: (p) => this.answer(p)
    };
    if (Object.hasOwn(admin, method)) return admin[method](params);

    const tools = {
      delegate: (id, p) => this.#delegate(id, p),
      send_to: (id, p) => this.#sendTo(id, p),
      wait_for: (id, p) => this.#waitFor(id, p),
      report_progress: (id, p) => this.#reportProgress(id, p),
      ask_human: (id, p) => this.#askHuman(id, p)
    };
    if (!Object.hasOwn(tools, method)) throw new Error(`unknown tool "${method}"`);
    const m = typeof token === 'string' ? this.store.memberByToken(token) : null;
    if (!m || !this.#live.has(m.id)) throw new Error('this member is not running');
    return tools[method](m.id, params);
  }

  #reportProgress(id, { text }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('report_progress needs "text"');
    const m = this.#live.get(id).member;
    this.store.addEvent(id, 'progress', { text });
    if (m.parent_id != null) {
      this.store.enqueue({ to: m.parent_id, fromKind: 'report', fromName: m.name, reportId: id, text: `progress: ${text}` });
      this.#pump(m.parent_id);
    }
    return { ok: true };
  }

  // Filled in by Task 6.
  #delegate() { throw new Error('delegate is not implemented yet'); }
  #sendTo() { throw new Error('send_to is not implemented yet'); }
  #waitFor() { throw new Error('wait_for is not implemented yet'); }
  #askHuman() { throw new Error('ask_human is not implemented yet'); }
}

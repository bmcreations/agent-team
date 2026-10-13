import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';
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
// A directory of its own: ~/.cache/agent-team predates the supervisor and may be 0755.
const supervisorDir = (env) => join(cacheRoot(env), 'agent-team', 'supervisor');
export const defaultSocketPath = (env = process.env) =>
  env.AGENT_TEAM_SUPERVISOR_SOCK || join(supervisorDir(env), 'supervisor.sock');
export const defaultStorePath = (env = process.env) =>
  env.AGENT_TEAM_SUPERVISOR_DB || join(supervisorDir(env), 'supervisor.db');

// The socket's only access control is its directory, so the default one is locked to this
// user on every start, as channel/server.js does. A path the user named is left alone.
export function lockSupervisorDir(env = process.env) {
  if (env.AGENT_TEAM_SUPERVISOR_SOCK && env.AGENT_TEAM_SUPERVISOR_DB) return;
  const dir = supervisorDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

const label = (m) => `${m.from_name} (${m.from_kind})`;
const render = (m) => ({ id: m.id, from: label(m), text: m.text, report_id: m.report_id });
const clampSeconds = (v, dflt, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : dflt);

export class Supervisor {
  #live = new Map();          // memberId -> runtime state of a launched, unfinished member
  #pending = [];              // memberIds waiting for a slot
  #runs = new Map();          // runId -> { projectRoot, config, budget }
  #runWaiters = new Map();    // runId -> [resolve]
  #resumes = new Map();       // memberId -> { note } for a paused member's next launch
  #closing = false;
  #resolutions = new Map();   // memberId -> Promise of { resolved, caps } | { team: true } | { error }

  constructor({ store, adapterDir, skillsDir = null, socketPath, env = {}, maxRunning = 6,
                timeoutMs = DEFAULT_TIMEOUT_MS, graceMs = 5000 }) {
    Object.assign(this, { store, adapterDir, skillsDir, socketPath, env, maxRunning, timeoutMs, graceMs });
  }

  async start() {
    this.server = await serveRpc(this.socketPath, (req) => this.#handle(req));
  }

  // Ends every live adapter and leaves the members' states as they are, so the next start
  // can recover them. Blocked tool calls are settled first, or their RPC connections hang.
  async close() {
    this.#closing = true;
    const live = [...this.#live.values()];
    for (const rt of live) this.#settle(rt, { error: 'the agent-team supervisor is shutting down' });
    await Promise.all(live.map((rt) => rt.session?.end(this.graceMs)));
    await this.server?.close();
  }

  submit({ projectRoot, member, task, timeoutMs }) {
    const config = loadConfig(projectRoot);
    if (!Object.hasOwn(config.members, member)) throw new Error(`unknown member "${member}"`);
    const runId = this.store.createRun({ project: projectRoot, task });
    this.#runs.set(runId, { projectRoot, config, budget: { runs: config.defaults.max_delegations },
                         timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs });
    const { id } = this.store.addMember({ runId, parentId: null, name: member, task, depth: 0 });
    this.store.setRunRoot(runId, id);
    this.#resolve(this.store.member(id));
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
    // A stopping or cancelling member will not read another message. A pausing or paused one
    // will, after it is resumed.
    const rt = this.#live.get(member_id);
    if (TERMINAL.has(m.state) || rt?.stopping || rt?.halt?.kind === 'cancel') throw new Error(`"${m.name}" has finished — delegate a new task`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('a message needs text');
    const id = this.store.enqueue({ to: member_id, fromKind: 'human', fromName: from, text });
    this.#pump(member_id);
    return { message_id: id };
  }

  answer({ question_id, answer, by = 'local' }) {
    const q = this.store.question(question_id);
    if (!q || q.answer != null || q.closed) throw new Error(`question ${question_id} is no longer open`);
    if (!this.store.answerQuestion(question_id, answer, by)) throw new Error(`question ${question_id} is no longer open`);
    const rt = this.#live.get(q.member_id);
    if (rt?.question?.id === question_id) {
      this.#resolveQuestion(q.member_id, { answer, answered_by: by, timed_out: false });
    }
    return { ok: true };
  }

  // Open ask_human questions, newest last, with who asked; `answer` takes their ids.
  questions({ run_id = null } = {}) {
    return this.store.openQuestions().map((q) => {
      const m = this.store.member(q.member_id);
      return { id: q.id, run_id: m.run_id, member_id: m.id, member: m.name,
               question: q.question, options: q.options, asked_at: q.at };
    }).filter((q) => run_id == null || q.run_id === Number(run_id));
  }

  // Re-check the queue, e.g. after raising maxRunning.
  kick() {
    this.#drain();
  }

  // ---- intervention ----

  // Pause: stop after the current turn (now: interrupt it). Cancel: interrupt and end as
  // cancelled. Either keeps the workspace. With subtree, every unfinished member below too;
  // members that cannot be stopped are listed in `skipped` instead of failing the call.
  pause(p = {}) { return this.#intervene(p, 'pause'); }
  cancel(p = {}) { return this.#intervene(p, 'cancel'); }

  // Relaunches paused members in their own workspaces, with their harness session resumed
  // and `note` as the first user turn. Queued messages are delivered once the session is up.
  resume({ subtree = false, note = null, by = 'local', ...who } = {}) {
    const top = this.#target(who);
    if (!subtree) {
      this.#unpause(top, { note, by });
      return { members: [{ id: top.id, name: top.name }], skipped: [] };
    }
    const members = [];
    const skipped = [];
    for (const m of this.#subtree(top.id)) {
      try {
        this.#unpause(m, { note, by });
        members.push({ id: m.id, name: m.name });
      } catch (err) {
        skipped.push({ id: m.id, name: m.name, reason: err.message });
      }
    }
    return { members, skipped };
  }

  #unpause(m, { note, by }) {
    if (m.state !== 'paused') throw new Error(`"${m.name}" is not paused (${m.state})`);
    const paused = this.store.events(m.id).findLast((e) => e.kind === 'paused')?.body ?? {};
    const lines = [`Resumed by ${by}.`];
    if (paused.now) {
      lines.push('Your last turn was interrupted: a command it started may have partly run. ' +
                 'Check the workspace before repeating work.');
    }
    if (typeof note === 'string' && note.trim()) lines.push(`${by}: ${note}`);
    this.#resumes.set(m.id, { note: lines.join('\n') });
    this.store.setState(m.id, 'queued');
    this.store.addEvent(m.id, 'resumed', { by });
    this.#schedule(m.id);
  }

  #intervene({ subtree = false, now = false, by = 'local', ...who } = {}, kind) {
    const top = this.#target(who);
    if (!subtree) {
      this.#halt(top, kind, { now, by });
      return { members: [{ id: top.id, name: top.name }], skipped: [] };
    }
    const members = [];
    const skipped = [];
    // Deepest first, so a report's notice is in its manager's inbox before the manager stops.
    for (const m of this.#subtree(top.id).reverse()) {
      try {
        this.#halt(m, kind, { now, by });
        members.push({ id: m.id, name: m.name });
      } catch (err) {
        skipped.push({ id: m.id, name: m.name, reason: err.message });
      }
    }
    return { members, skipped };
  }

  // A member by id, or by run and name. Names repeat when a manager delegates to the same
  // report twice; the latest unfinished one is meant.
  #target({ member_id, run_id, member } = {}) {
    if (member_id != null) {
      const m = this.store.member(Number(member_id));
      if (!m) throw new Error(`unknown member ${member_id}`);
      return m;
    }
    if (run_id == null || typeof member !== 'string') throw new Error('name a member: member_id, or run_id and member');
    const matches = this.store.members(Number(run_id)).filter((m) => m.name === member);
    if (!matches.length) throw new Error(`run ${run_id} has no member "${member}"`);
    return matches.filter((m) => !TERMINAL.has(m.state)).at(-1) ?? matches.at(-1);
  }

  #subtree(id) {
    const out = [];
    const walk = (mid) => { out.push(this.store.member(mid)); for (const c of this.store.children(mid)) walk(c.id); };
    walk(id);
    return out;
  }

  // | state                    | pause                              | cancel                      |
  // | queued                   | paused at once                     | cancelled at once           |
  // | paused                   | error                              | cancelled at once           |
  // | launching (no session)   | marked; #launch stops before spawn | same                        |
  // | running or waiting       | blocked call settled, then stop    | blocked call settled, then  |
  // |                          | (now: interrupt)                   | interrupt                   |
  // | one-shot (v1), stopping, finished, already halting: an error, nothing changes        |
  #halt(m, kind, { now, by }) {
    const verb = kind === 'pause' ? 'paused' : 'cancelled';
    if (TERMINAL.has(m.state)) throw new Error(`"${m.name}" has already finished (${m.state})`);
    const rt = this.#live.get(m.id);
    if (!rt) {
      if (kind === 'pause' && m.state === 'paused') throw new Error(`"${m.name}" is already paused`);
      const i = this.#pending.indexOf(m.id);
      if (i >= 0) this.#pending.splice(i, 1);
      if (kind === 'cancel') return this.#conclude(m, 'cancelled', { status: 'failed', summary: `cancelled by ${by}` });
      return this.#paused(m, { by, now: false });
    }
    if (rt.oneShot) throw new Error(`"${m.name}" runs one-shot and cannot be ${verb} — wait for its result`);
    if (rt.halt?.kind === 'cancel') throw new Error(`"${m.name}" is already being cancelled`);
    if (rt.halt && kind === 'pause' && (!now || rt.halt.now)) throw new Error(`"${m.name}" is already being paused`);
    if (rt.stopping && !rt.halt) throw new Error(`"${m.name}" has finished its work and is stopping`);
    rt.halt = { kind, now: now || kind === 'cancel', by };
    // A harness cannot end its turn while a tool call is pending.
    const note = this.#haltNote(rt);
    if (rt.waiter) this.#settle(rt, { messages: [], timed_out: false, note });
    if (rt.question) this.#settle(rt, { answer: null, timed_out: false, note });
    if (!rt.session) return;   // still launching: #launch checks rt.halt before it spawns
    if (rt.halt.now) rt.session.end(this.graceMs);
    else rt.session.send({ type: 'stop' });
  }

  #haltNote(rt) {
    return `${rt.halt.kind === 'pause' ? 'paused' : 'cancelled'} by ${rt.halt.by} — end your turn now`;
  }

  // A halting member's adapter has exited, or it never spawned.
  #halted(id, rt) {
    this.#live.delete(id);
    for (const mid of rt.offered) this.store.requeue(mid);
    this.#settle(rt, { error: 'member stopped' });
    const { kind, by, now } = rt.halt;
    if (kind === 'cancel') {
      return this.#conclude(rt.member, 'cancelled', { status: 'failed', summary: `cancelled by ${by}` }, rt.workspace);
    }
    this.#paused(rt.member, { by, now });
  }

  #paused(m, { by, now }) {
    this.store.setState(m.id, 'paused');
    this.store.addEvent(m.id, 'paused', { by, now });
    this.#notifyManager(m, `paused by ${by}`);
    this.#drain();
  }

  #notifyManager(m, text) {
    if (m.parent_id == null) return;
    this.store.enqueue({ to: m.parent_id, fromKind: 'report', fromName: m.name, reportId: m.id, text });
    this.#pump(m.parent_id);
  }

  // ---- scheduling ----

  #schedule(id) {
    this.#pending.push(id);
    this.#drain();
  }

  // A member blocked in wait_for or ask_human holds no slot, or a manager waiting on its
  // reports would starve them. When it wakes the count can pass maxRunning until members
  // finish; that overshoot is the price of never deadlocking.
  #running() {
    let n = 0;
    for (const rt of this.#live.values()) if (!rt.waiter && !rt.question) n++;
    return n;
  }

  #drain() {
    for (const id of [...this.#pending]) {
      if (this.#running() >= this.maxRunning) return;
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

  #ctx(m) {
    const run = this.#runs.get(m.run_id);
    return {
      config: run.config, projectRoot: run.projectRoot, member: m.name, task: m.task,
      adapterDir: this.adapterDir, assignments: {}, skillsDir: this.skillsDir, env: this.env,
      timeoutMs: run.timeoutMs, budget: run.budget, depth: m.depth,
      teams: teamKeys(run.projectRoot), originRoot: run.projectRoot
    };
  }

  // Each member is resolved once, starting when it is created; #launch and #sendTo share the
  // answer. A failure is kept as { error } so it fails the launch, not the delegate call.
  #resolve(m) {
    let p = this.#resolutions.get(m.id);
    if (!p) {
      const { config } = this.#runs.get(m.run_id);
      p = config.members[m.name].team
        ? Promise.resolve({ team: true })
        : resolveCaps(this.#ctx(m)).catch((error) => ({ error }));
      this.#resolutions.set(m.id, p);
    }
    return p;
  }

  async #launch(id) {
    const m = this.store.member(id);
    const run = this.#runs.get(m.run_id);
    const resume = this.#resumes.get(id) ?? null;
    this.#resumes.delete(id);
    // Registered before any await, so #drain counts this member against the caps at once.
    const rt = { member: m, session: null, resolved: null, caps: null, workspace: null, result: null,
                 offered: new Set(), staleOffers: new Set(), idle: false, stopping: false, waiter: null, question: null };
    this.#live.set(id, rt);
    this.store.setState(id, 'running');
    this.store.addEvent(id, 'started', {});

    const ctx = this.#ctx(m);
    const r = await this.#resolve(m);
    if (r.error) throw r.error;
    if (rt.halt) return this.#halted(id, rt);   // paused or cancelled while resolving
    // Teams in other projects and v1 adapters keep today's one-shot loop, with no session
    // for send_to to deliver to.
    if (r.team || r.caps.protocol !== 2) {
      rt.oneShot = true;
      return this.#finish(id, await runMember(r.team ? ctx : { ...ctx, preresolved: r }));
    }

    const { resolved, caps } = r;
    rt.resolved = resolved;
    rt.caps = caps;
    // A member paused before its adapter ever ran has no workspace yet and starts fresh.
    const prep = prepareMember(ctx, { resolved, caps }, { workspaceDir: resume ? m.workspace : null });
    rt.workspace = prep.workspace;
    this.store.setWorkspace(id, prep.workspace.dir);
    const brief = buildBrief({
      resolved, task: m.task, cwd: prep.workspace.dir, denyPaths: run.config.deny_paths,
      skillText: prep.skillText, dialectText: prep.dialectText,
      timeoutSec: Math.floor(run.timeoutMs / 1000), depth: m.depth, maxDepth: run.config.defaults.max_depth
    });
    brief.task += TEAM_NOTE;
    rt.session = new MemberSession({
      execPath: join(this.adapterDir, resolved.agent), cwd: prep.workspace.dir,
      env: { ...this.env, AGENT_TEAM_TEAM_SOCKET: this.socketPath, AGENT_TEAM_TEAM_TOKEN: m.token },
      onLine: (msg) => this.#onLine(id, msg),
      onExit: (code, stderr) => this.#onExit(id, code, stderr)
    });
    // With no harness session to resume, the note rides along with the task instead.
    if (resume && !m.resume) brief.task += `\n\n${resume.note}`;
    rt.session.send({
      type: 'start', brief,
      resume: resume ? m.resume : null,
      note: resume && m.resume ? resume.note : null
    });
    this.#pump(id);   // anything sent while the member was queued
  }

  // ---- adapter lines ----

  #onLine(id, msg) {
    const rt = this.#live.get(id);
    if (!rt) return;
    if (msg.type === 'session') {
      this.store.setHarness(id, msg.harness_id);
      if (msg.resume != null) this.store.setResume(id, msg.resume);
    }
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
    if (this.#closing) {
      this.#live.delete(id);
      for (const mid of rt.offered) this.store.requeue(mid);
      return;
    }
    // Pausing or cancelling wins over whatever the adapter reported on its way out.
    if (rt.halt) return this.#halted(id, rt);
    this.#finish(id, rt.result ?? {
      status: 'failed',
      summary: `adapter exited with code ${code} before a result: ${stderr.trim().slice(-1000)}`
    });
  }

  #finish(id, result) {
    const rt = this.#live.get(id);
    // A v1 member finishing after close() has nothing to write to: the store may be closed.
    if (!rt || this.#closing) return;
    this.#live.delete(id);
    for (const mid of rt.offered) this.store.requeue(mid);
    this.#settle(rt, { error: 'member finished' });
    this.#conclude(rt.member, result.status === 'ok' ? 'done' : 'failed', result, rt.workspace);
  }

  // Records a member's terminal state, tells its manager or ends the run, and frees its slot.
  // Also used for members that are not live: a cancelled queued or paused member.
  #conclude(m, state, result, workspace = null) {
    const id = m.id;
    this.store.setState(id, state);
    this.store.setResult(id, result);
    this.store.addEvent(id, 'finished', { status: result.status, state });
    if (state === 'done' && workspace) pruneWorkspace(workspace);

    if (m.parent_id != null) {
      const stat = result.artifacts?.diff_stat ? `\n${result.artifacts.diff_stat}` : '';
      // Every terminal notice opens with "finished ", so a manager waiting for its reports
      // stops waiting on a cancelled one too.
      const outcome = state === 'cancelled' ? 'cancelled' : result.status;
      this.#notifyManager(m, `finished ${outcome}: ${result.summary ?? ''}${stat}`);
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
    // A human or the manager can cut a question short, as wait_for would be; a report's
    // progress is offered to the harness as usual and read after the answer.
    if (rt.question) {
      const msgs = this.store.claimForQuestion(id);
      for (const m of msgs) { rt.offered.delete(m.id); rt.staleOffers.delete(m.id); }
      if (msgs.length) {
        this.store.closeQuestion(rt.question.id);
        this.#resolveQuestion(id, {
          answer: null, timed_out: false, messages: msgs.map(render),
          note: 'question closed: a message arrived before an answer'
        });
      }
    }
    // A halting member's messages wait in the inbox for its resume.
    if (rt.stopping || rt.halt) return;
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

  // Ends a blocked wait_for or ask_human with `value`, leaving the member's state alone.
  #settle(rt, value) {
    if (rt.waiter) {
      clearTimeout(rt.waiter.timer);
      rt.waiter.resolve(value);
      rt.waiter = null;
    }
    if (rt.question) {
      clearTimeout(rt.question.timer);
      this.store.closeQuestion(rt.question.id);
      rt.question.resolve(value);
      rt.question = null;
    }
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
      answer: (p) => this.answer(p),
      questions: (p) => this.questions(p),
      pause: (p) => this.pause(p),
      cancel: (p) => this.cancel(p),
      resume: (p) => this.resume(p)
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

  #delegate(id, { to, task } = {}) {
    const rt = this.#live.get(id);
    const m = rt.member;
    const { config, budget } = this.#runs.get(m.run_id);
    if (rt.halt) throw new Error(`delegation refused: ${this.#haltNote(rt)}`);
    if (typeof to !== 'string' || typeof task !== 'string' || !task.trim()) {
      throw new Error('delegate needs "to" (a report\'s name) and "task"');
    }
    if (!rt.resolved.reports.includes(to)) throw new Error(`"${to}" is not a direct report of "${m.name}"`);
    if (m.depth >= config.defaults.max_depth) {
      throw new Error(`delegation refused: already at max_depth ${config.defaults.max_depth}`);
    }
    if (budget.runs <= 0) throw new Error('delegation budget exhausted (max_delegations)');
    budget.runs -= 1;
    const child = this.store.addMember({ runId: m.run_id, parentId: id, name: to, task, depth: m.depth + 1 });
    this.store.addEvent(id, 'delegated', { to, report_id: child.id });
    this.#resolve(this.store.member(child.id));
    this.#schedule(child.id);
    return { report_id: child.id };
  }

  // Along the reporting line only: the caller's manager, or one of its own reports.
  async #sendTo(id, { to, text } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('send_to needs "text"');
    const m = this.#live.get(id).member;
    const parent = m.parent_id != null ? this.store.member(m.parent_id) : null;
    let target;
    let fromKind;
    if (parent && (to === parent.name || to === parent.id)) {
      target = parent;
      fromKind = 'report';
    } else {
      const matches = this.store.children(id).filter((c) => c.id === to || c.name === to);
      target = matches.find((c) => !TERMINAL.has(c.state)) ?? matches.at(-1);
      fromKind = 'manager';
    }
    if (!target) throw new Error(`"${to}" is not your manager or one of your reports`);
    // A queued report may still be resolving; a v1 or team report has no session to read it.
    if (fromKind === 'manager') {
      const r = await this.#resolve(target);
      if (r.team || r.caps?.protocol !== 2) {
        throw new Error(`"${target.name}" runs one-shot and cannot receive messages — wait for its result`);
      }
    }
    // Same guard as send(): a stopping or cancelling member will not read another message. Re-read: the
    // target can have finished during the await.
    target = this.store.member(target.id);
    const live = this.#live.get(target.id);
    if (TERMINAL.has(target.state) || live?.stopping || live?.halt?.kind === 'cancel') {
      throw new Error(`"${target.name}" has finished — delegate a new task`);
    }
    const messageId = this.store.enqueue({
      to: target.id, fromKind, fromName: m.name, reportId: fromKind === 'report' ? id : null, text
    });
    this.#pump(target.id);
    return { message_id: messageId };
  }

  #waitFor(id, { report_ids = null, timeout_s } = {}) {
    const rt = this.#live.get(id);
    this.#assertNotBlocked(rt);
    if (rt.halt) return { messages: [], timed_out: false, note: this.#haltNote(rt) };
    // Models often send ids as strings.
    const reportIds = Array.isArray(report_ids) ? report_ids.map(Number).filter(Number.isInteger) : null;
    const msgs = this.#claim(rt, id, reportIds);
    if (msgs.length) return { messages: msgs.map(render), timed_out: false };
    // Every listed report is already finished and its messages are read: nothing can arrive.
    if (reportIds?.length && reportIds.every((rid) => {
      const r = this.store.member(rid);
      return r && TERMINAL.has(r.state);
    })) {
      return { messages: [], timed_out: false, note: 'no open reports' };
    }
    // Only a member that has delegated can have nothing left to wait for; a leaf calling
    // wait_for is waiting on its manager and blocks.
    if (reportIds == null && this.store.children(id).length > 0 && this.#openReports(id) === 0) {
      return { messages: [], timed_out: false, note: 'no open reports' };
    }
    const seconds = clampSeconds(timeout_s, WAIT_DEFAULT_S, WAIT_MAX_S);
    this.store.setState(id, 'waiting');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#resolveWaiter(id, { messages: [], timed_out: true }), seconds * 1000);
      rt.waiter = { resolve, timer, reportIds };
      this.#drain();   // a blocked member gives up its slot
    });
  }

  #assertNotBlocked(rt) {
    if (rt.waiter || rt.question) {
      const inCall = rt.waiter ? 'wait_for' : 'ask_human';
      throw new Error(`member "${rt.member.name}" is already blocked in ${inCall} — one blocking call at a time`);
    }
  }

  #askHuman(id, { question, options = null, timeout_s } = {}) {
    if (typeof question !== 'string' || !question.trim()) throw new Error('ask_human needs "question"');
    const rt = this.#live.get(id);
    this.#assertNotBlocked(rt);
    if (rt.halt) return { answer: null, timed_out: false, note: this.#haltNote(rt) };
    const opts = Array.isArray(options) ? options.filter((o) => typeof o === 'string') : null;
    const questionId = this.store.addQuestion({ memberId: id, question, options: opts });
    const seconds = clampSeconds(timeout_s, ASK_DEFAULT_S, ASK_MAX_S);
    this.store.setState(id, 'waiting');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.store.closeQuestion(questionId);
        this.#resolveQuestion(id, { answer: null, timed_out: true });
      }, seconds * 1000);
      rt.question = { id: questionId, resolve, timer };
      this.#drain();
    });
  }
}

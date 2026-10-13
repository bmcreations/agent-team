import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';
import { loadConfig } from './config.js';
import { buildBrief } from './brief.js';
import { resolveCaps, prepareMember, runMember, teamKeys, adapterPath } from './dispatch.js';
import { pruneWorkspace } from './workspace.js';
import { MemberSession } from './sessions.js';
import { serveRpc, isListening } from './rpc.js';
import { TEAM_NOTE } from './team-tools.js';
import { DEFAULT_TIMEOUT_MS } from './adapter.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
// Who a cascade names in its reports' "cancelled by ..." summary: whoever cancelled the
// manager, or the manager itself and how it ended. The live path and close() share it.
const cascadeBy = (m, state, by) => by ?? `${m.name} (${state})`;
// An adapter's `takeover` capability, shape-checked (adapter output is untrusted): null when
// the adapter does not declare it, else { notice: string | null }.
const takeoverCap = (caps) => {
  const t = caps?.takeover;
  if (!t || typeof t !== 'object') return null;
  return { notice: typeof t.notice === 'string' ? t.notice : null };
};
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

function checkCap(cap) {
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) throw new Error('max_cost_usd must be a positive number');
}

export class Supervisor {
  #live = new Map();          // memberId -> runtime state of a launched, unfinished member
  #pending = [];              // memberIds waiting for a slot
  #runs = new Map();          // runId -> { projectRoot, config, budget }
  #runWaiters = new Map();    // runId -> [resolve]
  #resumes = new Map();       // memberId -> { note } for a paused member's next launch
  #closing = false;
  #ticker = null;
  #lastTick = null;
  #resolutions = new Map();   // memberId -> Promise of { resolved, caps } | { team: true } | { error }

  constructor({ store, adapterDir, skillsDir = null, socketPath, env = {}, maxRunning = 6,
                timeoutMs = DEFAULT_TIMEOUT_MS, graceMs = 5000, tickMs = 1000, stopMs = null }) {
    // How long a member may take to exit after its final stop before it is ended.
    stopMs ??= Math.max(graceMs * 2, 10_000);
    Object.assign(this, { store, adapterDir, skillsDir, socketPath, env, maxRunning, timeoutMs, graceMs, tickMs, stopMs });
  }

  async start() {
    this.server = await serveRpc(this.socketPath, (req) => this.#handle(req));
    this.#ticker = setInterval(() => {
      // A throw here would be uncaught and take the supervisor down with every run in it.
      try { this.#tick(); } catch (err) { process.stderr.write(`agent-team: tick failed: ${err.stack ?? err}\n`); }
    }, this.tickMs);
    this.#ticker.unref();
  }

  // Ends every live adapter and leaves working members' states as they are, so the next start
  // can recover them. A pause, cancel, or timeout already under way is recorded as its outcome
  // instead (see #recordHalt). Blocked tool calls are settled first, or their RPC connections hang.
  async close() {
    this.#closing = true;
    clearInterval(this.#ticker);
    const live = [...this.#live.values()];
    for (const rt of live) {
      clearTimeout(rt.stopTimer);
      this.#settle(rt, { error: 'the agent-team supervisor is shutting down' });
    }
    // Halted while launching: no adapter will exit to record it.
    for (const rt of live) {
      if (rt.halt && !rt.session) {
        this.#live.delete(rt.member.id);
        this.#recordHalt(rt);
      }
    }
    await Promise.all(live.map((rt) => rt.session?.end(this.graceMs)));
    await this.server?.close();
  }

  submit({ projectRoot, member, task, timeoutMs, maxCostUsd }) {
    const config = loadConfig(projectRoot);
    if (!Object.hasOwn(config.members, member)) throw new Error(`unknown member "${member}"`);
    const limits = { budget: config.defaults.max_delegations,
                     timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs,
                     maxCostUsd: maxCostUsd ?? config.defaults.max_cost_usd };
    if (limits.maxCostUsd != null) checkCap(limits.maxCostUsd);
    // Limits and owner are stored so a restarted supervisor can rebuild the run.
    const runId = this.store.createRun({ project: projectRoot, task, ...limits, owner: this.socketPath });
    this.#runs.set(runId, { projectRoot, config, budget: { runs: limits.budget }, timeoutMs: limits.timeoutMs });
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

  send({ member_id, run_id, member, text, from = 'local' }) {
    const m = this.#target({ member_id, run_id, member });
    // A stopping or cancelling member will not read another message. A pausing or paused one
    // will, after it is resumed.
    const rt = this.#live.get(m.id);
    if (TERMINAL.has(m.state) || rt?.stopping || (rt?.halt && rt.halt.kind !== 'pause')) throw new Error(`"${m.name}" has finished — delegate a new task`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('a message needs text');
    const id = this.store.enqueue({ to: m.id, fromKind: 'human', fromName: from, text });
    this.#pump(m.id);
    return { message_id: id };
  }

  answer({ question_id, answer, by = 'local' }) {
    const q = this.store.question(question_id);
    if (!q || q.answer != null || q.closed) throw new Error(`question ${question_id} is no longer open`);
    // The asker's wait lives in the supervisor running its run; an answer written here would
    // never reach it.
    this.#owned(this.store.member(q.member_id));
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
  resume({ subtree = false, note = null, by = 'local', max_cost_usd = null, ...who } = {}) {
    const top = this.#target(who);
    // A raised cap is kept only if something actually resumes.
    const restoreCap = this.#allowSpend(top.run_id, max_cost_usd);
    if (!subtree) {
      try {
        this.#unpause(top, { note, by });
      } catch (err) {
        restoreCap();
        throw err;
      }
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
    if (members.length === 0) restoreCap();
    return { members, skipped };
  }

  // Hands a member's harness session to a human: its turn is interrupted, and once its adapter
  // has exited (so two processes never write one session) it is marked taken_over. The caller
  // runs `argv` (the adapter's `attach`) in `cwd` and calls handback when the human is done.
  // Any adapter that declares the `takeover` capability can be taken over.
  async takeover({ by = 'local', ...who } = {}) {
    const target = this.#target(who);
    if (TERMINAL.has(target.state)) throw new Error(`"${target.name}" has already finished (${target.state})`);
    const r = await this.#resolve(target);
    const m = this.store.member(target.id);   // it may have moved while resolving
    if (r.team || !takeoverCap(r.caps)) {
      throw new Error(`"${m.name}" runs ${r.team ? 'a team in another project' : r.resolved?.agent ?? 'nothing'}, which does not support take-over`);
    }
    // Already taken over (an attach that died): hand the same session out again.
    if (m.state === 'taken_over') return this.#takeoverPayload(m, r);
    // Checked before pausing, so a member with no session to hand over is left as it was.
    if (m.state === 'queued') throw new Error(`"${m.name}" has not started yet — there is no session to take over`);
    if (!TERMINAL.has(m.state) && m.state !== 'paused' && !m.resume) throw new Error(`"${m.name}" has no harness session yet — try again in a moment`);
    if (m.state !== 'paused') {
      const rt = this.#live.get(m.id);
      this.#halt(m, 'pause', { now: true, by });
      await rt?.session?.exited;
    }
    const now = this.store.member(m.id);
    if (TERMINAL.has(now.state)) throw new Error(`"${m.name}" has already finished (${now.state})`);
    if (now.state !== 'paused') throw new Error(`"${m.name}" is still pausing — run attach again in a moment`);
    if (!now.resume || !now.workspace) throw new Error(`"${m.name}" has no harness session yet — resume it instead`);
    this.store.setState(m.id, 'taken_over');
    this.store.addEvent(m.id, 'taken_over', { by });
    this.#notifyManager(now, `taken over by ${by}`);
    return this.#takeoverPayload(now, r);
  }

  // `notice` is what the human should know before the harness starts; {cwd} is the workspace.
  #takeoverPayload(m, r) {
    const { notice } = takeoverCap(r.caps);
    return {
      member_id: m.id, name: m.name, cwd: m.workspace,
      argv: [adapterPath(this.adapterDir, r.resolved.agent), 'attach', m.resume],
      harness: r.resolved.agent,
      notice: notice?.replaceAll('{cwd}', m.workspace) ?? null
    };
  }

  // The human's terminal session has ended: run the member headless again from that session.
  // drove is false when the human's harness never started, so there is nothing to tell it.
  // A run at its cost cap leaves the member paused until a resume raises the cap; `skipped`
  // says why. The cap is met here by what other members spent while this one was taken over:
  // the human's own turns are not seen until the member's next turn after it resumes, when the
  // adapter reports the session's cost since the member's recorded spend.
  handback({ by = 'local', drove = true, ...who } = {}) {
    const m = this.#target(who);
    // A cancelled subtree takes its taken-over members with it. attach reads this wording.
    if (TERMINAL.has(m.state)) throw new Error(`"${m.name}" has already finished (${m.state})`);
    if (m.state !== 'taken_over') throw new Error(`"${m.name}" is not taken over (${m.state})`);
    this.store.setState(m.id, 'paused');
    this.store.addEvent(m.id, 'handed_back', { by });
    const { cost_usd: spent, max_cost_usd: cap } = this.store.run(m.run_id);
    if (cap != null && spent >= cap) {
      this.store.addEvent(m.id, 'cost_cap', { cost_usd: spent, max_cost_usd: cap });
      const reason = `run is at its cost cap ($${spent.toFixed(2)} of $${cap.toFixed(2)})`;
      this.#notifyManager(m, `handed back by ${by}, still paused: ${reason}`);
      return { members: [], skipped: [{ id: m.id, name: m.name, reason }] };
    }
    this.#notifyManager(m, `handed back by ${by}`);
    this.#unpause(this.store.member(m.id), { note: null, by, drove });
    return { members: [{ id: m.id, name: m.name }], skipped: [] };
  }

  // A run paused at its cost cap resumes only with a higher cap. Stores `cap` once it passes
  // and returns a function that puts the previous cap back.
  #allowSpend(runId, cap) {
    if (cap != null) checkCap(cap);
    const run = this.store.run(runId);
    const limit = cap ?? run.max_cost_usd;
    if (limit != null && run.cost_usd >= limit) {
      throw new Error(`run ${runId} has spent $${run.cost_usd.toFixed(2)} of its $${limit.toFixed(2)} cap — ` +
                      'pass max_cost_usd to raise it');
    }
    if (cap == null) return () => {};
    this.store.setRunCap(runId, cap);
    return () => this.store.setRunCap(runId, run.max_cost_usd);
  }

  #unpause(m, { note, by, drove = false }) {
    if (m.state !== 'paused') throw new Error(`"${m.name}" is not paused (${m.state})`);
    const paused = this.store.events(m.id).findLast((e) => e.kind === 'paused')?.body ?? {};
    const lines = [`Resumed by ${by}.`];
    if (paused.now) {
      lines.push('Your last turn was interrupted: a command it started may have partly run. ' +
                 'Check the workspace before repeating work.');
    }
    if (drove) {
      lines.push(`${by} drove this session in a terminal while you were paused; their turns are ` +
                 'in your history. Continue from where they left off.');
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
      return this.#owned(m);
    }
    if (run_id == null || typeof member !== 'string') throw new Error('name a member: member_id, or run_id and member');
    const matches = this.store.members(Number(run_id)).filter((m) => m.name === member);
    if (!matches.length) throw new Error(`run ${run_id} has no member "${member}"`);
    return this.#owned(matches.filter((m) => !TERMINAL.has(m.state)).at(-1) ?? matches.at(-1));
  }

  // Another supervisor (a CLI's in-process one) may be running this member's run. A finished
  // run is forgotten once its members are, and every member in it has finished: let the
  // caller say so.
  #owned(m) {
    if (!this.#runs.has(m.run_id) && this.store.run(m.run_id).status === 'running') {
      throw new Error(`run ${m.run_id} is run by another supervisor (${this.store.run(m.run_id).owner})`);
    }
    return m;
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
    if (m.state === 'taken_over' && kind === 'pause') throw new Error(`"${m.name}" is taken over by a human`);
    const rt = this.#live.get(m.id);
    if (!rt) {
      if (kind === 'pause' && m.state === 'paused') throw new Error(`"${m.name}" is already paused`);
      const i = this.#pending.indexOf(m.id);
      if (i >= 0) this.#pending.splice(i, 1);
      if (kind === 'cancel') return this.#conclude(m, 'cancelled', { status: 'failed', summary: `cancelled by ${by}` }, null, by);
      return this.#paused(m, { by, now: false });
    }
    if (rt.oneShot) throw new Error(`"${m.name}" runs one-shot and cannot be ${verb} — wait for its result`);
    if (rt.halt && rt.halt.kind !== 'pause') {
      throw new Error(`"${m.name}" is already being ${rt.halt.kind === 'cancel' ? 'cancelled' : 'stopped: it timed out'}`);
    }
    if (rt.halt && kind === 'pause' && (!now || rt.halt.now)) throw new Error(`"${m.name}" is already being paused`);
    // A stopping member has nothing left to pause, but cancel still ends one that hangs.
    if (rt.stopping && !rt.halt && kind === 'pause') throw new Error(`"${m.name}" has finished its work and is stopping`);
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
    const verb = { pause: 'paused', cancel: 'cancelled', timeout: 'stopped' }[rt.halt.kind];
    return `${verb} by ${rt.halt.by} — end your turn now`;
  }

  // A halting member's adapter has exited, or it never spawned.
  #halted(id, rt) {
    this.#live.delete(id);
    for (const mid of rt.offered) this.store.requeue(mid);
    this.#settle(rt, { error: 'member stopped' });
    const { kind, by, now } = rt.halt;
    if (kind === 'cancel') {
      return this.#conclude(rt.member, 'cancelled', { status: 'failed', summary: `cancelled by ${by}` }, rt.workspace, by);
    }
    if (kind === 'timeout') {
      return this.#conclude(rt.member, 'failed', { status: 'failed', summary: `timed out after ${rt.halt.seconds}s of work` }, rt.workspace);
    }
    this.#paused(rt.member, { by, now });
  }

  // A halt under way when the supervisor closes, written straight to the store: #halted would
  // drain the queue and pump inboxes, launching work on a supervisor that is going away. The
  // manager's notice waits in its inbox. A root that ends, or a member that is cancelled, takes
  // its unfinished reports with it, as #conclude does, or recover() would relaunch them under a
  // manager that is gone (or, for a root, they would sit `running` in a finished run).
  #recordHalt(rt) {
    const m = rt.member;
    const { kind, by, now } = rt.halt;
    if (TERMINAL.has(this.store.member(m.id).state)) return;
    if (kind === 'pause') {
      this.store.setState(m.id, 'paused');
      this.store.addEvent(m.id, 'paused', { by, now });
      if (m.parent_id != null) this.#enqueueNotice(m, `paused by ${by}`);
      return;
    }
    const result = kind === 'cancel'
      ? { status: 'failed', summary: `cancelled by ${by}` }
      : { status: 'failed', summary: `timed out after ${rt.halt.seconds}s of work` };
    const state = kind === 'cancel' ? 'cancelled' : 'failed';
    const record = (x, st, res) => {
      this.store.setState(x.id, st);
      this.store.setResult(x.id, res);
      this.store.addEvent(x.id, 'finished', { status: res.status, state: st });
    };
    record(m, state, result);
    // A cancelled or failed manager's reports go with it, as they do live; otherwise recover()
    // relaunches them under a manager that has finished.
    const cascaded = { status: 'failed', summary: `cancelled by ${cascadeBy(m, state, kind === 'cancel' ? by : null)}` };
    for (const d of this.#subtree(m.id).slice(1)) {
      if (!TERMINAL.has(d.state)) record(d, 'cancelled', cascaded);
    }
    if (m.parent_id != null) {
      this.#enqueueNotice(m, `finished ${kind === 'cancel' ? 'cancelled' : 'failed'}: ${result.summary}`);
      return;
    }
    this.store.finishRun(m.run_id, state);
    for (const resolve of this.#runWaiters.get(m.run_id) ?? []) resolve(this.store.member(m.id).result);
    this.#runWaiters.delete(m.run_id);
  }

  #enqueueNotice(m, text) {
    this.store.enqueue({ to: m.parent_id, fromKind: 'report', fromName: m.name, reportId: m.id, text });
  }

  #paused(m, { by, now }) {
    this.store.setState(m.id, 'paused');
    this.store.addEvent(m.id, 'paused', { by, now });
    this.#notifyManager(m, `paused by ${by}`);
    this.#drain();
  }

  #notifyManager(m, text) {
    if (m.parent_id == null) return;
    this.#enqueueNotice(m, text);
    this.#pump(m.parent_id);
  }

  // ---- limits ----

  // Every tickMs. Only a member doing work counts toward its timeout and its stall clock: one
  // blocked in wait_for or ask_human, idle between turns, or already stopping is waiting on
  // someone else. A plain pause waits for the current turn, which still counts: a turn that
  // runs past the timeout is ended and the member fails as timed out, not paused. The timeout counts from each launch, so a resumed member gets it afresh.
  #tick() {
    const at = Date.now();
    // One late tick (a busy event loop) must not charge a burst of work at once.
    const elapsed = Math.min(at - (this.#lastTick ?? at), 2 * this.tickMs);
    this.#lastTick = at;
    for (const [id, rt] of this.#live) {
      if (!rt.session) continue;
      // A member pausing at the end of its turn is still working that turn.
      const finishingTurn = rt.halt?.kind === 'pause' && !rt.halt.now;
      if (rt.waiter || rt.question || rt.idle || (rt.halt && !finishingTurn) || rt.stopping) { rt.quietSince = at; continue; }
      rt.activeMs += elapsed;
      const { timeoutMs, config } = this.#runs.get(rt.member.run_id);
      if (rt.activeMs >= timeoutMs) {
        this.store.addEvent(id, 'timed_out', { after_s: timeoutMs / 1000 });
        rt.halt = { kind: 'timeout', now: true, by: 'timeout', seconds: timeoutMs / 1000 };
        rt.session.end(this.graceMs);
        continue;
      }
      if (!rt.stalled && at - rt.quietSince >= config.defaults.stall_minutes * 60_000) {
        rt.stalled = true;
        const quiet = Math.round((at - rt.quietSince) / 1000);
        this.store.addEvent(id, 'stalled', { quiet_s: quiet });
        this.#notifyManager(rt.member, `stalled: no events for ${quiet}s`);
      }
    }
  }

  // Harness-reported cost, charged to the run and to the member that spent it. Past the run's
  // cap, the whole run pauses after its current turns.
  #spend(runId, memberId, usd) {
    const total = this.store.addRunCost(runId, usd, memberId);
    const { max_cost_usd: cap, root_member: root } = this.store.run(runId);
    if (cap == null || total < cap || TERMINAL.has(this.store.member(root).state)) return;
    const { members } = this.#intervene({ member_id: root, subtree: true, by: 'cost cap' }, 'pause');
    if (members.length) this.store.addEvent(root, 'cost_cap', { cost_usd: total, max_cost_usd: cap });
  }

  // ---- recovery ----

  // Adopts runs left running by a supervisor that is gone: this one before a restart, or a
  // CLI's in-process one. `serve` calls it once after start(). Members that were working are
  // relaunched from their harness sessions within the caps; paused ones stay paused.
  async recover() {
    const out = { recovered: [], failed: [] };
    for (const run of this.store.runsWithStatus('running')) {
      if (this.#runs.has(run.id)) continue;
      if (run.owner == null) {
        // Written before runs recorded an owner: no way to tell whether it is alive.
        this.#failRun(run, 'left by an older agent-team; start it again');
        out.failed.push(run.id);
        continue;
      }
      // serve listens on its fixed path before recovering, so its own old runs look alive.
      if (run.owner !== this.socketPath && await isListening(run.owner)) continue;
      if (!this.store.claimRun(run.id, run.owner, this.socketPath)) continue;   // another recoverer won
      let config;
      try {
        config = loadConfig(run.project);
      } catch (err) {
        this.#failRun(run, `could not recover after a supervisor restart: ${err.message}`);
        out.failed.push(run.id);
        continue;
      }
      this.#runs.set(run.id, {
        projectRoot: run.project, config,
        budget: { runs: run.budget ?? config.defaults.max_delegations },
        timeoutMs: run.timeout_ms ?? this.timeoutMs
      });
      for (const m of this.store.members(run.id)) this.#recoverMember(m);
      out.recovered.push(run.id);
    }
    return out;
  }

  #recoverMember(m) {
    // A taken-over member may still be in a human's terminal; handback resumes it.
    if (TERMINAL.has(m.state) || m.state === 'paused' || m.state === 'taken_over') return;
    this.store.requeueOffered(m.id);
    if (m.state === 'queued') {
      // Queued after a resume: it has a workspace and maybe a session to go back to.
      if (m.workspace) this.#resumes.set(m.id, { note: 'Resumed after an agent-team supervisor restart.' });
      return this.#schedule(m.id);
    }
    // running or waiting: its process ended with the old supervisor.
    for (const q of this.store.openQuestions()) if (q.member_id === m.id) this.store.closeQuestion(q.id);
    const lines = ['The agent-team supervisor restarted while you were working, and your last turn ' +
                   'was cut off: a command it started may have partly run. Check the workspace ' +
                   'before repeating work.'];
    if (m.state === 'waiting') lines.push('A wait_for or ask_human call you were in was ended; call it again if you still need it.');
    const reports = this.store.children(m.id);
    if (reports.length) {
      lines.push('Your reports now:', ...reports.map((r) => `- ${r.name} (#${r.id}): ${r.state}`));
    }
    this.store.addEvent(m.id, 'interrupted', { by: 'supervisor restart' });
    this.store.setState(m.id, 'queued');
    this.#resumes.set(m.id, { note: lines.join('\n'), restart: true });
    this.#schedule(m.id);
  }

  // A run that cannot be rebuilt: every unfinished member fails with the reason.
  #failRun(run, summary) {
    for (const m of this.store.members(run.id)) {
      if (TERMINAL.has(m.state)) continue;
      for (const q of this.store.openQuestions()) if (q.member_id === m.id) this.store.closeQuestion(q.id);
      this.store.setState(m.id, 'failed');
      this.store.setResult(m.id, { status: 'failed', summary });
      this.store.addEvent(m.id, 'finished', { status: 'failed', state: 'failed' });
    }
    this.store.finishRun(run.id, 'failed');
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
    if (this.#closing) return;
    for (const id of [...this.#pending]) {
      if (this.#running() >= this.maxRunning) return;
      const m = this.store.member(id);
      if (m.parent_id != null) {
        const { config } = this.#runs.get(m.run_id);
        const running = this.store.children(m.parent_id).filter((c) => this.#live.has(c.id)).length;
        if (running >= config.defaults.max_parallel) continue;
      }
      this.#pending.splice(this.#pending.indexOf(id), 1);
      this.#launch(id).catch((err) => {
        this.#live.get(id)?.session?.end(this.graceMs);   // #finish forgets it, so it must not outlive us
        this.#finish(id, { status: 'failed', summary: err.message });
      });
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
  // answer. A failure is returned as { error } so it fails the launch, not the delegate call.
  #resolve(m) {
    let p = this.#resolutions.get(m.id);
    if (!p) {
      const { config } = this.#runs.get(m.run_id);
      p = config.members[m.name].team
        ? Promise.resolve({ team: true })
        : resolveCaps(this.#ctx(m)).catch((error) => ({ error }));
      this.#resolutions.set(m.id, p);
      // A failure is not kept past this launch, so a resume tries again.
      p.then((r) => { if (r.error && this.#resolutions.get(m.id) === p) this.#resolutions.delete(m.id); });
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
                 offered: new Set(), staleOffers: new Set(), idle: false, stopping: false, waiter: null, question: null,
                 activeMs: 0, quietSince: null, stalled: false };
    this.#live.set(id, rt);
    this.store.setState(id, 'running');
    this.store.addEvent(id, 'started', {});

    const ctx = this.#ctx(m);
    const r = await this.#resolve(m);
    if (this.#closing) return;   // close() has recorded any halt; a working member is recovered
    // Paused or cancelled while resolving. A cancel wins over a failed resolution; a paused
    // member resolves afresh on resume.
    if (rt.halt) return this.#halted(id, rt);
    if (r.error) throw r.error;
    // For the web view and the report: the resolution is not otherwise kept.
    this.store.setHarnessInfo(id, r.team
      ? { agent: 'team' }
      : { agent: r.resolved.agent, model: r.resolved.model, readOnly: r.resolved.isolation !== 'workspace' });
    // Teams in other projects and v1 adapters keep today's one-shot loop, with no session
    // for send_to to deliver to.
    if (r.team || r.caps.protocol !== 2) {
      rt.oneShot = true;
      // A one-shot member has no session to resume after a restart.
      if (resume?.restart) return this.#finish(id, { status: 'failed', summary: 'interrupted by a supervisor restart' });
      const result = await runMember(r.team ? ctx : { ...ctx, preresolved: r });
      if (!this.#closing) this.store.setBudget(m.run_id, run.budget.runs);   // a team spends the run's budget too
      return this.#finish(id, result);
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
      execPath: adapterPath(this.adapterDir, resolved.agent), cwd: prep.workspace.dir,
      env: { ...this.env, AGENT_TEAM_TEAM_SOCKET: this.socketPath, AGENT_TEAM_TEAM_TOKEN: m.token },
      onLine: (msg) => this.#onLine(id, msg),
      onExit: (code, stderr) => this.#onExit(id, code, stderr)
    });
    rt.quietSince = Date.now();   // resolving and preparing the workspace are not quiet time
    // With no harness session to resume, the note rides along with the task instead.
    if (resume && !m.resume) brief.task += `\n\n${resume.note}`;
    // A resumed harness session may report its cost cumulatively from the session's start
    // (claude does), so the member's spend so far goes along as the baseline.
    rt.session.send({
      type: 'start', brief,
      resume: resume ? m.resume : null,
      note: resume && m.resume ? resume.note : null,
      ...(resume && m.resume ? { cost_usd: m.cost_usd, tokens: m.tokens } : {})
    });
    this.#pump(id);   // anything sent while the member was queued
  }

  // ---- adapter lines ----

  #onLine(id, msg) {
    const rt = this.#live.get(id);
    if (!rt) return;
    rt.quietSince = Date.now();
    rt.stalled = false;
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
      if (msg.cost_usd) this.#spend(rt.member.run_id, id, msg.cost_usd);
      if (msg.tokens) this.store.addTokens(rt.member.run_id, id, msg.tokens);   // never counts toward the cost cap
      this.#pump(id);
    } else if (msg.type === 'result') rt.result = msg;
  }

  #onExit(id, code, stderr) {
    const rt = this.#live.get(id);
    if (!rt) return;
    clearTimeout(rt.stopTimer);
    if (this.#closing) {
      this.#live.delete(id);
      for (const mid of rt.offered) this.store.requeue(mid);
      if (rt.halt) this.#recordHalt(rt);
      return;
    }
    // Pausing or cancelling wins over whatever the adapter reported on its way out.
    if (rt.halt) return this.#halted(id, rt);
    if (rt.stopOverdue) {
      return this.#finish(id, rt.result ?? {
        status: 'failed', summary: `the adapter did not exit within ${this.stopMs / 1000}s of being asked to stop`
      });
    }
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
  #conclude(m, state, result, workspace = null, by = null) {
    const id = m.id;
    // A run never ends with members still at work, and a report whose manager was cancelled or
    // failed has nobody left to report to. Pausing a manager alone leaves its reports working.
    if (m.parent_id == null || state !== 'done') this.#cancelReports(m, cascadeBy(m, state, by));
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
    this.#resolutions.delete(id);
    this.#forgetRun(m.run_id);
    this.#drain();
  }

  // A finished run is dropped once none of its members is live or queued; reports cancelled
  // with their root can still be stopping when the run ends.
  #forgetRun(runId) {
    if (this.store.run(runId).status === 'running') return;
    for (const rt of this.#live.values()) if (rt.member.run_id === runId) return;
    if (this.#pending.some((id) => this.store.member(id).run_id === runId)) return;
    this.#runs.delete(runId);
  }

  // Deepest first, as cancel --subtree does. A report already halting or finished is skipped.
  #cancelReports(m, by) {
    for (const d of this.#subtree(m.id).slice(1).reverse()) {
      if (TERMINAL.has(d.state)) continue;
      try { this.#halt(d, 'cancel', { now: true, by }); } catch { /* already cancelling or finished */ }
    }
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
      // An adapter that hangs on its way out would hold its slot forever.
      rt.stopTimer = setTimeout(() => {
        if (this.#live.get(id) !== rt || rt.halt) return;
        rt.stopOverdue = true;
        rt.session.end(this.graceMs);
      }, this.stopMs);
      rt.stopTimer.unref();
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
      resume: (p) => this.resume(p),
      takeover: (p) => this.takeover(p),
      handback: (p) => this.handback(p)
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
    this.store.setBudget(m.run_id, budget.runs);
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
    // Before resolving: a finished member's resolution is forgotten.
    if (TERMINAL.has(target.state)) throw new Error(`"${target.name}" has finished — delegate a new task`);
    // A queued report may still be resolving; a v1 or team report has no session to read it.
    if (fromKind === 'manager') {
      const r = await this.#resolve(target);
      if (r.team || r.caps?.protocol !== 2) {
        throw new Error(`"${target.name}" runs one-shot and cannot receive messages — wait for its result`);
      }
    }
    // Same guard as send(): a stopping, cancelling, or timing-out member will not read another message. Re-read: the
    // target can have finished during the await.
    target = this.store.member(target.id);
    const live = this.#live.get(target.id);
    if (TERMINAL.has(target.state) || live?.stopping || (live?.halt && live.halt.kind !== 'pause')) {
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

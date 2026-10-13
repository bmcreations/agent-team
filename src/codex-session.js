// `adapters/codex session`: one member as a long-lived `codex app-server` over stdio JSON-RPC,
// so the supervisor can steer it mid-run. The wire shapes are the ones probed from codex-cli
// 0.162.1 (plan 1b-2, "Codex behaviour this plan relies on"); test/fixtures/fake-codex plays
// them in tests.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/agent-team.js', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// codex's own MCP tool timeout (default 300 s) must outlast the longest blocking team tool
// (ask_human, 7200 s).
export const CODEX_TOOL_TIMEOUT_SEC = 7500;
const STDERR_TAIL = 2000;
// How long the app-server gets to exit after the supervisor has gone before it is killed.
const ORPHAN_GRACE_MS = 2000;

const codexBin = () => process.env.AGENT_TEAM_CODEX_BIN || 'codex';

function threadParams(brief, env) {
  const params = {
    cwd: brief.cwd, approvalPolicy: 'never', sandbox: brief.read_only ? 'read-only' : 'workspace-write',
    config: {
      mcp_servers: {
        'agent-team': {
          command: process.execPath, args: [BIN, 'mcp'],
          env: { AGENT_TEAM_TEAM_SOCKET: env.AGENT_TEAM_TEAM_SOCKET ?? '', AGENT_TEAM_TEAM_TOKEN: env.AGENT_TEAM_TEAM_TOKEN ?? '' },
          default_tools_approval_mode: 'approve', tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC
        }
      }
    },
    ephemeral: false
  };
  if (brief.model) params.model = brief.model;
  if (brief.effort) params.config.model_reasoning_effort = brief.effort;
  return params;
}

// The reply to a server-initiated request. With approvalPolicy 'never' these should not occur;
// each is answered so a turn can never hang, and nothing is approved on the member's behalf.
function serverReply(method, params) {
  switch (method) {
    case 'mcpServer/elicitation/request':
      return { result: params?.serverName === 'agent-team' ? { action: 'accept', content: {} } : { action: 'decline' } };
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: 'denied' } };
    default:
      return { error: { code: -32601, message: 'not supported by agent-team' } };
  }
}

const mcpResultText = (item) => (item.error?.message
  ?? (Array.isArray(item.result?.content) ? item.result.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('') : ''));

// `artifacts(cwd, logDir)` is the v1 adapter's diff reader, so a session's result carries the
// same artifacts a `run` result does.
export function runCodexSession({ artifacts }) {
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const logDir = mkdtempSync(join(tmpdir(), 'agent-team-codex-'));
  const logPath = join(logDir, 'session.log');
  const log = createWriteStream(logPath);
  let brief = null;
  let server = null;
  let stderr = '';
  let threadId = null;
  let nextId = 1;
  const pending = new Map();   // request id -> { resolve, reject }
  let inTurn = false;
  let turnId = null;        // the running turn's id, once turn/start's reply or turn/started names it
  let turnSeq = 0;          // identifies the latest turn/start, so a late reply is not taken for a newer turn
  let queue = [];           // messages not yet sent: { id, text, seq }
  let messageSeq = 0;
  let interrupting = false;
  let stopping = false;
  let killedByUs = false;   // we ended the server on purpose; any other exit is a crash
  let startError = null;
  // thread/tokenUsage/updated carries the thread's cumulative total; each idle reports the
  // change since the previous turn ended.
  let total = 0;
  let baseline = 0;
  let reported = 0;
  let turns = 0;
  let turnText = '';
  let turnFinal = false;
  let lastText = '';
  let lastError = false;

  const write = (m) => { if (server?.stdin.writable) server.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    write({ id, method, params });
  });
  const finish = (result) => process.stdout.write(JSON.stringify({ type: 'result', ...result }) + '\n', () => process.exit(0));
  const textInput = (text) => [{ type: 'text', text, text_elements: [] }];
  const endServer = () => {
    stopping = true;
    killedByUs = true;
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), ORPHAN_GRACE_MS).unref();
  };
  const sendInterrupt = () => { request('turn/interrupt', { threadId, turnId }).catch(() => {}); };

  function failStart(err) {
    const what = err.phase === 'turn' ? 'codex rejected the turn' : 'codex app-server did not start a session';
    startError = `${what}: ${err.message} ${stderr.trim()}`.trim();
    endServer();
  }

  function setTurnId(id) {
    if (turnId || !id) return;
    turnId = id;
    if (interrupting) sendInterrupt();
    flush();
  }

  function startTurn(text, ackId = null) {
    inTurn = true;
    turnId = null;
    const seq = ++turnSeq;
    return request('turn/start', { threadId, input: textInput(text) })
      .catch((err) => { throw Object.assign(err, { phase: 'turn' }); })
      .then((r) => {
        if (ackId !== null) out({ type: 'ack', message_id: ackId });
        if (seq === turnSeq && inTurn) setTurnId(r?.turn?.id);
      });
  }

  // Messages for the running turn go in as steers once its id is known. A steer that loses the
  // race with the end of the turn goes back to the queue and runs as the next turn.
  function flush() {
    if (!inTurn || !turnId || stopping || interrupting) return;
    while (queue.length) {
      const m = queue.shift();
      request('turn/steer', { threadId, input: textInput(m.text), expectedTurnId: turnId }).then(
        () => out({ type: 'ack', message_id: m.id }),
        () => { queue.push(m); queue.sort((a, b) => a.seq - b.seq); drain(); }
      );
    }
  }

  // Between turns, the head of the queue starts the next one; the rest steer into it.
  function drain() {
    if (inTurn || stopping || interrupting || !threadId || !queue.length) return;
    const m = queue.shift();
    startTurn(m.text, m.id).catch(failStart);
  }

  function onItem(item, phase) {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'mcpToolCall') {
      const name = `${item.server}.${item.tool}`;
      if (phase === 'started') out({ type: 'event', kind: 'tool_call', name, args: item.arguments ?? {} });
      else out({ type: 'event', kind: 'tool_result', name, is_error: item.status !== 'completed', text: mcpResultText(item).slice(0, 2000) });
      return;
    }
    if (phase !== 'completed') return;
    if (item.type === 'agentMessage') {
      out({ type: 'event', kind: 'text', text: item.text ?? '' });
      // A final_answer message wins over later non-final ones.
      if (item.phase === 'final_answer') { turnText = item.text ?? ''; turnFinal = true; }
      else if (!turnFinal) turnText = item.text ?? '';
    } else if (item.type === 'commandExecution') {
      out({ type: 'event', kind: 'command', command: item.command, exit_code: item.exitCode ?? null });
    } else {
      out({ type: 'event', kind: item.type });
    }
  }

  function onTurnCompleted(turn) {
    inTurn = false;
    turns++;
    const delta = Math.max(0, total - baseline);
    baseline = total;
    reported += delta;
    lastError = turn?.status === 'failed';
    lastText = turnText;
    if (lastError) {
      const failure = `codex turn failed: ${turn.error?.message ?? 'unknown error'}`;
      lastText = lastText ? `${lastText}\n${failure}` : failure;
    }
    turnText = '';
    turnFinal = false;
    turnId = null;
    out({ type: 'idle', ...(interrupting || turn?.status === 'interrupted' ? { interrupted: true } : {}), ...(delta > 0 ? { tokens: delta } : {}) });
    if (stopping || interrupting) endServer();
    else drain();
  }

  function onNotification(m) {
    const p = m.params ?? {};
    if (p.threadId && p.threadId !== threadId) return;   // another thread's traffic on the same server
    if (m.method === 'turn/started') { if (inTurn) setTurnId(p.turn?.id); }
    else if (m.method === 'item/started') onItem(p.item, 'started');
    else if (m.method === 'item/completed') onItem(p.item, 'completed');
    else if (m.method === 'thread/tokenUsage/updated') {
      if (Number.isFinite(p.tokenUsage?.total?.totalTokens)) total = p.tokenUsage.total.totalTokens;
    } else if (m.method === 'turn/completed') onTurnCompleted(p.turn);
  }

  function onServerLine(line) {
    log.write(line + '\n');
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined && m.method) write({ id: m.id, ...serverReply(m.method, m.params) });
    else if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? 'codex request failed'));
      else p.resolve(m.result);
    } else if (m.method) onNotification(m);
  }

  function onServerExit(code, signal) {
    // An interrupt answers with idle, not a result.
    if (interrupting && !startError) return log.end(() => process.stdout.write('', () => process.exit(0)));
    const usage = { tokens: reported, session_id: threadId, turns };
    let outcome;
    if (startError) outcome = { status: 'failed', summary: startError };
    else if (!stopping) {
      outcome = { status: 'failed', summary: `codex app-server exited (${signal ?? `code ${code}`}) before it was asked to stop: ${stderr.trim()}` };
    } else if (inTurn && !killedByUs) {
      // A stop was requested mid-turn, but the server died before the turn finished.
      outcome = { status: 'failed', summary: `codex app-server exited (${signal ?? `code ${code}`}) before the turn finished: ${stderr.trim()}` };
    } else outcome = { status: lastError ? 'failed' : 'ok', summary: lastText };
    const art = artifacts(brief.cwd, logDir);
    log.end(() => finish({ ...outcome, usage, permission_denials: [], findings: [], checked_sound: [],
                           artifacts: art, log_path: logPath }));
  }

  async function begin(resume, note) {
    await request('initialize', { clientInfo: { name: 'agent-team', version: VERSION } });
    write({ method: 'initialized' });
    let text = brief.task;
    if (resume) {
      // The restored thread needs the team tools again: config is not part of its history.
      const { ephemeral, model, ...params } = threadParams(brief, process.env);
      const restored = await request('thread/resume', { threadId: resume, excludeTurns: true, ...params });
      threadId = restored?.thread?.id ?? resume;
      text = note ?? 'Continue where you left off.';
    } else {
      const started = await request('thread/start', threadParams(brief, process.env));
      threadId = started.thread.id;
    }
    out({ type: 'session', harness_id: threadId, resume: threadId });
    if (interrupting) return;
    await startTurn(text);
    drain();
  }

  function start({ brief: b, resume = null, note = null, tokens = null }) {
    brief = b;
    // thread/resume re-emits the restored total; the recorded total keeps it out of the first idle.
    if (resume && Number.isInteger(tokens) && tokens > 0) baseline = tokens;
    if (!existsSync(brief.cwd)) return finish({ status: 'failed', summary: `cwd does not exist: ${brief.cwd}`, log_path: logPath });
    // The team token reaches codex only inside the thread config, not through its own env.
    const env = { ...process.env };
    delete env.AGENT_TEAM_TEAM_TOKEN;
    delete env.AGENT_TEAM_TEAM_SOCKET;
    server = spawn(codexBin(), ['app-server'], { cwd: brief.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    server.stdin.on('error', () => {});
    server.stderr.on('data', (d) => { log.write(d); stderr = (stderr + d).slice(-STDERR_TAIL); });
    server.on('error', (err) => { stderr += `\n${err.message}`; });
    createInterface({ input: server.stdout }).on('line', onServerLine);
    server.on('close', onServerExit);
    begin(resume, note).catch(failStart);
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'start' && !server) start(m);
    else if (m.type === 'message') {
      if (stopping || interrupting) return;
      queue.push({ id: m.id, text: `[from: ${m.from}] ${m.text}`, seq: messageSeq++ });
      drain();
      flush();
    } else if (m.type === 'interrupt' && !interrupting) {
      interrupting = true;
      queue = [];
      if (!server) { out({ type: 'idle', interrupted: true }); process.stdout.write('', () => process.exit(0)); }
      else if (inTurn) { if (turnId) sendInterrupt(); }
      else { out({ type: 'idle', interrupted: true }); endServer(); }
    } else if (m.type === 'stop') {
      // Between turns the server can go now; mid-turn it goes once the turn has completed.
      if (inTurn) stopping = true;
      else endServer();
    }
  }).on('close', () => {
    // The supervisor closed our stdin or died. The server would finish its turn first, writing to
    // the thread that a recovering supervisor resumes in a second server, so the turn is
    // interrupted and the server killed if it is still there after a short grace.
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    if (inTurn && !interrupting && !stopping) {
      interrupting = true;
      if (turnId) sendInterrupt();
    } else if (!stopping) endServer();
    killedByUs = true;
    setTimeout(() => server.kill('SIGTERM'), ORPHAN_GRACE_MS).unref();
    setTimeout(() => server.kill('SIGKILL'), ORPHAN_GRACE_MS * 2).unref();
  });
  // With the supervisor gone, writing to stdout fails; the exit path must still run.
  process.stdout.on('error', () => {});

  // The supervisor's last resort after an interrupt is SIGTERM; the server goes with us.
  process.on('SIGTERM', () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      // Unref'd timers cannot keep us alive, so the grace is a detached killer.
      spawn(process.execPath, ['-e', `setTimeout(()=>{try{process.kill(${server.pid},'SIGKILL')}catch{}},${ORPHAN_GRACE_MS})`],
            { detached: true, stdio: 'ignore' }).unref();
    }
    process.exit(143);
  });
}

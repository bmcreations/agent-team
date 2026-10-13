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
  let stopping = false;
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
  const endServer = () => { stopping = true; server?.kill('SIGTERM'); };

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
    out({ type: 'idle', ...(turn?.status === 'interrupted' ? { interrupted: true } : {}), ...(delta > 0 ? { tokens: delta } : {}) });
    if (stopping) endServer();
  }

  function onNotification(m) {
    const p = m.params ?? {};
    if (p.threadId && p.threadId !== threadId) return;   // another thread's traffic on the same server
    if (m.method === 'item/started') onItem(p.item, 'started');
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
    const usage = { tokens: reported, session_id: threadId, turns };
    let outcome;
    if (startError) outcome = { status: 'failed', summary: startError };
    else if (!stopping) {
      outcome = { status: 'failed', summary: `codex app-server exited (${signal ?? `code ${code}`}) before it was asked to stop: ${stderr.trim()}` };
    } else outcome = { status: lastError ? 'failed' : 'ok', summary: lastText };
    const art = artifacts(brief.cwd, logDir);
    log.end(() => finish({ ...outcome, usage, permission_denials: [], findings: [], checked_sound: [],
                           artifacts: art, log_path: logPath }));
  }

  async function begin() {
    await request('initialize', { clientInfo: { name: 'agent-team', version: VERSION } });
    write({ method: 'initialized' });
    const started = await request('thread/start', threadParams(brief, process.env));
    threadId = started.thread.id;
    out({ type: 'session', harness_id: threadId, resume: threadId });
    inTurn = true;
    await request('turn/start', { threadId, input: [{ type: 'text', text: brief.task, text_elements: [] }] });
  }

  function start({ brief: b }) {
    brief = b;
    if (!existsSync(brief.cwd)) return finish({ status: 'failed', summary: `cwd does not exist: ${brief.cwd}`, log_path: logPath });
    server = spawn(codexBin(), ['app-server'], { cwd: brief.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    server.stdin.on('error', () => {});
    server.stderr.on('data', (d) => { log.write(d); stderr = (stderr + d).slice(-STDERR_TAIL); });
    server.on('error', (err) => { stderr += `\n${err.message}`; });
    createInterface({ input: server.stdout }).on('line', onServerLine);
    server.on('close', onServerExit);
    begin().catch((err) => { startError = `codex app-server did not start a session: ${err.message} ${stderr.trim()}`.trim(); endServer(); });
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'start' && !server) start(m);
    else if (m.type === 'stop') {
      // Between turns the server can go now; mid-turn it goes once the turn has completed.
      if (inTurn) stopping = true;
      else endServer();
    }
  }).on('close', () => {
    // The supervisor closed our stdin or died: the server must not outlive it.
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    stopping = true;
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), ORPHAN_GRACE_MS).unref();
  });
  // With the supervisor gone, writing to stdout fails; the exit path must still run.
  process.stdout.on('error', () => {});

  // The supervisor's last resort after an interrupt is SIGTERM; the server goes with us.
  process.on('SIGTERM', () => { server?.kill('SIGTERM'); process.exit(143); });
}

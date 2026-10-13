// `adapters/claude session`: one member as a long-lived `claude -p` speaking stream-json, so
// the supervisor can steer it mid-run. The wire formats are the ones probed in the spec
// ("Harness behaviour this design relies on"); test/fixtures/fake-claude plays them in tests.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/agent-team.js', import.meta.url));
// claude's own MCP tool timeout must outlast the longest blocking team tool (ask_human, 7200 s).
export const MCP_TOOL_TIMEOUT_MS = 7_260_000;
const STDERR_TAIL = 2000;

export function claudeSessionArgs(brief, { resume, mcpConfig }) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--replay-user-messages', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__agent-team__*',
    // Plan mode admits the team tools because each declares readOnlyHint.
    '--permission-mode', brief.read_only ? 'plan' : (brief.permission_mode ?? 'auto')
  ];
  if (resume) args.push('--resume', resume);
  if (brief.model) args.push('--model', brief.model);
  if (brief.effort) args.push('--effort', brief.effort);
  if (brief.advisor) args.push('--settings', JSON.stringify({ advisorModel: brief.advisor }));
  return args;
}

// The team MCP server, as `agent-team mcp` with this member's socket and token. Written to a
// file in a 0700 directory, not passed inline, so the token stays out of `ps`.
function writeMcpConfig(dir, env) {
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify({
    mcpServers: {
      'agent-team': {
        command: process.execPath, args: [BIN, 'mcp'],
        env: { AGENT_TEAM_TEAM_SOCKET: env.AGENT_TEAM_TEAM_SOCKET ?? '', AGENT_TEAM_TEAM_TOKEN: env.AGENT_TEAM_TEAM_TOKEN ?? '' }
      }
    }
  }), { mode: 0o600 });
  return path;
}

const blocksText = (content) => (Array.isArray(content)
  ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
  : String(content ?? ''));

// `artifacts(cwd, logDir)` is the v1 adapter's diff reader, so a session's result carries the
// same artifacts a `run` result does.
export function runClaudeSession({ artifacts }) {
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const logDir = mkdtempSync(join(tmpdir(), 'agent-team-claude-'));
  const logPath = join(logDir, 'session.log');
  const log = createWriteStream(logPath);
  let brief = null;
  let claude = null;
  let stderr = '';
  const pending = new Map();   // uuid of an injected user line -> inbox message id
  let sessionId = null;
  let inTurn = false;
  let stopping = false;
  let interrupting = false;
  let cost = 0;                // claude's total_cost_usd is cumulative for the process
  let turns = 0;
  let lastText = '';
  let lastError = false;
  const denied = [];

  const write = (m) => { if (claude?.stdin.writable) claude.stdin.write(JSON.stringify(m) + '\n'); };
  // Content must be a list of blocks: claude drops a plain string sent mid-run without a word.
  const userTurn = (text) => {
    const uuid = randomUUID();
    write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, uuid });
    inTurn = true;
    return uuid;
  };
  const finish = (result) => process.stdout.write(JSON.stringify({ type: 'result', ...result }) + '\n', () => process.exit(0));
  const endClaude = () => { stopping = true; claude?.stdin.end(); };

  function onClaudeLine(line) {
    log.write(line + '\n');
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (!e || typeof e !== 'object') return;
    if (e.type === 'system' && e.subtype === 'init' && !sessionId && e.session_id) {
      sessionId = e.session_id;
      out({ type: 'session', harness_id: sessionId, resume: sessionId });
    } else if (e.type === 'user') {
      // An injected line counts as delivered when claude replays it, which is when it was
      // consumed. The interrupt's synthetic user lines carry no isReplay.
      if (e.isReplay && pending.has(e.uuid)) {
        out({ type: 'ack', message_id: pending.get(e.uuid) });
        pending.delete(e.uuid);
      }
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'tool_result') {
          out({ type: 'event', kind: 'tool_result', tool_use_id: b.tool_use_id ?? null, is_error: b.is_error === true,
                text: blocksText(b.content).slice(0, 2000) });
        }
      }
      if (e.isReplay) out({ type: 'event', kind: 'user', text: blocksText(e.message?.content) });
    } else if (e.type === 'assistant') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'text' && b.text) out({ type: 'event', kind: 'text', text: b.text });
        else if (b.type === 'tool_use') out({ type: 'event', kind: 'tool_call', name: b.name, args: b.input ?? {} });
      }
    } else if (e.type === 'result') {
      inTurn = false;
      turns++;
      const total = Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : cost;
      const delta = Math.max(0, total - cost);
      cost = Math.max(cost, total);
      lastError = e.is_error === true;
      if (typeof e.result === 'string') lastText = e.result;
      for (const d of e.permission_denials ?? []) denied.push(d.tool_name);
      out({ type: 'idle', ...(interrupting ? { interrupted: true } : {}), ...(delta > 0 ? { cost_usd: delta } : {}) });
      if (interrupting) endClaude();
    }
  }

  function onClaudeExit(code, signal) {
    if (interrupting) return log.end(() => process.exit(0));   // an interrupt answers with idle, not a result
    const usage = { cost_usd: cost, session_id: sessionId, turns };
    let outcome;
    if (!stopping) {
      outcome = { status: 'failed', summary: `claude exited (${signal ?? `code ${code}`}) before it was asked to stop: ${stderr.trim()}` };
    } else if (!brief.read_only && denied.length) {
      outcome = { status: 'failed', summary: `claude refused ${denied.length} tool call(s): ${denied.join(', ')}. Member summary: ${lastText}` };
    } else {
      outcome = { status: lastError ? 'failed' : 'ok', summary: lastText };
    }
    const art = artifacts(brief.cwd, logDir);
    log.end(() => finish({ ...outcome, usage, permission_denials: denied, findings: [], checked_sound: [],
                           artifacts: art, log_path: logPath }));
  }

  function start({ brief: b, resume = null, note = null }) {
    brief = b;
    if (!existsSync(brief.cwd)) return finish({ status: 'failed', summary: `cwd does not exist: ${brief.cwd}`, log_path: logPath });
    const mcpConfig = writeMcpConfig(logDir, process.env);
    claude = spawn('claude', claudeSessionArgs(brief, { resume, mcpConfig }), {
      cwd: brief.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) }
    });
    claude.stdin.on('error', () => {});
    claude.stderr.on('data', (d) => { log.write(d); stderr = (stderr + d).slice(-STDERR_TAIL); });
    claude.on('error', (err) => { stderr += `\n${err.message}`; });
    createInterface({ input: claude.stdout }).on('line', onClaudeLine);
    claude.on('close', onClaudeExit);
    userTurn(resume ? (note ?? 'Continue where you left off.') : brief.task);
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'start' && !claude) start(m);
    else if (m.type === 'message') pending.set(userTurn(`[from: ${m.from}] ${m.text}`), m.id);
    else if (m.type === 'stop') endClaude();
    else if (m.type === 'interrupt' && !interrupting) {
      interrupting = true;
      if (!claude) { out({ type: 'idle', interrupted: true }); return process.stdout.write('', () => process.exit(0)); }
      if (inTurn) write({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } });
      else { out({ type: 'idle', interrupted: true }); endClaude(); }
    }
  }).on('close', () => { if (claude && !stopping) endClaude(); });

  // The supervisor's last resort after an interrupt is SIGTERM; claude goes with us.
  process.on('SIGTERM', () => { claude?.kill('SIGTERM'); process.exit(143); });
}

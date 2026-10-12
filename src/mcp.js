import { createInterface } from 'node:readline';
import { callRpc } from './rpc.js';
import { TOOL_SCHEMAS } from './team-tools.js';
import { version } from './version.js';

// The team tools as a stdio MCP server, hand-rolled like channel/server.js because the plugin
// has no install step. The harness spawns one per member; it holds no state and forwards each
// call to the supervisor with the member's token, so the supervisor, not the member, decides
// who the caller is. Resolves once stdin closes and in-flight calls have been answered.
export function runMcpServer({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const socket = env.AGENT_TEAM_TEAM_SOCKET;
  const token = env.AGENT_TEAM_TEAM_TOKEN;
  const send = (m) => output.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const toolError = (id, text) => send({ id, result: { content: [{ type: 'text', text }], isError: true } });
  const pending = new Set();
  const toolNames = new Set(TOOL_SCHEMAS.map((t) => t.name));

  async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
    const { id, method, params } = msg;
    if (id === undefined) return;     // notifications need no reply
    try {
      await route(id, method, params);
    } catch (err) {
      send({ id, error: { code: -32603, message: err.message } });
    }
  }

  async function route(id, method, params) {
    if (method === 'initialize') {
      return send({ id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-team', version }
      } });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOL_SCHEMAS } });
    if (method === 'tools/call') {
      // The socket also serves supervisor admin methods; only the team tools may be forwarded.
      if (typeof params?.name !== 'string' || !toolNames.has(params.name)) {
        return toolError(id, `unknown tool "${params?.name}"`);
      }
      if (!socket || !token) return toolError(id, 'AGENT_TEAM_TEAM_SOCKET and AGENT_TEAM_TEAM_TOKEN must be set');
      try {
        // No timeout: wait_for legitimately blocks for minutes.
        const result = await callRpc(socket, { token, method: params?.name, params: params?.arguments ?? {} });
        // Handlers report refusals such as 'member finished' as {error} rather than throwing.
        if (result?.error) return toolError(id, String(result.error));
        return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] } });
      } catch (err) {
        return toolError(id, err.message);
      }
    }
    send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }

  const rl = createInterface({ input });
  rl.on('line', (line) => {
    const p = handle(line).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });
  return new Promise((resolve) => {
    rl.on('close', () => Promise.allSettled([...pending]).then(resolve));
  });
}

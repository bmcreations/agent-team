import { loadConfig } from './config.js';
import { resolveCaps } from './dispatch.js';
import { openStore } from './store.js';
import { Supervisor, defaultSocketPath, defaultStorePath } from './supervisor.js';
import { isListening, callRpc, SupervisorRunning } from './rpc.js';

export async function isLiveMember({ projectRoot, member, adapterDir, env = {} }) {
  const config = loadConfig(projectRoot);
  if (config.members[member]?.team) return false;
  const { caps } = await resolveCaps({ config, member, adapterDir, assignments: {}, env });
  return caps.protocol === 2;
}

async function submitRemote(socketPath, { projectRoot, member, task, timeoutMs }) {
  const { runId } = await callRpc(socketPath, { method: 'submit', params: { projectRoot, member, task, ...(timeoutMs ? { timeoutMs } : {}) } });
  return callRpc(socketPath, { method: 'wait_run', params: { run_id: runId } });
}

// Submit to the machine's supervisor if one is listening; otherwise run one in-process for
// the length of this run, so one-shot use and the /delegate skill need no `serve` running.
export async function runThroughSupervisor({ projectRoot, member, task, adapterDir, skillsDir = null, env = {}, timeoutMs }) {
  const merged = { ...process.env, ...env };
  const socketPath = defaultSocketPath(merged);
  if (await isListening(socketPath)) return submitRemote(socketPath, { projectRoot, member, task, timeoutMs });

  const store = openStore(defaultStorePath(merged));
  const sup = new Supervisor({ store, adapterDir, skillsDir, socketPath, env, ...(timeoutMs ? { timeoutMs } : {}) });
  try {
    await sup.start();
  } catch (err) {
    store.close();
    if (err instanceof SupervisorRunning) return submitRemote(socketPath, { projectRoot, member, task, timeoutMs });
    throw err;
  }
  try {
    const { runId } = sup.submit({ projectRoot, member, task });
    return await sup.waitRun(runId);
  } finally {
    await sup.close();
    store.close();
  }
}

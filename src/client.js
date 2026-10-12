import { join, dirname } from 'node:path';
import { loadConfig } from './config.js';
import { resolveCaps } from './dispatch.js';
import { openStore } from './store.js';
import { Supervisor, defaultSocketPath, defaultStorePath, lockSupervisorDir } from './supervisor.js';
import { isListening, callRpc } from './rpc.js';

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

let inprocCount = 0;

// Submit to the machine's supervisor if one is listening; otherwise run one in-process for
// the length of this run, so one-shot use and the /delegate skill need no `serve` running.
// The in-process supervisor listens on a socket of its own, beside the shared one, that only
// its members are told about: another CLI that found it would submit there and lose its run
// when this one closes.
export async function runThroughSupervisor({ projectRoot, member, task, adapterDir, skillsDir = null, env = {}, timeoutMs }) {
  const merged = { ...process.env, ...env };
  const sharedPath = defaultSocketPath(merged);
  if (await isListening(sharedPath)) return submitRemote(sharedPath, { projectRoot, member, task, timeoutMs });

  lockSupervisorDir(merged);
  const socketPath = join(dirname(sharedPath), `inproc-${process.pid}-${++inprocCount}.sock`);
  const store = openStore(defaultStorePath(merged));
  const sup = new Supervisor({ store, adapterDir, skillsDir, socketPath, env, ...(timeoutMs ? { timeoutMs } : {}) });
  try {
    await sup.start();
  } catch (err) {
    store.close();
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

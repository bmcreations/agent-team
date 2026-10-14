import { join, dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { resolveCaps } from './dispatch.js';
import { openStore } from './store.js';
import { Supervisor, defaultSocketPath, defaultStorePath, lockSupervisorDir } from './supervisor.js';
import { isListening, callRpc } from './rpc.js';

// Resolves the root member once: whether it runs live, and the resolution dispatch() reuses
// for a v1 member so its adapter is not probed twice. A member that cannot be resolved is
// reported as v1 with nothing to reuse, so dispatch() fails it and records the run.
export async function resolveRootMember({ projectRoot, member, adapterDir, env = {} }) {
  try {
    const config = loadConfig(projectRoot);
    if (config.members[member]?.team) return { live: false, preresolved: null };
    const preresolved = await resolveCaps({ config, member, adapterDir, assignments: {}, env });
    return { live: preresolved.caps.protocol === 2, preresolved };
  } catch {
    return { live: false, preresolved: null };
  }
}

async function submitRemote(socketPath, { projectRoot, member, task, timeoutMs, title, fresh, onSubmitted }) {
  const { runId, attached = false } = await callRpc(socketPath, { method: 'submit', params: {
    projectRoot, member, task, ...(timeoutMs ? { timeoutMs } : {}), ...(title ? { title } : {}), ...(fresh ? { fresh: true } : {}) } });
  onSubmitted?.({ runId, attached, remote: true });
  return callRpc(socketPath, { method: 'wait_run', params: { run_id: runId } });
}

let inprocCount = 0;

// `onSubmitted({ runId, attached, remote })` runs as soon as the run exists, before the wait.
// Submit to the machine's supervisor if one is listening; otherwise run one in-process for
// the length of this run, so one-shot use and the /delegate skill need no `serve` running.
// The in-process supervisor listens on a socket of its own, beside the shared one, that only
// its members are told about: another CLI that found it would submit there and lose its run
// when this one closes.
export async function runThroughSupervisor({ projectRoot, member, task, adapterDir, skillsDir = null, env = {}, timeoutMs, title, fresh = false, onSubmitted }) {
  projectRoot = resolve(projectRoot);   // a running `serve` has its own cwd
  const merged = { ...process.env, ...env };
  const sharedPath = defaultSocketPath(merged);
  if (await isListening(sharedPath)) return submitRemote(sharedPath, { projectRoot, member, task, timeoutMs, title, fresh, onSubmitted });

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
    const { runId } = sup.submit({ projectRoot, member, task, title });
    onSubmitted?.({ runId, attached: false, remote: false });
    return await sup.waitRun(runId);
  } finally {
    await sup.close();
    store.close();
  }
}

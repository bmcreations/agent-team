import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { defaultSocketPath } from './supervisor.js';
import { isListening, callRpc } from './rpc.js';

// The CLI side of the admin RPCs. Only `agent-team serve` listens on the shared socket; a
// CLI's in-process supervisor has a private one, so its runs cannot be steered from here.
export async function adminCall(method, params, env = process.env) {
  const socketPath = defaultSocketPath(env);
  if (!(await isListening(socketPath))) {
    throw new Error(`no agent-team supervisor is listening on ${socketPath}. ` +
                    'Start one with `agent-team serve` and run the team through it.');
  }
  return callRpc(socketPath, { method, params });
}

// `<run> <member>` from the positionals after the verb.
export function memberArgs([run, member]) {
  const runId = Number(run);
  if (!Number.isInteger(runId) || runId <= 0 || !member) throw new Error('name a member: <run-id> <member>');
  return { run_id: runId, member };
}

export const whoAmI = () => userInfo().username;

export function renderQuestions(questions) {
  if (!questions.length) return 'no open questions\n';
  return questions.map((q) => {
    const options = q.options?.length ? ` [${q.options.join(' | ')}]` : '';
    return `#${q.id}  run ${q.run_id}  ${q.member}: ${q.question}${options}\n`;
  }).join('');
}

// `agent-team attach`: take the member over, run its harness session in this terminal, and
// hand it back when the human exits, whatever the exit. Ctrl-C belongs to the harness while it
// runs; without ignoring it here, this process would die before handing back.
export async function attach(who, { call = adminCall, run = spawnSync, log = (s) => process.stderr.write(s) } = {}) {
  const by = whoAmI();
  const t = await call('takeover', { ...who, by });
  log(`agent-team: ${t.name} is paused and yours. claude may first ask whether to trust ${t.cwd}.\n` +
      'agent-team: exit claude to hand the session back.\n');
  const ignore = () => {};
  process.on('SIGINT', ignore);
  let r;
  try {
    r = run(t.argv[0], t.argv.slice(1), { cwd: t.cwd, stdio: 'inherit' });
  } finally {
    process.off('SIGINT', ignore);
  }
  if (r.error) log(`agent-team: could not run ${t.argv[0]}: ${r.error.message}\n`);
  return call('handback', { member_id: t.member_id, by });
}

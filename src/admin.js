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

import { execFileSync } from 'node:child_process';
import { runAdapter } from '../src/adapter.js';
import { buildBrief } from '../src/brief.js';

const REQUIRED_CAPS = ['write', 'workspace', 'structured_output', 'tool_dialect'];

export async function conformanceReport(execPath, { env = {}, cwd = undefined, reports = [] } = {}) {
  const failures = [];

  // probe's contract (src/dispatch.js's makeProbe) is exit-code only: a cheap
  // availability check, not a JSON envelope. capabilities and run are the two
  // subcommands that carry runAdapter's "last line of stdout is JSON" contract.
  try {
    execFileSync(execPath, ['probe'], {
      stdio: 'pipe', env: { ...process.env, ...env }, cwd, timeout: 30_000
    });
  } catch (e) {
    failures.push({ step: 'probe', detail: e.message });
  }

  const caps = await runAdapter(execPath, 'capabilities', { env, cwd, timeoutMs: 30_000 });
  if (caps.status === 'failed') {
    failures.push({ step: 'capabilities', detail: caps.summary });
  } else {
    for (const k of REQUIRED_CAPS) {
      if (!(k in caps)) failures.push({ step: 'capabilities', detail: `missing key: ${k}` });
    }
  }

  // The brief an adapter is probed with is built by the same function the dispatcher
  // uses, so a change to the brief shape cannot pass conformance and fail in production.
  const brief = buildBrief({
    resolved: {
      member: 'researcher',
      title: 'Researcher',
      agent: 'mock',
      model: null,
      skill: null,
      charter: null,
      persona: null,
      isolation: 'read-only',
      deliverable: 'text',
      output_path: null,
      reports_to: null,
      reports,
      warning: null
    },
    task: 'Reply with a one-sentence summary of what directory you are in. Change nothing.',
    cwd: cwd ?? process.cwd(),
    denyPaths: ['**/.env*'],
    timeoutSec: 120
  });

  const run = await runAdapter(execPath, 'run', { env, cwd, timeoutMs: 120_000, brief });

  if (!['ok', 'failed', 'timeout', 'delegating'].includes(run.status)) {
    failures.push({ step: 'run', detail: `status must be ok|failed|timeout|delegating, got ${run.status}` });
  }
  if (run.status === 'ok' && typeof run.summary !== 'string') {
    failures.push({ step: 'run', detail: 'a successful run must carry a string summary' });
  }
  // A distinct step name — not just wording — so a test can tell this cross-check apart
  // from the plain status-validity check above without relying on substring matching in
  // "detail" (both messages legitimately mention "delegating" now that it is a valid status).
  if (brief.can_delegate === false && run.status === 'delegating') {
    failures.push({
      step: 'delegation-guard',
      detail: 'answered "delegating" for a brief that forbids delegation'
    });
  }

  return { conformant: failures.length === 0, failures, brief };
}

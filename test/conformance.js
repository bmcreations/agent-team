import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { runAdapter } from '../src/adapter.js';
import { buildBrief } from '../src/brief.js';

const REQUIRED_CAPS = ['write', 'workspace', 'structured_output', 'tool_dialect'];

// null means "could not read git status here" — either cwd is not a git repository, or git
// itself failed. Both are treated the same way by the caller: skip the read-only check
// rather than guess, and say so, so a skipped check is never mistaken for a passed one.
function gitPorcelainStatus(cwd) {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd, stdio: 'pipe' }).toString();
  } catch {
    return null;
  }
}

// A commit moves HEAD and leaves the working tree clean, so gitPorcelainStatus alone cannot
// see it. Same null-on-failure contract as gitPorcelainStatus: not a git repo, or git failed.
function gitRevParseHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

// A new branch or tag moves neither the working tree nor the current HEAD, so it needs its
// own comparison. Same null-on-failure contract as the other two git-state readers.
function gitRefList(cwd) {
  try {
    return execFileSync('git', ['for-each-ref', "--format=%(refname) %(objectname)"], {
      cwd, stdio: 'pipe'
    }).toString();
  } catch {
    return null;
  }
}

function refListDiff(before, after) {
  const beforeSet = new Set((before ?? '').split('\n').filter(Boolean));
  const afterSet = new Set((after ?? '').split('\n').filter(Boolean));
  const added = [...afterSet].filter((r) => !beforeSet.has(r));
  const removed = [...beforeSet].filter((r) => !afterSet.has(r));
  return { added, removed };
}

export async function conformanceReport(execPath, {
  env = {}, cwd = undefined, reports = [], requireSuccess = false
} = {}) {
  const failures = [];
  const notes = [];

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
      deliverable: 'review',
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

  // Captured around the run itself — probe/capabilities are not expected to touch brief.cwd,
  // and this is the one code path a real vendor CLI actually runs through (conformanceReport,
  // not the mock-only inline assertion this replaces), so it is the only path worth guarding.
  //
  // Three independent facts, because a working tree can be clean while git state still moved:
  // a commit moves HEAD without dirtying the tree, and a new branch or tag moves neither.
  const statusBeforeRun = brief.read_only ? gitPorcelainStatus(brief.cwd) : null;
  const headBeforeRun = brief.read_only ? gitRevParseHead(brief.cwd) : null;
  const refsBeforeRun = brief.read_only ? gitRefList(brief.cwd) : null;

  const run = await runAdapter(execPath, 'run', { env, cwd, timeoutMs: 120_000, brief });

  if (brief.read_only) {
    if (statusBeforeRun === null) {
      notes.push({
        step: 'read-only-git-status',
        detail: `skipped — ${brief.cwd} is not a git repository (or "git status" failed)`
      });
    } else {
      const statusAfterRun = gitPorcelainStatus(brief.cwd);
      if (statusAfterRun !== statusBeforeRun) {
        failures.push({
          step: 'read-only-git-status',
          detail: statusAfterRun === null
            ? 'read-only run left the working tree unreadable by "git status" (it was readable before the run)'
            : `read-only run dirtied the working tree: ${statusAfterRun.trim()}`
        });
      }

      const headAfterRun = gitRevParseHead(brief.cwd);
      if (headAfterRun !== headBeforeRun) {
        failures.push({
          step: 'read-only-git-head',
          detail: `read-only run moved HEAD from ${headBeforeRun ?? '(no commit yet)'} to ` +
            `${headAfterRun ?? '(no commit)'} — the adapter committed despite read_only`
        });
      }

      const refsAfterRun = gitRefList(brief.cwd);
      if (refsAfterRun !== refsBeforeRun) {
        const { added, removed } = refListDiff(refsBeforeRun, refsAfterRun);
        failures.push({
          step: 'read-only-git-refs',
          detail: `read-only run changed the ref list — added: [${added.join(', ') || 'none'}], ` +
            `removed: [${removed.join(', ') || 'none'}]`
        });
      }

      // Honesty about the blind spot: this whole section is a before/after comparison, so a
      // write (or commit, or branch) that the adapter made and then reverted before exiting —
      // `rm` the file it wrote, `git reset --hard`, `git branch -D` the branch it made — leaves
      // no trace here. A conformant result means no write or ref change SURVIVED the run, not
      // that the adapter never wrote anything. Do not read more into a green run than that.
      notes.push({
        step: 'read-only-git-status',
        detail: 'this check compares git status/HEAD/refs captured before and after the run; ' +
          'it cannot detect a write that was made and reverted before the adapter exited'
      });
    }
  }

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

  // Off by default: failed | timeout | delegating are all conformant contract-wise — an
  // adapter that fails gracefully IS conformant, and the tests above pin that. But a
  // live-vendor run (AGENT_TEAM_CONFORMANCE=<adapter>) exists to answer one question this
  // status-validity check cannot: did the adapter actually reach the model? A green run
  // against an unauthenticated CLI answers that question wrongly. requireSuccess is the
  // opt-in that makes anything but "ok" a failure here, with the adapter's own summary as
  // the detail so the report reads as "grok returned failed: Not signed in..." rather than
  // a bare assertion.
  if (requireSuccess && run.status !== 'ok') {
    failures.push({
      step: 'run-status',
      detail: `${basename(execPath)} returned ${run.status}: ${run.summary ?? '(no summary)'}`
    });
  }

  return { conformant: failures.length === 0, failures, notes, brief };
}

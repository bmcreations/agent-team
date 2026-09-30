// A vendor CLI hands back one block of text, never a status. This reads a manager's final
// text for the delegation answer src/brief.js's delegationSection asks for, so the vendor
// adapters can report `delegating` the way adapters/mock does.
//
// The contract is deliberately strict. After trimming, the WHOLE text must be either the
// JSON object itself, or a single fenced block (```json or bare ```) holding only that
// object. A delegation embedded in prose is not recognised as one: scanning prose for JSON
// would let a manager's deliverable that quotes the format trigger real runs.
//
// But a text that plainly tried to delegate must not pass as a deliverable either, or the
// manager's reports are silently never run. If the text contains "status":"delegating"
// (any whitespace around the colon) and does not parse as a valid delegation, the result is
// malformed, which the adapters report as failed. The cost: a manager whose deliverable
// discusses that literal string fails instead of succeeding.
//
// Whether each `to` names a direct report is left to src/dispatch.js, which treats it as a
// boundary (it throws and prunes), not as an ordinary failure.

const FENCED = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;
const SENTINEL = /"status"\s*:\s*"delegating"/;

function parseObject(text) {
  const fenced = FENCED.exec(text);
  const body = fenced ? fenced[1].trim() : text;
  if (!body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function invalidEntry(entry, i) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `delegations[${i}] is not an object`;
  }
  if (typeof entry.to !== 'string' || entry.to.trim() === '') {
    return `delegations[${i}].to must be a non-empty string`;
  }
  if (typeof entry.task !== 'string' || entry.task.trim() === '') {
    return `delegations[${i}].task must be a non-empty string`;
  }
  return null;
}

// Returns { kind: 'none' } when the text is a deliverable, { kind: 'delegating', delegations }
// for a valid answer, or { kind: 'malformed', reason } for a delegation attempt that cannot
// be run. A brief that may not delegate is never inspected.
export function parseDelegation(text, brief) {
  if (brief?.can_delegate !== true || typeof text !== 'string') return { kind: 'none' };

  const trimmed = text.trim();
  const parsed = parseObject(trimmed);

  if (parsed === null || parsed.status !== 'delegating') {
    if (SENTINEL.test(trimmed)) {
      return {
        kind: 'malformed',
        reason: parsed === null
          ? 'the answer mentions "status":"delegating" but is not only a JSON object ' +
            '(alone, or in a single fenced block)'
          : `the answer's JSON object has status ${JSON.stringify(parsed.status)}, ` +
            'but mentions "status":"delegating"'
      };
    }
    return { kind: 'none' };
  }

  const { delegations } = parsed;
  if (!Array.isArray(delegations) || delegations.length === 0) {
    return { kind: 'malformed', reason: '"delegations" must be a non-empty array' };
  }
  for (let i = 0; i < delegations.length; i++) {
    const reason = invalidEntry(delegations[i], i);
    if (reason) return { kind: 'malformed', reason };
  }
  return {
    kind: 'delegating',
    delegations: delegations.map(({ to, task }) => ({ to, task }))
  };
}

// The status, summary and delegations an adapter reports for a member's final text.
export function answerOutcome(text, brief) {
  const d = parseDelegation(text, brief);
  if (d.kind === 'delegating') {
    return { status: 'delegating', summary: text, delegations: d.delegations };
  }
  if (d.kind === 'malformed') {
    return { status: 'failed', summary: `malformed delegation: ${d.reason}. Member answer: ${text}` };
  }
  return { status: 'ok', summary: text };
}

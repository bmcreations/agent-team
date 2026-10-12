// Adapter contract v2: newline-delimited JSON both ways. Lines from the adapter are untrusted
// (it wraps a vendor CLI), so each one is shape-checked here and dropped if it does not fit.
const RESULT_STATUSES = new Set(['ok', 'failed']);

const CHECKS = {
  session: (m) => typeof m.harness_id === 'string' && m.harness_id.length > 0,
  event: (m) => typeof m.kind === 'string' && m.kind.length > 0,
  ack: (m) => Number.isInteger(m.message_id),
  idle: () => true,
  result: (m) => RESULT_STATUSES.has(m.status) && typeof m.summary === 'string'
};

export function parseAdapterLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return null; }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
  const check = Object.hasOwn(CHECKS, m.type) ? CHECKS[m.type] : null;
  return check && check(m) ? m : null;
}

export const encode = (message) => JSON.stringify(message) + '\n';

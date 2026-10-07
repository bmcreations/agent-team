import { existsSync, readFileSync } from 'node:fs';
import { runLogPath } from './workspace.js';

// Every record in the run log, oldest first. A line that does not parse (a write cut short)
// is skipped rather than failing the whole report.
export function readRuns(projectRoot) {
  const path = runLogPath(projectRoot);
  if (!existsSync(path)) return [];
  const runs = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { runs.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return runs;
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const formatCost = (usd) => (usd == null ? '—' : `$${usd.toFixed(2)}`);
const formatCount = (n) => (n == null ? '—' : String(n));

// The model that did the member's work: the configured one, else the one the claude adapter
// read from the session transcript. Not inferred from modelUsage, where an advisor often
// outspends the member it advises.
const workModel = (node) => node.model ?? node.usage?.model ?? node.agent ?? '—';

function table(rows, rightAligned) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => (
    rightAligned.has(i) ? cell.padStart(widths[i]) : cell.padEnd(widths[i])
  )).join('  ').trimEnd()).join('\n');
}

function flatten(node, prefix, isLast, isRoot, out) {
  const label = isRoot ? node.member : `${prefix}${isLast ? '└ ' : '├ '}${node.member}`;
  out.push([node, label]);
  const childPrefix = isRoot ? '' : `${prefix}${isLast ? '  ' : '│ '}`;
  node.delegated.forEach((child, i) => flatten(child, childPrefix, i === node.delegated.length - 1, false, out));
  return out;
}

function sumTree(node, pick) {
  const own = pick(node);
  const children = node.delegated.map((c) => sumTree(c, pick));
  const all = [own, ...children].filter((v) => v != null);
  return all.length ? all.reduce((a, b) => a + b, 0) : null;
}

// One delegation as a tree: who ran under whom, and what each run cost. Turns, cost and
// advisor calls are the member's own; elapsed includes the reports it waited on.
export function renderRun(run) {
  const header = ['member', 'model', 'status', 'elapsed', 'turns', 'cost', 'advisor'];
  const rows = flatten(run.tree, '', true, true, []).map(([n, label]) => [
    label, workModel(n), n.status, formatDuration(n.elapsed_ms),
    formatCount(n.usage?.turns), formatCost(n.usage?.cost_usd), formatCount(n.usage?.advisor_calls)
  ]);
  const cost = sumTree(run.tree, (n) => n.usage?.cost_usd ?? null);
  const advisor = sumTree(run.tree, (n) => n.usage?.advisor_calls ?? null);
  return [
    `${run.at}  ${run.task ?? ''}`.trimEnd(),
    '',
    table([header, ...rows], new Set([3, 4, 5, 6])),
    '',
    `total ${formatDuration(run.tree.elapsed_ms)}  ${formatCost(cost)}  advisor calls ${formatCount(advisor)}`
  ].join('\n');
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Per-member totals across every logged run. "advisor" is runs that called it over runs
// whose transcript could be read, so a member on codex or grok shows "—", not "0/3".
export function renderTotals(runs) {
  const byMember = new Map();
  const visit = (n) => {
    const m = byMember.get(n.member) ?? [];
    m.push(n);
    byMember.set(n.member, m);
    n.delegated.forEach(visit);
  };
  runs.forEach((r) => visit(r.tree));

  const header = ['member', 'runs', 'failed', 'median', 'cost', 'advisor'];
  const rows = [...byMember].map(([member, nodes]) => {
    const costs = nodes.map((n) => n.usage?.cost_usd).filter((c) => c != null);
    const known = nodes.filter((n) => n.usage?.advisor_calls != null);
    return [
      member, String(nodes.length), String(nodes.filter((n) => n.status !== 'ok').length),
      formatDuration(median(nodes.map((n) => n.elapsed_ms).filter((v) => v != null))),
      costs.length ? formatCost(costs.reduce((a, b) => a + b, 0)) : '—',
      known.length ? `${known.filter((n) => n.usage.advisor_calls > 0).length}/${known.length}` : '—'
    ];
  });
  return [
    `${runs.length} delegation(s) since ${runs[0].at}`,
    '',
    table([header, ...rows], new Set([1, 2, 3, 4]))
  ].join('\n');
}

// Only runs started through agent-team are logged. A member played by an interactive
// session (an orchestrator you are talking to) never appears here.
export function renderReport(projectRoot, { all = false } = {}) {
  const runs = readRuns(projectRoot);
  if (runs.length === 0) {
    return `No delegations logged for ${projectRoot} yet. Only delegations run since ` +
      `the run log was added are recorded.`;
  }
  return all ? renderTotals(runs) : renderRun(runs[runs.length - 1]);
}

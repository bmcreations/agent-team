import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runLogPath } from '../src/workspace.js';
import { formatDuration, readRuns, renderReport, renderRun, renderTotals } from '../src/report.js';

process.env.AGENT_TEAM_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-report-wsroot-'));

// The advisor's model outspends the member in models, as in a real Sonnet run with a Fable
// advisor, so the table must take the member's model from usage.model, not from cost.
const usage = (cost, turns, advisor, model = 'claude-sonnet-5-5') => ({
  model, duration_ms: 1000, turns, cost_usd: cost, session_id: 's', advisor_calls: advisor,
  models: {
    [model]: { input_tokens: 1, output_tokens: 1, cost_usd: cost / 5 },
    'claude-fable-5-1': { input_tokens: 1, output_tokens: 1, cost_usd: cost * 4 / 5 }
  }
});
const node = (member, extra = {}) => ({
  member, agent: 'claude', model: null, advisor: 'fable', status: 'ok', summary: '', depth: 0,
  elapsed_ms: 60_000, usage: null, delegated: [], ...extra
});

const RUN = {
  v: 1, at: '2026-10-07T12:00:00.000Z', project: '/p', task: 'ship the settings screen',
  tree: node('orchestrator', {
    model: 'claude-opus-5-5', elapsed_ms: 900_000, usage: usage(1.84, 18, 2, 'claude-opus-5-5'),
    delegated: [
      node('worker', { elapsed_ms: 400_000, usage: usage(1.12, 37, 0) }),
      node('reviewer', { status: 'failed', elapsed_ms: 175_000, usage: usage(0.97, 21, null),
        delegated: [node('explorer', { agent: 'codex', advisor: null, usage: null })] })
    ]
  })
};

test('durations read the way /context-style tables do', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(9_400), '9s');
  assert.equal(formatDuration(252_000), '4m12s');
  assert.equal(formatDuration(3_900_000), '1h05m');
});

test('a run renders as a tree with each member on its own row', () => {
  const out = renderRun(RUN);
  assert.match(out, /ship the settings screen/);
  assert.match(out, /^orchestrator\s+claude-opus-5-5\s+ok\s+15m00s\s+18\s+\$1\.84\s+2$/m);
  assert.match(out, /^├ worker\s+claude-sonnet-5-5\s+ok\s+6m40s\s+37\s+\$1\.12\s+0$/m);
  assert.match(out, /^└ reviewer\s+claude-sonnet-5-5\s+failed/m);
  assert.match(out, /^  └ explorer\s+codex\s+ok\s+1m00s\s+—\s+—\s+—$/m);
  // advisor total counts only the runs whose transcript was read
  assert.match(out, /^total 15m00s  \$3\.93  advisor calls 2$/m);
});

test('totals group every run of a member and show the advisor rate over known runs', () => {
  const second = structuredClone(RUN);
  second.tree.delegated[0].usage.advisor_calls = 1;
  second.tree.delegated[0].status = 'timeout';
  const out = renderTotals([RUN, second]);
  assert.match(out, /^2 delegation\(s\) since 2026-10-07T12:00:00.000Z$/m);
  assert.match(out, /^worker\s+2\s+1\s+6m40s\s+\$2\.24\s+1\/2$/m);
  assert.match(out, /^reviewer\s+2\s+2\s+2m55s\s+\$1\.94\s+—$/m);
  assert.match(out, /^explorer\s+2\s+0\s+1m00s\s+—\s+—$/m);
});

test('the report reads the last run, skipping a torn line', () => {
  const project = mkdtempSync(join(tmpdir(), 'at-report-proj-'));
  const path = runLogPath(project);
  mkdirSync(dirname(path), { recursive: true });
  const older = { ...RUN, task: 'older task' };
  writeFileSync(path, [JSON.stringify(older), '{"torn', JSON.stringify(RUN), ''].join('\n'));
  assert.equal(readRuns(project).length, 2);
  assert.match(renderReport(project), /ship the settings screen/);
  assert.doesNotMatch(renderReport(project), /older task/);
  assert.match(renderReport(project, { all: true }), /^2 delegation/m);
});

test('a project with no run log says so instead of printing an empty table', () => {
  const project = mkdtempSync(join(tmpdir(), 'at-report-empty-'));
  assert.match(renderReport(project), /No delegations logged/);
});

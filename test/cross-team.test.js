import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { project, supervise, LIVE } from './helpers/live.js';

const until = async (f, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// Team B (the "loupe" repo): a lead with one report. Team A: a manager whose report "loupe"
// is team B.
function teams({ aDefaults = {}, bDefaults = {}, bMembers = {}, script }) {
  const b = project({ 'b-lead': LIVE(), 'b-dev': LIVE({ reports_to: 'b-lead' }), ...bMembers }, {}, bDefaults);
  const a = project({ manager: LIVE(), loupe: { team: b.root, reports_to: 'manager' } }, script, aDefaults);
  writeFileSync(b.script, JSON.stringify(script));
  return { a, b };
}

// Rewrites a project's config and commits it.
function editConfig(root, fn) {
  const file = join(root, '.claude', 'agent-team.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  fn(cfg);
  writeFileSync(file, JSON.stringify(cfg));
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'edit'], { stdio: 'pipe' });
}

const toolResults = (store, memberId) => store.events(memberId).filter((e) => e.kind === 'tool_result');

test('under serve, delegating to a team member starts that repo\'s entry member as a live report', async () => {
  const script = { by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'loupe', task: 'fix the crash' }, save: 'd' },
      { tool: 'wait_for', args: { report_ids: ['$d.report_id'] }, until_finished: ['$d.report_id'] }
    ] },
    'b-lead': { steps: [
      { tool: 'delegate', args: { to: 'b-dev', task: 'patch it' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ], result: { status: 'ok', summary: 'fixed in loupe' } },
    'b-dev': { steps: [{ say: 'patched' }] }
  } };
  const { a, b } = teams({ script });
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const rows = store.members(runId);
    const entry = rows.find((m) => m.name === 'b-lead');
    assert.equal(entry.project, realpathSync(b.root));
    assert.equal(entry.alias, 'loupe');
    assert.equal(entry.depth, 0);
    assert.equal(entry.agent, 'mock-live');            // a live member, not a one-shot "team"
    const dev = rows.find((m) => m.name === 'b-dev');
    assert.equal(dev.parent_id, entry.id);
    assert.equal(dev.depth, 1);
    assert.match(toolResults(store, rows[0].id)[1].body.result.messages.at(-1).text, /finished ok: fixed in loupe/);
  } finally { await sup.close(); store.close(); }
});

test('without serve, a team member stays one-shot', async () => {
  const script = { by_member: { manager: { steps: [
    { tool: 'delegate', args: { to: 'loupe', task: 'fix' }, save: 'd' },
    { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
  ] }, 'b-lead': { steps: [] } } };
  const { a } = teams({ script });
  const { sup, store } = await supervise(a.script);   // shared defaults to false
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const rows = store.members(runId);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].name, 'loupe');
    assert.equal(rows[1].agent, 'team');
  } finally { await sup.close(); store.close(); }
});

test('the entered team builds workspaces and briefs from its own deny_paths and max_depth', async () => {
  const script = { by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'loupe', task: 'go' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ] },
    'b-lead': { steps: [
      { tool: 'delegate', args: { to: 'b-dev', task: 'patch it' } },
      { sleep_ms: 300 }
    ] }
  } };
  const { a, b } = teams({ script, bMembers: { 'b-lead': LIVE({ isolation: 'workspace' }) } });
  mkdirSync(join(b.root, 'secret'));
  writeFileSync(join(b.root, 'secret', 'key.txt'), 'x\n');
  writeFileSync(join(b.root, '.env'), 'ok\n');
  editConfig(b.root, (cfg) => { cfg.deny_paths = ['secret/**']; cfg.defaults.max_depth = 0; });
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    const rows0 = () => store.members(runId);
    await until(() => rows0().find((m) => m.name === 'b-lead')?.workspace);
    const lead = rows0().find((m) => m.name === 'b-lead');
    // A's deny_paths would drop .env; B's own keep it and drop secret/.
    assert.ok(existsSync(join(lead.workspace, '.env')), 'B\'s deny_paths decided the workspace, not A\'s');
    assert.ok(!existsSync(join(lead.workspace, 'secret')), 'secret/ is denied in B');
    await sup.waitRun(runId);
    const res = toolResults(store, lead.id)[0].body.result;
    assert.match(res.error, /already at max_depth 0/);
  } finally { await sup.close(); store.close(); }
});

test('a team stops at its own max_delegations and spends the run\'s too', async () => {
  const script = { by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'loupe', task: 'go' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ] },
    'b-lead': { steps: [
      { tool: 'delegate', args: { to: 'b-dev', task: 'one' } },
      { tool: 'delegate', args: { to: 'b-dev', task: 'two' } }
    ] },
    'b-dev': { steps: [] }
  } };
  const { a } = teams({ script, aDefaults: { max_delegations: 5 }, bDefaults: { max_delegations: 1 } });
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const lead = store.members(runId).find((m) => m.name === 'b-lead');
    const [first, second] = toolResults(store, lead.id).map((e) => e.body.result);
    assert.ok(first.report_id);
    assert.match(second.error, /max_delegations of the team at/);
    assert.equal(store.run(runId).budget, 3);          // 5 - manager->loupe - b-lead->b-dev
    assert.equal(store.member(lead.id).scope_budget, 0);
  } finally { await sup.close(); store.close(); }
});

test('a team that leads back to a team already in the run is refused', async () => {
  const script = { by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'loupe', task: 'go' }, save: 'd' },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ] },
    'b-lead': { steps: [{ tool: 'delegate', args: { to: 'back', task: 'loop' } }] }
  } };
  const { a, b } = teams({ script });
  editConfig(b.root, (cfg) => { cfg.members.back = { team: a.root, reports_to: 'b-lead' }; });
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const lead = store.members(runId).find((m) => m.name === 'b-lead');
    assert.match(toolResults(store, lead.id)[0].body.result.error, /team ".*" is already in this delegation/);
    assert.equal(store.members(runId).length, 2, 'nothing was started for the refused team');
  } finally { await sup.close(); store.close(); }
});

test('the manager can message the entry member by its alias, and the entry member its manager', async () => {
  const script = { by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'loupe', task: 'go' }, save: 'd' },
      { tool: 'send_to', args: { to: 'loupe', text: 'use the v2 API' } },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ] },
    'b-lead': { steps: [
      { sleep_ms: 200 },
      { tool: 'send_to', args: { to: 'manager', text: 'on it' } },
      { sleep_ms: 100 }
    ] }
  } };
  const { a } = teams({ script });
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    const lead = store.members(runId).find((m) => m.name === 'b-lead');
    const leadResult = JSON.parse(JSON.stringify(store.member(lead.id).result ?? {}));
    const seen = [...(leadResult.received ?? []),
      ...store.events(lead.id).filter((e) => e.kind === 'user').map((e) => e.body.text)];
    assert.ok(seen.some((t) => t.includes('[from: manager (manager)] use the v2 API')), JSON.stringify(seen));
    assert.match(JSON.stringify(result.tool_results.at(-1)), /on it/);
  } finally { await sup.close(); store.close(); }
});

// A restartable pair: the manager enters B, whose lead delegates to a slow b-dev.
function recoverable() {
  const script = { by_member: {
    manager: {
      steps: [{ tool: 'delegate', args: { to: 'loupe', task: 'go' } }, { tool: 'wait_for', args: {} }],
      on_resume: { steps: [{ tool: 'wait_for', args: {} }] }
    },
    'b-lead': {
      steps: [{ tool: 'delegate', args: { to: 'b-dev', task: 'slow' } }, { tool: 'wait_for', args: {} }],
      on_resume: { steps: [{ tool: 'wait_for', args: {} }] }
    },
    'b-dev': { steps: [{ sleep_ms: 30_000 }], on_resume: { steps: [] } }
  } };
  return { ...teams({ script, bDefaults: { max_delegations: 2 } }), script };
}

async function startAndStop(a) {
  const first = await supervise(a.script, { shared: true });
  const { runId } = first.sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
  const { store } = first;
  await until(() => {
    const dev = store.members(runId).find((m) => m.name === 'b-dev');
    return dev?.resume && store.members(runId).find((m) => m.name === 'b-lead')?.state === 'waiting';
  });
  await first.sup.close();
  return { runId, store };
}

test('a restart recovers a run with an entered team, budgets and all', async () => {
  const { a } = recoverable();
  const { runId, store } = await startAndStop(a);
  const entryId = store.members(runId).find((m) => m.name === 'b-lead').id;
  assert.equal(store.member(entryId).scope_budget, 1);
  const { sup } = await supervise(a.script, { shared: true, store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [runId], failed: [] });
    const result = await sup.waitRun(runId);
    assert.equal(result.status, 'ok');
    assert.equal(store.member(entryId).scope_budget, 1);
    assert.equal(store.members(runId).find((m) => m.name === 'b-dev').state, 'done');
  } finally { await sup.close(); store.close(); }
});

test('a run whose entered team no longer loads fails on recovery', async () => {
  const { a, b } = recoverable();
  const { runId, store } = await startAndStop(a);
  renameSync(join(b.root, '.claude', 'agent-team.json'), join(b.root, '.claude', 'agent-team.gone'));
  const { sup } = await supervise(a.script, { shared: true, store });
  try {
    assert.deepEqual(await sup.recover(), { recovered: [], failed: [runId] });
    for (const m of store.members(runId)) {
      assert.equal(m.state, 'failed', m.name);
      assert.match(store.member(m.id).result.summary, /could not recover after a supervisor restart: no agent-team config/);
    }
  } finally { await sup.close(); store.close(); }
});

test('team_status lists the teams a member can name and reports another team\'s running work', async () => {
  const script = { by_member: {
    manager: { steps: [
      { tool: 'delegate', args: { to: 'loupe', task: 'go' }, save: 'd' },
      { sleep_ms: 300 },
      { tool: 'team_status', args: {} },
      { tool: 'team_status', args: { team: '$B_ROOT' } },
      { tool: 'team_status', args: { team: '../nowhere' } },
      { tool: 'wait_for', args: {}, until_finished: ['$d.report_id'] }
    ] },
    'b-lead': { steps: [{ tool: 'report_progress', args: { text: 'half way' } }, { sleep_ms: 600 }] }
  } };
  const { a, b } = teams({ script });
  const bRoot = realpathSync(b.root);
  const text = JSON.stringify(script).replaceAll('$B_ROOT', bRoot);
  writeFileSync(a.script, text);
  writeFileSync(b.script, text);
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId, memberId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const [, list, status, missing] = toolResults(store, memberId);
    assert.ok(list.body.result.teams.some((t) => t.root === bRoot));
    assert.equal(status.body.result.team.root, bRoot);
    const names = status.body.result.runs.flatMap((r) => r.members.map((m) => m.name));
    assert.ok(names.includes('b-lead'));
    assert.ok(!names.includes('manager'));
    assert.match(missing.body.result.error, /not found: no agent-team config/);
  } finally { await sup.close(); store.close(); }
});

test('a member name shared by two entered teams is ambiguous; an alias names the entry', async () => {
  const script = { by_member: { lead: { steps: [
    { tool: 'delegate', args: { to: 'loupe', task: 'go' } },
    { sleep_ms: 30_000 }
  ] } } };
  const b = project({ lead: LIVE() }, script);
  const a = project({ lead: LIVE(), loupe: { team: b.root, reports_to: 'lead' } }, script);
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'lead', task: 'ship' });
    await until(() => store.members(runId).filter((m) => m.state === 'running' || m.state === 'waiting').length === 2);
    const [root, entry] = store.members(runId);
    await assert.rejects(async () => sup.cancel({ run_id: runId, member: 'lead' }),
      new RegExp(`ambiguous.*${root.id}.*${entry.id}`));
    assert.equal(store.member(root.id).state, 'running', 'nothing was cancelled');
    assert.equal(store.member(entry.id).state, 'running');
    await sup.cancel({ run_id: runId, member: 'loupe' });   // the alias names B's entry
    await until(() => ['cancelled', 'stopping'].includes(store.member(entry.id).state) || store.member(entry.id).state === 'cancelled');
    assert.notEqual(store.member(root.id).state, 'cancelled');
  } finally { await sup.close(); store.close(); }
});

test('send_to refuses a name that two of the manager\'s reports share', async () => {
  const script = { by_member: {
    boss: { steps: [
      { tool: 'delegate', args: { to: 'dev', task: 'one' } },
      { tool: 'delegate', args: { to: 'loupe', task: 'two' } },
      { tool: 'send_to', args: { to: 'dev', text: 'hi' } },
      { sleep_ms: 500 }
    ] },
    dev: { steps: [{ sleep_ms: 5_000 }] }
  } };
  const b = project({ dev: LIVE() }, script);
  const a = project({ boss: LIVE(), dev: LIVE({ reports_to: 'boss' }), loupe: { team: b.root, reports_to: 'boss' } }, script);
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'boss', task: 'ship' });
    await until(() => toolResults(store, store.members(runId)[0].id).length >= 3);
    const res = toolResults(store, store.members(runId)[0].id)[2].body.result;
    assert.match(res.error, /ambiguous/);
  } finally { await sup.close(); store.close(); }
});

test('a team member naming an entry member the team lacks is a clear error and spends nothing', async () => {
  const script = { by_member: { manager: { steps: [
    { tool: 'delegate', args: { to: 'loupe', task: 'go' } }
  ] } } };
  const b = project({ lead: LIVE() }, script);
  const a = project({ manager: LIVE(), loupe: { team: b.root, member: 'ghost', reports_to: 'manager' } }, script);
  const { sup, store } = await supervise(a.script, { shared: true });
  try {
    const { runId } = sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
    await sup.waitRun(runId);
    const res = toolResults(store, store.members(runId)[0].id)[0].body.result;
    assert.match(res.error, /member "loupe": team .* has no member "ghost"/);
    assert.doesNotMatch(res.error, /undefined/);
    assert.equal(store.members(runId).length, 1);
  } finally { await sup.close(); store.close(); }
});

test('recovery ignores an entered team that already finished, even if its repo is gone', async () => {
  const script = { by_member: {
    manager: {
      steps: [{ tool: 'delegate', args: { to: 'loupe', task: 'go' }, save: 'd' }, { tool: 'wait_for', args: {} }],
      on_resume: { steps: [{ tool: 'wait_for', args: {} }] }
    },
    'b-lead': { steps: [{ say: 'done' }] }
  } };
  const b = project({ 'b-lead': LIVE() }, script);
  const a = project({ manager: LIVE(), loupe: { team: b.root, reports_to: 'manager' } }, script);
  const first = await supervise(a.script, { shared: true });
  const { store } = first;
  const { runId } = first.sup.submit({ projectRoot: a.root, member: 'manager', task: 'ship' });
  await until(() => store.members(runId).find((m) => m.name === 'b-lead')?.state === 'done');
  await first.sup.close();
  renameSync(join(b.root, '.claude', 'agent-team.json'), join(b.root, '.claude', 'agent-team.gone'));
  const { sup } = await supervise(a.script, { shared: true, store });
  try {
    const out = await sup.recover();
    assert.deepEqual(out.failed, []);
  } finally { await sup.close(); store.close(); }
});

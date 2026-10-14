import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtensions, mergeOptions, extensionUsage, findCommand, routeDelegation, extensionRuns } from '../src/extensions.js';
import { parseConfig, resetConfigExtensions } from '../src/config.js';
import { teamEntry } from '../src/dispatch.js';

const execFileAsync = promisify(execFile);
const BIN = new URL('../bin/agent-team.js', import.meta.url).pathname;
const FIXTURE = new URL('./fixtures/extension', import.meta.url).pathname;

function runCli(args, env = {}) {
  return execFileAsync(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' })
  );
}

function project(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'at-ext-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members: { w: { agent: 'mock', isolation: 'none' } }, deny_paths: ['credentials/**'],
    defaults: { on_unavailable: 'mock' }, ...config
  }));
  return root;
}

const withFixture = { AGENT_TEAM_EXTENSIONS: FIXTURE };

test('an extension is found by AGENT_TEAM_EXTENSIONS (a directory or its index.js) and under <root>/extensions', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'at-ext-root-'));
  assert.deepEqual(await loadExtensions({ root: empty, env: {} }), []);
  const byDir = await loadExtensions({ root: empty, env: withFixture });
  const byFile = await loadExtensions({ root: empty, env: { AGENT_TEAM_EXTENSIONS: join(FIXTURE, 'index.js') } });
  assert.equal(byDir[0].name, 'fixture');
  assert.equal(byFile[0].name, 'fixture');
  const root = mkdtempSync(join(tmpdir(), 'at-ext-root-'));
  cpSync(FIXTURE, join(root, 'extensions', 'fx'), { recursive: true });
  const found = await loadExtensions({ root, env: {} });
  assert.equal(found.length, 1);
  assert.match(found[0].path, /extensions\/fx\/index\.js$/);
  // the same module reached twice loads once
  assert.equal((await loadExtensions({ root, env: { AGENT_TEAM_EXTENSIONS: join(root, 'extensions', 'fx') } })).length, 1);
  resetConfigExtensions();
});

test('a broken extension fails loudly with its path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'at-ext-root-'));
  const bad = (name, src) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.js'), src);
    return join(dir, 'index.js');
  };
  const load = (p) => loadExtensions({ root, env: { AGENT_TEAM_EXTENSIONS: p } });
  const syntax = bad('syntax', 'export default {');
  await assert.rejects(load(syntax), (e) => e.message.includes(syntax));
  const notObject = bad('notobj', 'export default 5;');
  await assert.rejects(load(notObject), (e) => e.message.includes(notObject) && /must be an object/.test(e.message));
  const noName = bad('noname', 'export default { commands: {} };');
  await assert.rejects(load(noName), /"name" must be/);
  const typo = bad('typo', "export default { name: 'x', comands: {} };");
  await assert.rejects(load(typo), /unknown field "comands"/);
  const cmd = bad('cmd', "export default { name: 'x', commands: { v: 5 } };");
  await assert.rejects(load(cmd), /command "v" must be a function/);
  await assert.rejects(load(join(root, 'missing', 'index.js')), /no such file/);
  const clash = bad('clash', "export default { name: 'y', config: { keys: { members: { validate() {} } } } };");
  await assert.rejects(load(clash), /already taken by the core/);
  resetConfigExtensions();
});

test('two extensions cannot add the same name, verb or option', async () => {
  const root = mkdtempSync(join(tmpdir(), 'at-ext-root-'));
  const make = (n, body) => {
    mkdirSync(join(root, n));
    writeFileSync(join(root, n, 'index.js'), `export default { name: '${n}', ${body} };`);
    return join(root, n);
  };
  const run = (...dirs) => loadExtensions({ root, env: { AGENT_TEAM_EXTENSIONS: dirs.join(':') } });
  await assert.rejects(run(make('a', 'commands: { v: async () => {} }'), make('b', 'commands: { v: async () => {} }')), /command "v" is already added/);
  await assert.rejects(run(make('c', "options: { z: { type: 'string' } }"), make('d', "options: { z: { type: 'string' } }")), /option --z is already added/);
  resetConfigExtensions();
});

test('options merge into the core\'s, and may not redefine one of them', async () => {
  const [ext] = await loadExtensions({ root: tmpdir(), env: withFixture });
  const merged = mergeOptions({ member: { type: 'string' } }, [ext]);
  assert.deepEqual(Object.keys(merged), ['member', 'shout', 'tag']);
  assert.throws(() => mergeOptions({ tag: { type: 'string' } }, [ext]), /already a core option/);
  assert.match(extensionUsage([ext]), /^ {7}agent-team hello .*\n$/);
  resetConfigExtensions();
});

test('config keys from an extension are defaulted and validated; core keys still win', async () => {
  const base = { members: { a: { agent: 'mock' } }, deny_paths: ['x'] };
  assert.equal(parseConfig(base, 'c').fx_level, undefined, 'no extension, no key');
  await loadExtensions({ root: tmpdir(), env: withFixture });
  const cfg = parseConfig(base, 'c.json');
  assert.equal(cfg.defaults.fx_level, 2);
  assert.deepEqual(cfg.fx_tags, []);
  assert.equal(cfg.defaults.max_depth, 3);
  assert.equal(parseConfig({ ...base, defaults: { fx_level: 5 }, fx_tags: ['a'] }, 'c.json').fx_tags[0], 'a');
  assert.throws(() => parseConfig({ ...base, defaults: { fx_level: 0 } }, 'c.json'), /c\.json: "defaults.fx_level" must be an integer >= 1/);
  assert.throws(() => parseConfig({ ...base, fx_tags: 'a' }, 'c.json'), /"fx_tags" must be an array of strings/);
  // core validation still reports first
  assert.throws(() => parseConfig({ ...base, deny_paths: 5, fx_tags: 'a' }, 'c.json'), /deny_paths/);
  resetConfigExtensions();
  assert.equal(parseConfig(base, 'c').fx_level, undefined);
});

test('route: the first non-null answer claims the delegation, null falls through', async () => {
  const [ext] = await loadExtensions({ root: tmpdir(), env: withFixture });
  const dispatch = () => {};
  const claimed = await routeDelegation([ext], { member: 'w', task: 'claim: x', timeoutMs: undefined, values: {} }, { dispatch });
  assert.equal(claimed.status, 'ok');
  assert.equal(claimed.seen, true);
  assert.equal(await routeDelegation([ext], { member: 'w', task: 'plain', values: {} }, { dispatch }), null);
  assert.equal(await routeDelegation([], { member: 'w', task: 'claim: x' }, { dispatch }), null);
  assert.equal(findCommand([ext], 'hello') !== null, true);
  assert.equal(findCommand([ext], 'nope'), null);
  assert.equal(findCommand([ext], 'toString'), null);
  assert.equal((await extensionRuns([ext], '/p'))[0].tree.member, 'fx-member');
  resetConfigExtensions();
});

test('CLI: an extension verb gets the parsed arguments, and --help lists its usage', async () => {
  const r = await runCli(['hello', 'bob', '--shout', '--tag', 'x'], withFixture);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.text, 'HELLO BOB');
  assert.equal(out.tag, 'x');
  assert.deepEqual(out.options, ['shout', 'tag']);
  assert.match(out.adapterDir, /adapters$/);
  const help = await runCli(['--help'], withFixture);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /agent-team hello \[--shout\]/);
  assert.equal((await runCli(['exit3'], withFixture)).code, 3);
  assert.equal((await runCli(['hello'])).code, 2, 'without the extension, hello is not a verb');
});

test('CLI: the core\'s own verbs win over an extension\'s', async () => {
  const root = project();
  const r = await runCli(['org', '--project', root], withFixture);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /the extension org/);
});

test('CLI: a delegation an extension claims never reaches dispatch; any other falls through', async () => {
  const root = project();
  const claimed = await runCli(['--member', 'w', '--task', 'claim: it', '--project', root, '--tag', 'q'], withFixture);
  assert.equal(claimed.code, 0, claimed.stdout);
  assert.equal(JSON.parse(claimed.stdout).summary, 'claimed w timeout=undefined tag=q');
  const timed = await runCli(['--member', 'w', '--task', 'claim: it', '--project', root, '--timeout', '30'], withFixture);
  assert.match(JSON.parse(timed.stdout).summary, /timeout=30000/);
  const through = await runCli(['--member', 'w', '--task', 'do it', '--project', root], withFixture);
  // the mock adapter needs a script, so the run fails — but it is the core's run that failed
  assert.doesNotMatch(through.stdout, /claimed/);
  assert.equal(JSON.parse(through.stdout).member, 'w');
});

test('CLI: report includes an extension\'s runs, and config keys validate through the CLI', async () => {
  const root = project();
  const report = await runCli(['report', '--project', root, '--json'], withFixture);
  assert.equal(JSON.parse(report.stdout).at(-1).task, 'a run from the fixture');
  const bad = project({ fx_tags: 7 });
  const r = await runCli(['org', '--project', bad], withFixture);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout).summary, /"fx_tags" must be an array of strings/);
  assert.equal((await runCli(['org', '--project', bad])).code, 0, 'unknown to the core, so ignored without the extension');
});

test('CLI: a broken extension reports its path as JSON and exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-ext-bad-'));
  writeFileSync(join(dir, 'index.js'), 'throw new Error("boom");');
  const r = await runCli(['--help'], { AGENT_TEAM_EXTENSIONS: dir });
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'failed');
  assert.match(out.summary, new RegExp(`extension .*${dir}.*boom`));
});

test('teamEntry refuses an entry member the other team does not have', () => {
  const team = { members: { lead: {} }, org: { roots: ['lead'] } };
  assert.equal(teamEntry(team, 'lead', '/t', 'm'), 'lead');
  assert.equal(teamEntry(team, null, '/t', 'm'), 'lead');
  assert.throws(() => teamEntry(team, 'ghost', '/t', 'm'), /team \/t has no member "ghost"/);
});

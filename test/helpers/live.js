import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore } from '../../src/store.js';
import { Supervisor } from '../../src/supervisor.js';

process.env.AGENT_TEAM_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-sup-wsroot-'));

const repoAdapters = new URL('../../adapters/', import.meta.url).pathname;
const fixtures = new URL('../fixtures/', import.meta.url).pathname;

// An adapter directory with the real adapters plus the crash fixture under the name "crash".
export function adapterDir() {
  const dir = mkdtempSync(join(tmpdir(), 'at-sup-adapters-'));
  for (const name of readdirSync(repoAdapters)) {
    // Symlinked, not copied: node resolves a script's imports from its real path, and
    // mock-live imports ../src/rpc.js.
    symlinkSync(join(repoAdapters, name), join(dir, name));
  }
  copyFileSync(join(fixtures, 'session-crash'), join(dir, 'crash'));
  chmodSync(join(dir, 'crash'), 0o755);
  return dir;
}

export function project(members, scripted, defaults = {}) {
  const root = mkdtempSync(join(tmpdir(), 'at-sup-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, 'app.js'), 'ok\n');
  writeFileSync(join(root, '.claude', 'agent-team.json'), JSON.stringify({
    members, deny_paths: ['**/.env*'], defaults: { on_unavailable: 'mock-live', ...defaults }
  }));
  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify(scripted));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, script };
}

export async function supervise(script, opts = {}) {
  // Short path: macOS caps Unix socket paths at 104 bytes.
  const socketPath = join(mkdtempSync(join(tmpdir(), 'at-s-')), 'sup.sock');
  const store = openStore(':memory:');
  const sup = new Supervisor({
    store, adapterDir: opts.adapterDir ?? adapterDir(), socketPath,
    env: { AGENT_TEAM_MOCK_SCRIPT: script }, maxRunning: opts.maxRunning ?? 6
  });
  await sup.start();
  return { sup, store };
}

export const LIVE = (extra = {}) => ({ agent: 'mock-live', isolation: 'none', ...extra });

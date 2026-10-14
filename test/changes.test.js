import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startHttp } from '../src/http.js';
import { createWorkspace, pruneWorkspace } from '../src/workspace.js';
import { diffFiles } from '../src/diffbase.js';
import { get } from './helpers/http.js';

process.env.AGENT_TEAM_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'at-changes-wsroot-'));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'at-changes-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@e.st');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'tracked.txt'), 'original\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function seeded(workspace) {
  const store = openStore(':memory:');
  const runId = store.createRun({ project: '/p', task: 't', owner: null });
  const m = store.addMember({ runId, parentId: null, name: 'impl', task: 't', depth: 0 });
  store.setState(m.id, 'running');
  if (workspace) store.setWorkspace(m.id, workspace);
  return { store, id: m.id };
}

test('diffFiles reports path, status and +/- counts per file', () => {
  const diff = [
    'diff --git a/x b/x', 'new file mode 100644', '--- /dev/null', '+++ b/x', '@@ -0,0 +1,2 @@', '+a', '+b',
    'diff --git a/y b/y', 'deleted file mode 100644', '--- a/y', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone', ''
  ].join('\n');
  assert.deepEqual(diffFiles(diff), [
    { path: 'x', status: 'added', added: 2, removed: 0 },
    { path: 'y', status: 'deleted', added: 0, removed: 1 }
  ]);
});

test('GET /api/members/:id/changes: a running member shows its commits and untracked files; a finished one its stored diff', async () => {
  const ws = createWorkspace(repo(), 'impl', [], 'workspace');
  const { store, id } = seeded(ws.dir);
  const web = await startHttp({ store, port: 0 });
  try {
    git(ws.dir, 'config', 'user.email', 't@e.st');
    writeFileSync(join(ws.dir, 'tracked.txt'), 'committed\n');
    git(ws.dir, 'add', '.');
    git(ws.dir, 'commit', '-q', '-m', 'work');
    writeFileSync(join(ws.dir, 'NEW.txt'), 'fresh\n');

    const r = await get(web.url, `/api/members/${id}/changes`);
    assert.equal(r.status, 200);
    assert.equal(r.json.live, true);
    assert.equal(r.json.truncated, false);
    assert.deepEqual(r.json.files.map((f) => [f.path, f.status, f.added, f.removed]),
      [['NEW.txt', 'added', 1, 0], ['tracked.txt', 'modified', 1, 1]]);
    assert.ok(r.json.diff.includes('+committed'));

    // Done: the clone is pruned, and the stored result's artifacts are what is served.
    store.setResult(id, { status: 'ok', artifacts: { diff: r.json.diff } });
    store.setState(id, 'done');
    pruneWorkspace(ws);
    const done = await get(web.url, `/api/members/${id}/changes`);
    assert.equal(done.json.live, false);
    assert.deepEqual(done.json.files.map((f) => f.path), ['NEW.txt', 'tracked.txt']);
  } finally { await web.close(); pruneWorkspace(ws); }
});

test('GET /api/members/:id/changes: no workspace is an empty answer, an unknown member is 404, and the diff is capped', async () => {
  const { store, id } = seeded(null);
  const web = await startHttp({ store, port: 0 });
  try {
    const none = await get(web.url, `/api/members/${id}/changes`);
    assert.deepEqual(none.json, { files: [], diff: '', truncated: false, live: false });
    assert.equal((await get(web.url, '/api/members/999/changes')).status, 404);

    const big = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+' + 'x'.repeat(300_000) + '\n';
    store.setResult(id, { status: 'ok', artifacts: { diff: big } });
    store.setState(id, 'done');
    const r = await get(web.url, `/api/members/${id}/changes`);
    assert.equal(r.json.truncated, true);
    assert.equal(r.json.diff.length, 200_000);
    assert.equal(r.json.files[0].path, 'f');
  } finally { await web.close(); }
});

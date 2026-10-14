import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxBuildEnv, wrapperDistName } from '../src/buildcache.js';

const DIST = 'gradle-8.14-bin';

function gradleProject() {
  const cwd = mkdtempSync(join(tmpdir(), 'bc-proj-'));
  writeFileSync(join(cwd, 'settings.gradle.kts'), '');
  mkdirSync(join(cwd, 'gradle', 'wrapper'), { recursive: true });
  writeFileSync(join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    `distributionUrl=https\\://services.gradle.org/distributions/${DIST}.zip\n`);
  return cwd;
}

function userHome({ deps = true, dist = 'complete' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bc-home-'));
  if (deps) mkdirSync(join(home, '.gradle', 'caches', 'modules-2'), { recursive: true });
  if (dist) {
    const d = join(home, '.gradle', 'wrapper', 'dists', DIST, 'abc123');
    mkdirSync(join(d, 'gradle-8.14', 'bin'), { recursive: true });
    writeFileSync(join(d, 'gradle-8.14', 'bin', 'gradle'), '#!/bin/sh\n');
    if (dist === 'complete') writeFileSync(join(d, `${DIST}.zip.ok`), '');
  }
  return home;
}

test('wrapperDistName reads the distribution from the wrapper properties', () => {
  assert.equal(wrapperDistName(gradleProject()), DIST);
  assert.equal(wrapperDistName(mkdtempSync(join(tmpdir(), 'bc-none-'))), null);
});

test('a non-Gradle workspace gets no build env', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bc-plain-'));
  assert.deepEqual(sandboxBuildEnv(cwd, { env: {}, home: userHome() }), {});
});

test('a Gradle workspace reads deps from the user cache and gets the wrapper copied in', () => {
  const cwd = gradleProject();
  const home = userHome();
  const env = sandboxBuildEnv(cwd, { env: {}, home });
  assert.equal(env.GRADLE_USER_HOME, join(cwd, '.gradle-home'));
  assert.equal(env.GRADLE_RO_DEP_CACHE, join(home, '.gradle', 'caches'));
  const copied = join(cwd, '.gradle-home', 'wrapper', 'dists', DIST, 'abc123');
  assert.equal(readFileSync(join(copied, 'gradle-8.14', 'bin', 'gradle'), 'utf8'), '#!/bin/sh\n');
  assert.ok(existsSync(join(copied, `${DIST}.zip.ok`)));
});

test('a wrapper distribution still downloading is not copied', () => {
  const cwd = gradleProject();
  sandboxBuildEnv(cwd, { env: {}, home: userHome({ dist: 'partial' }) });
  assert.ok(!existsSync(join(cwd, '.gradle-home', 'wrapper', 'dists', DIST, 'abc123')));
});

test('no read-only cache when the user has none, and the user\'s own choices are kept', () => {
  const cwd = gradleProject();
  assert.equal(sandboxBuildEnv(cwd, { env: {}, home: userHome({ deps: false }) }).GRADLE_RO_DEP_CACHE, undefined);
  assert.deepEqual(sandboxBuildEnv(cwd, { env: { GRADLE_USER_HOME: '/mine' }, home: userHome() }), {});
  const ro = sandboxBuildEnv(cwd, { env: { GRADLE_RO_DEP_CACHE: '/ro' }, home: userHome() });
  assert.equal(ro.GRADLE_RO_DEP_CACHE, undefined);
});

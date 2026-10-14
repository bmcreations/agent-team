import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { copyTree, MEMBER_GRADLE_HOME } from './workspace.js';

const isGradleProject = (cwd) =>
  ['gradlew', 'settings.gradle', 'settings.gradle.kts'].some((f) => existsSync(join(cwd, f)));

// The wrapper distribution the project asks for, e.g. "gradle-8.14-bin", from
// gradle/wrapper/gradle-wrapper.properties. Null when there is no wrapper or no URL.
export function wrapperDistName(cwd) {
  let text;
  try { text = readFileSync(join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8'); } catch { return null; }
  const url = /^\s*distributionUrl\s*=\s*(.+?)\s*$/m.exec(text)?.[1];
  return url ? basename(url.replace(/\\:/g, ':')).replace(/\.zip$/, '') : null;
}

// Env for a CLI that runs in a write-to-workspace-only sandbox (codex workspace-write, grok
// workspace). Gradle's default home, ~/.gradle, is outside that sandbox, so without this a
// member points Gradle at a home inside the workspace and downloads every dependency again
// (382 MB in one reviewer's workspace). Two things avoid that without letting the member
// write ~/.gradle, where an init script would run in the user's own builds:
// - GRADLE_RO_DEP_CACHE: Gradle reads dependencies from the user's cache and never writes
//   it. Only what is missing is downloaded, into the member's own home.
// - The wrapper distribution the project uses, copied copy-on-write into the member's home,
//   so the wrapper does not download Gradle itself.
// A user who set GRADLE_USER_HOME has chosen where Gradle lives; that is left alone.
export function sandboxBuildEnv(cwd, { env = process.env, home = homedir() } = {}) {
  if (!cwd || env.GRADLE_USER_HOME || !isGradleProject(cwd)) return {};
  const userHome = join(home, '.gradle');
  const memberHome = join(cwd, MEMBER_GRADLE_HOME);
  const out = { GRADLE_USER_HOME: memberHome };
  if (!env.GRADLE_RO_DEP_CACHE && existsSync(join(userHome, 'caches', 'modules-2'))) {
    out.GRADLE_RO_DEP_CACHE = join(userHome, 'caches');
  }
  seedWrapper(cwd, userHome, memberHome);
  return out;
}

// dists/<name>/<hash>/ is complete once the wrapper wrote <name>.zip.ok beside the unpacked
// distribution. One still downloading is skipped; the member's wrapper fetches its own.
function seedWrapper(cwd, userHome, memberHome) {
  const name = wrapperDistName(cwd);
  if (!name) return;
  const src = join(userHome, 'wrapper', 'dists', name);
  const dst = join(memberHome, 'wrapper', 'dists', name);
  if (existsSync(dst)) return;
  let hashes;
  try { hashes = readdirSync(src); } catch { return; }
  for (const hash of hashes) {
    if (!existsSync(join(src, hash, `${name}.zip.ok`))) continue;
    try {
      mkdirSync(dst, { recursive: true });
      copyTree(join(src, hash), join(dst, hash));
    } catch {
      // Only a head start: the wrapper downloads what is missing.
    }
  }
}

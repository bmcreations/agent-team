import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extendConfig } from './config.js';

// An extension is a module whose default export is an object. docs/extensions.md has the
// contract; this file loads, checks and combines extensions and runs nothing of its own.

const KNOWN = ['name', 'options', 'usage', 'commands', 'route', 'config', 'report'];

// Extensions in <root>/extensions/<dir>/index.js, then the modules listed in
// AGENT_TEAM_EXTENSIONS (a directory means its index.js). A module found twice loads once.
function candidatePaths(root, env) {
  const dir = join(root, 'extensions');
  const found = existsSync(dir)
    ? readdirSync(dir).sort().map((n) => join(dir, n, 'index.js')).filter((p) => existsSync(p))
    : [];
  const listed = (env.AGENT_TEAM_EXTENSIONS ?? '').split(delimiter).filter(Boolean).map((p) => {
    const abs = resolve(p);
    return existsSync(abs) && statSync(abs).isDirectory() ? join(abs, 'index.js') : abs;
  });
  return [...found, ...listed];
}

function check(ext, path) {
  const bad = (what) => { throw new Error(`extension ${path}: ${what}`); };
  if (ext === null || typeof ext !== 'object' || Array.isArray(ext)) bad('the default export must be an object');
  const unknown = Object.keys(ext).filter((k) => !KNOWN.includes(k));
  if (unknown.length > 0) bad(`unknown field "${unknown.join('", "')}" (expected ${KNOWN.join(', ')})`);
  if (typeof ext.name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(ext.name)) bad('"name" must be a short name of letters, digits, "_" or "-"');
  const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (ext.options !== undefined && !plain(ext.options)) bad('"options" must be an object of parseArgs option specs');
  for (const [k, spec] of Object.entries(ext.options ?? {})) {
    if (!plain(spec) || (spec.type !== 'string' && spec.type !== 'boolean')) bad(`option "${k}" needs a type of "string" or "boolean"`);
  }
  if (ext.usage !== undefined && !(typeof ext.usage === 'string' || (Array.isArray(ext.usage) && ext.usage.every((l) => typeof l === 'string')))) {
    bad('"usage" must be a string or an array of strings');
  }
  if (ext.commands !== undefined && !plain(ext.commands)) bad('"commands" must be an object of verb: async (ctx) => ...');
  for (const [verb, fn] of Object.entries(ext.commands ?? {})) {
    if (typeof fn !== 'function') bad(`command "${verb}" must be a function`);
  }
  if (ext.route !== undefined && typeof ext.route !== 'function') bad('"route" must be a function');
  if (ext.config !== undefined && !plain(ext.config)) bad('"config" must be an object');
  if (ext.report !== undefined && (!plain(ext.report) || typeof ext.report.runs !== 'function')) {
    bad('"report" must be an object with a runs(projectRoot) function');
  }
}

export async function loadExtensions({ root, env = process.env }) {
  const loaded = [];
  const seen = new Set();
  for (const path of candidatePaths(root, env)) {
    let key;
    try { key = realpathSync(path); } catch { throw new Error(`extension ${path}: no such file`); }
    if (seen.has(key)) continue;
    seen.add(key);
    let ext;
    try {
      ext = (await import(pathToFileURL(key).href)).default;
    } catch (err) {
      throw new Error(`extension ${path}: ${err.message}`);
    }
    check(ext, path);
    const twin = loaded.find((l) => l.name === ext.name);
    if (twin) throw new Error(`extension ${path}: the name "${ext.name}" is already used by ${twin.path}`);
    loaded.push({ ...ext, path });
  }
  const options = new Map();
  const verbs = new Map();
  for (const ext of loaded) {
    for (const k of Object.keys(ext.options ?? {})) {
      if (options.has(k)) throw new Error(`extension ${ext.path}: option --${k} is already added by ${options.get(k)}`);
      options.set(k, ext.path);
    }
    for (const verb of Object.keys(ext.commands ?? {})) {
      if (verbs.has(verb)) throw new Error(`extension ${ext.path}: command "${verb}" is already added by ${verbs.get(verb)}`);
      verbs.set(verb, ext.path);
    }
    try {
      extendConfig(ext.name, ext.config);
    } catch (err) {
      throw new Error(`extension ${ext.path}: ${err.message}`);
    }
  }
  return loaded;
}

// The CLI's parseArgs options plus the extensions'. An extension cannot redefine a core option.
export function mergeOptions(core, extensions) {
  const merged = { ...core };
  for (const ext of extensions) {
    for (const [k, spec] of Object.entries(ext.options ?? {})) {
      if (k in core) throw new Error(`extension ${ext.path}: option --${k} is already a core option`);
      merged[k] = spec;
    }
  }
  return merged;
}

export function extensionUsage(extensions) {
  return extensions.flatMap((e) => [e.usage ?? []].flat()).map((l) => (l.endsWith('\n') ? l : l + '\n')).join('');
}

// The command for a verb, if an extension added it. The caller keeps the core's own verbs.
export function findCommand(extensions, verb) {
  if (verb === undefined) return null;
  return extensions.find((e) => Object.hasOwn(e.commands ?? {}, verb))?.commands[verb] ?? null;
}

// Offers a delegation to each extension's route in load order; the first answer that is not
// null or undefined is the result. Null when none claims it, and the caller dispatches.
export async function routeDelegation(extensions, opts, { dispatch }) {
  for (const ext of extensions) {
    if (!ext.route) continue;
    const result = await ext.route(opts, { dispatch });
    if (result != null) return result;
  }
  return null;
}

// Runs from the extensions' report sources, shaped like the run log's records.
export async function extensionRuns(extensions, projectRoot) {
  const runs = [];
  for (const ext of extensions) {
    if (ext.report) runs.push(...(await ext.report.runs(projectRoot)));
  }
  return runs;
}

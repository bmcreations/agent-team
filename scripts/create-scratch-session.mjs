#!/usr/bin/env node
// Creates a throwaway, read-only Managed Agents session for scripts/verify-join.mjs.
// Prints only the session id on stdout; everything else goes to stderr.
//
//   GITHUB_TOKEN=... node scripts/create-scratch-session.mjs [options]
//   node scripts/verify-join.mjs --session "$(GITHUB_TOKEN=... node scripts/create-scratch-session.mjs)" ...
//
//   --repo <url>          repository to mount (default: this checkout's origin)
//   --ref <branch>        branch to check out (default main)
//   --budget-cents <n>    session budget, in the units the adapter uses (default 100)
//   --model <id>          default claude-haiku-4-5-20251001
//
// Needs ANTHROPIC_API_KEY, and GITHUB_TOKEN (or AGENT_TEAM_GITHUB_TOKEN) with read access to
// the repo. The token goes to the Managed Agents API as the repo's authorization_token.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

const { values: opt } = parseArgs({
  options: {
    repo: { type: 'string' }, ref: { type: 'string', default: 'main' },
    'budget-cents': { type: 'string', default: '100' }, model: { type: 'string', default: 'claude-haiku-4-5-20251001' }
  }
});

const env = process.env;
const BASE = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const BETA = 'managed-agents-2026-04-01';
const log = (msg) => process.stderr.write(`${msg}\n`);
function fail(msg) { log(`create-scratch-session: ${msg}`); process.exit(2); }

const githubToken = env.GITHUB_TOKEN || env.AGENT_TEAM_GITHUB_TOKEN;
if (!env.ANTHROPIC_API_KEY) fail('ANTHROPIC_API_KEY is not set');
if (!githubToken) fail('set GITHUB_TOKEN (or AGENT_TEAM_GITHUB_TOKEN) to a token that can read the repo');
if (!/^\d+$/.test(opt['budget-cents'])) fail('--budget-cents must be a whole number');

function originUrl() {
  const raw = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const ssh = raw.match(/^git@github\.com:(.+?)(\.git)?$/);
  return ssh ? `https://github.com/${ssh[1]}` : raw.replace(/\.git$/, '');
}
let repo = opt.repo;
if (!repo) {
  try { repo = originUrl(); } catch { fail('no --repo given and no git origin to default to'); }
}

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) fail(`POST ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// The same request bodies the claude-cloud adapter sends for a read-only member.
const agent = await api('/v1/agents', {
  name: 'verify-join scratch',
  model: opt.model,
  tools: [{
    type: 'agent_toolset_20260401',
    default_config: { enabled: false, permission_policy: { type: 'always_allow' } },
    configs: ['read', 'glob', 'grep'].map((name) => ({ name, enabled: true }))
  }]
});
log(`agent        ${agent.id}`);

const environment = await api('/v1/environments', {
  name: 'verify-join scratch',
  config: { type: 'cloud', networking: { type: 'limited', allow_package_managers: false, allow_mcp_servers: false } }
});
log(`environment  ${environment.id}`);

// No initial_events, so the session starts idle and verify-join sends the first message.
const session = await api('/v1/sessions', {
  agent: agent.id,
  environment_id: environment.id,
  resources: [{ type: 'github_repository', url: repo, authorization_token: githubToken, checkout: { type: 'branch', name: opt.ref } }],
  budget: { type: 'limit', max_list_cost: { amount: opt['budget-cents'], currency: 'USD' } },
  metadata: { purpose: 'verify-join scratch' }
});
log(`session      ${session.id} (${session.status}), ${repo} @ ${opt.ref}`);
log(`budget       ${JSON.stringify(session.budget)}  <- check this is the cap you meant`);
log(`archive it when done: pass --archive on the last verify-join run`);
console.log(session.id);

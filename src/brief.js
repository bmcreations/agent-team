import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const REFS = join(dirname(fileURLToPath(import.meta.url)), '..', 'references');
const DIALECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function loadDialect(dialect) {
  if (!dialect || dialect === 'claude') return null;   // native vocabulary, nothing to translate

  // Layer 1: a dialect is a plain name — no separators, no traversal segments. This
  // value can come from caps.tool_dialect, i.e. the untrusted adapter's own stdout,
  // so a malformed name is a loud failure, not a silently dialect-less brief.
  if (!DIALECT_NAME.test(dialect)) {
    throw new Error(`loadDialect: "${dialect}" is not a valid dialect name`);
  }

  const path = join(REFS, `${dialect}-tools.md`);

  // Layer 2: even a name that passed the allowlist must still resolve inside
  // references/. This is the check that survives the allowlist being loosened or
  // removed later — it inspects where the path actually lands, not the input string.
  const resolvedPath = resolve(path);
  const resolvedRefs = resolve(REFS);
  if (resolvedPath !== resolvedRefs && !resolvedPath.startsWith(resolvedRefs + sep)) {
    throw new Error(`loadDialect: "${dialect}" resolves outside references/`);
  }

  return existsSync(resolvedPath) ? readFileSync(resolvedPath, 'utf8') : null;
}

function delegationSection(reports, depth, maxDepth) {
  return [
    '# Delegating',
    '',
    `Your direct reports are: ${reports.join(', ')}.`,
    `You are at depth ${depth} of a maximum of ${maxDepth}.`,
    '',
    'If this work belongs to your reports, answer with delegations instead of a deliverable:',
    '',
    '    {"status":"delegating","delegations":[{"to":"<report>","task":"<their whole brief>"}]}',
    '',
    `You may only delegate to the reports named above. Each task you write is the entire`,
    'brief that report receives — they cannot see this one, so it must stand alone.',
    '',
    'You will then be called again with their results, and must produce your own',
    'deliverable from them.'
  ].join('\n');
}

function depthLimitSection(maxDepth) {
  return [
    '# Delegating',
    '',
    `You cannot delegate any further: depth ${maxDepth} is the configured maximum.`,
    'Produce your deliverable yourself.'
  ].join('\n');
}

export function buildBrief({
  resolved, task, cwd, denyPaths, skillText = null, dialectText = null,
  timeoutSec = 900, depth = 0, maxDepth = 3, priorResults = null
}) {
  if (!Array.isArray(denyPaths) || denyPaths.length === 0) {
    throw new Error(
      'buildBrief: "denyPaths" is required and must be a non-empty array — ' +
      'a rival CLI runs in this tree and ships context to a third party'
    );
  }

  const hasReports = resolved.reports.length > 0;
  const canDelegate = hasReports && depth < maxDepth;
  const hasPriorResults = Array.isArray(priorResults) ? priorResults.length > 0 : Boolean(priorResults);

  const sections = [];
  if (dialectText) sections.push(dialectText);
  if (resolved.charter) sections.push(`# Your charter\n\n${resolved.charter}`);
  if (resolved.persona) sections.push(`# How you work\n\n${resolved.persona}`);
  if (skillText) sections.push(skillText);
  if (canDelegate) sections.push(delegationSection(resolved.reports, depth, maxDepth));
  else if (hasReports) sections.push(depthLimitSection(maxDepth));
  if (hasPriorResults) {
    sections.push(
      `# Results from your reports\n\n\`\`\`json\n${JSON.stringify(priorResults, null, 2)}\n\`\`\``
    );
  }
  sections.push(`# Task\n\n${task}`);

  return {
    member: resolved.member,
    title: resolved.title,
    task: sections.join('\n\n---\n\n'),
    cwd,
    read_only: resolved.isolation !== 'workspace',
    deliverable: resolved.deliverable,
    output_path: resolved.output_path,
    model: resolved.model,
    timeout_s: timeoutSec,
    deny_paths: denyPaths,
    reports: resolved.reports,
    can_delegate: canDelegate,
    depth,
    max_depth: maxDepth
  };
}

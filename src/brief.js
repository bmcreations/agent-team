import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REFS = join(dirname(fileURLToPath(import.meta.url)), '..', 'references');

export function loadDialect(dialect) {
  if (!dialect || dialect === 'claude') return null;   // native vocabulary, nothing to translate
  const path = join(REFS, `${dialect}-tools.md`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
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
  const hasReports = resolved.reports.length > 0;
  const canDelegate = hasReports && depth < maxDepth;

  const sections = [];
  if (dialectText) sections.push(dialectText);
  if (resolved.charter) sections.push(`# Your charter\n\n${resolved.charter}`);
  if (resolved.persona) sections.push(`# How you work\n\n${resolved.persona}`);
  if (skillText) sections.push(skillText);
  if (canDelegate) sections.push(delegationSection(resolved.reports, depth, maxDepth));
  else if (hasReports) sections.push(depthLimitSection(maxDepth));
  if (priorResults) {
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

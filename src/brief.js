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

// One line per report that has something to say: its charter, and for another team, that
// the task goes to that team's lead, who splits it among its own members.
function reportLines(details) {
  return details
    .filter((d) => d.charter || d.team)
    .map((d) => {
      const team = d.team
        ? `Another team, in ${d.team}. Its lead gets your task and splits it among that team's members.`
        : null;
      return `- ${d.name}: ${[d.charter, team].filter(Boolean).join(' ')}`;
    });
}

function delegationSection(reports, depth, maxDepth, details = []) {
  const lines = reportLines(details);
  return [
    '# Delegating',
    '',
    `Your direct reports are: ${reports.join(', ')}.`,
    ...(lines.length ? ['', ...lines, ''] : []),
    `You are at depth ${depth} of a maximum of ${maxDepth}.`,
    '',
    'If this work belongs to your reports, answer with delegations instead of a deliverable:',
    '',
    '    {"status":"delegating","delegations":[{"to":"<report>","task":"<their whole brief>"}]}',
    '',
    'Your whole answer must be that JSON object, alone or in one fenced code block, with no',
    'other text. An answer that mentions it among other text is treated as a failed run.',
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

// The advisor tool's own guidance already says when to call it, yet a sonnet worker with
// advisor "fable" called it in 2 of 10 runs, both near the end and never before its first
// edit. The step is repeated here, next to the task. Claude Code can still skip the advisor
// (see adapters/claude), so the wording allows for the tool being absent.
function advisorSection() {
  return [
    '# Advisor',
    '',
    'If you have an advisor tool, call it once you have oriented and before your first edit',
    'or your first conclusion, and again before you write your final answer.'
  ].join('\n');
}

export function buildBrief({
  resolved, task, cwd, denyPaths, skillText = null, dialectText = null,
  timeoutSec = 900, depth = 0, maxDepth = 3, priorResults = null, cloud = null
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
  if (canDelegate) sections.push(delegationSection(resolved.reports, depth, maxDepth, resolved.report_details));
  else if (hasReports) sections.push(depthLimitSection(maxDepth));
  if (hasPriorResults) {
    sections.push(
      `# Results from your reports\n\n\`\`\`json\n${JSON.stringify(priorResults, null, 2)}\n\`\`\``
    );
  }
  if (resolved.agent === 'claude' && resolved.advisor) sections.push(advisorSection());
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
    effort: resolved.effort,
    advisor: resolved.advisor,
    permission_mode: resolved.permission_mode ?? null,
    timeout_s: timeoutSec,
    deny_paths: denyPaths,
    reports: resolved.reports,
    can_delegate: canDelegate,
    depth,
    max_depth: maxDepth,
    // Only for a claude-cloud member: the GitHub repository and branch its session clones,
    // the cost cap, and the branch a workspace member pushes its work to.
    ...(cloud ? { cloud } : {})
  };
}

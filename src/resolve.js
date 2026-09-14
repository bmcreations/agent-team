import { directReports } from './org.js';

export function resolveMember(config, name, { probe, assignments = {} } = {}) {
  if (!Object.prototype.hasOwnProperty.call(config.members, name)) {
    throw new Error(
      `unknown member: ${name} (configured: ${Object.keys(config.members).join(', ')})`
    );
  }
  const member = config.members[name];

  if (typeof probe !== 'function') {
    throw new Error(`member "${name}": resolveMember requires a "probe" function`);
  }

  let agent = member.agent;
  let warning = null;

  if (!probe(agent)) {
    const fallback = config.defaults?.on_unavailable;
    if (!fallback || !probe(fallback)) {
      throw new Error(
        `member "${name}": agent "${agent}" is unavailable and no usable fallback ` +
        `(on_unavailable: ${fallback ?? 'unset'})`
      );
    }
    warning = `agent "${agent}" unavailable; fell back to "${fallback}"`;
    agent = fallback;
  }

  // Checked AFTER fallback: a fallback must not create the self-review
  // that distinct_from exists to prevent.
  const conflicts = (member.distinct_from ?? []).filter((other) => assignments[other] === agent);
  if (conflicts.length > 0) {
    throw new Error(
      `member "${name}": distinct_from forbids "${agent}", already assigned to ` +
      `${conflicts.join(', ')} — refusing to let an agent review its own work` +
      (warning ? ` (reached via fallback: ${warning})` : '')
    );
  }

  return {
    member: name,
    title: member.title ?? name,
    agent,
    model: member.model ?? null,
    skill: member.skill ?? null,
    charter: member.charter ?? null,
    persona: member.persona ?? null,
    isolation: member.isolation,
    deliverable: member.deliverable,
    output_path: member.output_path ?? null,
    reports_to: member.reports_to ?? null,
    reports: directReports(config.org, name),
    warning
  };
}

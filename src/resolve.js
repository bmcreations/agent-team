export function resolveRole(config, roleName, { probe, assignments = {} } = {}) {
  const role = config.roles[roleName];
  if (!role) {
    throw new Error(`unknown role: ${roleName} (configured: ${Object.keys(config.roles).join(', ')})`);
  }

  let agent = role.agent;
  let warning = null;

  if (!probe(agent)) {
    const fallback = config.defaults?.on_unavailable;
    if (!fallback || !probe(fallback)) {
      throw new Error(
        `role "${roleName}": agent "${agent}" is unavailable and no usable fallback ` +
        `(on_unavailable: ${fallback ?? 'unset'})`
      );
    }
    warning = `agent "${agent}" unavailable; fell back to "${fallback}"`;
    agent = fallback;
  }

  // Checked AFTER fallback: a fallback must not create the self-review
  // that distinct_from exists to prevent.
  const conflicts = (role.distinct_from ?? []).filter((other) => assignments[other] === agent);
  if (conflicts.length > 0) {
    throw new Error(
      `role "${roleName}": distinct_from forbids "${agent}", already assigned to ` +
      `${conflicts.join(', ')} — refusing to let an agent review its own work` +
      (warning ? ` (reached via fallback: ${warning})` : '')
    );
  }

  return {
    role: roleName,
    agent,
    model: role.model ?? null,
    skill: role.skill ?? null,
    isolation: role.isolation ?? 'read-only',
    warning
  };
}

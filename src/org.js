export function buildOrg(members) {
  const names = Object.keys(members).sort();
  const parentOf = {};

  for (const name of names) {
    const parent = members[name].reports_to ?? null;
    if (parent === name) {
      throw new Error(`member "${name}": reports_to itself`);
    }
    if (parent !== null && !members[parent]) {
      throw new Error(`member "${name}": reports_to "${parent}" is not a configured member`);
    }
    parentOf[name] = parent;
  }

  for (const name of names) {
    const seen = [name];
    let cur = parentOf[name];
    while (cur) {
      if (seen.includes(cur)) {
        throw new Error(`reporting cycle: ${seen.join(' -> ')} -> ${cur}`);
      }
      seen.push(cur);
      cur = parentOf[cur];
    }
  }

  const reportsOf = Object.fromEntries(names.map((n) => [n, []]));
  for (const name of names) {
    if (parentOf[name]) reportsOf[parentOf[name]].push(name);
  }

  return {
    names,
    roots: names.filter((n) => parentOf[n] === null),
    parentOf,
    reportsOf
  };
}

export function directReports(org, name) {
  if (!Object.prototype.hasOwnProperty.call(org.reportsOf, name)) return [];
  return [...org.reportsOf[name]];
}

export function canDelegate(org, name) {
  return directReports(org, name).length > 0;
}

export function depthOf(org, name) {
  if (!Object.prototype.hasOwnProperty.call(org.parentOf, name)) {
    throw new Error(`unknown member: ${name}`);
  }
  let depth = 0;
  let cur = org.parentOf[name];
  while (cur) {
    depth += 1;
    cur = org.parentOf[cur];
  }
  return depth;
}

export function renderOrg(org) {
  const lines = [];
  const walk = (name, indent) => {
    lines.push(`${' '.repeat(indent)}${name}`);
    for (const child of directReports(org, name)) walk(child, indent + 2);
  };
  for (const root of org.roots) walk(root, 0);
  return lines.join('\n');
}

// A fixture extension that uses every part of the contract (docs/extensions.md).
export default {
  name: 'fixture',
  options: { shout: { type: 'boolean', default: false }, tag: { type: 'string' } },
  usage: '       agent-team hello [--shout] [--tag <text>]',
  commands: {
    hello: async ({ values, positionals, tokens, ROOT, adapterDir, skillsDir }) => {
      const who = positionals[1] ?? 'world';
      const text = `hello ${who}`;
      process.stdout.write(JSON.stringify({
        text: values.shout ? text.toUpperCase() : text, tag: values.tag ?? null,
        options: tokens.filter((t) => t.kind === 'option').map((t) => t.name),
        root: ROOT, adapterDir, skillsDir
      }) + '\n');
    },
    // A verb the core owns: the core's own command has to win.
    org: async () => { process.stdout.write('the extension org\n'); },
    exit3: async () => 3
  },
  // Claims a task starting with "claim:"; anything else falls through to the core.
  route: async (opts, { dispatch }) => {
    if (!opts.task.startsWith('claim:')) return null;
    return {
      status: 'ok', summary: `claimed ${opts.member} timeout=${opts.timeoutMs} tag=${opts.values.tag ?? ''}`,
      seen: typeof dispatch === 'function'
    };
  },
  config: {
    defaults: {
      fx_level: {
        default: 2,
        validate(v, path) {
          if (!Number.isInteger(v) || v < 1) throw new Error(`${path}: "defaults.fx_level" must be an integer >= 1`);
        }
      }
    },
    keys: {
      fx_tags: {
        default: [],
        validate(v, path) {
          if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) throw new Error(`${path}: "fx_tags" must be an array of strings`);
        }
      }
    }
  },
  report: {
    runs: async (projectRoot) => [{
      v: 1, at: '2030-01-01T00:00:00.000Z', project: projectRoot, task: 'a run from the fixture',
      tree: { member: 'fx-member', agent: 'fixture', model: null, advisor: null, status: 'ok', summary: '',
        depth: 0, elapsed_ms: 1000, usage: null, delegated: [] }
    }]
  }
};

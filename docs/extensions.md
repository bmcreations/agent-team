# Extensions

An extension is a module that adds to the CLI without editing it. It can add verbs and
options, claim a delegation before the core runs it, add keys to the project config, and
contribute runs to `agent-team report`.

## Loading

The CLI loads extensions on every start, before it parses its arguments:

- `<install dir>/extensions/<name>/index.js`, for each directory there, in name order.
- Each module path in `AGENT_TEAM_EXTENSIONS`, separated by the platform's path delimiter
  (`:` on macOS and Linux). A path to a directory means its `index.js`.

A module reached twice loads once. An extension that fails to load, throws while loading, has
an unknown field, or collides with another extension or with the core stops the CLI with
`{"status":"failed","summary":"extension <path>: <reason>"}` on stdout and exit code 1. Nothing
is skipped silently.

## The module

The default export is an object. Every field but `name` is optional; a field the core does
not know is an error, so a typo does not go unnoticed.

```js
export default {
  name: 'example',
  options: { shout: { type: 'boolean', default: false } },
  usage: '       agent-team hello [--shout]',
  commands: {
    hello: async ({ values, positionals }) => {
      process.stdout.write(`hello ${positionals[1] ?? 'world'}\n`);
    }
  },
  route: async (opts, { dispatch }) => null,
  config: { defaults: { /* ... */ }, keys: { /* ... */ } },
  report: { runs: async (projectRoot) => [] }
};
```

### `name`

A short name of letters, digits, `_` and `-`. Unique across extensions. It appears in error
messages.

### `options`

Extra `parseArgs` option specs, merged into the CLI's. Each needs `type: 'string'` or
`'boolean'`; `short` and `default` work as in `node:util`. An extension cannot redefine a core
option or one another extension added.

### `usage`

A string or an array of strings, appended to the usage text that `--help` and a usage error
print.

### `commands`

`{ verb: async (ctx) => number | void }`, run when the first positional argument is `verb`.
`ctx` holds:

| Field | |
| --- | --- |
| `values`, `positionals` | the parsed arguments, core and extension options together |
| `tokens` | the same parse with `tokens: true`, for a verb that needs argument order |
| `ROOT` | the install directory |
| `adapterDir`, `skillsDir` | `<ROOT>/adapters`, `<ROOT>/skills` |
| `fail(err)` | prints the failure as JSON on stdout and exits 1 |

A command that returns a number sets the exit code; otherwise the process exits 0 once
stdout has flushed. A command that throws is reported the same way as `fail`.

The core's own verbs (`org`, `report`, `channel`) are handled first, so an extension cannot
replace them. Two extensions cannot add the same verb.

### `route(opts, { dispatch })`

Called for `--member ... --task ...` after the arguments are checked and before the core
dispatches. Return a result object to claim the delegation: it is printed as the run's result
and the exit code is 0 for `status: 'ok'`, 1 otherwise. Return `null` or `undefined` to pass.
Extensions are offered the delegation in load order; the first to claim it wins, and when none
does the core runs `dispatch(opts)`.

`opts` holds `projectRoot`, `member`, `task`, `adapterDir`, `skillsDir`, `timeoutMs`
(`undefined` when `--timeout` was not given, so the core keeps its default), and `values`, the
parsed option values, extension options included. `dispatch` is the core's own function. It
accepts `preresolved` (the result of `resolveCaps`, exported from `src/dispatch.js`) so a
route that has already looked up a member's capabilities does not repeat the lookup.

A route that throws fails the CLI call; it does not fall through.

### `config`

```js
config: {
  defaults: { work_minutes: { default: 60, validate(value, path) { /* throw on a bad value */ } } },
  keys:     { peers:        { default: [], validate(value, path) { /* ... */ } } }
}
```

`defaults` adds keys under `defaults`; `keys` adds top-level keys. `validate` runs after the
core's own checks, on the value with `default` applied, and throws an `Error` whose message
starts with `path` (the config file). A key the config does not set takes a copy of `default`;
`loadConfig` returns extension top-level keys next to `members` and `org`, and extension
defaults inside `defaults`.

Without an extension that declares them, the core ignores unknown `defaults` and top-level
keys. A key cannot be declared that the core or another extension owns.

### `report`

`{ runs: async (projectRoot) => records }`. Each record has the shape of a run log line:
`{ v, at, project, task, tree }`, where `tree` is the member tree `agent-team report --json`
prints. `agent-team report` sorts these with the project's own run log by `at`, so the
extension's runs appear in the last-run view, `--all` totals and `--json`.

## Programmatic use

`src/extensions.js` exports the loader (`loadExtensions`) and the helpers the CLI uses, for
tests and for tools that embed the core. `extendConfig` and `resetConfigExtensions` in
`src/config.js` register and clear config keys; `loadExtensions` registers them for you.

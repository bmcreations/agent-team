import type { Register } from 'claude-code'

// /delegation prints the delegation report straight into the transcript, the way /context
// does, with no model turn. It runs the same `agent-team report` the /agent-team:report
// skill runs, so the table is formatted in one place.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'delegation',
      description: 'Show the last agent-team delegation as a tree (--all for per-member totals)',
    })
    return next(e)
  })

  on('command.run', { command: 'delegation' }, async ($, e) => {
    const args = e.args.split(/\s+/).filter(a => a === '--all' || a === '--json')
    const project = await $.session.root()
    // $.process.run rejects when node cannot start (say it is not on the app's PATH). Left
    // uncaught, the hook would fail and the command would print nothing.
    try {
      const { exitCode, stdout, stderr } = await $.process.run(
        ['node', `${$.plugin.root}/bin/agent-team.js`, 'report', '--project', project, ...args],
        { timeoutMs: 15_000 },
      )
      if (exitCode !== 0) return { text: `agent-team report failed: ${(stderr || stdout).trim()}` }
      return { text: stdout.trimEnd() }
    } catch (err) {
      return { text: `agent-team report could not run: ${(err as Error).message}. Try /agent-team:report.` }
    }
  })
}

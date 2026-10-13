// Loaded into every test process (`npm test` passes it with --import, and helpers/live.js
// imports it). A 1a test once ran the real claude by accident; from here on a test can only
// reach a fake. The sentinels answer --version, so `<adapter> probe` still passes and member
// resolution does not depend on what is installed, and refuse everything else loudly.
// AGENT_TEAM_LIVE_SMOKE=1 turns the guard off for the opt-in smoke tests in test/live/.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

export const GUARD_EXIT = 97;

// The test runner process sets this before spawning one process per file; they inherit it.
if (process.env.AGENT_TEAM_LIVE_SMOKE !== '1' && !process.env.AGENT_TEAM_TEST_GUARD) {
  const dir = mkdtempSync(join(tmpdir(), 'at-guard-'));
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(dir, name), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "0.0.0 (agent-team test guard)"; exit 0; fi',
      `echo "agent-team test guard: refusing to run the real ${name} ($*). Use a fake binary, or set AGENT_TEAM_LIVE_SMOKE=1." >&2`,
      `exit ${GUARD_EXIT}`,
      ''
    ].join('\n'));
    chmodSync(join(dir, name), 0o755);
  }
  process.env.AGENT_TEAM_TEST_GUARD = dir;
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  process.env.AGENT_TEAM_CODEX_BIN = join(dir, 'codex');
}

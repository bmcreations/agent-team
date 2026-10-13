# Task 8 report

Implemented src/client.js (verbatim from brief), test/client.test.js (verbatim), and the CLI: imports, USAGE line, `serve` branch, and live-vs-dispatch choice in the default path.

Deviations: the `serve` branch ends with `await new Promise(() => {})` so execution does not fall through to the usage check (exit 2) after start; signal handlers exit. Also `store.close()` before `fail(err)` on start failure.

TDD: RED step not separately run (tests and client written together); GREEN: `node --test test/client.test.js` 3/3 pass.
Manual serve check: printed "supervisor listening on .../s.sock", SIGINT -> exit 0 (store file remained, socket removed).
`npm test`: 428/428 pass.

Commit: feat(cli): add serve and run live members through the supervisor

Concerns: none. Not verified: the SupervisorRunning race path in runThroughSupervisor (no test).

## Fix round

1. serveRpc tracks open sockets and destroys them in close(), so a client blocked in wait_run no longer holds shutdown open. `shutdown` in bin/agent-team.js has a re-entrancy guard and `.catch`, always exits. Test: test/rpc-close.test.js (close resolves within 2s with a blocked call; the call rejects).
2. --timeout remotely: client passes timeoutMs in the `submit` params; the supervisor (src/supervisor.js, outside the stated files, necessary because `submit` ignored it) stores a per-run timeoutMs, falling back to the supervisor default, and uses it for the member context and brief.
3. serveRpc chmods the socket dir to 0700 only when mkdirSync created it.

Check: `npm test` 429/429 pass. Commit: fix(cli): exit serve promptly and honour --timeout remotely.

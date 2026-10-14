// Opt-in: runs the real `codex` against the user's ChatGPT login. `npm run test:live`.
// Drives `adapters/codex session` directly with a stub for the team's MCP socket, and
// `adapters/codex attach` under a pty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

const ADAPTER = new URL('../../adapters/codex', import.meta.url).pathname;
const skip = process.env.AGENT_TEAM_LIVE_SMOKE !== '1' && 'set AGENT_TEAM_LIVE_SMOKE=1 to run';
const WAIT_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pids matching `pgrep -f <pattern>`; empty when none.
const pids = (pattern) => {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
};
async function waitFor(what, fn, ms = WAIT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]/g, '');

// The model codex reports for a thread, from the adapter's raw log (thread/start, thread/resume
// and thread/started all carry it).
function modelIn(logPath) {
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const model = m?.result?.model ?? m?.result?.thread?.model ?? m?.params?.thread?.model;
    if (typeof model === 'string') return model;
  }
  return null;
}

test('real codex: a session is steered, interrupted, resumed and taken over', { skip, timeout: 300_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at-live-codex-'));
  const brief = (task) => ({ task, cwd, read_only: false });

  // The team's MCP socket, answering report_progress. Short path: macOS caps socket paths at 104 bytes.
  const calls = [];
  const sockPath = join(mkdtempSync(join(tmpdir(), 'at-s-')), 't.sock');
  const stub = createServer((sock) => {
    createInterface({ input: sock }).on('line', (line) => {
      const req = JSON.parse(line);
      calls.push(req);
      sock.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n');
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => stub.listen(sockPath, r));

  // A failed assertion leaves adapters (and their app-servers) running, and the runner would wait
  // on them forever; the finally below ends every one started.
  const children = [];
  const run = (start) => {
    const child = spawn(ADAPTER, ['session'], {
      cwd, stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, AGENT_TEAM_TEAM_SOCKET: sockPath, AGENT_TEAM_TEAM_TOKEN: 'stub-token' }
    });
    children.push(child);
    const lines = [];
    const waiting = [];
    let said = [];
    createInterface({ input: child.stdout }).on('line', (l) => {
      const m = JSON.parse(l);
      if (m.type === 'event' && m.kind === 'text') said.push(m.text);
      if (m.type === 'idle') { m.said = said.join('\n'); said = []; }
      lines.push(m);
      for (const w of waiting.splice(0)) w();
    });
    let seen = 0;
    const next = async (type) => {
      const end = Date.now() + WAIT_MS;
      for (;;) {
        const i = lines.findIndex((m, k) => k >= seen && m.type === type);
        if (i >= 0) { seen = i + 1; return lines[i]; }
        if (Date.now() > end) throw new Error(`timed out waiting for ${type}; saw ${JSON.stringify(lines.slice(seen))}`);
        await new Promise((r) => { waiting.push(r); setTimeout(r, 1000); });
      }
    };
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send(start);
    return { send, next, exit: new Promise((r) => child.on('close', r)) };
  };

  let pty = null;
  const sleepsBefore = pids('sleep 30');
  const serversBefore = pids('app-server');
  try {
    // 1. A fresh session answers, and its tokens are counted.
    const a = run({ type: 'start', brief: brief('Reply with the single word PONG.'), resume: null, note: null });
    const { resume } = await a.next('session');
    const first = await a.next('idle');
    assert.match(first.said, /PONG/);
    assert.ok(first.tokens > 0, `first idle tokens: ${first.tokens}`);

    // 2. A message between turns is acked, and the next turn answers it.
    a.send({ type: 'message', id: 1, from: 'ana (human)', text: 'The secret word is MANGO. Reply with the single word PING.' });
    assert.deepEqual(await a.next('ack'), { type: 'ack', message_id: 1 });
    const second = await a.next('idle');
    assert.match(second.said, /PING/);
    a.send({ type: 'stop' });
    const doneA = await a.next('result');
    assert.equal(doneA.status, 'ok');
    assert.equal(await a.exit, 0);
    const recorded = doneA.usage.tokens;
    assert.equal(recorded, first.tokens + (second.tokens ?? 0));

    // 3. A turn running `sleep 30` is interrupted, and the sleep goes with the app-server.
    const c = run({ type: 'start', resume: null, note: null,
                    brief: brief('Run the shell command `sleep 30`, then reply with the single word DONE.') });
    await c.next('session');
    await waitFor('the sleep to start', () => pids('sleep 30').some((p) => !sleepsBefore.includes(p)));
    c.send({ type: 'interrupt' });
    assert.equal((await c.next('idle')).interrupted, true);
    assert.equal(await c.exit, 0);
    await waitFor('the sleep to end', () => pids('sleep 30').every((p) => sleepsBefore.includes(p)), 10_000);

    // 4. A resumed session recalls the first, and does not count the restored total again.
    const b = run({ type: 'start', brief: brief('unused on resume'), resume, tokens: recorded,
                    note: 'What was the secret word I told you? Answer with that word only.' });
    assert.equal((await b.next('session')).resume, resume);
    const resumed = await b.next('idle');
    assert.match(resumed.said, /MANGO/i);
    assert.ok((resumed.tokens ?? 0) < recorded, `resumed turn tokens ${resumed.tokens} >= recorded ${recorded}`);

    // 5. The team tool works after resume.
    b.send({ type: 'message', id: 2, from: 'ana (human)',
             text: 'Call the agent-team report_progress tool with the text "live check", then reply with the single word DONE.' });
    await b.next('ack');
    await b.next('idle');
    const progress = calls.find((r) => r.method === 'report_progress');
    assert.ok(progress, `report_progress never reached the stub; calls: ${JSON.stringify(calls)}`);
    assert.equal(progress.token, 'stub-token');
    b.send({ type: 'stop' });
    const doneB = await b.next('result');
    assert.equal(await b.exit, 0);

    // thread/resume omits `model`, so codex may pick its default on resume. Both are read from
    // the adapters' raw logs.
    const modelA = modelIn(doneA.log_path);
    const modelB = modelIn(doneB.log_path);
    console.log(`codex model: fresh=${modelA} resumed=${modelB} (logs ${doneA.log_path}, ${doneB.log_path})`);
    if (modelA !== null && modelB !== null) assert.equal(modelB, modelA, 'the resumed thread runs on a different model');

    // 6. Take-over: the human drives the thread in the TUI, then the member resumes headless.
    const inner = `stty rows 50 cols 160; exec ${shq(ADAPTER)} attach ${shq(resume)}`;
    const scriptCmd = platform() === 'darwin' ? `script -q /dev/null sh -c ${shq(inner)}` : `script -qc ${shq(`sh -c ${shq(inner)}`)} /dev/null`;
    // Node's stdin pipe is a socket, which macOS `script` rejects ("tcgetattr/ioctl: Operation not
    // supported on socket"); `cat` hands it a real pipe. Closing our stdin after /quit lets cat exit.
    pty = spawn('sh', ['-c', `cat | ${scriptCmd}`], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color' } });
    let screen = '';
    pty.stdout.on('data', (d) => { screen += d; });
    pty.stderr.on('data', (d) => { screen += d; });
    const ptyExit = new Promise((r) => pty.on('close', r));
    const text = () => stripAnsi(screen);
    // The prompt is typed, then Enter is sent 2 s later: an Enter within about 1 s of the text is taken as part of a paste.
    const submit = async (line) => { pty.stdin.write(line); await sleep(2000); pty.stdin.write('\r'); };
    await waitFor('the TUI to draw', () => text().length > 200);
    // A first run in a directory may ask to trust it; its default answer is yes.
    if (/trust/i.test(text())) { await sleep(2000); pty.stdin.write('\r'); await sleep(2000); }
    // The reply "OKGO" is not in the prompt, so it appears only once the model has answered.
    await submit('Remember the word TAKEN. Reply with the word OK immediately followed by GO, with no space.');
    await waitFor('the TUI to show the reply', () => /OKGO/.test(text())).catch((e) => {
      throw new Error(`${e.message}; screen tail: ${JSON.stringify(text().slice(-1500))}`);
    });
    await sleep(2000);
    await submit('/quit');
    pty.stdin.end();
    const code = await Promise.race([ptyExit, sleep(30_000).then(() => 'hung')]);
    assert.notEqual(code, 'hung', `the TUI did not quit; screen tail: ${JSON.stringify(text().slice(-1500))}`);
    pty = null;
    await waitFor('the attach-owned app-server to be gone', () => pids('app-server').every((p) => serversBefore.includes(p)), 10_000);

    const d = run({ type: 'start', brief: brief('unused on resume'), resume, tokens: recorded + doneB.usage.tokens,
                    note: 'What word did I ask you to remember? Answer with that word only.' });
    await d.next('session');
    assert.match((await d.next('idle')).said, /TAKEN/i);
    d.send({ type: 'stop' });
    assert.equal((await d.next('result')).status, 'ok');
    assert.equal(await d.exit, 0);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (pty && pty.exitCode === null && pty.signalCode === null) pty.kill('SIGTERM');
    stub.close();
  }
});

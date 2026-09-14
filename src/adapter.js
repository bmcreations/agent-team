import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 900_000;

export function runAdapter(execPath, subcommand, {
  brief = null, timeoutMs = DEFAULT_TIMEOUT_MS, env = {}, cwd = undefined
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(execPath, [subcommand], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,               // own process group, so the whole tree dies on timeout
        env: { ...process.env, ...env },
        cwd
      });
    } catch (e) {
      resolve({ status: 'failed', summary: `could not spawn adapter: ${e.message}`, stderr: '' });
      return;
    }

    let out = '', err = '', timedOut = false, settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // `+=` on a raw Buffer chunk calls toString('utf8') on that chunk in isolation, so a
    // multi-byte character whose bytes straddle a chunk boundary decodes to U+FFFD on both
    // sides. setEncoding puts a StringDecoder in front of the stream, which buffers a
    // partial trailing character until the rest of its bytes arrive in the next chunk —
    // this line looks like a no-op but is load-bearing, don't remove it.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      finish({ status: 'failed', summary: `could not spawn adapter: ${e.message}`, stderr: err });
    });

    child.on('close', (code) => {
      if (timedOut) {
        return finish({
          status: 'timeout',
          summary: `adapter timed out after ${timeoutMs}ms`,
          stderr: err
        });
      }
      if (code !== 0) {
        return finish({ status: 'failed', summary: `adapter exited ${code}`, stderr: err });
      }

      const lines = out.trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1] ?? '';
      try {
        const parsed = JSON.parse(last);
        finish({ ...parsed, stderr: err });
      } catch {
        finish({
          status: 'failed',
          summary: 'adapter emitted non-JSON on stdout',
          raw: out.slice(0, 2000),
          stderr: err
        });
      }
    });

    try {
      child.stdin.on('error', () => { /* ignore EPIPE if the child never reads stdin */ });
      child.stdin.end(brief ? JSON.stringify(brief) : '');
    } catch { /* ignore */ }
  });
}

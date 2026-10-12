import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { encode, parseAdapterLine } from './protocol.js';

const STDERR_TAIL = 4000;

// One live v2 adapter process. It knows nothing about members or inboxes: it frames lines
// and reports the exit. The supervisor decides what each line means.
export class MemberSession {
  constructor({ execPath, cwd, env, onLine, onExit }) {
    this.stderr = '';
    this.child = spawn(execPath, ['session'], {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdin.on('error', () => {});   // the adapter may exit before we stop writing
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-STDERR_TAIL); });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const m = parseAdapterLine(line);
      if (m) onLine(m);
    });
    // 'close' rather than 'exit', so every stdout line has been read before onExit runs.
    this.child.on('close', (code) => onExit(code, this.stderr));
    this.child.on('error', (err) => { this.stderr += `\n${err.message}`; });
  }

  send(message) {
    if (this.child.stdin.writable) this.child.stdin.write(encode(message));
  }
}

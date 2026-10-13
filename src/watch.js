import { describe } from './web/feed.js';

const pad = (n) => String(n).padStart(2, '0');
const clock = (at) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
// Agent output reaches a terminal here, so control characters (ESC, BEL, OSC) are dropped.
export const plain = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();

export function formatRow(row) {
  if (row.type === 'message') {
    return `${clock(row.at)}  ${plain(row.from_name)} → ${plain(row.to_name)}  message  ${plain(row.text)}`;
  }
  return `${clock(row.at)}  ${plain(row.member)}  ${plain(row.kind)}  ${plain(describe(row))}`.trimEnd();
}

// Follows one run in the store: every write lands there, whichever supervisor made it, so
// this needs no socket and works for in-process runs too.
export async function watchRun({ store, runId, write, json = false, pollMs = 250, signal = null }) {
  if (!store.run(runId)) throw new Error(`unknown run ${runId}`);
  let afterEvent = 0;
  let afterMessage = 0;
  let seen = null;
  for (;;) {
    const v = store.version();
    if (v !== seen) {
      seen = v;
      // Status first: rows written before it said "done" are read below, in this pass.
      const status = store.run(runId).status;
      for (;;) {
        const { events, messages } = store.timeline({ runId, afterEvent, afterMessage, limit: 500 });
        const rows = [...events.map((e) => ({ type: 'event', ...e })), ...messages.map((m) => ({ type: 'message', ...m }))]
          .sort((a, b) => a.at - b.at || a.id - b.id);
        for (const row of rows) write(json ? `${JSON.stringify(row)}\n` : `${formatRow(row)}\n`);
        afterEvent = events.at(-1)?.id ?? afterEvent;
        afterMessage = messages.at(-1)?.id ?? afterMessage;
        if (events.length < 500 && messages.length < 500) break;
      }
      if (status !== 'running') return status;
    }
    if (signal?.aborted) return store.run(runId).status;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

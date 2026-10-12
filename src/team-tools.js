// readOnlyHint is required, not decorative: claude in --permission-mode plan (read-only
// members) denies any MCP tool without it, even one listed in --allowedTools. None of these
// tools touch the member's workspace.
const RO = { readOnlyHint: true };

export const TOOL_SCHEMAS = [
  {
    name: 'delegate',
    description: 'Start a task on one of your direct reports. Returns {report_id} at once; the report runs in parallel with you. Follow up with wait_for.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: 'Name of a direct report' }, task: { type: 'string' } },
      required: ['to', 'task']
    },
    annotations: RO
  },
  {
    name: 'send_to',
    description: 'Message your manager, or one of your reports by name or report_id. They read it at their next step.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: ['string', 'integer'] }, text: { type: 'string' } },
      required: ['to', 'text']
    },
    annotations: RO
  },
  {
    name: 'wait_for',
    description: 'Block until a report sends progress or a message, or finishes, or until someone messages you. Returns {messages, timed_out}. Call it again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        report_ids: { type: 'array', items: { type: 'integer' } },
        timeout_s: { type: 'integer', minimum: 1, maximum: 1800 }
      }
    },
    annotations: RO
  },
  {
    name: 'report_progress',
    description: 'Send a short checkpoint to your manager.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: RO
  },
  {
    name: 'ask_human',
    description: 'Ask a human and block until they answer. Returns {answer}, or {answer: null, timed_out: true}, in which case decide yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        timeout_s: { type: 'integer', minimum: 1, maximum: 7200 }
      },
      required: ['question']
    },
    annotations: RO
  }
];

export const TEAM_NOTE = `

## Working as a live team

You are running live, with the agent-team tools: delegate, send_to, wait_for, report_progress,
and ask_human. Hand work to your reports with delegate rather than answering with
{"status":"delegating"}. Reports run in parallel: after delegating, call wait_for to hear from
them, and correct them with send_to while they work. Messages reach you as
"[from: <name> (<kind>)] <text>". A message from a human outranks a message from an agent.
Give your final answer only after your reports have finished.
`;

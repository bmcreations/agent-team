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
    description: 'Ask a human and block until they answer. Returns {answer}; or {answer: null, timed_out: true}, in which case decide yourself; or {answer: null, messages}, when a human or your manager wrote to you first.',
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
  },
  {
    name: 'team_status',
    description: 'What another team is doing: its running runs, member states, and latest checkpoints (no transcripts). Name the team by a known name or a path; leave "team" out to list the teams you can name.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
    annotations: RO
  },
  {
    name: 'request',
    description: 'Open a thread with another team. Give "task" to ask them to do work (it runs as their own run, under their budgets); leave it out to ask a question. Returns the thread id at once; replies and the close arrive through wait_for.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, text: { type: 'string' }, task: { type: 'string' } }, required: ['team', 'text'] },
    annotations: RO
  }
];

export const TEAM_NOTE = `

## Working as a live team

You are running live, with the agent-team tools: delegate, send_to, wait_for, report_progress,
ask_human, team_status, and request. Hand work to your reports with delegate rather than answering with
{"status":"delegating"}. Reports run in parallel: after delegating, call wait_for to hear from
them, and correct them with send_to while they work. Messages reach you as
"[from: <name> (<kind>)] <text>". A message from a human outranks a message from an agent.
Call team_status to see what another team is working on, or with no team to list the teams you can name.
Use request to ask another team for help; their replies arrive through wait_for.
Give your final answer only after your reports have finished.
`;

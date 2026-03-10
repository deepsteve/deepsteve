const { z } = require('zod');
const path = require('path');

function init(context) {
  const { shells, closeSession } = context;
  return {
    get_session_info: {
      description: 'Get session metadata (tab name, cwd, worktree) for a deepsteve session. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get the session ID.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value.'),
      },
      handler: async ({ session_id }) => {
        const entry = shells.get(session_id);
        if (!entry) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        const fallbackName = entry.cwd ? path.basename(entry.cwd) : 'shell';
        return {
          content: [{ type: 'text', text: JSON.stringify({
            id: session_id,
            name: entry.name || fallbackName || 'root',
            cwd: entry.cwd,
            worktree: entry.worktree || null,
            windowId: entry.windowId || null,
            createdAt: entry.createdAt || null,
            elapsedMs: entry.createdAt ? Date.now() - entry.createdAt : null,
          }, null, 2) }]
        };
      },
    },
    close_session: {
      description: 'Close a deepsteve session and its browser tab. Gracefully terminates the Claude process. Call this when your work is complete and you want to clean up.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID to close. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value.'),
      },
      handler: async ({ session_id }) => {
        if (!closeSession(session_id)) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        return { content: [{ type: 'text', text: `Session "${session_id}" closed.` }] };
      },
    },
  };
}

module.exports = { init };

const { z } = require('zod');

function init(context) {
  const { shells } = context;
  return {
    get_session_info: {
      description: 'Get session metadata (tab name, cwd, worktree) for a deepsteve session. Pass the value of the DEEPSTEVE_SESSION_ID environment variable.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID (from DEEPSTEVE_SESSION_ID env var)'),
      },
      handler: async ({ session_id }) => {
        const entry = shells.get(session_id);
        if (!entry) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            id: session_id,
            name: entry.name || null,
            cwd: entry.cwd,
            worktree: entry.worktree || null,
          }, null, 2) }]
        };
      },
    },
  };
}

module.exports = { init };

const { z } = require('zod');

/**
 * Initialize activity tools. Returns tool definitions keyed by name.
 */
function init(context) {
  const { addActivityEvent, shells } = context;

  return {
    post_activity: {
      description: 'Post a status update to the activity feed. Use this to announce milestones, progress, or important events.',
      schema: {
        message: z.string().describe('The status message to post'),
        session_tag: z.string().optional().describe('Session name or tag to identify the source'),
      },
      handler: async ({ message, session_tag }) => {
        // Try to find the session by tag to get its ID
        let sessionId = null;
        let sessionName = session_tag || 'agent';
        if (session_tag) {
          for (const [id, entry] of shells) {
            if (entry.name === session_tag) {
              sessionId = id;
              break;
            }
          }
        }
        addActivityEvent({
          type: 'milestone',
          level: 'info',
          sessionId,
          sessionName,
          message,
        });
        return { content: [{ type: 'text', text: `Posted to activity feed: "${message}"` }] };
      },
    },
  };
}

/**
 * Register REST endpoints for the activity panel.
 */
function registerRoutes(app, context) {
  const { broadcast, activityEvents } = context;

  app.get('/api/activity', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const events = activityEvents.slice(-limit);
    res.json({ events });
  });

  app.post('/api/activity/clear', (req, res) => {
    activityEvents.length = 0;
    broadcast({ type: 'activity-cleared' });
    res.json({ cleared: true });
  });
}

module.exports = { init, registerRoutes };

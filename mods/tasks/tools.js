const fs = require('fs');
const path = require('path');
const { stateDir, spawnCwdProblem } = require('../../paths');
const { callerShellId } = require('../../project-scope');
const { z } = require('zod');

const TASKS_FILE = path.join(stateDir(), 'tasks.json');
let tasks = [];
let nextId = 1;

// The daemon's initMCP context. init() and registerRoutes() are handed the same object, and the
// session references below need it from both.
let ctx = null;

// Load existing tasks
try {
  if (fs.existsSync(TASKS_FILE)) {
    tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (tasks.length > 0) {
      nextId = Math.max(...tasks.map(t => t.id)) + 1;
    }
  }
} catch {}

function saveTasks() {
  try {
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch {}
}

// ── Session references (#719) ────────────────────────────────────────────────
//
// A task stores `sessions: [{ id, name }]`: the deepsteve shell id, which survives a close and a
// reopen, and the name the session had when it was attached. The stored name is shown only once
// the session record itself is gone, so a purged badge still says what it was.
//
// Whether a session is live, closed or gone is the daemon's state, not the task's. It is read as
// the task list goes out (describeSession) and never written back, because a stored copy would go
// stale the moment a tab closed.

/** A task's stored references. Tasks written before #719 have none. */
function sessionRefs(task) {
  return Array.isArray(task.sessions) ? task.sessions : [];
}

/** The daemon's record for a session id, live or tombstoned, or null. */
function sessionEntry(id) {
  if (!id || !ctx) return null;
  return ctx.shells.get(id) || (ctx.getSavedSession ? ctx.getSavedSession(id) : null) || null;
}

/**
 * One stored reference -> what the panel draws: { id, label, state, closedAt }.
 *
 * state is 'live' (a running shell), 'closed' (a tombstone, reopenable with --resume), 'saved'
 * (a record that is neither running nor closed — restorable all the same) or 'gone' (the
 * retention sweep purged the tombstone, and there is nothing left to reopen).
 */
function describeSession(ref) {
  const live = ctx ? ctx.shells.get(ref.id) : null;
  const saved = live ? null : sessionEntry(ref.id);
  const entry = live || saved;
  const label = (entry && entry.name) || ref.name || (entry && entry.cwd ? path.basename(entry.cwd) : '') || ref.id;
  if (live) return { id: ref.id, label, state: 'live', closedAt: null };
  if (saved) {
    return {
      id: ref.id, label,
      state: saved.closed ? 'closed' : 'saved',
      closedAt: saved.closed ? (saved.closedAt || saved.lastActivity || null) : null,
    };
  }
  return { id: ref.id, label, state: 'gone', closedAt: null };
}

/**
 * The project a task belongs to, derived from where its sessions ran: the first session whose cwd
 * sits inside a registered project's directory. { id, name, dir } or null. Derived rather than
 * stored for the same reason as a session's state — a project can be renamed or archived.
 */
function taskProject(task) {
  const contexts = ctx && ctx.getContexts ? ctx.getContexts() : [];
  if (!Array.isArray(contexts) || contexts.length === 0) return null;
  for (const ref of sessionRefs(task)) {
    const entry = sessionEntry(ref.id);
    const cwd = entry && entry.cwd;
    if (!cwd) continue;
    for (const c of contexts) {
      const dir = (c.dirs || []).find(d => cwd === d || cwd.startsWith(String(d).replace(/\/+$/, '') + '/'));
      if (dir) return { id: c.id, name: c.name, dir };
    }
  }
  return null;
}

/** The task list as it goes over the wire: each reference decorated with its session's state. */
function wireTasks() {
  return tasks.map(t => ({ ...t, sessions: sessionRefs(t).map(describeSession), project: taskProject(t) }));
}

/** Every directory of every registered project — the only places the Tasks app starts a session. */
function projectDirs() {
  const contexts = ctx && ctx.getContexts ? ctx.getContexts() : [];
  return (Array.isArray(contexts) ? contexts : []).flatMap(c => c.dirs || []);
}

// The screen preview's row cap. A session is spawned 40 rows tall, and the preview never needs its
// scrollback.
const SCREEN_ROWS_MAX = 60;

function broadcastTasks() {
  if (ctx) ctx.broadcast({ type: 'tasks', tasks: wireTasks() });
}

/** A windowId only if that window is connected now — otherwise the open would reach nobody. */
function connectedWindow(windowId) {
  if (!windowId || !ctx || !ctx.reloadClients) return null;
  for (const client of ctx.reloadClients) {
    if (client.readyState === 1 && client.windowId === windowId) return windowId;
  }
  return null;
}

function formatTaskList(filtered) {
  if (filtered.length === 0) return 'No tasks found.';
  return filtered.map(t => {
    const status = t.status === 'done' ? '[x]' : t.status === 'in-progress' ? '[~]' : '[ ]';
    const priority = t.priority ? ` (${t.priority})` : '';
    const tag = t.session_tag ? ` [${t.session_tag}]` : '';
    const desc = t.description ? `\n    ${t.description}` : '';
    const refs = sessionRefs(t).map(describeSession);
    const sessions = refs.length
      ? `\n    sessions: ${refs.map(r => `${r.label} (${r.id}, ${r.state})`).join(', ')}`
      : '';
    return `${status} #${t.id}: ${t.title}${priority}${tag}${desc}${sessions}`;
  }).join('\n');
}

/**
 * Initialize task tools. Returns tool definitions keyed by name.
 * Each tool has: { description, schema (Zod raw shape), handler }
 */
function init(context) {
  ctx = context;

  return {
    add_task: {
      description: 'Add a task for the human to do. The calling session is attached to the task automatically, so the human can get back to this conversation from the task later.',
      schema: {
        title: z.string().describe('Short title of the task'),
        description: z.string().optional().describe('Detailed description'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority level'),
        session_tag: z.string().optional().describe('Tag to identify which session created this task'),
      },
      handler: async ({ title, description, priority, session_tag }, extra) => {
        // The session that creates a task is its first reference (#719).
        const callerId = callerShellId(extra);
        const caller = callerId ? ctx.shells.get(callerId) : null;
        const task = {
          id: nextId++,
          title,
          description: description || '',
          priority: priority || 'medium',
          status: 'pending',
          session_tag: session_tag || '',
          sessions: caller ? [{ id: callerId, name: caller.name || null }] : [],
          created: Date.now(),
        };
        tasks.push(task);
        saveTasks();
        broadcastTasks();
        return { content: [{ type: 'text', text: `Task #${task.id} created: "${task.title}"` }] };
      },
    },

    update_task: {
      description: 'Update an existing task',
      schema: {
        id: z.number().describe('Task ID to update'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        status: z.enum(['pending', 'in-progress', 'done']).optional().describe('New status'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('New priority'),
      },
      handler: async ({ id, title, description, status, priority }) => {
        const task = tasks.find(t => t.id === id);
        if (!task) return { content: [{ type: 'text', text: `Task #${id} not found.` }] };

        if (title !== undefined) task.title = title;
        if (description !== undefined) task.description = description;
        if (status !== undefined) task.status = status;
        if (priority !== undefined) task.priority = priority;
        saveTasks();
        broadcastTasks();
        return { content: [{ type: 'text', text: `Task #${id} updated.` }] };
      },
    },

    complete_task: {
      description: 'Mark a task as done',
      schema: {
        id: z.number().describe('Task ID to complete'),
      },
      handler: async ({ id }) => {
        const task = tasks.find(t => t.id === id);
        if (!task) return { content: [{ type: 'text', text: `Task #${id} not found.` }] };

        task.status = 'done';
        saveTasks();
        broadcastTasks();
        return { content: [{ type: 'text', text: `Task #${id} marked as done.` }] };
      },
    },

    list_tasks: {
      description: 'List current tasks',
      schema: {
        status: z.enum(['pending', 'in-progress', 'done']).optional().describe('Filter by status'),
        session_tag: z.string().optional().describe('Filter by session tag'),
      },
      handler: async ({ status, session_tag }) => {
        let filtered = tasks;
        if (status) filtered = filtered.filter(t => t.status === status);
        if (session_tag) filtered = filtered.filter(t => t.session_tag === session_tag);
        return { content: [{ type: 'text', text: formatTaskList(filtered) }] };
      },
    },
  };
}

/**
 * Register REST endpoints for the browser panel.
 */
function registerRoutes(app, context) {
  ctx = context;

  app.get('/api/tasks', (req, res) => {
    res.json({ tasks: wireTasks() });
  });

  // The Tasks app's rail badge: how many tasks are not done. Polled every 5s by every window, so it
  // reads the in-memory list and nothing else.
  app.get('/api/tasks/count', (req, res) => {
    res.json({ count: tasks.filter(t => t.status !== 'done').length });
  });

  // A task the human writes in the Tasks app. add_task is the agents' door; this is the human's, so
  // it attaches no session.
  app.post('/api/tasks', (req, res) => {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return res.status(400).json({ error: 'A task needs a title' });
    const priority = ['low', 'medium', 'high'].includes(body.priority) ? body.priority : 'medium';
    const task = {
      id: nextId++,
      title: title.slice(0, 500),
      description: typeof body.description === 'string' ? body.description : '',
      priority,
      status: 'pending',
      session_tag: '',
      sessions: [],
      created: Date.now(),
    };
    tasks.push(task);
    saveTasks();
    broadcastTasks();
    res.json({ task });
  });

  app.post('/api/tasks/:id/status', (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!['pending', 'in-progress', 'done'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    task.status = status;
    saveTasks();
    broadcastTasks();
    res.json({ task });
  });

  app.post('/api/tasks/:id/description', (req, res) => {
    const id = parseInt(req.params.id);
    const { description } = req.body;
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (typeof description !== 'string') {
      return res.status(400).json({ error: 'Invalid description' });
    }
    task.description = description;
    saveTasks();
    broadcastTasks();
    res.json({ task });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    tasks.splice(idx, 1);
    saveTasks();
    broadcastTasks();
    res.json({ deleted: id });
  });

  // Attach a session from the panel's picker (#719). Only one the daemon has a record of, live or
  // tombstoned: an id that names nothing would be a "gone" badge from the moment it was added.
  app.post('/api/tasks/:id/sessions', (req, res) => {
    const id = parseInt(req.params.id);
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const sessionId = req.body && typeof req.body.sessionId === 'string' ? req.body.sessionId : '';
    const entry = sessionEntry(sessionId);
    if (!entry) return res.status(404).json({ error: 'Session not found' });
    if (!sessionRefs(task).some(s => s.id === sessionId)) {
      task.sessions = [...sessionRefs(task), { id: sessionId, name: entry.name || null }];
      saveTasks();
      broadcastTasks();
    }
    res.json({ task });
  });

  app.delete('/api/tasks/:id/sessions/:sessionId', (req, res) => {
    const id = parseInt(req.params.id);
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const kept = sessionRefs(task).filter(s => s.id !== req.params.sessionId);
    if (kept.length !== sessionRefs(task).length) {
      task.sessions = kept;
      saveTasks();
      broadcastTasks();
    }
    res.json({ task });
  });

  // Go to one of a task's sessions (#719): bring its tab forward if it is running, reopen it with
  // --resume if it is closed. These are the two pushes Inbox's Discuss sends (discussItem in
  // mods/inbox/tools.js), and app.js's open-session handler does the rest. Live or closed is
  // decided HERE, at click time, so a badge drawn before its session closed still does the right
  // thing. Scoped to a session this task references, so the route is not a door to any session.
  app.post('/api/tasks/:id/sessions/:sessionId/open', (req, res) => {
    const id = parseInt(req.params.id);
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const sessionId = req.params.sessionId;
    if (!sessionRefs(task).some(s => s.id === sessionId)) {
      return res.status(404).json({ error: 'Session is not attached to this task' });
    }
    const clickedWindow = connectedWindow(req.body && req.body.windowId);

    const live = ctx.shells.get(sessionId);
    if (live) {
      // The window that already has the tab, if it is connected; the one that clicked otherwise.
      const target = connectedWindow(live.windowId) || clickedWindow;
      const tabDelivery = ctx.deliverToWindow({
        type: 'open-session', id: sessionId, cwd: live.cwd, name: live.name, windowId: target, repair: true, focus: true,
      }, target, { openBrowser: true });
      ctx.log(`[tasks] task #${id} -> focus ${sessionId} (${tabDelivery})`);
      return res.json({ opened: 'focused', tabDelivery });
    }

    const saved = ctx.getSavedSession ? ctx.getSavedSession(sessionId) : null;
    if (!saved) {
      return res.status(410).json({
        error: 'gone',
        message: 'This session was removed by the closed-session retention sweep and cannot be reopened.',
      });
    }
    const problem = saved.cwd
      ? spawnCwdProblem(saved.cwd)
      : { code: 'cwd-missing', message: 'This session has no working directory to reopen in.' };
    if (problem) return res.status(409).json({ error: problem.code, message: problem.message });

    const tabDelivery = ctx.deliverToWindow({
      type: 'open-session', id: sessionId, cwd: saved.cwd, name: saved.name, windowId: clickedWindow, restore: true,
    }, clickedWindow, { openBrowser: true });
    ctx.log(`[tasks] task #${id} -> restore ${sessionId} (${tabDelivery})`);
    res.json({ opened: 'restored', tabDelivery });
  });

  // The Tasks app's terminal preview: the bottom of a live session's screen, as plain text. Scoped
  // like the open route, so it is not a way to read any session's screen. linesSync, not the
  // awaited read, because this is polled every second and a chatty session must not stall it.
  app.get('/api/tasks/:id/sessions/:sessionId/screen', (req, res) => {
    const id = parseInt(req.params.id);
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const sessionId = req.params.sessionId;
    if (!sessionRefs(task).some(s => s.id === sessionId)) {
      return res.status(404).json({ error: 'Session is not attached to this task' });
    }
    const entry = ctx.shells.get(sessionId);
    if (!entry) return res.status(409).json({ error: 'not-live' });
    const n = Math.max(1, Math.min(SCREEN_ROWS_MAX, Number(req.query.lines) || 40));
    let lines = [];
    try {
      const scr = entry.terminalScreen;
      if (scr && typeof scr.linesSync === 'function') lines = scr.linesSync(n) || [];
    } catch {}
    const state = ctx.sessionInputState ? ctx.sessionInputState(entry) : null;
    res.json({ lines, state });
  });

  // Start a new agent session for a task, in one of a registered project's directories, and attach
  // it (#719's reference, so it gets a badge and survives a close like any other). The spawn is
  // server-side because the browser's createSession cannot hand back the id the task needs.
  app.post('/api/tasks/:id/start', (req, res) => {
    const id = parseInt(req.params.id);
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const cwd = req.body && typeof req.body.cwd === 'string' ? req.body.cwd : '';
    if (!projectDirs().includes(cwd)) {
      return res.status(400).json({ error: 'not-a-project', message: 'Tasks start sessions only in a registered project\'s directory.' });
    }
    if (typeof ctx.spawnAgentSession !== 'function') {
      return res.status(501).json({ error: 'This daemon cannot start sessions for Tasks' });
    }
    const name = task.title.length > 40 ? task.title.slice(0, 39) + '…' : task.title;
    const result = ctx.spawnAgentSession({
      cwd,
      agentType: (ctx.settings && ctx.settings.defaultAgent) || 'claude',
      name,
      windowId: connectedWindow(req.body && req.body.windowId),
      source: `tasks #${id}`,
    });
    if (!result || result.error) {
      const err = result && result.error;
      return res.status(409).json({ error: (err && err.code) || 'spawn-failed', message: (err && err.message) || 'The session did not start' });
    }
    task.sessions = [...sessionRefs(task), { id: result.id, name }];
    saveTasks();
    broadcastTasks();
    ctx.log(`[tasks] task #${id} -> started ${result.id} in ${cwd}`);
    res.json({ id: result.id, tabDelivery: result.tabDelivery });
  });
}

module.exports = { init, registerRoutes };

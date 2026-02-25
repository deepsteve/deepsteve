const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const TASKS_FILE = path.join(os.homedir(), '.deepsteve', 'tasks.json');
let tasks = [];
let nextId = 1;

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

function formatTaskList(filtered) {
  if (filtered.length === 0) return 'No tasks found.';
  return filtered.map(t => {
    const status = t.status === 'done' ? '[x]' : t.status === 'in-progress' ? '[~]' : '[ ]';
    const priority = t.priority ? ` (${t.priority})` : '';
    const tag = t.session_tag ? ` [${t.session_tag}]` : '';
    const desc = t.description ? `\n    ${t.description}` : '';
    return `${status} #${t.id}: ${t.title}${priority}${tag}${desc}`;
  }).join('\n');
}

/**
 * Initialize task tools. Returns tool definitions keyed by name.
 * Each tool has: { description, schema (Zod raw shape), handler }
 */
function init(context) {
  const { broadcast } = context;

  function broadcastTasks() {
    broadcast({ type: 'tasks', tasks });
  }

  return {
    add_task: {
      description: 'Add a task for the human to do',
      schema: {
        title: z.string().describe('Short title of the task'),
        description: z.string().optional().describe('Detailed description'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority level'),
        session_tag: z.string().optional().describe('Tag to identify which session created this task'),
      },
      handler: async ({ title, description, priority, session_tag }) => {
        const task = {
          id: nextId++,
          title,
          description: description || '',
          priority: priority || 'medium',
          status: 'pending',
          session_tag: session_tag || '',
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
  const { broadcast } = context;

  function broadcastTasks() {
    broadcast({ type: 'tasks', tasks });
  }

  app.get('/api/tasks', (req, res) => {
    res.json({ tasks });
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
}

module.exports = { init, registerRoutes };

// Locally-queued cron for scheduled, MCP-capable agent tasks (issue #521).
//
// Schedules recurring agent runs that execute ON THIS MACHINE, so they get the
// user's local MCP servers for free (unlike Claude Code's cloud /schedule, which
// is egress-restricted). Tasks are self-contained (prompt + project + cron) and
// organized by project (git repo root); optional project groups let sibling
// repos be viewed together.
//
// The scheduler lives entirely in this mod: init(context) starts a setInterval
// tick using the spawn helpers on the shared `context` object (assembled in
// server.js where initMCP is called). server.js itself only contributes the
// `scheduledTasksEnabled` kill-switch setting.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');
const { z } = require('zod');
const cron = require('./cron');

const TASKS_FILE = path.join(os.homedir(), '.deepsteve', 'scheduled-tasks.json');
const GROUPS_FILE = path.join(os.homedir(), '.deepsteve', 'project-groups.json');
const MAX_RUNS = 20;          // per-task run history is bounded
const TICK_MS = 30 * 1000;    // cron granularity is 1 min; 30s never misses a minute
const CATCHUP_DELAY_MS = 10 * 1000; // let the daemon settle before the overdue pass

// --- Persistent state (load on start, write-through on mutate) ---
let tasks = [];
let groups = [];
let ctx = null;               // set in init(); shared with registerRoutes
let schedulerStarted = false;

try {
  if (fs.existsSync(TASKS_FILE)) tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) || [];
} catch { tasks = []; }
try {
  if (fs.existsSync(GROUPS_FILE)) groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')) || [];
} catch { groups = []; }

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    if (ctx) ctx.log(`[scheduled] failed to write ${path.basename(file)}: ${e.message}`);
  }
}
function saveTasks() { writeJson(TASKS_FILE, tasks); }
function saveGroups() { writeJson(GROUPS_FILE, groups); }
function broadcastTasks() { if (ctx) ctx.broadcast({ type: 'scheduled-tasks' }); }

// --- Project resolution ---------------------------------------------------

// Canonicalize a path to its git repo root; fall back to the path itself.
function gitRoot(dir) {
  try {
    return execSync("zsh -l -c 'git rev-parse --show-toplevel'", { cwd: dir, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return dir;
  }
}

// The project a scheduled run should use. An explicit path wins (canonicalized);
// otherwise inherit the calling session's repo root.
function resolveProject(rawProject, shellId) {
  if (rawProject && String(rawProject).trim()) {
    let p = String(rawProject).trim();
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    return fs.existsSync(p) ? gitRoot(p) : p;
  }
  if (shellId && ctx && ctx.shells.has(shellId)) {
    const { repoRoot } = ctx.sessionPaths(ctx.shells.get(shellId));
    if (repoRoot) return repoRoot;
  }
  return '';
}

function displayName(project) {
  return project ? path.basename(project) : 'No project';
}

// Every project we know about (from tasks, groups, and live sessions), with
// basenames disambiguated by parent dir on collision — mirrors /api/git-roots.
function knownProjects() {
  const roots = new Set();
  for (const t of tasks) if (t.project) roots.add(t.project);
  for (const g of groups) for (const p of (g.projects || [])) if (p) roots.add(p);
  if (ctx) {
    for (const entry of ctx.shells.values()) {
      try { const { repoRoot } = ctx.sessionPaths(entry); if (repoRoot) roots.add(repoRoot); } catch {}
    }
  }
  const list = [...roots];
  const baseCounts = {};
  for (const r of list) { const b = path.basename(r); baseCounts[b] = (baseCounts[b] || 0) + 1; }
  return list.sort().map(root => {
    const base = path.basename(root);
    const name = baseCounts[base] > 1 ? path.join(path.basename(path.dirname(root)), base) : base;
    return { root, name };
  });
}

// Projects that share at least one group with `project` (includes itself).
function groupSiblings(project) {
  const sibs = new Set([project]);
  for (const g of groups) {
    if ((g.projects || []).includes(project)) {
      for (const p of g.projects) sibs.add(p);
    }
  }
  return sibs;
}

// --- Scheduling core ------------------------------------------------------

function safeNextRun(cronStr, from) {
  try { return cron.nextRun(cronStr, new Date(from)); }
  catch (e) { if (ctx) ctx.log(`[scheduled] bad cron "${cronStr}": ${e.message}`); return null; }
}

// Spawn a session for a task and record the run. Returns the new shell id, or
// null if the run was skipped (overlap guard) or the scheduler isn't ready.
function runTask(task, reason) {
  if (!ctx) return null;
  const {
    shells, getDefaultEngine, getSpawnArgs, spawnSession, sessionEnv, getAgentConfig,
    wireShellOutput, emitSessionOpen, watchClaudeSessionDir, unwatchClaudeSessionDir,
    deliverPromptWhenReady, deliverToWindow, saveState, isShuttingDown, log,
  } = ctx;

  // Overlap guard: don't stack a run on a still-running previous run.
  const last = task.runs && task.runs[0];
  if (last && last.status === 'started' && shells.has(last.sessionId)) {
    log(`[scheduled] "${task.title}" (${task.id}) skipped — previous run ${last.sessionId} still active`);
    return null;
  }

  const agentType = task.agentType || 'claude';
  const agentConfig = getAgentConfig(agentType);
  const cwd = task.project && fs.existsSync(task.project) ? task.project : os.homedir();
  const id = randomUUID().slice(0, 8);
  const claudeSessionId = randomUUID();
  const spawnArgs = getSpawnArgs(agentType, { sessionId: claudeSessionId, shellId: id, planMode: !!task.planMode });
  const sessionEngine = getDefaultEngine();
  const engineType = sessionEngine.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
  const name = `⏰ ${task.title}`;

  log(`[scheduled] running "${task.title}" (${task.id}) id=${id} agent=${agentType} engine=${engineType} cwd=${cwd} reason=${reason}`);
  spawnSession(sessionEngine, id, agentType, spawnArgs, cwd, {
    cols: 120, rows: 40, env: sessionEnv(id, { name, windowId: null, cwd, agentType }),
  });
  shells.set(id, {
    clients: new Set(), cwd, claudeSessionId, agentType,
    engine: sessionEngine, engineType, worktree: null, windowId: null,
    name, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(), prefill: true,
  });
  wireShellOutput(id);
  emitSessionOpen(id);
  if (task.prompt) deliverPromptWhenReady(id, task.prompt);
  if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
  sessionEngine.onExit(id, () => {
    if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
    // Flip this run's status to completed before the core removes the shell.
    const t = tasks.find(x => x.id === task.id);
    const run = t && t.runs.find(r => r.sessionId === id);
    if (run && run.status === 'started') { run.status = 'completed'; run.endedAt = Date.now(); saveTasks(); broadcastTasks(); }
    if (!isShuttingDown()) { shells.delete(id); saveState(); }
  });
  saveState();

  const now = Date.now();
  task.lastRun = now;
  task.runs = task.runs || [];
  task.runs.unshift({ startedAt: now, sessionId: id, status: 'started', endedAt: null });
  if (task.runs.length > MAX_RUNS) task.runs.length = MAX_RUNS;
  saveTasks();
  broadcastTasks();
  // No windowId and no openBrowser: unattended. The tab queues (pendingOpens)
  // and appears when a browser next connects.
  deliverToWindow({ type: 'open-session', id, cwd, name, windowId: null, prefill: true }, null);
  return id;
}

// Fire any enabled task whose next run has arrived.
function tick() {
  if (!ctx || !ctx.settings.scheduledTasksEnabled) return;
  const now = Date.now();
  let changed = false;
  for (const task of tasks) {
    if (!task.enabled) continue;
    if (task.nextRun == null) { task.nextRun = safeNextRun(task.cron, now); changed = true; continue; }
    if (task.nextRun <= now) {
      runTask(task, 'schedule');
      task.nextRun = safeNextRun(task.cron, now);
      changed = true;
    }
  }
  if (changed) saveTasks();
}

// One-shot startup pass: run each genuinely-overdue task ONCE (catch-up), then
// resume its schedule. A brand-new task with no computed nextRun is only
// scheduled forward, never back-run.
function runCatchUp() {
  if (!ctx || !ctx.settings.scheduledTasksEnabled) return;
  const now = Date.now();
  let changed = false;
  for (const task of tasks) {
    if (!task.enabled) continue;
    if (task.nextRun != null && task.nextRun <= now) {
      log_(`catch-up running overdue "${task.title}" (${task.id})`);
      runTask(task, 'catch-up');
    }
    if (task.nextRun == null || task.nextRun <= now) { task.nextRun = safeNextRun(task.cron, now); changed = true; }
  }
  if (changed) { saveTasks(); broadcastTasks(); }
}
function log_(msg) { if (ctx) ctx.log(`[scheduled] ${msg}`); }

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setTimeout(() => { try { runCatchUp(); } catch (e) { log_(`catch-up error: ${e.message}`); } }, CATCHUP_DELAY_MS);
  setInterval(() => { try { tick(); } catch (e) { log_(`tick error: ${e.message}`); } }, TICK_MS);
  log_(`scheduler started (${tasks.length} task(s))`);
}

// --- CRUD used by both MCP tools and REST ---------------------------------

function createTask({ title, prompt, cron: cronStr, project, agentType, planMode, enabled, createdBy }) {
  cron.parseCron(cronStr); // throws on invalid — caller catches
  const now = Date.now();
  const task = {
    id: randomUUID().slice(0, 8),
    title: String(title || 'Untitled task'),
    prompt: String(prompt || ''),
    project: project || '',
    agentType: agentType || 'claude',
    planMode: !!planMode,
    cron: cronStr.trim(),
    enabled: enabled !== false,
    createdAt: now,
    createdBy: createdBy || null,
    lastRun: null,
    nextRun: safeNextRun(cronStr, now),
    runs: [],
  };
  tasks.push(task);
  saveTasks();
  broadcastTasks();
  return task;
}

function updateTask(id, fields) {
  const task = tasks.find(t => t.id === id);
  if (!task) return null;
  if (fields.cron !== undefined) { cron.parseCron(fields.cron); task.cron = fields.cron.trim(); }
  if (fields.title !== undefined) task.title = String(fields.title);
  if (fields.prompt !== undefined) task.prompt = String(fields.prompt);
  if (fields.project !== undefined) task.project = fields.project || '';
  if (fields.agentType !== undefined) task.agentType = fields.agentType || 'claude';
  if (fields.planMode !== undefined) task.planMode = !!fields.planMode;
  if (fields.enabled !== undefined) task.enabled = !!fields.enabled;
  // Recompute next run from any schedule/enable change.
  task.nextRun = task.enabled ? safeNextRun(task.cron, Date.now()) : null;
  saveTasks();
  broadcastTasks();
  return task;
}

function deleteTask(id) {
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  saveTasks();
  broadcastTasks();
  return true;
}

// Compact one task for tool/JSON output.
function taskView(task) {
  const lastRun = task.runs && task.runs[0];
  return {
    id: task.id,
    title: task.title,
    project: task.project || null,
    projectName: displayName(task.project),
    cron: task.cron,
    schedule: cron.describe(task.cron),
    agentType: task.agentType,
    planMode: !!task.planMode,
    enabled: !!task.enabled,
    nextRun: task.nextRun,
    lastRun: task.lastRun,
    lastStatus: lastRun ? lastRun.status : null,
  };
}

function formatTaskLines(list) {
  if (list.length === 0) return 'No scheduled tasks.';
  return list.map(t => {
    const v = taskView(t);
    const state = v.enabled ? '' : ' (disabled)';
    const next = v.nextRun ? new Date(v.nextRun).toLocaleString() : 'n/a';
    return `#${v.id} "${v.title}"${state}\n  ${v.schedule} (cron: ${v.cron})\n  project: ${v.project || 'none'}\n  next run: ${next}${v.lastRun ? `; last run: ${new Date(v.lastRun).toLocaleString()} [${v.lastStatus}]` : ''}`;
  }).join('\n\n');
}

// --- MCP tools ------------------------------------------------------------

function init(context) {
  ctx = context;
  startScheduler();

  const callerShellId = (extra) => extra?.requestInfo?.url?.searchParams?.get('shellId') || null;

  return {
    schedule_task: {
      description: 'Schedule a recurring local agent task that runs on this machine (with full access to the project\'s MCP servers). Tasks are organized by project. Use for recurring reports/maintenance/digests that need local MCP — e.g. a weekly analytics report.',
      schema: {
        title: z.string().describe('Short title for the task'),
        prompt: z.string().describe('The prompt/instructions the agent runs each time'),
        cron: z.string().describe('5-field cron in local time: "min hour day-of-month month day-of-week". E.g. "0 9 * * 1" = every Monday 9am.'),
        project: z.string().optional().describe('Repo path to run in (canonicalized to its git root). Defaults to the calling session\'s project.'),
        agent_type: z.string().optional().describe('Agent to run (default "claude" — the MCP-capable agent).'),
        plan_mode: z.boolean().optional().describe('Start the agent in plan mode (default false).'),
        enabled: z.boolean().optional().describe('Whether the schedule is active (default true).'),
      },
      handler: async ({ title, prompt, cron: cronStr, project, agent_type, plan_mode, enabled }, extra) => {
        let task;
        try {
          task = createTask({
            title, prompt, cron: cronStr,
            project: resolveProject(project, callerShellId(extra)),
            agentType: agent_type, planMode: plan_mode, enabled,
            createdBy: callerShellId(extra),
          });
        } catch (e) {
          return { content: [{ type: 'text', text: `Could not schedule task: ${e.message}` }] };
        }
        const v = taskView(task);
        return { content: [{ type: 'text', text: `Scheduled #${v.id} "${v.title}": ${v.schedule} in ${v.project || 'no project'}. Next run: ${v.nextRun ? new Date(v.nextRun).toLocaleString() : 'n/a'}.` }] };
      },
    },

    list_scheduled_tasks: {
      description: 'List locally-scheduled agent tasks. By default lists tasks for the calling session\'s project; scope "group" adds sibling repos in the same project group; scope "all" lists everything.',
      schema: {
        scope: z.enum(['project', 'group', 'all']).optional().describe('project (default), group, or all'),
        project: z.string().optional().describe('Override the project to scope to (defaults to the caller\'s).'),
      },
      handler: async ({ scope, project }, extra) => {
        const effScope = scope || 'project';
        const proj = resolveProject(project, callerShellId(extra));
        let list = tasks;
        if (effScope === 'project') {
          list = tasks.filter(t => t.project === proj);
        } else if (effScope === 'group') {
          const sibs = groupSiblings(proj);
          list = tasks.filter(t => sibs.has(t.project));
        }
        const header = effScope === 'all' ? 'All scheduled tasks:'
          : effScope === 'group' ? `Scheduled tasks in ${displayName(proj)}'s group:`
          : `Scheduled tasks for ${displayName(proj)}:`;
        return { content: [{ type: 'text', text: `${header}\n\n${formatTaskLines(list)}` }] };
      },
    },

    update_scheduled_task: {
      description: 'Update fields of an existing scheduled task by id.',
      schema: {
        id: z.string().describe('Task id'),
        title: z.string().optional(),
        prompt: z.string().optional(),
        cron: z.string().optional().describe('New 5-field cron (local time)'),
        project: z.string().optional(),
        agent_type: z.string().optional(),
        plan_mode: z.boolean().optional(),
        enabled: z.boolean().optional(),
      },
      handler: async ({ id, title, prompt, cron: cronStr, project, agent_type, plan_mode, enabled }, extra) => {
        const fields = {};
        if (title !== undefined) fields.title = title;
        if (prompt !== undefined) fields.prompt = prompt;
        if (cronStr !== undefined) fields.cron = cronStr;
        if (project !== undefined) fields.project = resolveProject(project, callerShellId(extra));
        if (agent_type !== undefined) fields.agentType = agent_type;
        if (plan_mode !== undefined) fields.planMode = plan_mode;
        if (enabled !== undefined) fields.enabled = enabled;
        let task;
        try { task = updateTask(id, fields); }
        catch (e) { return { content: [{ type: 'text', text: `Could not update: ${e.message}` }] }; }
        if (!task) return { content: [{ type: 'text', text: `Task #${id} not found.` }] };
        const v = taskView(task);
        return { content: [{ type: 'text', text: `Updated #${v.id} "${v.title}": ${v.schedule}. Next run: ${v.nextRun ? new Date(v.nextRun).toLocaleString() : 'n/a'}.` }] };
      },
    },

    unschedule_task: {
      description: 'Delete a scheduled task by id.',
      schema: { id: z.string().describe('Task id to delete') },
      handler: async ({ id }) => {
        return { content: [{ type: 'text', text: deleteTask(id) ? `Deleted #${id}.` : `Task #${id} not found.` }] };
      },
    },

    run_scheduled_task_now: {
      description: 'Run a scheduled task immediately (does not change its schedule).',
      schema: { id: z.string().describe('Task id to run now') },
      handler: async ({ id }) => {
        const task = tasks.find(t => t.id === id);
        if (!task) return { content: [{ type: 'text', text: `Task #${id} not found.` }] };
        const shellId = runTask(task, 'manual');
        return { content: [{ type: 'text', text: shellId ? `Running #${id} now (session ${shellId}).` : `#${id} not started (a previous run may still be active).` }] };
      },
    },
  };
}

// --- REST for the panel ---------------------------------------------------

function registerRoutes(app, context) {
  ctx = ctx || context;

  app.get('/api/scheduled-tasks', (req, res) => {
    // Enrich each task with a human-readable schedule + project name for the panel,
    // keeping the full stored fields (prompt, runs, nextRun) for editing/history.
    const enriched = tasks.map(t => ({ ...t, schedule: cron.describe(t.cron), projectName: displayName(t.project) }));
    res.json({ tasks: enriched, groups, projects: knownProjects(), enabled: !!ctx.settings.scheduledTasksEnabled });
  });

  app.post('/api/scheduled-tasks', (req, res) => {
    const b = req.body || {};
    let projectRoot = b.project || '';
    if (projectRoot) projectRoot = resolveProject(projectRoot, null);
    try {
      const task = createTask({
        title: b.title, prompt: b.prompt, cron: b.cron, project: projectRoot,
        agentType: b.agentType, planMode: b.planMode, enabled: b.enabled,
      });
      res.json({ task });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/scheduled-tasks/:id', (req, res) => {
    const b = req.body || {};
    const fields = { ...b };
    if (b.project !== undefined) fields.project = b.project ? resolveProject(b.project, null) : '';
    try {
      const task = updateTask(req.params.id, fields);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ task });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/scheduled-tasks/:id', (req, res) => {
    if (!deleteTask(req.params.id)) return res.status(404).json({ error: 'Task not found' });
    res.json({ deleted: req.params.id });
  });

  app.post('/api/scheduled-tasks/:id/run', (req, res) => {
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const shellId = runTask(task, 'manual');
    res.json({ started: !!shellId, sessionId: shellId || null });
  });

  app.post('/api/scheduled-tasks/:id/enabled', (req, res) => {
    const task = updateTask(req.params.id, { enabled: !!(req.body && req.body.enabled) });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ task });
  });

  // --- Project groups ---
  app.get('/api/project-groups', (req, res) => res.json({ groups, projects: knownProjects() }));

  app.post('/api/project-groups', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Group name required' });
    const projects = Array.isArray(b.projects) ? b.projects.filter(Boolean) : [];
    const existing = groups.find(g => g.name === name);
    if (existing) existing.projects = projects;
    else groups.push({ name, projects });
    saveGroups();
    if (ctx) ctx.broadcast({ type: 'scheduled-tasks' });
    res.json({ groups });
  });

  app.delete('/api/project-groups/:name', (req, res) => {
    const idx = groups.findIndex(g => g.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'Group not found' });
    groups.splice(idx, 1);
    saveGroups();
    if (ctx) ctx.broadcast({ type: 'scheduled-tasks' });
    res.json({ deleted: req.params.name });
  });
}

module.exports = { init, registerRoutes };

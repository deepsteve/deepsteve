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
const MAX_RUNS = 20;          // per-task run history is bounded
const TICK_MS = 30 * 1000;    // cron granularity is 1 min; 30s never misses a minute
const CATCHUP_DELAY_MS = 10 * 1000; // let the daemon settle before the overdue pass

// Run status lifecycle (interactive Claude sessions don't exit when they finish,
// so completion is driven by the agent self-reporting via MCP — issue #525):
//   queued    — session spawned, prompt delivered, agent hasn't engaged yet
//   running   — agent called scheduled_task_started
//   succeeded / failed — agent called scheduled_task_finished
//   ended     — session closed with no self-report (fallback; crash or manual close)
// ACTIVE = not yet self-reported terminal; used by the overlap guard + onExit fallback.
// Legacy 'started'/'completed' rows (pre-#525) still render in the UI badge.
const ACTIVE_STATUSES = new Set(['queued', 'running', 'started']);

// --- Persistent state (load on start, write-through on mutate) ---
// Tasks live here; the named groups that drive scope:'group' are now the shared
// server-owned "contexts" (#526), read live via ctx.getContexts() — this mod no
// longer stores project-groups.json of its own.
let tasks = [];
let ctx = null;               // set in init(); shared with registerRoutes
let schedulerStarted = false;

try {
  if (fs.existsSync(TASKS_FILE)) tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) || [];
} catch { tasks = []; }

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
function broadcastTasks() { if (ctx) ctx.broadcast({ type: 'scheduled-tasks' }); }

// The shared contexts (#526), from server core via the initMCP ctx. Empty on an
// older core that doesn't expose them (group scope then falls back to self-only).
function getContexts() { return (ctx && ctx.getContexts) ? ctx.getContexts() : []; }
function pathInside(p, dir) {
  if (ctx && ctx.pathInside) return ctx.pathInside(p, dir);
  if (!p || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  return p === base || p.startsWith(base + '/');
}

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
  for (const c of getContexts()) for (const d of (c.dirs || [])) if (d) roots.add(d);
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

// Folders that define `project`'s group scope: the dirs of every context that
// contains `project` (by folder prefix), plus `project` itself. A task is "in the
// group" when its repo root is inside/equals one of these folders.
function groupScopeDirs(project) {
  const dirs = new Set(project ? [project] : []);
  for (const c of getContexts()) {
    if ((c.dirs || []).some(d => pathInside(project, d))) {
      for (const d of c.dirs) dirs.add(d);
    }
  }
  return [...dirs];
}

// --- Scheduling core ------------------------------------------------------

function safeNextRun(cronStr, from) {
  try { return cron.nextRun(cronStr, new Date(from)); }
  catch (e) { if (ctx) ctx.log(`[scheduled] bad cron "${cronStr}": ${e.message}`); return null; }
}

// Next fire time for a task. A one-shot (#528) fires at its next cron match and then
// retires: once it has fired (firedAt set) it never re-arms — returning null here is
// what makes it run exactly once. Recurring tasks always recompute from their cron.
function nextRunFor(task, from) {
  if (task.once && task.firedAt) return null;
  return safeNextRun(task.cron, from);
}

// Wrap a task's prompt with the scheduled-run contract: tell the agent this is an
// automated scheduled run and have it self-report via the MCP tools so the run
// record reflects real work rather than the session lifecycle (#525).
function scheduledRunPrompt(task) {
  return [
    `⏰ This is an automated scheduled task run: "${task.title}" (task ${task.id}).`,
    ``,
    `Before you start, call the \`scheduled_task_started\` tool to mark this run as started.`,
    `When you're done, call \`scheduled_task_finished\` with a one-line \`summary\` of what you did`,
    `(pass \`success: false\` if the task could not be completed). These record that the work actually ran.`,
    ``,
    `Your task:`,
    task.prompt,
  ].join('\n');
}

// Find the task + run for a calling session's shellId, mirroring the run<->session
// link recorded in runTask (run.sessionId === the spawned shellId). Returns
// { task, run } or null when the caller isn't a scheduled run.
function findRunByShell(shellId) {
  if (!shellId) return null;
  for (const task of tasks) {
    const run = (task.runs || []).find(r => r.sessionId === shellId);
    if (run) return { task, run };
  }
  return null;
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

  // Overlap guard: don't stack a run on a still-running previous run. A run that
  // has self-reported terminal (succeeded/failed) no longer blocks the next fire,
  // even though its idle tab may still be alive.
  const last = task.runs && task.runs[0];
  if (last && ACTIVE_STATUSES.has(last.status) && shells.has(last.sessionId)) {
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
  // Deliver the task prompt. For MCP-capable agents (claude today), wrap it with
  // the scheduled-run contract so the agent self-reports start/finish (#525);
  // agents without deepsteve MCP get the raw prompt as before.
  if (task.prompt) {
    const mcpWired = ctx.mcpConfigArgs(agentType, id).length > 0;
    deliverPromptWhenReady(id, mcpWired ? scheduledRunPrompt(task) : task.prompt);
  }
  if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
  sessionEngine.onExit(id, () => {
    if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
    // A daemon restart persists + resumes this session (same shellId), so the run
    // can still be self-reported afterwards — don't touch it while shutting down.
    // A real close with no self-report becomes 'ended' (we know it stopped, but
    // not that the work completed).
    if (!isShuttingDown()) {
      const t = tasks.find(x => x.id === task.id);
      const run = t && t.runs.find(r => r.sessionId === id);
      if (run && ACTIVE_STATUSES.has(run.status)) {
        run.status = 'ended'; run.endedAt = Date.now(); saveTasks(); broadcastTasks();
      }
      ctx.handleShellGone(id);
    }
  });
  saveState();

  const now = Date.now();
  task.lastRun = now;
  task.runs = task.runs || [];
  task.runs.unshift({ startedAt: now, sessionId: id, status: 'queued', endedAt: null, agentStartedAt: null, success: null, summary: null });
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
    if (task.once && task.firedAt) continue; // one-shot already fired — done, never again
    if (task.nextRun == null) { task.nextRun = nextRunFor(task, now); changed = true; continue; }
    if (task.nextRun <= now) {
      const started = runTask(task, 'schedule');
      if (task.once) {
        // Retire on a successful fire; if overlap-skipped (started == null) leave nextRun
        // (a past time) so the next tick retries the missed fire.
        if (started) { task.firedAt = now; task.nextRun = null; }
      } else {
        task.nextRun = nextRunFor(task, now);
      }
      changed = true;
    }
  }
  if (changed) { saveTasks(); broadcastTasks(); }
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
    if (task.once && task.firedAt) continue; // one-shot already fired — never re-run or re-arm
    if (task.nextRun != null && task.nextRun <= now) {
      log_(`catch-up running overdue "${task.title}" (${task.id})`);
      const started = runTask(task, 'catch-up');
      if (task.once) {
        // Retire on a successful catch-up fire; if overlap-skipped, leave nextRun to retry.
        if (started) { task.firedAt = now; task.nextRun = null; changed = true; }
        continue; // never recompute a one-shot forward
      }
    } else if (task.once) {
      // A one-shot not yet due: leave nextRun alone (its absolute time is already correct).
      // Only backfill a missing nextRun (e.g. re-enabled while the daemon was down).
      if (task.nextRun == null) { task.nextRun = nextRunFor(task, now); changed = true; }
      continue;
    }
    if (task.nextRun == null || task.nextRun <= now) { task.nextRun = nextRunFor(task, now); changed = true; }
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

function createTask({ title, prompt, cron: cronStr, once, project, agentType, planMode, enabled, createdBy, keepOpen, keepOpenOnFailure }) {
  cron.parseCron(cronStr); // throws on invalid — caller catches (a one-shot still uses a cron)
  const now = Date.now();
  const task = {
    id: randomUUID().slice(0, 8),
    title: String(title || 'Untitled task'),
    prompt: String(prompt || ''),
    project: project || '',
    agentType: agentType || 'claude',
    planMode: !!planMode,
    // Auto-close is the default: the tab closes when the agent self-reports
    // finished, unless keepOpen (always keep) or keepOpenOnFailure (keep on a
    // failed run) is set. Both default off. See scheduled_task_finished (#525).
    keepOpen: !!keepOpen,
    keepOpenOnFailure: !!keepOpenOnFailure,
    cron: cronStr.trim(),
    // One-shot (#528): fires at the next cron match then retires (firedAt set). firedAt
    // stays null on a manual Run now — only the scheduled/catch-up fire retires it.
    once: !!once,
    firedAt: null,
    enabled: enabled !== false,
    createdAt: now,
    createdBy: createdBy || null,
    lastRun: null,
    nextRun: null,
    runs: [],
  };
  task.nextRun = nextRunFor(task, now);
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
  if (fields.keepOpen !== undefined) task.keepOpen = !!fields.keepOpen;
  if (fields.keepOpenOnFailure !== undefined) task.keepOpenOnFailure = !!fields.keepOpenOnFailure;
  if (fields.once !== undefined) task.once = !!fields.once;
  if (fields.enabled !== undefined) task.enabled = !!fields.enabled;
  // Recompute next run from any schedule/enable change. A one-shot that has already
  // fired stays retired (nextRunFor returns null via its firedAt guard).
  task.nextRun = task.enabled ? nextRunFor(task, Date.now()) : null;
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

// Human-readable schedule for the panel/tools. A one-shot's cron (e.g. "0 15 * * *")
// would read as "Every day at 15:00", which is misleading for a run-once — so show the
// concrete single fire time instead, or "fired …" once it has retired (#528).
function scheduleLabel(task) {
  if (task.once) {
    if (task.firedAt) return `One-shot · fired ${new Date(task.firedAt).toLocaleString()}`;
    return task.nextRun
      ? `One-shot · ${new Date(task.nextRun).toLocaleString()}`
      : `One-shot · ${cron.describe(task.cron)}`;
  }
  return cron.describe(task.cron);
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
    schedule: scheduleLabel(task),
    once: !!task.once,
    firedAt: task.firedAt || null,
    done: !!(task.once && task.firedAt),
    agentType: task.agentType,
    planMode: !!task.planMode,
    keepOpen: !!task.keepOpen,
    keepOpenOnFailure: !!task.keepOpenOnFailure,
    enabled: !!task.enabled,
    nextRun: task.nextRun,
    lastRun: task.lastRun,
    lastStatus: lastRun ? lastRun.status : null,
    lastSuccess: lastRun && lastRun.success != null ? lastRun.success : null,
    lastSummary: lastRun && lastRun.summary ? lastRun.summary : null,
  };
}

function formatTaskLines(list) {
  if (list.length === 0) return 'No scheduled tasks.';
  return list.map(t => {
    const v = taskView(t);
    const state = v.done ? ' (one-shot, done)' : v.once ? ' (one-shot)' : v.enabled ? '' : ' (disabled)';
    const next = v.nextRun ? new Date(v.nextRun).toLocaleString() : 'n/a';
    // A retired one-shot has no next run — don't print a misleading "n/a".
    const nextLine = v.done ? '' : `\n  next run: ${next}`;
    const lastLine = v.lastRun
      ? `\n  last run: ${new Date(v.lastRun).toLocaleString()} [${v.lastStatus}]${v.lastSummary ? ` — ${v.lastSummary}` : ''}`
      : '';
    return `#${v.id} "${v.title}"${state}\n  ${v.schedule} (cron: ${v.cron})\n  project: ${v.project || 'none'}${nextLine}${lastLine}`;
  }).join('\n\n');
}

// --- MCP tools ------------------------------------------------------------

function init(context) {
  ctx = context;
  startScheduler();

  const callerShellId = (extra) => extra?.requestInfo?.url?.searchParams?.get('shellId') || null;

  return {
    schedule_task: {
      description: 'Schedule a local agent task that runs on this machine (with full access to the project\'s MCP servers). Tasks are organized by project. Recurring by default; pass once:true for a run-once task that fires at the next cron match and then retires itself (no need to unschedule it afterward). Use for reports/maintenance/digests that need local MCP — e.g. a weekly analytics report.',
      schema: {
        title: z.string().describe('Short title for the task'),
        prompt: z.string().describe('The prompt/instructions the agent runs each time'),
        cron: z.string().describe('5-field cron in local time: "min hour day-of-month month day-of-week". E.g. "0 9 * * 1" = every Monday 9am. For a one-shot (once:true), this is just the next matching time to fire at.'),
        once: z.boolean().optional().describe('Run exactly once at the next cron match, then retire (kept as a done row). Default false (recurring).'),
        project: z.string().optional().describe('Repo path to run in (canonicalized to its git root). Defaults to the calling session\'s project.'),
        agent_type: z.string().optional().describe('Agent to run (default "claude" — the MCP-capable agent).'),
        plan_mode: z.boolean().optional().describe('Start the agent in plan mode (default false).'),
        keep_open: z.boolean().optional().describe('Keep the tab open after each run finishes instead of auto-closing (default false).'),
        keep_open_on_failure: z.boolean().optional().describe('Keep the tab open when a run fails, even if auto-close is on (default false).'),
        enabled: z.boolean().optional().describe('Whether the schedule is active (default true).'),
      },
      handler: async ({ title, prompt, cron: cronStr, once, project, agent_type, plan_mode, keep_open, keep_open_on_failure, enabled }, extra) => {
        let task;
        try {
          task = createTask({
            title, prompt, cron: cronStr, once,
            project: resolveProject(project, callerShellId(extra)),
            agentType: agent_type, planMode: plan_mode, enabled,
            keepOpen: keep_open, keepOpenOnFailure: keep_open_on_failure,
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
          const dirs = groupScopeDirs(proj);
          list = tasks.filter(t => dirs.some(d => pathInside(t.project, d)));
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
        once: z.boolean().optional().describe('Make this a run-once task (fires at the next cron match, then retires) or back to recurring.'),
        project: z.string().optional(),
        agent_type: z.string().optional(),
        plan_mode: z.boolean().optional(),
        keep_open: z.boolean().optional().describe('Keep the tab open after each run finishes instead of auto-closing.'),
        keep_open_on_failure: z.boolean().optional().describe('Keep the tab open when a run fails, even if auto-close is on.'),
        enabled: z.boolean().optional(),
      },
      handler: async ({ id, title, prompt, cron: cronStr, once, project, agent_type, plan_mode, keep_open, keep_open_on_failure, enabled }, extra) => {
        const fields = {};
        if (title !== undefined) fields.title = title;
        if (prompt !== undefined) fields.prompt = prompt;
        if (cronStr !== undefined) fields.cron = cronStr;
        if (once !== undefined) fields.once = once;
        if (project !== undefined) fields.project = resolveProject(project, callerShellId(extra));
        if (agent_type !== undefined) fields.agentType = agent_type;
        if (plan_mode !== undefined) fields.planMode = plan_mode;
        if (keep_open !== undefined) fields.keepOpen = keep_open;
        if (keep_open_on_failure !== undefined) fields.keepOpenOnFailure = keep_open_on_failure;
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

    // --- Self-reporting (called by the scheduled-run agent itself, #525) ---
    // The caller is identified by its shellId (baked into its MCP URL); no params
    // needed to locate the run. Both are no-ops (with a friendly message) when the
    // caller isn't a scheduled run.
    scheduled_task_started: {
      description: 'Mark the current scheduled-task run as started. Call this once, before you begin the work, when you are running as a scheduled task. Takes no parameters — the run is identified from your session.',
      schema: {},
      handler: async (_args, extra) => {
        const found = findRunByShell(callerShellId(extra));
        if (!found) return { content: [{ type: 'text', text: 'This session is not a scheduled task run — nothing to mark.' }] };
        const { task, run } = found;
        run.status = 'running';
        run.agentStartedAt = Date.now();
        saveTasks();
        broadcastTasks();
        return { content: [{ type: 'text', text: `Marked scheduled run of "${task.title}" (#${task.id}) as started.` }] };
      },
    },

    scheduled_task_finished: {
      description: 'Mark the current scheduled-task run as finished. Call this once, when you are done, if you are running as a scheduled task. Pass a one-line summary of what you did; set success:false if the task could not be completed. The tab may auto-close afterwards depending on the task\'s settings.',
      schema: {
        success: z.boolean().optional().describe('Whether the task completed successfully (default true).'),
        summary: z.string().optional().describe('One-line summary of what was done (or why it failed).'),
      },
      handler: async ({ success, summary }, extra) => {
        const shellId = callerShellId(extra);
        const found = findRunByShell(shellId);
        if (!found) return { content: [{ type: 'text', text: 'This session is not a scheduled task run — nothing to mark.' }] };
        const { task, run } = found;
        const ok = success !== false; // default true
        run.status = ok ? 'succeeded' : 'failed';
        run.success = ok;
        run.summary = summary ? String(summary) : null;
        run.endedAt = Date.now();
        saveTasks();
        broadcastTasks();
        // Auto-close is the default; keepOpen always keeps, keepOpenOnFailure keeps
        // a failed run open for inspection. Closing acks this response first (the
        // core's killShell defers teardown), and the now-terminal status means the
        // onExit fallback won't overwrite it.
        const stayOpen = task.keepOpen || (!ok && task.keepOpenOnFailure);
        let closed = false;
        if (!stayOpen && shellId && ctx.shells.has(shellId)) {
          try { ctx.closeSession(shellId, 'scheduled'); closed = true; } catch (e) { log_(`auto-close failed for ${shellId}: ${e.message}`); }
        }
        return { content: [{ type: 'text', text: `Marked scheduled run of "${task.title}" (#${task.id}) as ${run.status}.${closed ? ' Closing this session.' : ''}` }] };
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
    const enriched = tasks.map(t => ({ ...t, schedule: scheduleLabel(t), projectName: displayName(t.project) }));
    // Groups (now the shared "contexts") arrive over /api/contexts + the 'contexts'
    // broadcast, not in this payload.
    res.json({ tasks: enriched, projects: knownProjects(), enabled: !!ctx.settings.scheduledTasksEnabled });
  });

  app.post('/api/scheduled-tasks', (req, res) => {
    const b = req.body || {};
    let projectRoot = b.project || '';
    if (projectRoot) projectRoot = resolveProject(projectRoot, null);
    try {
      const task = createTask({
        title: b.title, prompt: b.prompt, cron: b.cron, once: b.once, project: projectRoot,
        agentType: b.agentType, planMode: b.planMode, enabled: b.enabled,
        keepOpen: b.keepOpen, keepOpenOnFailure: b.keepOpenOnFailure,
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

  // Named groups moved to server core as the shared "contexts" (#526):
  // GET/POST/DELETE /api/contexts live in server.js. The panel edits groups there.
}

module.exports = { init, registerRoutes };

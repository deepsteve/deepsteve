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
// Resolves to ~/.deepsteve/git-root.js once deployed — mods sit at ~/.deepsteve/mods/<id>/.
const { findGitRoot } = require('../../git-root');

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
// Pure-fs walk (#553) — this used to shell out to `zsh -l -c 'git rev-parse'`, which
// blocks the event loop the WS upgrade handshake shares.
function gitRoot(dir) {
  return findGitRoot(dir) || dir;
}

// True when dir is inside a non-bare git work tree. gitRoot() can't answer this:
// it returns its input on failure, indistinguishable from "dir IS the root".
function isGitRepo(dir) {
  try {
    return execSync("zsh -l -c 'git rev-parse --is-inside-work-tree'",
      { cwd: dir, encoding: 'utf8', timeout: 5000 }).trim() === 'true';
  } catch { return false; }
}

// launchd-started daemons have a minimal PATH; login zsh matches gitRoot/ensureWorktree.
function zshExec(cmd, cwd) {
  return execSync(`zsh -l -c '${cmd}'`, { cwd, encoding: 'utf8', timeout: 15000 }).trim();
}

// Remove a per-run scheduled worktree and delete its branch — conservatively (#565):
// - `git worktree remove` WITHOUT --force: git refuses when the worktree has
//   modified/untracked files, so uncommitted work is never deleted (worktree AND
//   branch kept, for inspection).
// - `git branch -d` (never -D): git refuses when the branch has unmerged commits,
//   so committed-but-unmerged work keeps its branch.
// Claude's native --worktree <name> names the branch worktree-<name>.
// Never throws. Returns { removed, branchDeleted }; `exec` is injectable for tests.
function cleanupWorktree(repoRoot, name, exec = zshExec) {
  const res = { removed: false, branchDeleted: false };
  if (!repoRoot || !name) return res;
  const wtPath = path.join(repoRoot, '.claude', 'worktrees', name);
  if (fs.existsSync(wtPath)) {
    // Claude locks its worktree while running ("claude session <name> (pid ...)")
    // and an abnormal exit leaves the lock behind. Both cleanup call sites only
    // fire once that claude process is dead (onExit = the PTY exited; the sweep
    // requires the shell gone + a closed tombstone), so the lock is always stale
    // here — release it or `git worktree remove` refuses even a clean worktree.
    try { exec(`git worktree unlock "${wtPath}"`, repoRoot); } catch {} // not locked is fine
    try {
      exec(`git worktree remove "${wtPath}"`, repoRoot);
      res.removed = true;
    } catch (e) {
      log_(`worktree ${name} kept (uncommitted changes or locked): ${String(e.message || e).split('\n')[0]}`);
      return res; // keep the branch too while the worktree stays inspectable
    }
  } else {
    // Dir already gone (run died before claude created it, or removed by hand).
    // Prune stale metadata so a registered-but-missing worktree can't pin the branch.
    try { exec('git worktree prune', repoRoot); } catch {}
    res.removed = true;
  }
  const branch = `worktree-${name}`;
  try { exec(`git rev-parse --verify --quiet "refs/heads/${branch}"`, repoRoot); }
  catch { res.branchDeleted = true; return res; } // branch never created — nothing to delete
  try { exec(`git branch -d "${branch}"`, repoRoot); res.branchDeleted = true; }
  catch { log_(`worktree ${name} removed; branch ${branch} kept (unmerged commits)`); }
  return res;
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

// Isolation contract (#565): tell the agent its work area is disposable and
// that keeping work requires merging/pushing BEFORE it self-reports finished.
function worktreeContract(iso) {
  return [
    `You are working in a DISPOSABLE git worktree created just for this run:`,
    `- working directory (worktree): ${iso.path}`,
    `- branch: ${iso.branch} (branched from the repo's current HEAD)`,
    `- main checkout: ${iso.repoRoot} — never edit files there directly.`,
    ``,
    `When this run ends the worktree is removed and the branch deleted, unless there is`,
    `uncommitted work (worktree kept) or unmerged commits (branch kept).`,
    `If this run produces anything worth keeping, commit it and merge it back into the`,
    `repo's main branch (or push the branch / open a PR) BEFORE you finish.`,
  ].join('\n');
}

// Wrap a task's prompt with the scheduled-run contract: tell the agent this is an
// automated scheduled run and have it self-report via the MCP tools so the run
// record reflects real work rather than the session lifecycle (#525). When the
// run is isolated in a per-run worktree (#565), `iso` adds the merge-back contract.
function scheduledRunPrompt(task, iso) {
  return [
    `⏰ This is an automated scheduled task run: "${task.title}" (task ${task.id}).`,
    ``,
    ...(iso ? [worktreeContract(iso), ``] : []),
    `Before you start, call the \`scheduled_task_started\` tool to mark this run as started.`,
    `When you're done, call \`scheduled_task_finished\` with a one-line \`summary\` of what you did`,
    `(pass \`success: false\` if the task could not be completed). These record that the work actually ran.`,
    ...(iso ? [`Merge/push anything worth keeping BEFORE calling \`scheduled_task_finished\` — the tab may auto-close and the worktree is reclaimed right after.`] : []),
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
// `foreground` opts out of the background open (#600) — only the panel's own
// "Run now" button sets it, since the user just asked to see the run.
function runTask(task, reason, { foreground = false } = {}) {
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
  const claudeSessionId = agentType === 'codex' ? null : randomUUID();
  const codexHomeId = agentType === 'codex' ? id : null;
  // Per-run worktree isolation (#565): claude-native only. The name embeds the
  // run's shellId, so it's unique per run (a kept/leaked worktree from a previous
  // run can never collide with or block the next fire) and links run <-> worktree
  // for cleanup. Claude creates .claude/worktrees/<name> + branch worktree-<name>
  // itself; the PTY still spawns in the repo root (entry.cwd stays the repo root,
  // sessionPaths/sessionEnv resolve the subdir). `cwd === task.project` excludes
  // the homedir fallback above.
  let worktree = null;
  if (task.isolateWorktree !== false && agentConfig.supportsWorktree
      && task.project && cwd === task.project && isGitRepo(cwd)) {
    worktree = ctx.validateWorktree(`scheduled-${id}`);
  }
  const spawnArgs = getSpawnArgs(agentType, { sessionId: claudeSessionId, shellId: id, planMode: !!task.planMode, worktree });
  const sessionEngine = getDefaultEngine();
  const engineType = sessionEngine.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
  const name = `⏰ ${task.title}`;

  log(`[scheduled] running "${task.title}" (${task.id}) id=${id} agent=${agentType} engine=${engineType} cwd=${cwd} worktree=${worktree || 'none'} reason=${reason}`);
  spawnSession(sessionEngine, id, agentType, spawnArgs, cwd, {
    cols: 120, rows: 40, env: sessionEnv(id, { name, windowId: null, cwd, agentType, worktree, codexHomeId }),
  });
  shells.set(id, {
    clients: new Set(), cwd, claudeSessionId, agentType,
    codexHomeId,
    engine: sessionEngine, engineType, worktree, windowId: null,
    name, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(), prefill: true,
  });
  wireShellOutput(id);
  emitSessionOpen(id);
  // Deliver the task prompt. For MCP-capable agents (Claude Code and Codex), wrap it with
  // the scheduled-run contract so the agent self-reports start/finish (#525);
  // agents without deepsteve MCP get the raw prompt as before — except that an
  // isolated run must always be told its work area is disposable (#565).
  if (task.prompt) {
    const mcpWired = ctx.mcpConfigArgs(agentType, id).length > 0;
    const iso = worktree ? {
      path: path.join(cwd, '.claude', 'worktrees', worktree),
      branch: `worktree-${worktree}`, repoRoot: cwd,
    } : null;
    deliverPromptWhenReady(id, mcpWired
      ? scheduledRunPrompt(task, iso)
      : (iso ? `${worktreeContract(iso)}\n\n${task.prompt}` : task.prompt),
    { retryCodexEnter: agentType === 'codex' })
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
      // PTY is dead and the tab is gone (auto-close after scheduled_task_finished,
      // manual close of a kept-open tab, or a crash-'ended' run): reclaim the
      // per-run worktree. Conservative — see cleanupWorktree. The isShuttingDown
      // guard above is what preserves it across a daemon restart for resume.
      if (worktree) {
        const res = cleanupWorktree(cwd, worktree);
        if (run) { run.worktreeRemoved = !!res.removed; saveTasks(); broadcastTasks(); }
      }
    }
  });
  saveState();

  const now = Date.now();
  task.lastRun = now;
  task.runs = task.runs || [];
  task.runs.unshift({ startedAt: now, sessionId: id, status: 'queued', endedAt: null, agentStartedAt: null, success: null, summary: null, worktree });
  if (task.runs.length > MAX_RUNS) task.runs.length = MAX_RUNS;
  saveTasks();
  broadcastTasks();
  // No windowId and no openBrowser: unattended. The tab queues (pendingOpens)
  // and appears when a browser next connects. `background` additionally tells the
  // client to leave the new tab *unfocused* (#600) — a scheduled fire must not
  // yank the user off whatever they were doing. Read live off ctx.settings (which
  // is mutated in place), so the setting takes effect with no restart.
  const background = !foreground && ctx.settings.scheduledTasksOpenInBackground !== false;
  deliverToWindow({ type: 'open-session', id, cwd, name, windowId: null, prefill: true, background }, null);
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

// Worktrees the sweep already tried and couldn't remove (dirty/unmerged) this
// process lifetime — don't retry every tick (log spam); a daemon restart retries.
const sweepAttempted = new Set();

// Reclaim scheduled-* worktrees whose onExit cleanup never fired (#565): the
// restore path installs its own onExit after a daemon restart, so a run that
// finishes post-restore leaks its worktree. Conservative: only terminal-status
// runs whose tab is gone AND whose state.json record is closed (a kept-open tab
// the user may still resurrect for inspection stays untouched).
function sweepLeakedWorktrees() {
  if (!ctx) return;
  let changed = false;
  for (const task of tasks) {
    if (!task.project) continue;
    for (const run of task.runs || []) {
      if (!run.worktree || run.worktreeRemoved) continue;
      if (ACTIVE_STATUSES.has(run.status)) continue;      // may resume + self-report later
      if (ctx.shells.has(run.sessionId)) continue;        // tab still open (keepOpen)
      const saved = ctx.getSavedSession ? ctx.getSavedSession(run.sessionId) : null;
      if (saved && !saved.closed) continue;               // restorable — don't pull the worktree out from under it
      const key = `${task.id}:${run.sessionId}`;
      if (sweepAttempted.has(key)) continue;
      if (!fs.existsSync(path.join(task.project, '.claude', 'worktrees', run.worktree))) {
        run.worktreeRemoved = true; changed = true; continue; // nothing on disk — stop re-checking
      }
      sweepAttempted.add(key);
      if (cleanupWorktree(task.project, run.worktree).removed) { run.worktreeRemoved = true; changed = true; }
    }
  }
  if (changed) { saveTasks(); broadcastTasks(); }
}

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // .unref() so the scheduler timers never keep the process alive on their own
  // (the daemon stays up via its HTTP server); this also lets init() run in a
  // unit test without the interval hanging the test process.
  setTimeout(() => {
    try { runCatchUp(); } catch (e) { log_(`catch-up error: ${e.message}`); }
    try { sweepLeakedWorktrees(); } catch (e) { log_(`worktree sweep error: ${e.message}`); }
  }, CATCHUP_DELAY_MS).unref();
  setInterval(() => {
    try { tick(); } catch (e) { log_(`tick error: ${e.message}`); }
    try { sweepLeakedWorktrees(); } catch (e) { log_(`worktree sweep error: ${e.message}`); }
  }, TICK_MS).unref();
  log_(`scheduler started (${tasks.length} task(s))`);
}

// --- CRUD used by both MCP tools and REST ---------------------------------

function createTask({ title, prompt, cron: cronStr, once, project, agentType, planMode, enabled, createdBy, keepOpen, keepOpenOnFailure, isolateWorktree }) {
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
    // Per-run worktree isolation (#565), default ON — legacy tasks (field absent)
    // also isolate. Only takes effect for claude on a git-repo project; see runTask.
    isolateWorktree: isolateWorktree !== false,
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
  if (fields.isolateWorktree !== undefined) task.isolateWorktree = !!fields.isolateWorktree;
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
    isolateWorktree: task.isolateWorktree !== false,
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

// --- Feature gate ---------------------------------------------------------
// The client mod toggle only shows/hides the panel (per-browser localStorage),
// so it can't be the server's gate. The server-authoritative on/off is the
// `scheduledTasksEnabled` setting — the same one the tick already honors. These
// helpers extend that one gate to every write/action surface (MCP tools + REST)
// so that when the feature is off an agent gets a clear "it's turned off" error
// instead of a cheerful ack for a task the scheduler will never fire.
function featureEnabled() { return !!(ctx && ctx.settings && ctx.settings.scheduledTasksEnabled); }
const FEATURE_OFF_MSG =
  'Scheduled tasks are turned off. Ask the user to enable "Run scheduled tasks" ' +
  'in Settings (the scheduledTasksEnabled setting) before scheduling or running tasks.';
function featureOffResult() {
  return { content: [{ type: 'text', text: FEATURE_OFF_MSG }], isError: true };
}

// --- MCP tools ------------------------------------------------------------

function init(context) {
  ctx = context;
  startScheduler();

  const callerShellId = (extra) => extra?.requestInfo?.url?.searchParams?.get('shellId') || null;

  const tools = {
    schedule_task: {
      description: 'Schedule a local agent task that runs on this machine (with full access to the project\'s MCP servers). Tasks are organized by project. Recurring by default; pass once:true for a run-once task that fires at the next cron match and then retires itself (no need to unschedule it afterward). Use for reports/maintenance/digests that need local MCP — e.g. a weekly analytics report.',
      schema: {
        title: z.string().describe('Short title for the task'),
        prompt: z.string().describe('The prompt/instructions the agent runs each time'),
        cron: z.string().describe('5-field cron in local time: "min hour day-of-month month day-of-week". E.g. "0 9 * * 1" = every Monday 9am. For a one-shot (once:true), this is just the next matching time to fire at.'),
        once: z.boolean().optional().describe('Run exactly once at the next cron match, then retire (kept as a done row). Default false (recurring).'),
        project: z.string().optional().describe('Repo path to run in (canonicalized to its git root). Defaults to the calling session\'s project.'),
        agent_type: z.string().optional().describe('Agent to run: "claude" (default), "codex", or an experimental agent such as "opencode", "pi", or "hermes".'),
        plan_mode: z.boolean().optional().describe('Start the agent in plan mode (default false).'),
        keep_open: z.boolean().optional().describe('Keep the tab open after each run finishes instead of auto-closing (default false).'),
        keep_open_on_failure: z.boolean().optional().describe('Keep the tab open when a run fails, even if auto-close is on (default false).'),
        isolate_worktree: z.boolean().optional().describe('Run each fire in a disposable git worktree/branch (scheduled-<runId>) so it never touches the main checkout; cleaned up after the run when clean/merged. Only applies to claude on a git-repo project. Default true.'),
        enabled: z.boolean().optional().describe('Whether the schedule is active (default true).'),
      },
      handler: async ({ title, prompt, cron: cronStr, once, project, agent_type, plan_mode, keep_open, keep_open_on_failure, isolate_worktree, enabled }, extra) => {
        let task;
        try {
          task = createTask({
            title, prompt, cron: cronStr, once,
            project: resolveProject(project, callerShellId(extra)),
            agentType: agent_type, planMode: plan_mode, enabled,
            keepOpen: keep_open, keepOpenOnFailure: keep_open_on_failure,
            isolateWorktree: isolate_worktree,
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
        agent_type: z.string().optional().describe('Agent to run: "claude", "codex", or an experimental agent such as "opencode", "pi", or "hermes".'),
        plan_mode: z.boolean().optional(),
        keep_open: z.boolean().optional().describe('Keep the tab open after each run finishes instead of auto-closing.'),
        keep_open_on_failure: z.boolean().optional().describe('Keep the tab open when a run fails, even if auto-close is on.'),
        isolate_worktree: z.boolean().optional().describe('Run each fire in a disposable git worktree/branch that is cleaned up after the run when clean/merged (claude + git-repo projects only).'),
        enabled: z.boolean().optional(),
      },
      handler: async ({ id, title, prompt, cron: cronStr, once, project, agent_type, plan_mode, keep_open, keep_open_on_failure, isolate_worktree, enabled }, extra) => {
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
        if (isolate_worktree !== undefined) fields.isolateWorktree = isolate_worktree;
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

  // Fail-closed when the feature is off: the write/action tools refuse with a
  // clear reason (isError) so an agent scheduling into a disabled feature learns
  // why instead of getting a cheerful ack for a task that will never fire.
  // Deliberately NOT gated: list_scheduled_tasks (read-only), unschedule_task
  // (cleanup should always work), and scheduled_task_started/finished (a run
  // already in flight when the feature is toggled off must still self-report and
  // clean up). The gate reads the setting live on every call.
  for (const name of ['schedule_task', 'update_scheduled_task', 'run_scheduled_task_now']) {
    const inner = tools[name].handler;
    tools[name].handler = (args, extra) => (featureEnabled() ? inner(args, extra) : featureOffResult());
  }
  return tools;
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
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
    const b = req.body || {};
    let projectRoot = b.project || '';
    if (projectRoot) projectRoot = resolveProject(projectRoot, null);
    try {
      const task = createTask({
        title: b.title, prompt: b.prompt, cron: b.cron, once: b.once, project: projectRoot,
        agentType: b.agentType, planMode: b.planMode, enabled: b.enabled,
        keepOpen: b.keepOpen, keepOpenOnFailure: b.keepOpenOnFailure,
        isolateWorktree: b.isolateWorktree,
      });
      res.json({ task });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/scheduled-tasks/:id', (req, res) => {
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
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
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    // The panel's Run-now button: the user explicitly asked for this run, so open
    // its tab in the foreground even when scheduled fires are silent (#600).
    const shellId = runTask(task, 'manual', { foreground: true });
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

// The mod loader only uses init/registerRoutes; the extra named exports are for
// unit tests (test/unit/scheduled-worktree.test.js).
module.exports = { init, registerRoutes, cleanupWorktree, isGitRepo, scheduledRunPrompt, worktreeContract };

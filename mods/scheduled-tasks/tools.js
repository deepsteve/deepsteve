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
const { stateDir, expandTilde, spawnCwdProblem } = require('../../paths');
const { runBinary } = require('../../bin-path');
const { randomUUID } = require('crypto');
const { z } = require('zod');
const cron = require('./cron');
// Resolves to ~/.deepsteve/git-root.js once deployed — mods sit at ~/.deepsteve/mods/<id>/.
const { findGitRoot } = require('../../git-root');
const { usableWorktree } = require('../../worktree-support');

const TASKS_FILE = path.join(stateDir(), 'scheduled-tasks.json');
const MAX_RUNS = 20;          // per-task run history is bounded
const TICK_MS = 30 * 1000;    // cron granularity is 1 min; 30s never misses a minute
const CATCHUP_DELAY_MS = 10 * 1000; // let the daemon settle before the overdue pass

// Run status lifecycle (interactive Claude sessions don't exit when they finish,
// so completion is driven by the agent self-reporting via MCP — issue #525):
//   queued    — session spawned, prompt delivered, agent hasn't engaged yet
//   running   — agent called scheduled_task_started
//   succeeded / failed — agent called scheduled_task_finished
//   ended     — session closed with no self-report (fallback; crash or manual close)
//   timed-out — exceeded the task's maxRuntimeMinutes and was closed by the tick (#596)
// ACTIVE = not yet self-reported terminal; used by the overlap guard + onExit fallback.
// Legacy 'started'/'completed' rows (pre-#525) still render in the UI badge.
const ACTIVE_STATUSES = new Set(['queued', 'running', 'started']);

// #612: the exact tools scheduledRunPrompt() *requires* the agent to call. deepsteve
// imposes that contract, so deepsteve pre-permits it: an unattended run has nobody to
// answer "Do you want to proceed?", and blocking on it wedges the run in `running`
// forever, which makes the overlap guard skip every subsequent fire of the task.
// Narrow by design — the self-report tools only, not a blanket permission widening.
// `deepsteve` is the MCP server key hardcoded in server.js's mcpConfigArgs().
const CONTRACT_TOOLS = ['mcp__deepsteve__scheduled_task_started', 'mcp__deepsteve__scheduled_task_finished'];

// How long a tombstoned task (#614, see deleteTask) is kept once its last run has
// stopped looking active. Normally the purge fires as soon as no run is ACTIVE; this
// is only the backstop for a run whose shell died so hard that nothing ever moved its
// status off ACTIVE (enforceRunTimeouts skips a run whose shell is already gone).
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Default ceiling on a single run's wall-clock (#596). A run that parks on a
// permission prompt is never reaped — armDetachReap only arms when a client
// disconnects, and an unattended run never had one — so without this the overlap
// guard skips every future fire of that task forever, signalled by nothing but one
// log line per tick. 0 on a task means "no limit".
const DEFAULT_MAX_RUNTIME_MINUTES = 60;

// Effort levels accepted by `claude --effort` (#592). Mirrors server.js's
// EFFORT_LEVELS, which stays the authority — this copy only shapes the MCP enum;
// every value still goes through ctx.validateEffort before it reaches argv.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

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

// --- Live tasks vs tombstones (#614) --------------------------------------
//
// `tasks` holds two kinds of row: real schedules, and tombstones — tasks that have
// been deleted while one of their runs was still in flight (see deleteTask). A
// tombstone is NOT a schedule: it never fires, and it is invisible to the panel and
// to list_scheduled_tasks. It exists only so the live agent it spawned can still find
// its run record and self-report.
//
// So: everything that schedules, lists or mutates a schedule goes through
// liveTasks()/findLiveTask(); everything that reasons about a *run* (findRunByShell,
// enforceRunTimeouts, sweepLeakedWorktrees, unattendedRunInFlight, the onExit
// epilogue) deliberately iterates the full `tasks` — that is the whole point.
function liveTasks() { return tasks.filter(t => !t.deleted); }
function findLiveTask(id) { return liveTasks().find(t => t.id === id); }
function activeRunOf(task) { return (task.runs || []).find(r => ACTIVE_STATUSES.has(r.status)); }

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

// True when dir is inside a git work tree — the gate for per-run worktree isolation.
// gitRoot() can't answer this: its `|| dir` fallback makes "not a repo" and "dir IS
// the root" the same answer. findGitRoot() can, by returning null.
//
// Pure-fs for the same reason gitRoot() is (#553), plus one this function taught us:
// as `zsh -l -c 'git rev-parse --is-inside-work-tree'` it made worktree isolation
// silently conditional on zsh being installed. Where it isn't, every fire fell back
// to the shared checkout with nothing logged, and the #614 tombstone test — which
// drives the whole runTask path — went red on the bare CI runner while the docker
// suites (which apt-get zsh) stayed green.
function isGitRepo(dir) {
  return findGitRoot(dir) !== null;
}

// Run git, argv-style, with no shell layer at all (#621).
//
// This was `zsh -l -c '<cmd string>'`, for the same launchd-minimal-PATH reason
// gitRoot/ensureWorktree had one — but a login shell to find git is a PATH lookup in
// costume, and it made scheduled worktree cleanup silently conditional on zsh, the
// exact failure #619 removed from the tmux engine. runBinary does the $PATH +
// fallback-dirs scan and execs the absolute path directly.
//
// Taking argv rather than a string also fixes a real quoting bug: every caller below
// interpolated a filesystem path into single quotes, so a repo path containing an
// apostrophe broke the command outright.
function gitExec(argv, cwd) {
  return String(runBinary('git', argv, { cwd, encoding: 'utf8', timeout: 15000 })).trim();
}

// Remove a per-run scheduled worktree and delete its branch — conservatively (#565):
// - `git worktree remove` WITHOUT --force: git refuses when the worktree has
//   modified/untracked files, so uncommitted work is never deleted (worktree AND
//   branch kept, for inspection).
// - `git branch -d` (never -D): git refuses when the branch has unmerged commits,
//   so committed-but-unmerged work keeps its branch.
// Claude's native --worktree <name> names the branch worktree-<name>.
// Never throws. Returns { removed, branchDeleted }; `exec` is injectable for tests and
// takes (argv, cwd) — an array, not a command string, since #621.
function cleanupWorktree(repoRoot, name, exec = gitExec) {
  const res = { removed: false, branchDeleted: false };
  if (!repoRoot || !name) return res;
  const wtPath = path.join(repoRoot, '.claude', 'worktrees', name);
  if (fs.existsSync(wtPath)) {
    // Claude locks its worktree while running ("claude session <name> (pid ...)")
    // and an abnormal exit leaves the lock behind. Both cleanup call sites only
    // fire once that claude process is dead (onExit = the PTY exited; the sweep
    // requires the shell gone + a closed tombstone), so the lock is always stale
    // here — release it or `git worktree remove` refuses even a clean worktree.
    try { exec(['worktree', 'unlock', wtPath], repoRoot); } catch {} // not locked is fine
    try {
      exec(['worktree', 'remove', wtPath], repoRoot);
      res.removed = true;
    } catch (e) {
      log_(`worktree ${name} kept (uncommitted changes or locked): ${String(e.message || e).split('\n')[0]}`);
      return res; // keep the branch too while the worktree stays inspectable
    }
  } else {
    // Dir already gone (run died before claude created it, or removed by hand).
    // Prune stale metadata so a registered-but-missing worktree can't pin the branch.
    try { exec(['worktree', 'prune'], repoRoot); } catch {}
    res.removed = true;
  }
  const branch = `worktree-${name}`;
  try { exec(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot); }
  catch { res.branchDeleted = true; return res; } // branch never created — nothing to delete
  try { exec(['branch', '-d', branch], repoRoot); res.branchDeleted = true; }
  catch { log_(`worktree ${name} removed; branch ${branch} kept (unmerged commits)`); }
  return res;
}

// The project a scheduled run should use. An explicit path wins (canonicalized);
// otherwise inherit the calling session's repo root.
function resolveProject(rawProject, shellId) {
  if (rawProject && String(rawProject).trim()) {
    const p = expandTilde(String(rawProject).trim());
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

// Display names for a set of repo roots: the basename, widened to `parent/base`
// only where two roots would otherwise collide — mirrors /api/git-roots.
// Pure and scoped to the roots handed in, so a caller that renders a *different*
// root set (the run-history grid includes tombstoned tasks' roots, which
// knownProjects() never sees) gets names disambiguated against what it shows.
function disambiguate(roots) {
  const list = [...new Set([...roots].filter(Boolean))].sort();
  const baseCounts = {};
  for (const r of list) { const b = path.basename(r); baseCounts[b] = (baseCounts[b] || 0) + 1; }
  const names = new Map();
  for (const root of list) {
    const base = path.basename(root);
    names.set(root, baseCounts[base] > 1 ? path.join(path.basename(path.dirname(root)), base) : base);
  }
  return names;
}

// Every project we know about (from tasks, groups, and live sessions).
function knownProjects() {
  const roots = new Set();
  for (const t of liveTasks()) if (t.project) roots.add(t.project);
  for (const c of getContexts()) for (const d of (c.dirs || [])) if (d) roots.add(d);
  if (ctx) {
    for (const entry of ctx.shells.values()) {
      try { const { repoRoot } = ctx.sessionPaths(entry); if (repoRoot) roots.add(repoRoot); } catch {}
    }
  }
  return [...disambiguate(roots)].map(([root, name]) => ({ root, name }));
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
  // Full `tasks`, tombstones included (#614): a run whose schedule was deleted
  // mid-flight is exactly the case this has to keep answering.
  for (const task of tasks) {
    const run = (task.runs || []).find(r => r.sessionId === shellId);
    if (run) return { task, run };
  }
  return null;
}

// The previous run still occupying this task, or null. A run that has self-reported
// terminal (succeeded/failed) no longer blocks the next fire, even though its idle
// tab may still be alive. Shared by runTask's overlap guard and the Run-now route,
// which reports the reason back to the panel (#611).
function activeRunFor(task) {
  const last = task && task.runs && task.runs[0];
  if (!last || !ACTIVE_STATUSES.has(last.status)) return null;
  return (ctx && ctx.shells.has(last.sessionId)) ? last : null;
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

  // Overlap guard: don't stack a run on a still-running previous run.
  const blocking = activeRunFor(task);
  if (blocking) {
    log(`[scheduled] "${task.title}" (${task.id}) skipped — previous run ${blocking.sessionId} still active`);
    return null;
  }

  const { agentType } = splitAgentSelection(task.agentType, task.configProfile);
  const agentConfig = getAgentConfig(agentType);
  // Custom Claude config profile (#537/#592). Resolved here, at spawn time, so a
  // profile whose directory changed in Settings takes effect on the next run; the
  // resolved dir (not the id) is what gets persisted on the shell entry, matching
  // every other spawn path. A deleted profile resolves to null = default config.
  const configDir = agentType === 'claude' && ctx.resolveConfigDir
    ? (ctx.resolveConfigDir(task.configProfile) || null) : null;
  // #604: a task that pins nothing falls back to the system-level default rather
  // than to Claude Code's own (which can silently drop to a cheaper model on usage
  // limits). Read live off ctx.settings — like the scheduledTasksEnabled gate — so
  // a Settings change applies to already-created tasks on their next fire, with no
  // restart. cleanModel/cleanEffort never return '', so `||` is the whole chain.
  const model = cleanModel(task.model) || defaultModel();
  const effort = cleanEffort(task.effort) || defaultEffort();
  // #632: a task whose project directory is gone is REFUSED, not quietly rehomed.
  // The old `: os.homedir()` fallback was the worst instance of that bug in the tree:
  // unattended, so nobody was watching; and the `cwd === task.project` guard below
  // then also disabled #565 worktree isolation — so the run happened in $HOME, with
  // no isolation, while the panel still showed the project's name.
  //
  // Deliberately not a throw. runTask is called from tick(), whose single try/catch
  // would abandon every other task due in that tick AND skip the `if (changed)`
  // save — so the task would re-fire and re-throw every tick, forever.
  const cwdProblem = task.project ? spawnCwdProblem(task.project) : null;
  if (cwdProblem) {
    log_(`"${task.title}" (${task.id}) NOT run — ${cwdProblem.message}`);
    task.runs = task.runs || [];
    // A terminal row ('ended' is outside ACTIVE_STATUSES), so the timeout sweep skips
    // it and the panel can answer "why didn't my task run". sessionId stays null:
    // nothing spawned, and every consumer keys off shells.has()/ACTIVE_STATUSES.
    const at = Date.now();
    task.lastRun = at;
    task.runs.unshift({
      startedAt: at, sessionId: null, status: 'ended', endedAt: at, agentStartedAt: null,
      success: false, summary: cwdProblem.message, worktree: null,
      model: null, effort: null, configDir: null,
    });
    trimRuns(task);
    // Retire a one-shot in place rather than retrying a directory that is gone —
    // tick()'s `task.once && task.firedAt` guard does the rest. Recurring tasks keep
    // their normal schedule, in case the directory comes back.
    if (task.once) task.firedAt = at;
    // Persist here: we return null, and runCatchUp() only sets `changed` when a run
    // actually started, so otherwise neither the row nor firedAt would survive.
    saveTasks();
    broadcastTasks();
    return null;  // the existing "did not start" contract — both callers handle it
  }
  const cwd = task.project || os.homedir();
  const id = randomUUID().slice(0, 8);
  const claudeSessionId = agentType === 'codex' ? null : randomUUID();
  const codexHomeId = agentType === 'codex' ? id : null;
  // Per-run worktree isolation (#565): claude-native only. The name embeds the
  // run's shellId, so it's unique per run (a kept/leaked worktree from a previous
  // run can never collide with or block the next fire) and links run <-> worktree
  // for cleanup. Claude creates .claude/worktrees/<name> + branch worktree-<name>
  // itself; the PTY still spawns in the repo root (entry.cwd stays the repo root,
  // sessionPaths/sessionEnv resolve the subdir). `cwd === task.project` used to be
  // what excluded the old missing-project homedir fallback; since #632 refuses that
  // case outright it is simply "the task named a project", kept as-is.
  let worktree = null;
  if (task.isolateWorktree !== false && agentConfig.supportsWorktree
      && task.project && cwd === task.project && isGitRepo(cwd)) {
    // isGitRepo is the cheap pre-filter (a pure-fs walk); usableWorktree then spends
    // a `git rev-parse` on the case it cannot see — a repo whose HEAD has no commit
    // yet, where --worktree makes Claude exit on arrival (#656). An unattended run
    // that dies a second after spawn leaves nobody to notice, so this path wants the
    // check even more than the interactive ones do.
    worktree = usableWorktree(cwd, ctx.validateWorktree(`scheduled-${id}`), { log });
  }
  // Does this agent get deepsteve MCP at all? Decides both the self-report contract in
  // the prompt below and — since we're the ones imposing it — whether to pre-permit the
  // contract tools on the spawn (#612). Claude-only in practice: the flag lives in
  // AGENT_CONFIGS.claude, so allowedToolsArgs is a no-op for codex.
  const mcpWired = ctx.mcpConfigArgs(agentType, id).length > 0;
  const allowedTools = mcpWired ? CONTRACT_TOOLS : null;
  const spawnArgs = getSpawnArgs(agentType, { sessionId: claudeSessionId, shellId: id, planMode: !!task.planMode, worktree, model, effort, allowedTools });
  const sessionEngine = getDefaultEngine();
  const engineType = sessionEngine.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
  const name = `⏰ ${task.title}`;

  log(`[scheduled] running "${task.title}" (${task.id}) id=${id} agent=${agentType} model=${model || 'default'} effort=${effort || 'default'} profile=${task.configProfile || 'none'} engine=${engineType} cwd=${cwd} worktree=${worktree || 'none'} allowedTools=${allowedTools ? 'contract' : 'none'} reason=${reason}`);
  spawnSession(sessionEngine, id, agentType, spawnArgs, cwd, {
    cols: 120, rows: 40, env: sessionEnv(id, { name, windowId: null, cwd, agentType, worktree, codexHomeId, configDir }),
  });
  shells.set(id, {
    clients: new Set(), cwd, claudeSessionId, agentType,
    codexHomeId, configDir, model, effort,
    // Persisted by serializeShellEntry so a restart-resumed run keeps the grant —
    // Claude's --resume doesn't carry session flags forward (#612).
    allowedTools,
    engine: sessionEngine, engineType, worktree, windowId: null,
    // Unattended by construction (#597): no browser ever owned this tab, so a
    // windowId-less scheduled run must not be offered up as a lost session by
    // the restore modal. See buildWindowsView() in server.js.
    scheduled: true,
    name, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(), prefill: true,
  });
  wireShellOutput(id);
  emitSessionOpen(id);
  // Deliver the task prompt. For MCP-capable agents (Claude Code and Codex), wrap it with
  // the scheduled-run contract so the agent self-reports start/finish (#525);
  // agents without deepsteve MCP get the raw prompt as before — except that an
  // isolated run must always be told its work area is disposable (#565).
  if (task.prompt) {
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
      // Full `tasks`: the schedule may have been deleted mid-run (#614), and this
      // row is still the record of what happened.
      const t = tasks.find(x => x.id === task.id);
      const run = t && t.runs.find(r => r.sessionId === id);
      if (run && ACTIVE_STATUSES.has(run.status)) {
        run.status = 'ended'; run.endedAt = Date.now(); saveTasks(); broadcastTasks();
      }
      // Named, because an unattended run's death is the one this log line has to be
      // able to explain on its own: nobody was watching, and the run row above is the
      // only other trace (#625).
      ctx.handleShellGone(id, 'scheduled-run-ended');
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
  // Record the *effective* model/effort/config dir on the run row (#592). Nothing
  // else stores them: reconstructing what a past run actually used previously meant
  // digging through Claude transcripts, and effort isn't in there at all.
  task.runs.unshift({ startedAt: now, sessionId: id, status: 'queued', endedAt: null, agentStartedAt: null, success: null, summary: null, worktree, model, effort, configDir });
  trimRuns(task);
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

// Bound a task's run history to MAX_RUNS — but never evict a row whose session is
// still alive (#614). A keepOpen tab can outlive MAX_RUNS later fires, and dropping
// its row orphans that live agent exactly the way a mid-run delete used to: its
// self-report tools would find no record of the run it is sitting in.
function trimRuns(task) {
  if (!task.runs || task.runs.length <= MAX_RUNS) return;
  task.runs = task.runs.slice(0, MAX_RUNS)
    .concat(task.runs.slice(MAX_RUNS).filter(r => ctx && ctx.shells.has(r.sessionId)));
}

// Close any run that has outlived its task's maxRuntimeMinutes (#596).
//
// Nothing else can rescue a wedged unattended run: it has no client, so the detach
// reaper never arms, and while its session stays alive in an ACTIVE status the
// overlap guard skips every subsequent fire of that task — permanently. Marking it
// 'timed-out' (deliberately NOT an ACTIVE status) fixes all of that at once: the
// onExit fallback won't overwrite the status, sweepLeakedWorktrees reclaims the
// worktree, and the next fire is no longer blocked.
//
// Only runs with no attached client are eligible — if a human has the tab open,
// they own it, whatever the clock says. Returns true if anything changed.
function enforceRunTimeouts(now) {
  if (!ctx) return false;
  let changed = false;
  for (const task of tasks) { // tombstones included (#614) — their runs still need reaping
    const limitMs = sanitizeMaxRuntime(task.maxRuntimeMinutes) * 60 * 1000;
    if (limitMs <= 0) continue; // 0 = no limit
    for (const run of task.runs || []) {
      if (!ACTIVE_STATUSES.has(run.status)) continue;
      const shell = ctx.shells.get(run.sessionId);
      if (!shell || shell.clients.size > 0) continue;
      const elapsed = now - (run.agentStartedAt || run.startedAt || now);
      if (elapsed <= limitMs) continue;
      const mins = Math.round(elapsed / 60000);
      log_(`[scheduled] run ${run.sessionId} of "${task.title}" exceeded ${task.maxRuntimeMinutes}m (${mins}m elapsed) — closing`);
      run.status = 'timed-out';
      run.success = false;
      run.endedAt = now;
      run.summary = run.summary || `Timed out after ${mins}m with no completion report.`;
      changed = true;
      // Status is already terminal before teardown, so the onExit fallback leaves it alone.
      try { ctx.closeSession(run.sessionId, 'scheduled-timeout'); }
      catch (e) { log_(`timeout close failed for ${run.sessionId}: ${e.message}`); }
    }
  }
  if (changed) { saveTasks(); broadcastTasks(); }
  return changed;
}

// Drop tombstoned tasks (#614) once nothing still needs their record. Ordered after
// enforceRunTimeouts in the tick so a run reaped this tick releases its tombstone in
// the same pass. Returns true if anything was removed.
function purgeTombstonedTasks(now) {
  let changed = false;
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    if (!t.deleted) continue;
    const active = activeRunOf(t);
    // An unreclaimed worktree pins the row too: sweepLeakedWorktrees reads
    // task.project + run.worktree off it, and after a daemon restart the sweep is
    // the ONLY thing that reclaims one (the restore handler replaces the run's own
    // onExit cleanup). Purging first would leak the directory permanently — and the
    // tick purges *before* the sweep runs, so this is not hypothetical.
    const pinned = active || (t.runs || []).find(r => r.worktree && !r.worktreeRemoved);
    const expired = now - (t.deletedAt || 0) > TOMBSTONE_TTL_MS;
    if (pinned && !expired) continue;
    log_(`purging deleted task "${t.title}" (${t.id})${pinned ? ` — run ${pinned.sessionId} still ${active ? `marked ${active.status}` : `holding worktree ${pinned.worktree}`} after ${Math.round(TOMBSTONE_TTL_MS / 86400000)}d` : ''}`);
    tasks.splice(i, 1);
    changed = true;
  }
  // Persist here rather than relying on the caller, exactly like enforceRunTimeouts —
  // otherwise a purged row survives on disk until something else happens to save. No
  // broadcast: a tombstone was never in the panel payload, so nothing on screen changes.
  if (changed) saveTasks();
  return changed;
}

// Fire any enabled task whose next run has arrived.
function tick() {
  if (!ctx || !ctx.settings.scheduledTasksEnabled) return;
  const now = Date.now();
  let changed = false;
  if (enforceRunTimeouts(now)) changed = true;
  if (purgeTombstonedTasks(now)) changed = true;
  for (const task of liveTasks()) {
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
  // liveTasks() only: a tombstone must never be caught up either. Deliberately no
  // purge here — a run resumed after a restart is still ACTIVE and needs its record.
  for (const task of liveTasks()) {
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
  for (const task of tasks) { // tombstones included (#614) — their worktrees still need reclaiming
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
  log_(`scheduler started (${liveTasks().length} task(s))`);
}

// --- CRUD used by both MCP tools and REST ---------------------------------

// Minutes → a non-negative integer, or the default when absent/garbage. 0 = no limit.
function sanitizeMaxRuntime(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_MAX_RUNTIME_MINUTES;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_RUNTIME_MINUTES;
  return n;
}

// #592/#537: a custom config profile is agentType 'claude' + a profile id, not a
// new agent type — but the panel's Agent dropdown (like the main new-tab menu)
// encodes profiles as 'config:<profileId>'. Accept either form, the same way the
// WS new-session path does, and always store the two pieces separately.
function splitAgentSelection(agentType, configProfile) {
  let type = agentType || 'claude';
  let profile = configProfile || null;
  if (typeof type === 'string' && type.startsWith('config:')) {
    profile = profile || type.slice('config:'.length);
    type = 'claude';
  }
  // A profile only means anything for claude; keep the record honest so the form
  // and runTask don't have to re-check.
  if (type !== 'claude') profile = null;
  return { agentType: type, configProfile: profile };
}

// Sanitize model/effort through the server's validators when the mod ctx has
// them (it always does at runtime; unit-test stubs may not). null = inherit.
function cleanModel(v) { return (ctx && ctx.validateModel ? ctx.validateModel(v) : (v || null)) || null; }
function cleanEffort(v) { return (ctx && ctx.validateEffort ? ctx.validateEffort(v) : (v || null)) || null; }

// #604: the system-level fallbacks, resolved live. Same sanitizing as a task value —
// a settings value is no more trusted at the argv boundary than a task one.
function settingsObj() { return (ctx && ctx.settings) || {}; }
function defaultModel() { return cleanModel(settingsObj().scheduledDefaultModel); }
function defaultEffort() { return cleanEffort(settingsObj().scheduledDefaultEffort); }

function createTask({ title, prompt, cron: cronStr, once, project, agentType, configProfile, model, effort, planMode, enabled, createdBy, keepOpen, keepOpenOnFailure, isolateWorktree, maxRuntimeMinutes }) {
  cron.parseCron(cronStr); // throws on invalid — caller catches (a one-shot still uses a cron)
  const now = Date.now();
  const agent = splitAgentSelection(agentType, configProfile);
  const task = {
    id: randomUUID().slice(0, 8),
    title: String(title || 'Untitled task'),
    prompt: String(prompt || ''),
    project: project || '',
    agentType: agent.agentType,
    // Custom Claude config profile (#537) to run under, by profile id. Stored as the
    // id (not the resolved dir) because a task is a template: editing the profile's
    // directory in Settings should move future runs with it. Resolved at spawn time.
    configProfile: agent.configProfile,
    // #592: null = inherit Claude Code's own default (the pre-#592 behavior, which
    // is also what silently fell back off Opus on usage limits). claude-only.
    model: cleanModel(model),
    effort: cleanEffort(effort),
    planMode: !!planMode,
    // Auto-close is the default: the tab closes when the agent self-reports
    // finished, unless keepOpen (always keep) or keepOpenOnFailure (keep on a
    // failed run) is set. Both default off. See scheduled_task_finished (#525).
    keepOpen: !!keepOpen,
    keepOpenOnFailure: !!keepOpenOnFailure,
    // Per-run worktree isolation (#565), default ON — legacy tasks (field absent)
    // also isolate. Only takes effect for claude on a git-repo project; see runTask.
    isolateWorktree: isolateWorktree !== false,
    // Wall-clock ceiling per run (#596); 0 = unlimited. Legacy tasks (field absent)
    // inherit the default rather than staying unbounded.
    maxRuntimeMinutes: sanitizeMaxRuntime(maxRuntimeMinutes),
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
  log_(`created "${task.title}" (${task.id}) cron="${task.cron}"${task.once ? ' once' : ''} project=${task.project || 'none'} by=${task.createdBy || 'panel'}`);
  return task;
}

function updateTask(id, fields) {
  const task = findLiveTask(id); // a tombstone is not a schedule — nothing to edit
  if (!task) return null;
  if (fields.cron !== undefined) { cron.parseCron(fields.cron); task.cron = fields.cron.trim(); }
  if (fields.title !== undefined) task.title = String(fields.title);
  if (fields.prompt !== undefined) task.prompt = String(fields.prompt);
  if (fields.project !== undefined) task.project = fields.project || '';
  // Agent + config profile move together: switching to a non-claude agent must drop
  // the profile, and a 'config:<id>' agentType carries the profile inside it.
  if (fields.agentType !== undefined || fields.configProfile !== undefined) {
    const agent = splitAgentSelection(
      fields.agentType !== undefined ? fields.agentType : task.agentType,
      fields.configProfile !== undefined ? fields.configProfile : task.configProfile);
    task.agentType = agent.agentType;
    task.configProfile = agent.configProfile;
  }
  if (fields.model !== undefined) task.model = cleanModel(fields.model);
  if (fields.effort !== undefined) task.effort = cleanEffort(fields.effort);
  if (fields.planMode !== undefined) task.planMode = !!fields.planMode;
  if (fields.keepOpen !== undefined) task.keepOpen = !!fields.keepOpen;
  if (fields.keepOpenOnFailure !== undefined) task.keepOpenOnFailure = !!fields.keepOpenOnFailure;
  if (fields.isolateWorktree !== undefined) task.isolateWorktree = !!fields.isolateWorktree;
  if (fields.maxRuntimeMinutes !== undefined) task.maxRuntimeMinutes = sanitizeMaxRuntime(fields.maxRuntimeMinutes);
  if (fields.once !== undefined) task.once = !!fields.once;
  if (fields.enabled !== undefined) task.enabled = !!fields.enabled;
  // Recompute next run from any schedule/enable change. A one-shot that has already
  // fired stays retired (nextRunFor returns null via its firedAt guard).
  task.nextRun = task.enabled ? nextRunFor(task, Date.now()) : null;
  saveTasks();
  broadcastTasks();
  return task;
}

// Unschedule a task. Always takes effect immediately — the task never fires again —
// but when one of its runs is still in flight the row is KEPT as a tombstone
// (`deleted: true`) instead of being spliced out.
//
// #614: splicing takes `task.runs` with it, and that array is the only record of the
// run <-> session link. Destroying it orphans a live agent: findRunByShell stops
// resolving, so scheduled_task_started/finished answer "this session is not a
// scheduled task run", the run is never recorded, the unattended tab never
// auto-closes (auto-close lives inside scheduled_task_finished), and both
// enforceRunTimeouts and sweepLeakedWorktrees lose track of it. Same spirit as the
// session tombstones in #561: a delete may not destroy a record something live still
// depends on. purgeTombstonedTasks drops the row once no run is active.
//
// Returns null when no such task exists, else { title, tombstoned, alreadyDeleted,
// activeSession } so callers can say which of those three things happened.
function deleteTask(id) {
  const task = tasks.find(t => t.id === id); // tombstones too, so a re-delete is idempotent
  if (!task) return null;
  if (task.deleted) return { title: task.title, tombstoned: false, alreadyDeleted: true, activeSession: null };
  const active = activeRunOf(task);
  if (active) {
    task.deleted = true;
    task.deletedAt = Date.now();
    task.enabled = false;
    task.nextRun = null;
  } else {
    tasks.splice(tasks.indexOf(task), 1);
  }
  saveTasks();
  broadcastTasks();
  log_(active
    ? `unscheduled "${task.title}" (${task.id}) — run ${active.sessionId} still in flight, keeping the record`
    : `deleted "${task.title}" (${task.id})`);
  return { title: task.title, tombstoned: !!active, alreadyDeleted: false, activeSession: active ? active.sessionId : null };
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
    configProfile: task.configProfile || null,
    model: task.model || null,
    effort: task.effort || null,
    planMode: !!task.planMode,
    keepOpen: !!task.keepOpen,
    keepOpenOnFailure: !!task.keepOpenOnFailure,
    isolateWorktree: task.isolateWorktree !== false,
    maxRuntimeMinutes: sanitizeMaxRuntime(task.maxRuntimeMinutes),
    enabled: !!task.enabled,
    nextRun: task.nextRun,
    lastRun: task.lastRun,
    lastStatus: lastRun ? lastRun.status : null,
    lastSuccess: lastRun && lastRun.success != null ? lastRun.success : null,
    lastSummary: lastRun && lastRun.summary ? lastRun.summary : null,
  };
}

// --- Cross-project run history (#633) -------------------------------------
//
// The status page's whole point is that a schedule which has quietly stopped
// firing becomes visible, so this deliberately shows MORE than the panel does:
// tasks with no runs at all, tasks whose repo folder is gone, and tombstoned
// tasks (a delete that landed mid-run, #614) — none of which reach the panel.
//
// It also shows LESS in one place that matters: `prompt` is stripped. The grid
// never renders it and it is the bulk of the payload, which is refetched on
// every scheduled-tasks broadcast.

const DIR_EXISTS_TTL_MS = 30 * 1000;
const dirExistsCache = new Map(); // root -> { ok, at }

// TTL-cached existsSync. A missing repo root is exactly the case where the
// volume may be unmounted, and a blocking stat on the event loop is what #553
// took off the request path — so never call this per row, and never uncached.
function dirExists(root, now = Date.now()) {
  if (!root) return true; // '' is the "no repo" bucket, not a missing folder
  const hit = dirExistsCache.get(root);
  if (hit && now - hit.at < DIR_EXISTS_TTL_MS) return hit.ok;
  let ok = false;
  try { ok = fs.existsSync(root); } catch { ok = false; }
  // The live key set is the distinct repo roots across all tasks — a handful.
  // The cap is only so a long-running daemon whose projects churn can't grow
  // this without bound; dropping the whole map just costs one extra stat each.
  if (dirExistsCache.size >= 500) dirExistsCache.clear();
  dirExistsCache.set(root, { ok, at: now });
  return ok;
}

// One run row, trimmed to what the grid renders. Every field is optional:
// worktree/model/effort arrived with #565/#592, so older rows lack them.
function runView(r) {
  return {
    startedAt: r.startedAt || null,
    agentStartedAt: r.agentStartedAt || null,
    endedAt: r.endedAt || null,
    status: r.status || null,
    success: r.success != null ? r.success : null,
    summary: r.summary || null,
    sessionId: r.sessionId || null,
    worktree: r.worktree || null,
    worktreeRemoved: !!r.worktreeRemoved,
    model: r.model || null,
    effort: r.effort || null,
  };
}

function historyTaskView(task) {
  return {
    id: task.id,
    title: task.title,
    schedule: scheduleLabel(task),
    cron: task.cron,
    agentType: task.agentType || null,
    enabled: !!task.enabled,
    once: !!task.once,
    firedAt: task.firedAt || null,
    nextRun: task.nextRun || null,
    lastRun: task.lastRun || null,
    deleted: !!task.deleted,
    // Passed through whole, never sliced: trimRuns() can leave more than
    // MAX_RUNS rows, and the ones it keeps past the cap — runs whose session is
    // still live — are appended at the END. Slicing to 20 would drop exactly the
    // in-flight run the page most needs to show. The client orders for display.
    runs: (task.runs || []).map(runView),
  };
}

// A task still fires on its schedule: enabled, and not a one-shot that already
// went. Mirrors isActive() in the panel so the two surfaces order the same way.
function isSchedulable(task) {
  return !!task && task.enabled !== false && !task.deleted && !(task.once && task.firedAt);
}

/**
 * The whole grid, as data: Project (context) -> repo -> task -> runs.
 *
 * Pure — every input is injected, so the truth tables in
 * test/unit/scheduled-run-history.test.js need no daemon and no filesystem.
 *
 * @param {object[]} taskList   the FULL task array, tombstones included
 * @param {object[]} contextList contexts in their stored (rail drag) order
 * @param {(root: string) => boolean} exists  folder-existence probe
 */
function buildRunHistory({ tasks: taskList = [], contexts: contextList = [], exists = dirExists, enabled = true, now = Date.now() } = {}) {
  const withRepo = taskList.filter(t => t && t.id);

  // Names are disambiguated against the roots this page actually renders — which
  // includes tombstoned tasks' roots, so knownProjects() is the wrong source.
  const names = disambiguate(withRepo.map(t => t.project));

  const byRoot = new Map();
  for (const t of withRepo) {
    const root = t.project || '';
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(t);
  }

  // Active tasks first, as a PARTITION so each tier keeps its creation order —
  // one live task among a hundred paused ones must not sink out of sight (#613).
  const orderTasks = (list) => [...list.filter(isSchedulable), ...list.filter(t => !isSchedulable(t))];

  // The same repo under two contexts is two rows, so the key must carry BOTH.
  // Separated by NUL because that is the one byte neither a group id nor a path
  // can contain, so no id/path pair can forge another row's key.
  const repoView = (groupId, root) => ({
    key: `${groupId == null ? '' : groupId}\u0000${root}`,
    root: root || null,
    name: root ? (names.get(root) || path.basename(root)) : displayName(root),
    missing: root ? !exists(root) : false,
    tasks: orderTasks(byRoot.get(root)).map(historyTaskView),
  });

  const grouped = new Set();
  const groups = [];
  // Contexts keep their stored order — that is the order the user dragged the
  // rail into. Archived ones are still listed (a dormant project's tasks keep
  // firing, server.js:5274) but sink below the live ones.
  const ordered = [...contextList.filter(c => !c.archived), ...contextList.filter(c => c.archived)];
  for (const c of ordered) {
    const dirs = (c.dirs || []).filter(Boolean);
    // A repo can sit inside two contexts (or a context and its own nested
    // sub-context) and is then listed under BOTH, matching how the panel's
    // single-select Show filter already behaves. `key` is what keeps the two
    // copies distinct; any count over them must dedupe by task id.
    const roots = [...byRoot.keys()].filter(root => dirs.some(d => pathInside(root, d)));
    if (!roots.length) continue;
    for (const r of roots) grouped.add(r);
    groups.push({
      id: c.id || null,
      name: c.name || '(unnamed)',
      archived: !!c.archived,
      repos: roots.sort((a, b) => (names.get(a) || '').localeCompare(names.get(b) || '')).map(r => repoView(c.id, r)),
    });
  }

  // Everything that matched no context, including '' (a task with no repo at
  // all). pathInside('', dir) is false, so '' can only ever land here.
  const loose = [...byRoot.keys()].filter(r => !grouped.has(r));
  if (loose.length) {
    groups.push({
      id: null,
      name: 'Ungrouped',
      archived: false,
      // '' ("No project") sorts last — it is a fallback bucket, not a repo.
      repos: loose
        .sort((a, b) => (!a - !b) || (names.get(a) || '').localeCompare(names.get(b) || ''))
        .map(r => repoView(null, r)),
    });
  }

  return { enabled: !!enabled, generatedAt: now, groups };
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

// --- Self-report responses ------------------------------------------------

// What scheduled_task_started/finished say when the caller's session has no run
// record. Pre-#614 this was a bare "This session is not a scheduled task run", which
// is what an agent saw after its own schedule had been deleted out from under it —
// unfalsifiable and alarming enough to get filed as a bug. Now that a delete keeps
// the record (see deleteTask), reaching this really does mean there is no run, so
// name the causes and hand back the two calls that resolve the ambiguity.
// Not isError: it is a no-op notice, not a failure.
function noRunResult(shellId) {
  return { content: [{ type: 'text', text: [
    `No scheduled-task run is recorded for this session${shellId ? ` (${shellId})` : ''}, so there is nothing to mark. This is not an error and does not affect the work itself — just carry on and skip the start/finish bookkeeping.`,
    ``,
    `This happens when the conversation was resumed or forked under a new session id (the ⏰ header you are reading is replayed from the original run's transcript), or when the run's record has aged out of the task's history.`,
    ``,
    `To check whether the schedule is still live, call \`list_scheduled_tasks\` with \`scope: "all"\`. To stop it, call \`unschedule_task\` with the task id from the ⏰ header — that works whether or not the task appears in the listing, and it will tell you if no such task exists.`,
  ].join('\n') }] };
}

// Appended to a self-report response when the run's schedule was deleted while the
// run was still in flight. The run record survived (that is the tombstone's whole
// job), so the bookkeeping still lands — the agent just needs to know the schedule
// is gone and that nothing further will fire.
function deletedScheduleNote(task) {
  return task.deleted
    ? ` This task's schedule was deleted while this run was in flight — it will not fire again, and this is its final run.`
    : '';
}

// --- MCP tools ------------------------------------------------------------

// An unattended run in flight: a live session with no browser attached whose run
// hasn't self-reported terminal yet. The auto-updater asks before restarting (#596)
// — with zero browsers connected, /api/request-restart auto-confirms, so nothing
// else would stop it from killing a scheduled run mid-work and leaking its worktree
// (shutdown skips the run's onExit, and the sweep skips ACTIVE runs).
function unattendedRunInFlight() {
  if (!ctx || !ctx.settings.scheduledTasksEnabled) return null;
  for (const task of tasks) { // tombstones included (#614) — an orphaned run is still live work
    const run = task.runs && task.runs[0];
    if (!run || !ACTIVE_STATUSES.has(run.status)) continue;
    const shell = ctx.shells.get(run.sessionId);
    if (!shell || shell.clients.size > 0) continue; // gone, or a human is watching it
    return { reason: `unattended scheduled run ${run.sessionId} ("${task.title}") in flight` };
  }
  return null;
}

// Shared schema fragment for the claude-only run knobs (#592/#537), so
// schedule_task and update_scheduled_task can never drift apart.
const AGENT_TUNING_SCHEMA = () => ({
  model: z.string().optional().describe('Model for each run: an alias such as "opus", "sonnet", "haiku" or "fable", or a full id such as "claude-fable-5". Omit (or "") to inherit Claude Code\'s own default — note that the default can silently fall back to a cheaper model on usage limits. claude only.'),
  effort: z.enum(EFFORT_LEVELS).optional().describe('Thinking/effort level for each run: low, medium, high, xhigh or max. Omit to inherit Claude Code\'s default. claude only.'),
  config_profile: z.string().optional().describe('Id of a custom Claude config profile (Settings → config profiles, #537) to run under, i.e. an alternate CLAUDE_CONFIG_DIR. Omit for the default config. claude only.'),
});

function init(context) {
  ctx = context;
  startScheduler();
  if (ctx.registerRestartBlocker) ctx.registerRestartBlocker(unattendedRunInFlight);

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
        agent_type: z.string().optional().describe('Agent to run. Supported: "claude" (default), "codex". Experimental: "opencode", "pi", "hermes" — these have no deepsteve MCP tools, so the run cannot self-report and the tab never auto-closes; set max_runtime_minutes. See docs/agents.md.'),
        ...AGENT_TUNING_SCHEMA(),
        plan_mode: z.boolean().optional().describe('Start the agent in plan mode (default false).'),
        keep_open: z.boolean().optional().describe('Keep the tab open after each run finishes instead of auto-closing (default false).'),
        keep_open_on_failure: z.boolean().optional().describe('Keep the tab open when a run fails, even if auto-close is on (default false).'),
        isolate_worktree: z.boolean().optional().describe('Run each fire in a disposable git worktree/branch (scheduled-<runId>) so it never touches the main checkout; cleaned up after the run when clean/merged. Only applies to claude on a git-repo project. Default true.'),
        max_runtime_minutes: z.number().optional().describe('Close a run that has not reported finished after this many minutes, so a stuck run cannot block future fires. Default 60; 0 disables the limit.'),
        enabled: z.boolean().optional().describe('Whether the schedule is active (default true).'),
      },
      handler: async ({ title, prompt, cron: cronStr, once, project, agent_type, model, effort, config_profile, plan_mode, keep_open, keep_open_on_failure, isolate_worktree, max_runtime_minutes, enabled }, extra) => {
        let task;
        try {
          task = createTask({
            title, prompt, cron: cronStr, once,
            project: resolveProject(project, callerShellId(extra)),
            agentType: agent_type, configProfile: config_profile, model, effort,
            planMode: plan_mode, enabled,
            keepOpen: keep_open, keepOpenOnFailure: keep_open_on_failure,
            isolateWorktree: isolate_worktree,
            maxRuntimeMinutes: max_runtime_minutes,
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
        let list = liveTasks(); // tombstones are not schedules — never listed (#614)
        if (effScope === 'project') {
          list = list.filter(t => t.project === proj);
        } else if (effScope === 'group') {
          const dirs = groupScopeDirs(proj);
          list = list.filter(t => dirs.some(d => pathInside(t.project, d)));
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
        agent_type: z.string().optional().describe('Agent to run. Supported: "claude", "codex". Experimental: "opencode", "pi", "hermes" — these have no deepsteve MCP tools, so the run cannot self-report and the tab never auto-closes. See docs/agents.md.'),
        ...AGENT_TUNING_SCHEMA(),
        plan_mode: z.boolean().optional(),
        keep_open: z.boolean().optional().describe('Keep the tab open after each run finishes instead of auto-closing.'),
        keep_open_on_failure: z.boolean().optional().describe('Keep the tab open when a run fails, even if auto-close is on.'),
        isolate_worktree: z.boolean().optional().describe('Run each fire in a disposable git worktree/branch that is cleaned up after the run when clean/merged (claude + git-repo projects only).'),
        max_runtime_minutes: z.number().optional().describe('Close a run that has not reported finished after this many minutes (0 disables the limit).'),
        enabled: z.boolean().optional(),
      },
      handler: async ({ id, title, prompt, cron: cronStr, once, project, agent_type, model, effort, config_profile, plan_mode, keep_open, keep_open_on_failure, isolate_worktree, max_runtime_minutes, enabled }, extra) => {
        const fields = {};
        if (title !== undefined) fields.title = title;
        if (prompt !== undefined) fields.prompt = prompt;
        if (cronStr !== undefined) fields.cron = cronStr;
        if (once !== undefined) fields.once = once;
        if (project !== undefined) fields.project = resolveProject(project, callerShellId(extra));
        if (agent_type !== undefined) fields.agentType = agent_type;
        if (config_profile !== undefined) fields.configProfile = config_profile;
        if (model !== undefined) fields.model = model;
        if (effort !== undefined) fields.effort = effort;
        if (plan_mode !== undefined) fields.planMode = plan_mode;
        if (keep_open !== undefined) fields.keepOpen = keep_open;
        if (keep_open_on_failure !== undefined) fields.keepOpenOnFailure = keep_open_on_failure;
        if (isolate_worktree !== undefined) fields.isolateWorktree = isolate_worktree;
        if (max_runtime_minutes !== undefined) fields.maxRuntimeMinutes = max_runtime_minutes;
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
      description: 'Delete a scheduled task by id, so it never fires again. Works with the task id from a scheduled run\'s ⏰ header even if the task does not appear in list_scheduled_tasks, and always reports definitively whether anything is still scheduled under that id.',
      schema: { id: z.string().describe('Task id to delete') },
      handler: async ({ id }) => {
        // Three distinguishable answers, not one ambiguous "not found" (#614): an
        // agent winding its own recurring task down has to be able to tell "stopped"
        // from "was already stopped" from "that id never existed".
        const del = deleteTask(id);
        const text = !del
          ? `No scheduled task #${id} exists — nothing is scheduled under that id, so it cannot fire.`
          : del.alreadyDeleted
            ? `#${id} "${del.title}" was already unscheduled; it will not fire again.`
            : del.tombstoned
              ? `Unscheduled #${id} "${del.title}" — it will not fire again. A run is still in flight (session ${del.activeSession}); it keeps going and can still report its result.`
              : `Deleted #${id} "${del.title}" — it will not fire again.`;
        return { content: [{ type: 'text', text }] };
      },
    },

    run_scheduled_task_now: {
      description: 'Run a scheduled task immediately (does not change its schedule).',
      schema: { id: z.string().describe('Task id to run now') },
      handler: async ({ id }) => {
        const task = findLiveTask(id);
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
        const shellId = callerShellId(extra);
        const found = findRunByShell(shellId);
        if (!found) return noRunResult(shellId);
        const { task, run } = found;
        run.status = 'running';
        run.agentStartedAt = Date.now();
        saveTasks();
        broadcastTasks();
        return { content: [{ type: 'text', text: `Marked scheduled run of "${task.title}" (#${task.id}) as started.${deletedScheduleNote(task)}` }] };
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
        if (!found) return noRunResult(shellId);
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
        return { content: [{ type: 'text', text: `Marked scheduled run of "${task.title}" (#${task.id}) as ${run.status}.${closed ? ' Closing this session.' : ''}${deletedScheduleNote(task)}` }] };
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
    const enriched = liveTasks().map(t => ({ ...t, schedule: scheduleLabel(t), projectName: displayName(t.project) }));
    // Groups (now the shared "contexts") arrive over /api/contexts + the 'contexts'
    // broadcast, not in this payload.
    // `defaults` (#604) is what an unpinned task actually resolves to, so the form's
    // "Default" options can name it instead of vaguely saying "inherit".
    res.json({
      tasks: enriched, projects: knownProjects(), enabled: !!ctx.settings.scheduledTasksEnabled,
      defaults: { model: defaultModel(), effort: defaultEffort() },
    });
  });

  // The cross-project run-history grid (#633). Read-only, and deliberately NOT
  // feature-gated — same carve-out as list_scheduled_tasks: when the scheduler is
  // off you especially want to see the history and be told why nothing is firing,
  // which is what the `enabled` flag in the payload drives.
  //
  // Registered ahead of the POST and the /:id routes: nothing collides today, but
  // Express resolves in registration order, so this stays safe if a
  // GET /api/scheduled-tasks/:id is ever added.
  app.get('/api/scheduled-tasks/history', (req, res) => {
    res.json(buildRunHistory({
      tasks,                       // the FULL array — tombstones included, on purpose
      contexts: getContexts(),
      enabled: !!ctx.settings.scheduledTasksEnabled,
    }));
  });

  app.post('/api/scheduled-tasks', (req, res) => {
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
    const b = req.body || {};
    let projectRoot = b.project || '';
    if (projectRoot) projectRoot = resolveProject(projectRoot, null);
    try {
      const task = createTask({
        title: b.title, prompt: b.prompt, cron: b.cron, once: b.once, project: projectRoot,
        agentType: b.agentType, configProfile: b.configProfile,
        model: b.model, effort: b.effort,
        planMode: b.planMode, enabled: b.enabled,
        keepOpen: b.keepOpen, keepOpenOnFailure: b.keepOpenOnFailure,
        isolateWorktree: b.isolateWorktree,
        maxRuntimeMinutes: b.maxRuntimeMinutes,
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
    const del = deleteTask(req.params.id);
    if (!del) return res.status(404).json({ error: 'Task not found' });
    // `tombstoned` (#614): unscheduled, but the row is kept until the run still in
    // flight finishes reporting. The card disappears from the panel either way.
    res.json({ deleted: req.params.id, tombstoned: !!del.tombstoned, activeSession: del.activeSession });
  });

  app.post('/api/scheduled-tasks/:id/run', (req, res) => {
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
    const task = findLiveTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    // A skipped run is not an error (still 200), but the panel has to be able to
    // say *why* nothing happened — silence on this path is #611. Ask before firing,
    // since runTask's own guard only returns null.
    const blocking = activeRunFor(task);
    if (blocking) return res.json({ started: false, reason: 'active-run', activeSessionId: blocking.sessionId });
    // The panel's Run-now button: the user explicitly asked for this run, so open
    // its tab in the foreground even when scheduled fires are silent (#600).
    const shellId = runTask(task, 'manual', { foreground: true });
    if (!shellId) return res.json({ started: false, reason: 'unavailable', sessionId: null });
    res.json({ started: true, sessionId: shellId });
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
module.exports = { init, registerRoutes, cleanupWorktree, isGitRepo, scheduledRunPrompt, worktreeContract, enforceRunTimeouts, CONTRACT_TOOLS, purgeTombstonedTasks, TOMBSTONE_TTL_MS, buildRunHistory, disambiguate };

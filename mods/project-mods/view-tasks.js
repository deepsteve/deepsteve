/**
 * Task boards — the server half: a project's tasks, each an ad hoc grouping of its sessions.
 *
 * A view can carry `tasks: true` (see the "Project views" section of tools.js): while it is the
 * selected view, a superview at the head of the strip opens a board of the project's tasks.
 * public/js/view-tasks.js draws it; this file keeps the tasks.
 *
 * A task is a title and a list of deepsteve session ids. The tasks are the daemon's, not a
 * repo's and not a browser's: a session id means nothing on another machine, so they are never
 * committed, and every window should see the same board, so they are not kept client-side. They
 * live in one state file, `view-tasks.json`, keyed by project (context) id.
 *
 * A session is in at most one of a project's tasks — moving it anywhere takes it out of every
 * other. A task keeps a session's id after its tab closes, so a reopened tab is back on its card;
 * an id is dropped only once the daemon has no record of that session at all (the retention
 * sweep purged its tombstone), and only on a write, so a read can never shrink a board.
 *
 * Unrelated to the Tasks mod (mods/tasks/), which is a to-do list.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const FILE_VERSION = 1;
const DEFAULT_TITLE = 'New task';
const MAX_TITLE = 120;
// A board past these is not one anyone reads; they keep a runaway client from growing the file.
const MAX_TASKS = 200;
const MAX_TASK_SESSIONS = 200;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** A title: one line, trimmed and capped. Empty is empty — the caller picks the default. */
function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim();
}

/** Session ids from a request: well-formed strings, each once, in the order given. */
function cleanSessionIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    if (typeof id === 'string' && SESSION_ID_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_TASK_SESSIONS) break;
  }
  return out;
}

const cleanTaskId = (raw) => (typeof raw === 'string' && TASK_ID_RE.test(raw) ? raw : '');

function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

/**
 * The store, made once per daemon. `file` is the state file's path, or a function returning it
 * (resolved on first use, so a test's HOME is the one read). `sessionKnown(id)` says whether the
 * daemon still has any record of a session, live or closed. `now` and `newId` are swappable in a
 * test.
 */
function createTaskStore({ file, sessionKnown = () => true, now = Date.now, newId = randomUUID } = {}) {
  let data = null;   // { version, projects: { [contextId]: { tasks: [{ id, title, sessions, created }] } } }
  const fileOf = () => (typeof file === 'function' ? file() : file);

  function load() {
    if (data) return data;
    data = { version: FILE_VERSION, projects: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
      if (raw && raw.projects && typeof raw.projects === 'object') {
        for (const [ctxId, p] of Object.entries(raw.projects)) {
          const tasks = (p && Array.isArray(p.tasks) ? p.tasks : [])
            .filter(t => t && cleanTaskId(t.id))
            .map(t => ({
              id: t.id,
              title: cleanTitle(t.title) || DEFAULT_TITLE,
              sessions: cleanSessionIds(t.sessions),
              created: Number.isFinite(t.created) ? t.created : 0,
            }));
          if (tasks.length) data.projects[ctxId] = { tasks };
        }
      }
    } catch {
      // No file yet (the common case), or one we can't read: start empty rather than refuse.
    }
    return data;
  }

  function save() {
    writeFileAtomic(fileOf(), JSON.stringify(data, null, 2) + '\n');
  }

  const tasksOf = (contextId) => (load().projects[contextId] || { tasks: [] }).tasks;

  /** A copy of a project's tasks, oldest first — the order the board draws them. */
  function list(contextId) {
    return tasksOf(contextId).map(t => ({ ...t, sessions: [...t.sessions] }));
  }

  /** Every write ends here: forget purged sessions, drop an empty project, persist. */
  function commit(contextId, tasks) {
    for (const t of tasks) t.sessions = t.sessions.filter(id => sessionKnown(id));
    if (tasks.length) load().projects[contextId] = { tasks };
    else delete load().projects[contextId];
    save();
    return list(contextId);
  }

  /** Take `ids` out of every task of the project, then append them to `target` when given. */
  function place(tasks, ids, target) {
    for (const t of tasks) t.sessions = t.sessions.filter(id => !ids.includes(id));
    if (target) target.sessions = [...target.sessions, ...ids].slice(0, MAX_TASK_SESSIONS);
  }

  /** A new task, at the end. `sessions` are moved into it. → { task, tasks } or { error, status }. */
  function create(contextId, { title, sessions } = {}) {
    const tasks = tasksOf(contextId).slice();
    if (tasks.length >= MAX_TASKS) return { error: `A project holds at most ${MAX_TASKS} tasks`, status: 400 };
    const task = { id: newId(), title: cleanTitle(title) || DEFAULT_TITLE, sessions: [], created: now() };
    tasks.push(task);
    place(tasks, cleanSessionIds(sessions), task);
    const after = commit(contextId, tasks);
    return { task: after.find(t => t.id === task.id), tasks: after };
  }

  function rename(contextId, taskId, title) {
    const tasks = tasksOf(contextId).slice();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return { error: 'Task not found', status: 404 };
    const cleaned = cleanTitle(title);
    if (!cleaned) return { error: 'title must not be empty', status: 400 };
    task.title = cleaned;
    return { tasks: commit(contextId, tasks) };
  }

  /** Delete a task. Its sessions are simply in no task again — nothing happens to them. */
  function remove(contextId, taskId) {
    const tasks = tasksOf(contextId);
    if (!tasks.some(t => t.id === taskId)) return { error: 'Task not found', status: 404 };
    return { tasks: commit(contextId, tasks.filter(t => t.id !== taskId)) };
  }

  /** Move sessions into task `to`, or out of every task when `to` is null. */
  function move(contextId, sessions, to) {
    const tasks = tasksOf(contextId).slice();
    const target = to == null ? null : tasks.find(t => t.id === to);
    if (to != null && !target) return { error: 'Task not found', status: 404 };
    const ids = cleanSessionIds(sessions);
    if (!ids.length) return { error: 'sessions must name at least one session', status: 400 };
    place(tasks, ids, target);
    return { tasks: commit(contextId, tasks) };
  }

  return { list, create, rename, remove, move };
}

module.exports = {
  createTaskStore, cleanTitle, cleanSessionIds, cleanTaskId,
  DEFAULT_TITLE, MAX_TITLE, MAX_TASKS, MAX_TASK_SESSIONS,
};

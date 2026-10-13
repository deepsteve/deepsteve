// Project Notes — three columns, the way Apple Notes lays them out: projects, the notes in
// the selected project (pinned first, then most recently edited), and the open note.
//
// Vanilla, no CDN, so the app paints instantly. Edits are optimistic: a keystroke updates
// the note in memory, re-sorts the list, and schedules a debounced PUT. Saves run through
// one promise chain so they reach the server in the order they were made, and each one
// sends the note's text as it is *when it runs*, so the last write is always the newest.
//
// Deleting moves a note to the Trash, which is a view like a project's: it lists only
// trashed notes, newest-deleted first, read-only until restored. Only "Delete
// Permanently" and "Empty Trash" lose anything, and both ask twice.

// Mod iframes get no theme variables, so these are mirrored from the host document. Keep
// this list in step with the var() names in index.html.
const THEME_TOKENS = [
  '--ds-bg-primary',
  '--ds-bg-secondary',
  '--ds-bg-tertiary',
  '--ds-border',
  '--ds-text-primary',
  '--ds-text-secondary',
  '--ds-text-bright',
  '--ds-accent-blue',
  '--ds-accent-red',
  '--ds-accent-orange',
  '--ds-selected-bg',
];

const ALL = 'all';
const TRASH = 'trash';
const SAVE_DELAY_MS = 400;
const RETRY_MS = 3000;
const KEY_PROJECT = 'deepsteve-project-notes-project';
const KEY_NOTE = 'deepsteve-project-notes-note';
const KEY_LAST = 'deepsteve-project-notes-last-project';

const FOLDER_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2h6.6a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
const ALL_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2.5" width="12" height="15" rx="1.5"/><path d="M7 6.5h6M7 9.5h6M7 12.5h4"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 5.5l.8 10.6a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L15 5.5"/></svg>';
const PIN_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.2 1.3a.75.75 0 0 0-1.06 0L6.9 3.54 4.06 3.1a.75.75 0 0 0-.65.21l-1 1a.75.75 0 0 0 0 1.06l2.6 2.6-3.3 3.3a.75.75 0 1 0 1.06 1.06l3.3-3.3 2.6 2.6a.75.75 0 0 0 1.06 0l1-1a.75.75 0 0 0 .21-.65l-.44-2.84 2.24-2.24a.75.75 0 0 0 0-1.06z"/></svg>';

const el = {
  projectList: document.getElementById('pn-project-list'),
  notesTitle: document.getElementById('pn-notes-title'),
  newBtn: document.getElementById('pn-new'),
  search: document.getElementById('pn-search'),
  noteList: document.getElementById('pn-note-list'),
  editorHead: document.getElementById('pn-editor-head'),
  noteProject: document.getElementById('pn-note-project'),
  trashedLabel: document.getElementById('pn-trashed-label'),
  edited: document.getElementById('pn-edited'),
  restoreBtn: document.getElementById('pn-restore'),
  deleteBtn: document.getElementById('pn-delete'),
  text: document.getElementById('pn-text'),
  editorEmpty: document.getElementById('pn-editor-empty'),
  status: document.getElementById('pn-status'),
  menu: document.getElementById('pn-menu'),
};

let projects = [];   // every rail project, archived included, so old notes keep their names
let notes = [];      // most recently edited first
let loaded = false;
let projectId = readPref(KEY_PROJECT) || ALL;
let noteId = readPref(KEY_NOTE);
let query = '';
const dirty = new Set();       // note ids with a text edit the server has not confirmed
const timers = new Map();      // note id → debounce timer
let saveChain = Promise.resolve();
// Bumped by every local change other than typing (pin, trash, move, create, purge). A
// refresh that saw it move while its GET was in flight may be holding a list from before
// that change, so it throws the response away and asks again.
let writes = 0;
let deleteArmedTimer = null;
let menuTarget = null;

// --- small helpers -----------------------------------------------------------

function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private window — selection just won't persist */ }
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const noteUrl = id => `/api/project-notes/${encodeURIComponent(id)}`;

function byId(id) { return notes.find(n => n.id === id) || null; }
function sortNotes() { notes.sort((a, b) => b.updatedAt - a.updatedAt); }
function liveProjects() { return projects.filter(p => !p.archived); }
function projectName(id) {
  const p = projects.find(x => x.id === id);
  return p ? p.name : 'Deleted project';
}

function noteLines(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
}
function noteTitle(note) { return (noteLines(note.text)[0] || 'New Note').slice(0, 200); }
function noteSnippet(note) { return noteLines(note.text)[1] || 'No additional text'; }

/** The timestamp a view orders and groups by: deletion in the Trash, the last edit elsewhere. */
function stamp(note) { return note.deletedAt || note.updatedAt; }

function startOfDay(d, offsetDays = 0) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime();
}

/** The section a note sorts under — Apple Notes' buckets. */
function groupLabel(ts, now) {
  if (ts >= startOfDay(now)) return 'Today';
  if (ts >= startOfDay(now, -1)) return 'Yesterday';
  if (ts >= startOfDay(now, -7)) return 'Previous 7 Days';
  if (ts >= startOfDay(now, -30)) return 'Previous 30 Days';
  const d = new Date(ts);
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'long' });
  return String(d.getFullYear());
}

function rowDate(ts, now) {
  const d = new Date(ts);
  if (ts >= startOfDay(now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ts >= startOfDay(now, -1)) return 'Yesterday';
  if (ts >= startOfDay(now, -6)) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

function longDate(ts) {
  return new Date(ts).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });
}

function setStatus(msg) {
  el.status.textContent = msg || '';
  el.status.hidden = !msg;
}

// --- theme -------------------------------------------------------------------

function syncTheme() {
  try {
    const cs = parent.getComputedStyle(parent.document.documentElement);
    for (const name of THEME_TOKENS) {
      const value = cs.getPropertyValue(name).trim();
      if (value) document.documentElement.style.setProperty(name, value);
    }
  } catch { /* no reachable parent — the fallbacks carry the page */ }
}

function watchTheme() {
  try {
    new MutationObserver(syncTheme).observe(parent.document.head, {
      childList: true, subtree: true, characterData: true,
    });
  } catch { /* best-effort */ }
}

// --- loading -----------------------------------------------------------------

async function refresh() {
  await saveChain;
  const seen = writes;
  let ctx, data;
  try {
    [ctx, data] = await Promise.all([
      api('GET', '/api/contexts'),
      api('GET', '/api/project-notes'),
    ]);
  } catch (e) {
    // Mod routes register after core's, so right after a daemon start this can 404 for a
    // moment. Keep what is on screen and try again shortly.
    if (!loaded) el.noteList.replaceChildren(emptyMessage('Loading…'));
    setTimeout(refresh, RETRY_MS);
    return;
  }
  if (writes !== seen) { refresh(); return; }

  projects = Array.isArray(ctx.contexts) ? ctx.contexts : [];
  mergeNotes(Array.isArray(data.notes) ? data.notes : []);
  loaded = true;
  setStatus('');

  if (projectId !== ALL && projectId !== TRASH && !liveProjects().some(p => p.id === projectId)) {
    selectProjectId(ALL);
  }
  const current = byId(noteId);
  if (!current || !inView(current)) noteId = visibleNotes()[0]?.id || null;
  writePref(KEY_NOTE, noteId);
  renderAll();
}

/** Take the server's notes, but never over a text edit it hasn't confirmed yet. */
function mergeNotes(serverNotes) {
  const local = new Map(notes.map(n => [n.id, n]));
  notes = serverNotes.map(s => {
    const mine = dirty.has(s.id) && local.get(s.id);
    return mine ? { ...s, text: mine.text, updatedAt: mine.updatedAt } : s;
  });
  sortNotes();
}

// --- views and selection -----------------------------------------------------

/** Whether a note belongs in the current view, before the search filter. */
function inView(note) {
  if (projectId === TRASH) return !!note.deletedAt;
  if (note.deletedAt) return false;
  return projectId === ALL || note.projectId === projectId;
}

function visibleNotes() {
  const q = query.trim().toLowerCase();
  const list = notes.filter(n => inView(n) && (!q || n.text.toLowerCase().includes(q)));
  if (projectId === TRASH) return list.sort((a, b) => b.deletedAt - a.deletedAt);
  // Stable: pinned notes first, each half still most-recently-edited first.
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/** The note to land on when `id` leaves the list: the one below it, else above. */
function neighbourOf(id) {
  const list = visibleNotes();
  const i = list.findIndex(n => n.id === id);
  if (i === -1) return null;
  return (list[i + 1] || list[i - 1] || null)?.id || null;
}

function setSelected(id) {
  noteId = id;
  writePref(KEY_NOTE, id);
}

function selectProjectId(id) {
  projectId = id;
  writePref(KEY_PROJECT, id);
}

async function selectProject(id) {
  if (id === projectId) return;
  selectProjectId(id);
  const current = byId(noteId);
  if (!current || !inView(current)) {
    await leaveNote(noteId);
    setSelected(visibleNotes()[0]?.id || null);
  }
  renderAll();
}

async function selectNote(id) {
  if (id === noteId) return;
  const prev = noteId;
  setSelected(id);
  renderAll();
  await leaveNote(prev);
}

/** Save what's pending, and drop the note if it was left blank — Apple Notes does both. */
async function leaveNote(id) {
  if (!id) return;
  await flush(id);
  const note = byId(id);
  if (note && !note.deletedAt && !note.text.trim()) await purgeNote(id);
}

/** Where a new note goes: the open project, else the one you last wrote in. */
function targetProject() {
  const live = liveProjects();
  if (projectId === TRASH) return null;
  if (projectId !== ALL && live.some(p => p.id === projectId)) return projectId;
  const last = readPref(KEY_LAST);
  if (last && live.some(p => p.id === last)) return last;
  return live[0]?.id || null;
}

// --- writes ------------------------------------------------------------------

/** Run `fn` after every write queued before it. The chain itself never rejects, so one
 *  failed request can't poison the writes behind it; the caller still sees the failure. */
function enqueue(fn) {
  const run = saveChain.then(fn, fn);
  saveChain = run.catch(() => {});
  return run;
}

function scheduleSave(id) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { timers.delete(id); enqueue(() => doSave(id)); }, SAVE_DELAY_MS));
}

function flush(id) {
  if (!timers.has(id)) return saveChain;
  clearTimeout(timers.get(id));
  timers.delete(id);
  return enqueue(() => doSave(id));
}

async function doSave(id) {
  const note = byId(id);
  if (!note || !dirty.has(id)) return;
  const text = note.text;
  try {
    await api('PUT', noteUrl(id), { text });
    if (note.text === text) dirty.delete(id);
    setStatus('');
  } catch (e) {
    if (e.status === 404) { dirty.delete(id); return; }   // deleted in another window
    setStatus(`Couldn't save this note (${e.message}). Retrying…`);
    setTimeout(() => { if (dirty.has(id) && !timers.has(id)) scheduleSave(id); }, RETRY_MS);
  }
}

/** Apply a field change locally now, and send it in order behind any pending saves. */
function patchNote(id, fields, failMsg) {
  writes++;
  return enqueue(async () => {
    try { await api('PUT', noteUrl(id), fields); }
    catch (e) { if (e.status !== 404) setStatus(`${failMsg} (${e.message}).`); }
  });
}

function togglePin(id) {
  const note = byId(id);
  if (!note || note.deletedAt) return;
  note.pinned = !note.pinned;
  renderNotes();
  patchNote(id, { pinned: note.pinned }, "Couldn't pin this note");
}

/** Delete = move to the Trash. A blank note has nothing worth keeping and goes for good. */
async function trashNote(id) {
  const note = byId(id);
  if (!note || note.deletedAt) return;
  if (!note.text.trim()) { await purgeNote(id); return; }
  if (noteId === id) setSelected(neighbourOf(id));
  note.deletedAt = Date.now();
  note.pinned = false;
  renderAll();
  flush(id);   // any unsaved typing goes out first, ahead of the move
  await patchNote(id, { deleted: true }, "Couldn't delete this note");
}

async function restoreNote(id) {
  const note = byId(id);
  if (!note || !note.deletedAt) return;
  if (noteId === id) setSelected(neighbourOf(id));
  note.deletedAt = null;
  renderAll();
  await patchNote(id, { deleted: false }, "Couldn't restore this note");
}

/** Gone for good. */
async function purgeNote(id) {
  writes++;
  clearTimeout(timers.get(id));
  timers.delete(id);
  dirty.delete(id);
  if (noteId === id) setSelected(neighbourOf(id));
  notes = notes.filter(n => n.id !== id);
  renderAll();
  await enqueue(async () => {
    try { await api('DELETE', noteUrl(id)); }
    catch (e) { if (e.status !== 404) setStatus(`Couldn't delete that note (${e.message}).`); }
  });
}

async function emptyTrash() {
  writes++;
  const current = byId(noteId);
  if (current && current.deletedAt) setSelected(null);
  notes = notes.filter(n => !n.deletedAt);
  renderAll();
  await enqueue(async () => {
    try { await api('POST', '/api/project-notes/empty-trash'); }
    catch (e) { setStatus(`Couldn't empty the Trash (${e.message}).`); }
  });
}

async function newNote() {
  const pid = targetProject();
  if (!pid) return;
  const current = byId(noteId);
  if (current && !current.deletedAt && !current.text.trim() && current.projectId === pid) { el.text.focus(); return; }
  await leaveNote(noteId);
  if (query) { query = ''; el.search.value = ''; }
  writes++;
  try {
    const { note } = await enqueue(() => api('POST', '/api/project-notes', { projectId: pid, text: '' }));
    notes.unshift(note);
    sortNotes();
    setSelected(note.id);
    writePref(KEY_LAST, pid);
    setStatus('');
    renderAll();
    el.text.focus();
  } catch (e) {
    setStatus(`Couldn't create a note (${e.message}).`);
  }
}

// --- context menu ------------------------------------------------------------
// Items are { label, action, danger?, disabled?, confirm? } or '-' for a separator. An
// item with `confirm` asks twice: the first click relabels it and keeps the menu open.
// (Mod iframes are sandboxed without allow-modals, so confirm() is not available.)

function openMenu(x, y, items, targetEl) {
  closeMenu();
  menuTarget = targetEl || null;
  if (menuTarget) menuTarget.classList.add('menu-target');
  el.menu.replaceChildren(...items.map(item => {
    if (item === '-') return document.createElement('hr');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    b.disabled = !!item.disabled;
    if (item.danger) b.className = 'danger';
    b.addEventListener('click', e => {
      e.stopPropagation();
      if (item.confirm && !b.dataset.armed) {
        b.dataset.armed = '1';
        b.textContent = item.confirm;
        return;
      }
      closeMenu();
      item.action();
    });
    return b;
  }));
  el.menu.hidden = false;
  const r = el.menu.getBoundingClientRect();
  el.menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  el.menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  el.menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function closeMenu() {
  if (el.menu.hidden) return;
  el.menu.hidden = true;
  el.menu.replaceChildren();
  if (menuTarget) menuTarget.classList.remove('menu-target');
  menuTarget = null;
}

function noteMenu(note) {
  if (note.deletedAt) {
    return [
      { label: 'Restore', action: () => restoreNote(note.id) },
      '-',
      { label: 'Delete Permanently', danger: true, confirm: 'Click again to delete forever', action: () => purgeNote(note.id) },
    ];
  }
  return [
    { label: note.pinned ? 'Unpin Note' : 'Pin Note', action: () => togglePin(note.id) },
    '-',
    { label: 'Delete', danger: true, action: () => trashNote(note.id) },
  ];
}

function trashMenu() {
  const count = notes.filter(n => n.deletedAt).length;
  return [
    { label: 'Empty Trash', danger: true, disabled: !count, confirm: `Click again to delete ${count} note${count === 1 ? '' : 's'} forever`, action: emptyTrash },
  ];
}

document.addEventListener('mousedown', e => { if (!el.menu.contains(e.target)) closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
el.noteList.addEventListener('scroll', closeMenu);
el.menu.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...el.menu.querySelectorAll('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});

// --- rendering ---------------------------------------------------------------

function emptyMessage(text) {
  const div = document.createElement('div');
  div.className = 'pn-empty';
  div.textContent = text;
  return div;
}

function projectIcon(p, svg) {
  const span = document.createElement('span');
  span.className = 'pn-icon';
  if (svg) span.innerHTML = svg;
  else if (p.icon) span.textContent = p.icon;
  else if (p.iconImage) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `/api/contexts/${encodeURIComponent(p.id)}/icon`;
    span.appendChild(img);
  } else span.innerHTML = FOLDER_SVG;
  return span;
}

function projectRow(id, label, icon, count) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pn-project' + (id === projectId ? ' active' : '');
  const name = document.createElement('span');
  name.className = 'pn-name';
  name.textContent = label;
  const n = document.createElement('span');
  n.className = 'pn-count';
  n.textContent = count ? String(count) : '';
  btn.append(icon, name, n);
  btn.addEventListener('click', () => selectProject(id));
  return btn;
}

function divider() {
  const hr = document.createElement('div');
  hr.className = 'pn-divider';
  return hr;
}

function renderProjects() {
  const counts = new Map();
  let live = 0;
  let trashed = 0;
  for (const n of notes) {
    if (n.deletedAt) { trashed++; continue; }
    live++;
    counts.set(n.projectId, (counts.get(n.projectId) || 0) + 1);
  }
  const rows = [projectRow(ALL, 'All Notes', projectIcon(null, ALL_SVG), live)];
  const projectsLive = liveProjects();
  if (projectsLive.length) rows.push(divider());
  for (const p of projectsLive) rows.push(projectRow(p.id, p.name, projectIcon(p), counts.get(p.id) || 0));
  rows.push(divider());
  const trashRow = projectRow(TRASH, 'Trash', projectIcon(null, TRASH_SVG), trashed);
  trashRow.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, trashMenu(), trashRow);
  });
  rows.push(trashRow);
  el.projectList.replaceChildren(...rows);
}

function noteRow(note, now) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pn-note' + (note.id === noteId ? ' active' : '');
  btn.dataset.id = note.id;
  const title = document.createElement('div');
  title.className = 'pn-note-title';
  if (note.pinned) title.innerHTML = PIN_SVG;
  title.append(noteTitle(note));
  const meta = document.createElement('div');
  meta.className = 'pn-note-meta';
  const date = document.createElement('span');
  date.className = 'pn-note-date';
  date.textContent = rowDate(stamp(note), now);
  const snip = document.createElement('span');
  snip.className = 'pn-note-snippet';
  snip.textContent = noteSnippet(note);
  meta.append(date, snip);
  btn.append(title, meta);
  if (projectId === ALL || projectId === TRASH) {
    const proj = document.createElement('div');
    proj.className = 'pn-note-project';
    proj.textContent = projectName(note.projectId);
    btn.appendChild(proj);
  }
  btn.addEventListener('click', () => selectNote(note.id));
  btn.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, noteMenu(note), btn);
  });
  return btn;
}

function groupHeading(label) {
  const h = document.createElement('div');
  h.className = 'pn-group';
  h.textContent = label;
  return h;
}

function renderNotes() {
  el.notesTitle.textContent = projectId === ALL ? 'All Notes'
    : projectId === TRASH ? 'Trash'
    : projectName(projectId);
  const target = targetProject();
  el.newBtn.disabled = !target;
  el.newBtn.title = target ? `New note in ${projectName(target)}`
    : projectId === TRASH ? 'Notes can\'t be written in the Trash'
    : 'Add a project first';

  if (!loaded) return;
  const list = visibleNotes();
  if (!list.length) {
    const msg = query.trim() ? 'No matching notes.'
      : projectId === TRASH ? 'The Trash is empty.'
      : !liveProjects().length ? 'Add a project in the rail to start writing notes.'
      : 'No notes yet. Press the pencil to write one.';
    el.noteList.replaceChildren(emptyMessage(msg));
    return;
  }

  const now = new Date();
  const rows = [];
  let group = null;
  for (const note of list) {
    const label = note.pinned ? 'Pinned' : groupLabel(stamp(note), now);
    if (label !== group) { group = label; rows.push(groupHeading(label)); }
    rows.push(noteRow(note, now));
  }
  el.noteList.replaceChildren(...rows);
}

function renderEditorMeta(note) {
  el.edited.textContent = note.deletedAt ? `Deleted ${longDate(note.deletedAt)}` : longDate(note.updatedAt);
}

function renderEditor() {
  const note = byId(noteId);
  el.editorHead.hidden = !note;
  el.text.hidden = !note;
  el.editorEmpty.hidden = !!note;
  disarmDelete();
  if (!note) {
    el.editorEmpty.textContent = loaded && visibleNotes().length ? 'Select a note, or start a new one.' : '';
    return;
  }

  const trashed = !!note.deletedAt;
  el.noteProject.hidden = trashed;
  el.trashedLabel.hidden = !trashed;
  el.restoreBtn.hidden = !trashed;
  el.text.readOnly = trashed;

  // Options: every live project, plus the note's own if it was archived or deleted, so
  // the select never silently shows (and then saves) a different project.
  const options = liveProjects().map(p => [p.id, p.name]);
  if (!options.some(([id]) => id === note.projectId)) options.unshift([note.projectId, projectName(note.projectId)]);
  el.noteProject.replaceChildren(...options.map(([id, name]) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = name;
    return o;
  }));
  el.noteProject.value = note.projectId;

  renderEditorMeta(note);
  // Only touch the textarea when its text is actually stale, or every render would
  // throw the caret to the end.
  if (el.text.value !== note.text) {
    const focused = document.activeElement === el.text;
    const pos = el.text.selectionStart;
    el.text.value = note.text;
    if (focused) el.text.setSelectionRange(Math.min(pos, note.text.length), Math.min(pos, note.text.length));
    else el.text.scrollTop = 0;
  }
}

function renderAll() {
  renderProjects();
  renderNotes();
  renderEditor();
}

// --- editor buttons ----------------------------------------------------------
// Delete moves to the Trash, which is recoverable, so it acts at once. Inside the Trash
// the same button deletes for good, and asks twice.

function disarmDelete() {
  clearTimeout(deleteArmedTimer);
  deleteArmedTimer = null;
  el.deleteBtn.classList.remove('confirm');
  el.deleteBtn.textContent = byId(noteId)?.deletedAt ? 'Delete Permanently' : 'Delete';
}

el.deleteBtn.addEventListener('click', () => {
  const note = byId(noteId);
  if (!note) return;
  if (!note.deletedAt) { trashNote(note.id); return; }
  if (!deleteArmedTimer) {
    el.deleteBtn.classList.add('confirm');
    el.deleteBtn.textContent = 'Delete forever?';
    deleteArmedTimer = setTimeout(disarmDelete, 3000);
    return;
  }
  purgeNote(note.id);
});

el.restoreBtn.addEventListener('click', () => { if (noteId) restoreNote(noteId); });

// --- events ------------------------------------------------------------------

el.newBtn.addEventListener('click', newNote);

el.search.addEventListener('input', () => {
  query = el.search.value;
  renderNotes();
});
el.search.addEventListener('keydown', e => {
  if (e.key === 'Escape' && el.search.value) { el.search.value = ''; query = ''; renderNotes(); }
});

el.text.addEventListener('input', () => {
  const note = byId(noteId);
  if (!note || note.deletedAt) return;
  note.text = el.text.value;
  note.updatedAt = Date.now();
  dirty.add(note.id);
  sortNotes();
  renderProjects();
  renderNotes();
  renderEditorMeta(note);
  scheduleSave(note.id);
});

el.noteProject.addEventListener('change', () => {
  const note = byId(noteId);
  const pid = el.noteProject.value;
  if (!note || pid === note.projectId) return;
  note.projectId = pid;
  note.updatedAt = Date.now();
  writePref(KEY_LAST, pid);
  // Follow the note to its new project, so it doesn't vanish from the list you're in.
  if (projectId !== ALL) selectProjectId(pid);
  sortNotes();
  renderAll();
  patchNote(note.id, { projectId: pid }, "Couldn't move this note");
});

el.noteList.addEventListener('keydown', e => {
  const focusedId = document.activeElement?.dataset?.id;
  // Delete / Backspace on a focused row moves it to the Trash.
  if ((e.key === 'Delete' || e.key === 'Backspace') && focusedId && projectId !== TRASH) {
    e.preventDefault();
    const next = focusedId === noteId ? neighbourOf(focusedId) : null;
    trashNote(focusedId).then(() => {
      if (next) el.noteList.querySelector(`.pn-note[data-id="${CSS.escape(next)}"]`)?.focus();
    });
    return;
  }
  // ↑/↓ walk the list while it has focus.
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const list = visibleNotes();
  const i = list.findIndex(n => n.id === noteId);
  const next = list[e.key === 'ArrowDown' ? i + 1 : i - 1];
  if (!next) return;
  e.preventDefault();
  const focusRow = () => el.noteList.querySelector(`.pn-note[data-id="${CSS.escape(next.id)}"]`)?.focus();
  selectNote(next.id).then(focusRow);
  focusRow();
});

// Another window (or the rail) may have changed things while this page sat parked.
window.addEventListener('focus', () => { if (loaded) refresh(); });

// The page is going away with an edit still pending: send it with keepalive so it
// survives the unload.
window.addEventListener('pagehide', () => {
  for (const id of dirty) {
    const note = byId(id);
    if (!note) continue;
    try {
      fetch(noteUrl(id), {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: note.text }),
      });
    } catch {}
  }
});

syncTheme();
watchTheme();
renderAll();
refresh();

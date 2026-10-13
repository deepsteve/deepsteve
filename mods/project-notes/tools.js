// Project Notes — a notepad whose notes are filed under the rail's projects.
//
// One JSON file, ~/.deepsteve/project-notes.json, rewritten atomically on every change.
// A note is { id, projectId, text, pinned, deletedAt, createdAt, updatedAt }: the first
// line of `text` is its title, the way Apple Notes does it, so there is no separate title
// field to keep in step. `projectId` is a /api/contexts id. A note whose project is later
// deleted is kept and still listed under All Notes — deleting a project never deletes
// what you wrote.
//
// Deleting a note moves it to the Trash (`deletedAt` set); only DELETE and empty-trash
// remove one for good. Pinning and trashing leave `updatedAt` alone — they are not edits,
// and the list's order is "most recently edited".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateDir } = require('../../paths');

const NOTES_FILE = path.join(stateDir(), 'project-notes.json');
const MAX_ID = 64;

let ctx = null;
let notes = null;

function log_(msg) {
  if (ctx && ctx.log) ctx.log(`[project-notes] ${msg}`);
}

function load() {
  if (notes) return notes;
  try {
    const data = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    // Notes written before pinning and the Trash existed carry neither field.
    notes = (Array.isArray(data.notes) ? data.notes : []).map(n => ({
      ...n,
      pinned: !!n.pinned,
      deletedAt: n.deletedAt || null,
    }));
  } catch (e) {
    // A missing file is a fresh install. A corrupt one is set aside rather than silently
    // overwritten by the next save, so nothing a user wrote is lost to a bad write.
    if (e.code !== 'ENOENT') {
      const aside = `${NOTES_FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(NOTES_FILE, aside); } catch {}
      log_(`could not read ${NOTES_FILE} (${e.message}); moved it to ${aside}`);
    }
    notes = [];
  }
  return notes;
}

function save() {
  fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
  const tmp = NOTES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ notes }, null, 2));
  fs.renameSync(tmp, NOTES_FILE);
}

/** Most recently edited first — the list's only order. */
function sorted() {
  return load().slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

function cleanProjectId(raw) {
  return typeof raw === 'string' && raw && raw.length <= MAX_ID ? raw : null;
}

function init(context) {
  ctx = context;
  // No MCP tools: these are the user's own notes, written by hand.
  return {};
}

function registerRoutes(app, context) {
  if (!ctx) ctx = context;

  app.get('/api/project-notes', (req, res) => {
    res.json({ notes: sorted() });
  });

  app.post('/api/project-notes', (req, res) => {
    const b = req.body || {};
    const projectId = cleanProjectId(b.projectId);
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const now = Date.now();
    const note = {
      id: crypto.randomUUID(),
      projectId,
      text: typeof b.text === 'string' ? b.text : '',
      pinned: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    load().push(note);
    save();
    res.json({ note });
  });

  app.put('/api/project-notes/:id', (req, res) => {
    const note = load().find(n => n.id === req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    const b = req.body || {};
    let changed = false;
    if (typeof b.text === 'string' && b.text !== note.text) { note.text = b.text; changed = true; }
    if (b.projectId !== undefined) {
      const projectId = cleanProjectId(b.projectId);
      if (!projectId) return res.status(400).json({ error: 'Invalid projectId' });
      if (projectId !== note.projectId) { note.projectId = projectId; changed = true; }
    }
    // A save that changes nothing must not bump updatedAt, or merely opening a note
    // would float it to the top of the list.
    if (changed) note.updatedAt = Date.now();

    let flagged = false;
    if (typeof b.pinned === 'boolean' && b.pinned !== note.pinned) { note.pinned = b.pinned; flagged = true; }
    if (typeof b.deleted === 'boolean' && b.deleted !== !!note.deletedAt) {
      note.deletedAt = b.deleted ? Date.now() : null;
      // Trashing unpins, so a restored note doesn't jump back into the Pinned section.
      if (b.deleted) note.pinned = false;
      flagged = true;
    }
    if (changed || flagged) save();
    res.json({ note });
  });

  app.post('/api/project-notes/empty-trash', (req, res) => {
    const before = load().length;
    notes = load().filter(n => !n.deletedAt);
    const removed = before - notes.length;
    if (removed) save();
    res.json({ removed });
  });

  app.delete('/api/project-notes/:id', (req, res) => {
    const list = load();
    const idx = list.findIndex(n => n.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Note not found' });
    list.splice(idx, 1);
    save();
    res.status(204).end();
  });
}

module.exports = { init, registerRoutes };

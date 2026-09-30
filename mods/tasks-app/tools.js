// Tasks app: the routes behind its views. The task list itself belongs to the Tasks mod
// (mods/tasks/tools.js), which this app reads and writes through /api/tasks.
//
// A view is one HTML page that draws the tasks — a board, a 3D workspace, anything. Built-in views
// ship in this mod's views/ directory. A custom view is a file in the state dir, and a custom view
// with a built-in's name replaces it, so an agent can rework the board without editing the mod.
// Deleting the custom file brings the built-in back.

const fs = require('fs');
const path = require('path');
const { stateDir } = require('../../paths');

const BUILTIN_VIEWS = path.join(__dirname, 'views');
const VIEW_API_DOC = path.join(BUILTIN_VIEWS, 'README.md');
const USER_VIEWS = path.join(stateDir(), 'tasks-app', 'views');
const VIEW_STATE = path.join(stateDir(), 'tasks-app', 'state');

let ctx = null;

/** A view name is a file stem: lowercase, digits and dashes. Anything else is refused. */
function viewName(raw) {
  return typeof raw === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(raw) ? raw : null;
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function stems(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.html')).map(f => f.slice(0, -5)).filter(viewName);
  } catch {
    return [];
  }
}

/** Every view, custom or built-in, with the mtime of the file that would be served. */
function listViews() {
  const builtin = new Set(stems(BUILTIN_VIEWS));
  const custom = new Set(stems(USER_VIEWS));
  const names = [...new Set([...builtin, ...custom])].sort();
  return names.map(name => ({
    name,
    builtin: builtin.has(name),
    custom: custom.has(name),
    mtime: mtime(path.join(custom.has(name) ? USER_VIEWS : BUILTIN_VIEWS, name + '.html')),
  }));
}

/** The file that is served for a view: the custom one if it exists. */
function viewFile(name) {
  const custom = path.join(USER_VIEWS, name + '.html');
  if (fs.existsSync(custom)) return custom;
  const builtin = path.join(BUILTIN_VIEWS, name + '.html');
  return fs.existsSync(builtin) ? builtin : null;
}

/** A windowId only if that window is connected now — otherwise the open would reach nobody. */
function connectedWindow(windowId) {
  if (!windowId || !ctx || !ctx.reloadClients) return null;
  for (const client of ctx.reloadClients) {
    if (client.readyState === 1 && client.windowId === windowId) return windowId;
  }
  return null;
}

function editPrompt({ name, file, request, isNew }) {
  return [
    isNew
      ? `Create a new view for Deep Steve's Tasks app. It is the single file ${file}, which does not exist yet.`
      : `Edit a view in Deep Steve's Tasks app. The view is the single file ${file}.`,
    `Read ${VIEW_API_DOC} first. It describes the taskApp API the view gets from the app and the rules a view follows.`,
    'The app reloads the view every time the file is saved, so the user watches each save land. Save early and often.',
    request
      ? `What the user wants:\n\n${request}`
      : `Ask the user what they want the "${name}" view to do before you change anything.`,
  ].join('\n\n');
}

function registerRoutes(app, context) {
  ctx = context;

  app.get('/api/tasks-app/views', (req, res) => {
    res.json({ views: listViews(), dir: USER_VIEWS });
  });

  app.get('/api/tasks-app/views/:name', (req, res) => {
    const name = viewName(req.params.name);
    const file = name && viewFile(name);
    if (!file) return res.status(404).type('text').send('No such view');
    res.set('Cache-Control', 'no-store');
    res.type('html').sendFile(file);
  });

  // Delete a custom view. A built-in is never deleted: when a custom file shadowed one, this is
  // how the built-in comes back.
  app.delete('/api/tasks-app/views/:name', (req, res) => {
    const name = viewName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Bad view name' });
    const custom = path.join(USER_VIEWS, name + '.html');
    if (!fs.existsSync(custom)) return res.status(404).json({ error: 'No custom view by that name' });
    fs.unlinkSync(custom);
    ctx.log(`[tasks-app] deleted custom view ${name}`);
    res.json({ deleted: name, builtin: fs.existsSync(path.join(BUILTIN_VIEWS, name + '.html')) });
  });

  // What a view remembers about its own layout: column order, 3D positions. Opaque JSON, per view,
  // kept on the server so every window lays the tasks out the same way.
  app.get('/api/tasks-app/views/:name/state', (req, res) => {
    const name = viewName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Bad view name' });
    try {
      res.json({ state: JSON.parse(fs.readFileSync(path.join(VIEW_STATE, name + '.json'), 'utf8')) });
    } catch {
      res.json({ state: null });
    }
  });

  app.put('/api/tasks-app/views/:name/state', (req, res) => {
    const name = viewName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Bad view name' });
    const state = req.body && req.body.state;
    if (state === undefined) return res.status(400).json({ error: 'Send { state }' });
    fs.mkdirSync(VIEW_STATE, { recursive: true });
    const file = path.join(VIEW_STATE, name + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(state));
    fs.renameSync(file + '.tmp', file);
    res.json({ saved: name });
  });

  // Start an agent on a view. Its cwd is the custom-views directory. A built-in is copied there
  // first, so the agent edits a copy and the shipped file stays as it was.
  app.post('/api/tasks-app/views/:name/edit', (req, res) => {
    const name = viewName(req.params.name);
    if (!name) return res.status(400).json({ error: 'bad-name', message: 'A view name is lowercase letters, digits and dashes.' });
    if (typeof ctx.spawnAgentSession !== 'function') {
      return res.status(501).json({ error: 'This daemon cannot start sessions for the Tasks app' });
    }
    const request = req.body && typeof req.body.request === 'string' ? req.body.request.trim() : '';
    fs.mkdirSync(USER_VIEWS, { recursive: true });
    const file = path.join(USER_VIEWS, name + '.html');
    const builtin = path.join(BUILTIN_VIEWS, name + '.html');
    let started = 'custom';
    if (!fs.existsSync(file)) {
      if (fs.existsSync(builtin)) {
        fs.copyFileSync(builtin, file);
        started = 'copied';
      } else {
        started = 'new';
      }
    }
    const result = ctx.spawnAgentSession({
      cwd: USER_VIEWS,
      agentType: (ctx.settings && ctx.settings.defaultAgent) || 'claude',
      name: `view: ${name}`,
      prompt: editPrompt({ name, file, request, isNew: started === 'new' }),
      windowId: connectedWindow(req.body && req.body.windowId),
      source: `tasks-app view ${name}`,
    });
    if (!result || result.error) {
      const err = result && result.error;
      return res.status(409).json({ error: (err && err.code) || 'spawn-failed', message: (err && err.message) || 'The session did not start' });
    }
    ctx.log(`[tasks-app] view ${name} (${started}) -> editor ${result.id}`);
    res.json({ id: result.id, file, started });
  });
}

module.exports = { registerRoutes, viewName, editPrompt };

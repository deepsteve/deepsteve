/**
 * Project Mods (#618) — per-project, entirely-local mods.
 *
 * A DeepSteve Mod (mods/*) is global to the install: every tools.js loads for every
 * session and enable/disable is a per-browser toggle. A PROJECT MOD is the opposite —
 * one page, registered by an agent to ONE project (a git repo root), visible only when
 * that project is the one you're looking at, and never in a shared store.
 *
 * This file owns the registry and the page bytes. The three registration surfaces are
 * host chrome (the projects rail, the tab strip, a pinned tab), so they live in core
 * client code — public/js/project-mods.js — not in a mod iframe.
 *
 * Disk layout (deliberately outside the repo, so "not shared" is a guarantee rather
 * than a gitignore convention):
 *
 *   ~/.deepsteve/project-mods.json        the registry
 *   ~/.deepsteve/project-mods/<id>.html   one page per mod
 *
 * Pages are NOT subject to the 7-day stale sweep server.js applies to display-tabs/ —
 * a project mod is durable by definition. The only removals are an explicit delete and
 * the orphan sweep at load (a page with no registry row).
 *
 * Trust: the page is served same-origin from /api/project-mods/:id/page and its iframe
 * carries allow-same-origin (the window.deepsteve bridge is injected cross-frame, which
 * requires it). So a project mod has exactly the authority an agent-authored display tab
 * already has. That is a continuation of the existing model, not a new hole — but it is
 * why `projectModsEnabled` exists as a server-authoritative kill switch.
 */

const { z } = require('zod');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveHtml } = require('../../html-source.js');
const { findGitRoot } = require('../../git-root.js');

const REGISTRY_FILE = path.join(os.homedir(), '.deepsteve', 'project-mods.json');
const PAGES_DIR = path.join(os.homedir(), '.deepsteve', 'project-mods');

// The three registration surfaces from #618, in rail → strip → tab order.
const SURFACES = ['rail', 'button', 'tab'];
const DEFAULT_SURFACES = ['rail'];

const MAX_NAME_LEN = 60;
const MAX_ICON_LEN = 8;   // one emoji can be several code points (ZWJ sequences, skin tones)

const FEATURE_OFF_MSG =
  'Project mods are turned off. Ask the user to enable "Project mods" in Settings ' +
  '(the projectModsEnabled setting) before registering or editing one.';

// --- Persistent state (load on start, write-through on mutate) ---------------
// Loaded at require() time, which is why every unit test points HOME at a scratch
// dir BEFORE requiring this file.

let mods = [];
let ctx = null;   // set by init(); registerRoutes may run first, so both assign it

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`failed to write ${path.basename(file)}: ${e.message}`);
  }
}

function log(msg) {
  if (ctx && ctx.log) ctx.log(`[project-mods] ${msg}`);
}

function pagePath(id) {
  return path.join(PAGES_DIR, `${id}.html`);
}

/** Normalize one persisted row, dropping anything we can't make sense of. */
function normalize(m) {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(m.id)) return null;
  if (typeof m.project !== 'string' || !m.project) return null;
  const surfaces = cleanSurfaces(m.surfaces);
  return {
    id: m.id,
    project: m.project,
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, MAX_NAME_LEN) : 'Project mod',
    icon: cleanIcon(m.icon),
    surfaces,
    enabled: m.enabled !== false,
    createdAt: Number(m.createdAt) || 0,
    updatedAt: Number(m.updatedAt) || 0,
  };
}

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
      mods = (Array.isArray(raw) ? raw : []).map(normalize).filter(Boolean);
      return;
    }
  } catch (e) {
    // Corrupt registry: start empty rather than crashing the daemon at require time.
    // The pages stay on disk, so nothing is destroyed until something writes.
  }
  mods = [];
}
loadRegistry();

function saveRegistry() { writeJson(REGISTRY_FILE, mods); }

// Payload-less ping; the client refetches /api/project-mods (the scheduled-tasks
// idiom). reloadClients matters as much as wss here — a window sitting on the empty
// state has no session socket, and that is exactly when a project mod is registered.
function broadcastMods() {
  if (!ctx) return;
  const msg = { type: 'project-mods' };
  try { ctx.broadcast(msg); } catch {}
  const data = JSON.stringify(msg);
  for (const client of ctx.reloadClients || []) {
    if (client.readyState === 1) client.send(data);
  }
}

// --- Validation --------------------------------------------------------------

function cleanSurfaces(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_SURFACES];
  const picked = SURFACES.filter(s => raw.includes(s));
  return picked.length ? picked : [...DEFAULT_SURFACES];
}

// Control characters are stripped from both name and icon before anything is stored:
// these strings end up as textContent in the rail and as a button aria-label, and a
// stray carriage return or NUL there is only ever a rendering bug.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// An icon is display-only, so the bar is "cannot break the rail", not "is an emoji".
// Sliced by code POINT (spread, not .slice) so a multi-code-unit emoji survives whole.
// Empty means "derive one from the name" — tabIcon() on the client, the same derivation
// tabs and mod toolbar buttons already use.
function cleanIcon(raw) {
  if (typeof raw !== 'string') return '';
  return [...raw.replace(CONTROL_CHARS, '').trim()].slice(0, MAX_ICON_LEN).join('');
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_CHARS, '').trim().slice(0, MAX_NAME_LEN);
}

/**
 * The project a mod belongs to. An explicit path wins (canonicalized to its git repo
 * root); otherwise inherit the calling session's repo root. Mirrors resolveProject()
 * in mods/scheduled-tasks/tools.js — the two features answer "which project is this"
 * the same way on purpose.
 *
 * Returns '' when neither yields a directory. Unlike a scheduled task (which can run
 * in the homedir), a project mod with no project is meaningless, so callers reject.
 */
function resolveProject(rawProject, shellId) {
  if (rawProject && String(rawProject).trim()) {
    let p = String(rawProject).trim();
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) return '';
    return findGitRoot(p) || (fs.existsSync(p) ? p : '');
  }
  if (shellId && ctx && ctx.shells.has(shellId)) {
    const { repoRoot } = ctx.sessionPaths(ctx.shells.get(shellId));
    if (repoRoot) return repoRoot;
  }
  return '';
}

function genId() {
  for (;;) {
    const id = randomUUID().slice(0, 8);
    if (!mods.some(m => m.id === id)) return id;
  }
}

const findMod = (id) => mods.find(m => m.id === id) || null;

// --- Page bytes --------------------------------------------------------------

function writePage(id, html) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const tmp = pagePath(id) + '.tmp';
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, pagePath(id));
}

function readPage(id) {
  try { return fs.readFileSync(pagePath(id), 'utf8'); } catch { return null; }
}

function removePage(id) {
  try { fs.unlinkSync(pagePath(id)); } catch {}
}

// --- Feature gate ------------------------------------------------------------

const featureEnabled = () => !!(ctx && ctx.settings && ctx.settings.projectModsEnabled);
const featureOffResult = () => ({ content: [{ type: 'text', text: FEATURE_OFF_MSG }], isError: true });

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

const callerShellId = (extra) => extra?.requestInfo?.url?.searchParams?.get('shellId') || null;

// The wire shape the client sees. Kept separate from the persisted row so a future
// server-internal field doesn't leak into the browser by accident.
const serialize = (m) => ({
  id: m.id, project: m.project, name: m.name, icon: m.icon,
  surfaces: m.surfaces, enabled: m.enabled,
  createdAt: m.createdAt, updatedAt: m.updatedAt,
});

// --- MCP tools ---------------------------------------------------------------

function init(context) {
  if (context) ctx = context;

  // One-time orphan sweep: pages whose registry row is gone (a delete that failed
  // mid-way, or a hand-edited registry). Cheap, and keeps the dir honest.
  try {
    if (fs.existsSync(PAGES_DIR)) {
      const known = new Set(mods.map(m => m.id));
      for (const f of fs.readdirSync(PAGES_DIR)) {
        if (f.endsWith('.html') && !known.has(f.slice(0, -5))) {
          try { fs.unlinkSync(path.join(PAGES_DIR, f)); } catch {}
        }
      }
    }
  } catch {}

  const tools = {
    create_project_mod: {
      description:
        'Register a PROJECT MOD: a page that belongs to ONE project (this repo) and nowhere else. ' +
        'Unlike a display tab — a one-shot snapshot that disappears with the session — a project mod is durable: ' +
        'it stays registered to the project and is reachable every session from the projects rail, a square button ' +
        'in the tab strip, or a pinned tab that opens in the background and keeps running. Use it for a dashboard or ' +
        'live tooling the project should carry with it. It is entirely local — never uploaded, never shared, never ' +
        'visible in another project. Supply the page EITHER inline via html OR — cheaper, preferred when the page ' +
        'already exists on disk — via file_path, which the server reads itself. The page is served from the deepsteve ' +
        'origin, so use relative /api/... URLs to call back into deepsteve (never a hard-coded port), and window.deepsteve ' +
        'is injected into it (getSessions, focusSession, createSession, onActiveContextChanged, …) so it can drive the UI.',
      schema: {
        name: z.string().describe('Display name, e.g. "Build Dashboard"'),
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — the project is inferred from your session\'s repo root. Omit only if you pass project'),
        html: z.string().optional().describe('Full HTML content of the page. Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads instead of you passing html. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied server-side, e.g. {"%%REPO%%": "deepsteve"} — lets a file on disk stay a reusable template'),
        icon: z.string().optional().describe('An emoji shown in the rail and on the tab-strip button. Defaults to a monogram derived from the name'),
        surfaces: z.array(z.enum(['rail', 'button', 'tab'])).optional().describe('Where the mod registers: "rail" = an entry under the project in the projects rail (default), "button" = a square button at the top/left of the tab strip, "tab" = a pinned tab that auto-opens in the background whenever this project is active'),
        project: z.string().optional().describe('Absolute path to the project, canonicalized to its git repo root. Defaults to the calling session\'s repo root'),
      },
      handler: async ({ name, session_id, html, file_path, replacements, icon, surfaces, project }, extra) => {
        const cleanedName = cleanName(name);
        if (!cleanedName) return err('name is required.');

        const shellId = session_id || callerShellId(extra);
        const proj = resolveProject(project, shellId);
        if (!proj) {
          return err(
            'Could not determine which project this mod belongs to. Pass your DEEPSTEVE_SESSION_ID as session_id, ' +
            'or an absolute path as project. (A project mod is scoped to one repo by definition — there is no global form; ' +
            'for a one-off page use create_display_tab instead.)'
          );
        }

        const resolved = resolveHtml({ html, file_path, replacements });
        if (resolved.error) return err(resolved.error);

        const now = Date.now();
        const mod = {
          id: genId(),
          project: proj,
          name: cleanedName,
          icon: cleanIcon(icon),
          surfaces: cleanSurfaces(surfaces),
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };

        try {
          writePage(mod.id, resolved.html);
        } catch (e) {
          return err(`Failed to write the project mod page: ${e.message}`);
        }
        mods.push(mod);
        saveRegistry();
        log(`created ${mod.id} "${mod.name}" for ${proj} [${mod.surfaces.join(',')}]`);
        broadcastMods();

        return ok({ id: mod.id, name: mod.name, project: mod.project, surfaces: mod.surfaces });
      },
    },

    update_project_mod: {
      description:
        'Update a project mod: replace its page (html or file_path) and/or its metadata (name, icon, surfaces, enabled). ' +
        'Every field is optional — pass only what changes. Open tabs showing this mod reload.',
      schema: {
        mod_id: z.string().describe('The project mod id returned by create_project_mod'),
        html: z.string().optional().describe('New page content. Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied server-side'),
        name: z.string().optional().describe('New display name'),
        icon: z.string().optional().describe('New emoji icon; pass "" to clear it back to a derived monogram'),
        surfaces: z.array(z.enum(['rail', 'button', 'tab'])).optional().describe('New registration surfaces'),
        enabled: z.boolean().optional().describe('false hides the mod from every surface without deleting it'),
      },
      handler: async ({ mod_id, html, file_path, replacements, name, icon, surfaces, enabled }) => {
        const mod = findMod(mod_id);
        if (!mod) return err(`Project mod "${mod_id}" not found.`);

        const wantsPage = typeof html === 'string' || (typeof file_path === 'string' && file_path.trim() !== '');
        if (wantsPage) {
          const resolved = resolveHtml({ html, file_path, replacements });
          if (resolved.error) return err(resolved.error);
          try {
            writePage(mod.id, resolved.html);
          } catch (e) {
            return err(`Failed to write the project mod page: ${e.message}`);
          }
        }

        if (name !== undefined) {
          const cleaned = cleanName(name);
          if (!cleaned) return err('name must not be empty.');
          mod.name = cleaned;
        }
        if (icon !== undefined) mod.icon = cleanIcon(icon);
        if (surfaces !== undefined) mod.surfaces = cleanSurfaces(surfaces);
        if (enabled !== undefined) mod.enabled = !!enabled;

        mod.updatedAt = Date.now();
        saveRegistry();
        log(`updated ${mod.id}${wantsPage ? ' (page)' : ''}`);
        broadcastMods();

        return ok({ id: mod.id, updated: true, pageReplaced: wantsPage });
      },
    },

    edit_project_mod: {
      description:
        'Edit a project mod\'s page by replacing an exact substring (like the Edit tool). Faster than update_project_mod ' +
        'for small changes — no need to resend the whole document. Errors if old_string is not found, or matches more than ' +
        'once unless replace_all is set.',
      schema: {
        mod_id: z.string().describe('The project mod id'),
        old_string: z.string().describe('Exact substring to find in the current page'),
        new_string: z.string().describe('Replacement string'),
        replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
      },
      handler: async ({ mod_id, old_string, new_string, replace_all }) => {
        const mod = findMod(mod_id);
        if (!mod) return err(`Project mod "${mod_id}" not found.`);
        if (old_string === '') return err('old_string must not be empty.');
        if (old_string === new_string) return err('old_string and new_string are identical — no change.');

        const html = readPage(mod.id);
        if (html === null) return err(`Project mod "${mod_id}" has no page on disk. Use update_project_mod to rewrite it.`);

        // split-count doubles as the uniqueness check and the reported replacement count.
        const count = html.split(old_string).length - 1;
        if (count === 0) return err(`old_string not found in project mod "${mod_id}".`);
        if (count > 1 && !replace_all) {
          return err(`old_string is not unique (${count} matches). Set replace_all:true or provide a longer, unique string.`);
        }

        // split/join (not String.replace) so $-sequences in new_string stay literal.
        try {
          writePage(mod.id, html.split(old_string).join(new_string));
        } catch (e) {
          return err(`Failed to write the project mod page: ${e.message}`);
        }
        mod.updatedAt = Date.now();
        saveRegistry();
        log(`edited ${mod.id}, replacements=${count}`);
        broadcastMods();

        return ok({ id: mod.id, replacements: count });
      },
    },

    list_project_mods: {
      description:
        'List project mods. Defaults to the ones registered to YOUR project; scope:"all" lists every project\'s. ' +
        'Read-only, and never gated by the projectModsEnabled setting.',
      schema: {
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — scopes the listing to your project'),
        scope: z.enum(['project', 'all']).optional().describe('"project" (default) = this project only; "all" = every project'),
        project: z.string().optional().describe('Absolute path to list a specific project instead of your own'),
      },
      handler: async ({ session_id, scope, project }, extra) => {
        if (scope === 'all') {
          return ok({ scope: 'all', mods: mods.map(serialize) });
        }
        const shellId = session_id || callerShellId(extra);
        const proj = resolveProject(project, shellId);
        if (!proj) {
          return ok({
            scope: 'project', project: null, mods: [],
            note: 'No project could be determined for this session — pass session_id or project, or use scope:"all".',
          });
        }
        return ok({ scope: 'project', project: proj, mods: mods.filter(m => m.project === proj).map(serialize) });
      },
    },

    delete_project_mod: {
      description: 'Delete a project mod permanently, page and all. Any open tab showing it closes.',
      schema: { mod_id: z.string().describe('The project mod id') },
      handler: async ({ mod_id }) => {
        const i = mods.findIndex(m => m.id === mod_id);
        if (i === -1) return err(`Project mod "${mod_id}" not found.`);
        const [mod] = mods.splice(i, 1);
        removePage(mod.id);
        saveRegistry();
        log(`deleted ${mod.id} "${mod.name}"`);
        broadcastMods();
        return ok({ id: mod.id, deleted: true });
      },
    },
  };

  // Fail-closed on every WRITE surface, the scheduled-tasks pattern: an agent that
  // registers into a disabled feature learns why instead of getting a cheerful ack
  // for a mod that will never appear. list_project_mods stays open (a read), and so
  // do the GET routes — turning the feature off must not make existing mods
  // un-inspectable.
  for (const name of ['create_project_mod', 'update_project_mod', 'edit_project_mod', 'delete_project_mod']) {
    const inner = tools[name].handler;
    tools[name].handler = (args, extra) => (featureEnabled() ? inner(args, extra) : featureOffResult());
  }

  return tools;
}

// --- REST --------------------------------------------------------------------

function registerRoutes(app, context) {
  ctx = ctx || context;

  // The whole list; the client filters by the active project (the payload is a few
  // rows of metadata, and it needs all of them to answer "does THIS project have any").
  app.get('/api/project-mods', (req, res) => {
    res.json({ mods: mods.map(serialize), enabled: featureEnabled() });
  });

  // The page itself. Serving only ids present in the registry is what keeps a crafted
  // :id from reaching outside PAGES_DIR — the id is never concatenated into a path
  // before it has matched a row.
  app.get('/api/project-mods/:id/page', (req, res) => {
    const mod = findMod(req.params.id);
    if (!mod) return res.status(404).send('Not found');
    const html = readPage(mod.id);
    if (html === null) return res.status(404).send('Not found');
    if (req.method === 'HEAD') return res.type('html').end();
    res.type('html').send(html);
  });

  // Metadata edits from the UI (rename, icon, surfaces, enable/disable). The page
  // bytes are agent-authored and stay that way — there is no REST page write.
  app.put('/api/project-mods/:id', (req, res) => {
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
    const mod = findMod(req.params.id);
    if (!mod) return res.status(404).json({ error: 'Project mod not found' });

    const { name, icon, surfaces, enabled } = req.body || {};
    if (name !== undefined) {
      const cleaned = cleanName(name);
      if (!cleaned) return res.status(400).json({ error: 'name must not be empty' });
      mod.name = cleaned;
    }
    if (icon !== undefined) mod.icon = cleanIcon(icon);
    if (surfaces !== undefined) mod.surfaces = cleanSurfaces(surfaces);
    if (enabled !== undefined) mod.enabled = !!enabled;

    mod.updatedAt = Date.now();
    saveRegistry();
    broadcastMods();
    res.json({ mod: serialize(mod) });
  });

  app.delete('/api/project-mods/:id', (req, res) => {
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
    const i = mods.findIndex(m => m.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Project mod not found' });
    const [mod] = mods.splice(i, 1);
    removePage(mod.id);
    saveRegistry();
    log(`deleted ${mod.id} "${mod.name}" (REST)`);
    broadcastMods();
    res.json({ deleted: true, id: mod.id });
  });
}

// The mod loader only uses init/registerRoutes; the extra named exports are for unit tests.
module.exports = {
  init, registerRoutes,
  resolveProject, cleanSurfaces, cleanIcon, cleanName,
  SURFACES, DEFAULT_SURFACES, FEATURE_OFF_MSG, REGISTRY_FILE, PAGES_DIR,
};

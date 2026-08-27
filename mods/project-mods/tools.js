/**
 * Project Mods (#618, #628, #638) — per-project mods that live IN the project.
 *
 * A DeepSteve Mod (mods/*) is global to the install: every tools.js loads for every
 * session and enable/disable is a per-browser toggle. A PROJECT MOD is the opposite —
 * a page registered to ONE project (a git repo root), visible only when that project is
 * the one you're looking at.
 *
 * This file owns discovery and the page bytes. The three registration surfaces are host
 * chrome (the projects rail, the tab strip, a pinned tab), so they live in core client
 * code — public/js/project-mods.js — not in a mod iframe.
 *
 * Two axes, deliberately separate (#628): `surfaces` says WHERE the launchers go, `openMode`
 * says what a launcher DOES — open a real tab, or take over the content area as a view that
 * consumes no tab at all. Conflating them is what the original three-surface design got
 * wrong: a mod could ask for a button launcher and still be handed a tab it never wanted.
 *
 * Disk layout — inside the repo, one directory per mod (#638):
 *
 *   <repoRoot>/.deepsteve/mods/<dirname>/mod.json     the manifest
 *   <repoRoot>/.deepsteve/mods/<dirname>/index.html   the entry page (override with "entry")
 *   <repoRoot>/.deepsteve/mods/<dirname>/*            anything else the page loads
 *
 * This reversed #618, which kept the registry and the pages in ~/.deepsteve so that "not
 * shared" was a guarantee rather than a gitignore convention. That was the wrong trade: a
 * thing that belongs to the project was not in source control, not reviewable, and could not
 * travel to another checkout. `.deepsteve/` is therefore never gitignored — a guard test
 * (test/unit/project-mods-repo-storage.test.js) keeps it that way.
 *
 * `scope: "project"` in mod.json is what marks a directory as OURS. A repo may perfectly
 * well ship a regular DeepSteve Mod under .deepsteve/mods/; without the marker we skip it
 * rather than adopting it.
 *
 * There is no registry file and no id on disk. The id a mod is addressed by is DERIVED from
 * its repo root and its directory name, which is what makes it stable across restarts (the
 * browser persists it in a pinned tab's session entry) while two checkouts of the same repo
 * still get distinct ids. `updatedAt` is derived too — the newest mtime in the mod dir — so
 * a page edited directly with the Edit tool, or arriving via `git pull`, reloads an open tab
 * exactly like one written through update_project_mod.
 *
 * Discovery is bounded by the projects you have REGISTERED: the repos named by
 * contexts.json, and nothing else. The daemon never walks the disk looking for mods. So a
 * fresh clone lights up as soon as its project exists, and create_project_mod refuses a repo
 * nobody scans rather than writing a directory that could never appear.
 *
 * Trust: the page is served same-origin from /api/project-mods/:id/page and its iframe
 * carries allow-same-origin (the window.deepsteve bridge is injected cross-frame, which
 * requires it). So a project mod has exactly the authority an agent-authored display tab
 * already has. Being committed makes that BETTER than it was — the page is now reviewable
 * in a diff instead of appearing silently in a home directory — but it is still why
 * `projectModsEnabled` exists as a server-authoritative kill switch.
 */

const { z } = require('zod');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const { projectModsDir } = require('../../paths');
const path = require('path');

const { resolveHtml } = require('../../html-source.js');
const { findGitRoot } = require('../../git-root.js');

// The manifest field that says "this directory is a project mod". Anything else under
// .deepsteve/mods/ — including a regular DeepSteve Mod someone distributes in their repo —
// is left strictly alone.
const PROJECT_SCOPE = 'project';

const MANIFEST_FILE = 'mod.json';
const DEFAULT_ENTRY = 'index.html';

// A mod's directory name is also its human handle, so it is constrained the way a package
// name is: starts alphanumeric (which excludes `.`, `..` and hidden dirs) and holds nothing
// that needs escaping in a path or a URL.
const DIRNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// The three registration surfaces from #618, in rail → strip → tab order.
const SURFACES = ['rail', 'button', 'tab'];
const DEFAULT_SURFACES = ['rail'];

// How a launcher OPENS the mod (#628) — a different axis from `surfaces`, which only says
// WHERE the launchers go.
//
// The default was 'tab' when view mode was new, so that existing mods kept their behaviour
// with no manifest migration. It is 'view' now, because the old default was quietly the
// wrong one for the thing a project mod usually is. An agent that does not think about
// open_mode gets what it did not ask for: a dashboard that takes a tab, forever, every time
// the project is active. That is what actually happened to the Terminal Wall mod, whose
// second commit is titled "rail-only launcher, opened as a view" — the correction, one
// commit after it was created with the default.
//
// A pinned mod is unaffected: the 'tab' surface overrides the stored mode while it is set
// (see effectiveOpenMode), so a manifest carrying `surfaces:['rail','tab']` and no openMode
// still opens exactly as it did. What changes is the rail/button-only mod that never said
// what it wanted — it now glances instead of accumulating a tab.
const OPEN_MODES = ['tab', 'view'];
const DEFAULT_OPEN_MODE = 'view';

const MAX_NAME_LEN = 60;
const MAX_ICON_LEN = 8;   // one emoji can be several code points (ZWJ sequences, skin tones)
const MAX_DIRNAME_LEN = 48;

// How long a scan is reused before the next read re-walks the registered repos. Short
// enough that a `git pull` shows up on the browser's next refresh, long enough that the
// burst of reads one broadcast triggers costs a single walk.
const SCAN_TTL_MS = 2000;

const FEATURE_OFF_MSG =
  'Project mods are turned off. Ask the user to enable "Project mods" in Settings ' +
  '(the projectModsEnabled setting) before registering or editing one.';

const unregisteredProjectMsg = (proj) =>
  `${proj} is not part of any registered project, so a mod written there would never be ` +
  'discovered. Project mods are found by scanning the repos of the projects in the rail. ' +
  'Ask the user to add this repo to a project first (the "+ New project" entry in the ' +
  'projects rail), then register the mod.';

// --- State -------------------------------------------------------------------
// There is no persistent state of our own: `mods` is a cache of what the registered
// repos hold, rebuilt by scan(). ctx is set by init(); registerRoutes may run first,
// so both assign it.

let mods = [];
let lastScan = 0;
let ctx = null;

function log(msg) {
  if (ctx && ctx.log) ctx.log(`[project-mods] ${msg}`);
}

function writeJson(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// --- Discovery ---------------------------------------------------------------

/**
 * The repos we look in: the ones named by REGISTERED projects, and nothing else.
 *
 * Deliberately not "every repo any session has ever been in" and emphatically not a walk of
 * the disk. It mirrors the rule the rail already applies — railModsFor() only ever shows a
 * mod whose project is inside a registered project's dirs — so a mod we can find is exactly
 * a mod that could be displayed.
 *
 * A dir is normalized to its git root so a project registered as a subdirectory still finds
 * the repo's mods; a non-repo dir is kept as-is, which is the same fallback resolveProject()
 * applies to an explicit path.
 */
function scanRoots() {
  const roots = new Set();
  const contexts = (ctx && typeof ctx.getContexts === 'function') ? ctx.getContexts() : null;
  for (const c of (Array.isArray(contexts) ? contexts : [])) {
    for (const d of (Array.isArray(c && c.dirs) ? c.dirs : [])) {
      if (!d) continue;
      const root = canonicalRoot(d);
      if (root) roots.add(root);
    }
  }
  return roots;
}

/**
 * A mod's id — derived from where it lives, never written to disk.
 *
 * Stable across restarts, which it has to be: the browser persists `projectModId` in a
 * pinned tab's session entry, and a minted id would strand every one of those on every
 * daemon start. Keyed on the repo root as well as the directory name so two checkouts of the
 * same repo (a second clone, an unmapped worktree) can't collide on one URL. Kept to the
 * 8-hex shape ids already had, so nothing downstream needs widening.
 */
function modId(root, dirname) {
  return createHash('sha1').update(`${root}\0${dirname}`).digest('hex').slice(0, 8);
}

/**
 * The mod's `updatedAt`: the newest mtime among the files in its directory.
 *
 * Derived rather than stored so that syncOpenTabs()'s existing "updatedAt changed → reload
 * the iframe" rule covers every way the bytes can change now that they are repo files —
 * update_project_mod, an agent's Edit tool, a branch switch, a git pull. Top level only;
 * a mod that hides assets in a subdirectory needs a manual refresh, which is a fair price
 * for one readdir per mod.
 */
function dirMtime(dir) {
  let newest = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      try { newest = Math.max(newest, fs.statSync(path.join(dir, e.name)).mtimeMs); } catch {}
    }
  } catch {}
  return Math.round(newest);
}

/** Read and normalize one candidate directory, or null if it isn't a project mod of ours. */
function readMod(root, dirname) {
  if (!DIRNAME_RE.test(dirname)) return null;
  const dir = path.join(projectModsDir(root), dirname);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    return null;   // no manifest, or unreadable/corrupt — not ours to guess about
  }
  return normalize(raw, root, dirname);
}

/**
 * Rebuild `mods` from the registered repos. Cheap — one readdir per repo plus one per mod
 * directory — and total, so a deleted or renamed directory disappears without bookkeeping.
 *
 * Does nothing before init() has handed us a context: with no way to ask which projects are
 * registered, an empty scan is not a fact, and caching it would hide the first real one.
 */
function scan() {
  if (!ctx) return;
  const out = [];
  for (const root of scanRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(projectModsDir(root), { withFileTypes: true });
    } catch {
      continue;   // no .deepsteve/mods in this repo, which is the common case
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const mod = readMod(root, e.name);
      if (mod) out.push(mod);
    }
  }
  mods = out;
  lastScan = Date.now();
}

/** Scan if the cache has aged out; `force` after any write, so a caller never reads stale. */
function ensureScanned(force = false) {
  if (force || Date.now() - lastScan > SCAN_TTL_MS) scan();
}

// --- Validation --------------------------------------------------------------

function cleanSurfaces(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_SURFACES];
  const picked = SURFACES.filter(s => raw.includes(s));
  return picked.length ? picked : [...DEFAULT_SURFACES];
}

function cleanOpenMode(raw) {
  return OPEN_MODES.includes(raw) ? raw : DEFAULT_OPEN_MODE;
}

/**
 * The one cross-field rule (#628, reshaped by #645): openMode 'view' and the 'tab' surface
 * cannot both be in force. A view takes over the content area and consumes no tab, so it
 * cannot also be a pinned background tab — that combination is the very duplicate the view
 * mode exists to remove.
 *
 * The pin is an OVERRIDE, not a rewrite. Adding the 'tab' surface to a view-mode mod leaves
 * the stored openMode alone and simply wins for as long as the pin is set — see
 * effectiveOpenMode(), which is what every reader gets. That is what makes the right-click
 * checklist reversible: un-ticking the pin restores the view the mod was in, instead of
 * stranding it as a tab with nothing to flip it back (#645).
 *
 * Only a deliberate openMode write still resolves the pair destructively, and in that
 * direction it must: "Open as a full view" would look like it did nothing if the pin kept
 * overriding it, so setting 'view' drops the pin. `explicit` names the field the caller
 * actually passed; with both passed (or neither — create and load) openMode wins, since it
 * is the more specific statement.
 */
function cleanPlacement(rawSurfaces, rawOpenMode, explicit = null) {
  let surfaces = cleanSurfaces(rawSurfaces);
  const openMode = cleanOpenMode(rawOpenMode);
  if (openMode === 'view' && surfaces.includes('tab') && explicit !== 'surfaces') {
    surfaces = surfaces.filter(s => s !== 'tab');
    if (!surfaces.length) surfaces = [...DEFAULT_SURFACES];
  }
  return { surfaces, openMode };
}

/**
 * How a mod actually opens right now: the pin wins over view mode while it is set, and only
 * while (#645). The stored openMode is the user's standing choice; this is the effective
 * one, and it is what serialize() puts on the wire so no client has to know the rule.
 */
const effectiveOpenMode = (m) => (m.openMode === 'view' && m.surfaces.includes('tab') ? 'tab' : m.openMode);

/**
 * Apply a partial placement edit to a stored row. Shared by update_project_mod and the REST
 * PUT so the "which field did the caller mean" rule is written once. A no-op when neither
 * field was passed, so an unrelated rename can't disturb the placement.
 */
function applyPlacement(mod, rawSurfaces, rawOpenMode) {
  if (rawSurfaces === undefined && rawOpenMode === undefined) return;
  const next = cleanPlacement(
    rawSurfaces !== undefined ? rawSurfaces : mod.surfaces,
    rawOpenMode !== undefined ? rawOpenMode : mod.openMode,
    rawOpenMode !== undefined ? 'openMode' : 'surfaces',
  );
  mod.surfaces = next.surfaces;
  mod.openMode = next.openMode;
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
 * The manifest's `entry` — a path relative to the mod directory, defaulting to index.html.
 *
 * Backslashes are normalized before the check rather than after, so a Windows-style
 * `..\\..\\etc` can't smuggle a traversal past a `/`-oriented test. Containment is still
 * re-verified at read time by resolveInMod(); this is the cheap first filter.
 */
function cleanEntry(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_ENTRY;
  const rel = raw.replace(CONTROL_CHARS, '').trim().replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel)) return DEFAULT_ENTRY;
  if (rel.split('/').some(seg => seg === '..')) return DEFAULT_ENTRY;
  return rel;
}

/**
 * Normalize one manifest into the in-memory row, dropping anything we can't make sense of.
 *
 * The `scope` check is the gate that makes .deepsteve/mods/ a shared namespace: a directory
 * that doesn't declare itself a project mod is somebody else's, and we neither show it nor
 * touch it.
 */
function normalize(m, root, dirname) {
  if (!m || typeof m !== 'object') return null;
  if (m.scope !== PROJECT_SCOPE) return null;
  if (!root || !dirname || !DIRNAME_RE.test(dirname)) return null;
  // Each field on its own, NOT through cleanPlacement: a pinned view is a legal thing to
  // find on disk since #645 (the pin overrides the stored mode rather than overwriting it),
  // and resolving the pair here would undo that on the very next scan. That separation is
  // also what makes the 'view' default safe to apply to old manifests: one with no openMode
  // at all now cleans to 'view', but if it also carries the 'tab' surface the pin still
  // wins, so it opens the way it always did.
  const surfaces = cleanSurfaces(m.surfaces);
  const openMode = cleanOpenMode(m.openMode);
  const dir = path.join(projectModsDir(root), dirname);
  return {
    id: modId(root, dirname),
    // Server-only fields — kept off the wire by serialize(), which is why that exists.
    root,
    dirname,
    dir,
    entry: cleanEntry(m.entry),
    project: root,
    name: cleanName(m.name) || dirname,
    icon: cleanIcon(m.icon),
    surfaces,
    openMode,
    enabled: m.enabled !== false,
    createdAt: Number(m.createdAt) || 0,
    updatedAt: dirMtime(dir),
  };
}

// --- Paths inside a mod ------------------------------------------------------

/**
 * Resolve a path relative to a mod's directory, or null if it escapes.
 *
 * The escape check is the whole security story for the asset route, and it is a resolved
 * prefix test rather than a string inspection of the request: `..%2f`, a symlink-free
 * `a/../../b`, and an absolute path all collapse to something outside `dir` before this
 * compares them. Same shape as server.js's containment check for mod uninstall.
 */
function resolveInMod(mod, rel) {
  const base = path.resolve(mod.dir);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

const entryPath = (mod) => resolveInMod(mod, mod.entry);

/** The manifest fields, in the order they read best in a diff — these ARE repo files now. */
function manifestOf(mod) {
  return {
    scope: PROJECT_SCOPE,
    name: mod.name,
    icon: mod.icon,
    surfaces: mod.surfaces,
    openMode: mod.openMode,
    enabled: mod.enabled,
    entry: mod.entry,
    createdAt: mod.createdAt,
  };
}

function writeManifest(mod) {
  writeJson(path.join(mod.dir, MANIFEST_FILE), manifestOf(mod));
}

function writePage(mod, html) {
  const target = entryPath(mod);
  if (!target) throw new Error(`entry "${mod.entry}" escapes the mod directory`);
  writeFileAtomic(target, html);
}

function readPage(mod) {
  const target = entryPath(mod);
  if (!target) return null;
  try { return fs.readFileSync(target, 'utf8'); } catch { return null; }
}

/**
 * Remove a mod's directory, then any now-empty `.deepsteve/mods` and `.deepsteve` above it.
 *
 * This deletes inside the user's repo, so it re-derives the directory from the repo root and
 * the dirname and refuses anything that isn't underneath — the row it came from is our own,
 * but a delete path is the wrong place to take that on faith. The parent prune uses rmdir,
 * whose failure on a non-empty directory is exactly the guard we want: a repo that keeps
 * other things in .deepsteve/ keeps them.
 */
function removeMod(mod) {
  const base = path.resolve(projectModsDir(mod.root));
  const dir = path.resolve(base, mod.dirname);
  if (!dir.startsWith(base + path.sep)) throw new Error('refusing to delete outside the mods directory');
  fs.rmSync(dir, { recursive: true, force: true });
  try { fs.rmdirSync(base); } catch {}
  try { fs.rmdirSync(path.dirname(base)); } catch {}
}

// --- Project resolution ------------------------------------------------------

/**
 * The project a mod belongs to. An explicit path wins (canonicalized to its git repo
 * root); otherwise inherit the calling session's repo root. Mirrors resolveProject()
 * in mods/scheduled-tasks/tools.js — the two features answer "which project is this"
 * the same way on purpose.
 *
 * Returns '' when neither yields a directory. Unlike a scheduled task (which can run
 * in the homedir), a project mod with no project is meaningless, so callers reject.
 *
 * BOTH branches go through findGitRoot, and that matters now that a resolved project is
 * checked for membership in scanRoots() rather than merely recorded: findGitRoot realpaths,
 * so a session whose repoRoot is reached through a symlink (`/var/...` → `/private/var/...`
 * on macOS) would otherwise never match the same repo registered as a project, and every
 * create would be refused. Canonicalizing on both sides is what makes the comparison mean
 * "the same directory" instead of "the same string".
 */
function canonicalRoot(p) {
  if (!p) return '';
  return findGitRoot(p) || (isDirectory(p) ? p : '');
}

function resolveProject(rawProject, shellId) {
  if (rawProject && String(rawProject).trim()) {
    let p = String(rawProject).trim();
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) return '';
    return canonicalRoot(p);
  }
  if (shellId && ctx && ctx.shells.has(shellId)) {
    const { repoRoot } = ctx.sessionPaths(ctx.shells.get(shellId));
    if (repoRoot) return canonicalRoot(repoRoot) || repoRoot;
  }
  return '';
}

/** A directory name for a new mod: readable, safe, and unused in this repo. */
function slugify(name) {
  const s = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_DIRNAME_LEN)
    .replace(/-+$/, '');
  return DIRNAME_RE.test(s) ? s : 'project-mod';
}

function uniqueDirname(root, base) {
  const parent = projectModsDir(root);
  let name = base;
  for (let n = 2; fs.existsSync(path.join(parent, name)); n++) name = `${base}-${n}`;
  return name;
}

const findMod = (id) => { ensureScanned(); return mods.find(m => m.id === id) || null; };

// --- Feature gate ------------------------------------------------------------

const featureEnabled = () => !!(ctx && ctx.settings && ctx.settings.projectModsEnabled);
const featureOffResult = () => ({ content: [{ type: 'text', text: FEATURE_OFF_MSG }], isError: true });

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

const callerShellId = (extra) => extra?.requestInfo?.url?.searchParams?.get('shellId') || null;

// The wire shape the client sees. Kept separate from the in-memory row so the server-only
// fields (root, dirname, dir, entry) don't leak into the browser.
//
// `openMode` is the EFFECTIVE one, so every consumer keeps reading a single field and none
// of them has to know about the pin override. `storedOpenMode` is the standing choice
// underneath it, and exists for one reason: the right-click menu shows "Open as a full
// view" still ticked, marked paused, while a pin is overriding it (#645).
const serialize = (m) => ({
  id: m.id, project: m.project, name: m.name, icon: m.icon,
  surfaces: m.surfaces, openMode: effectiveOpenMode(m), storedOpenMode: m.openMode,
  enabled: m.enabled, createdAt: m.createdAt, updatedAt: m.updatedAt,
});

// What an AGENT sees. Same fields plus where the mod actually lives — the point of #638 is
// that these are repo files, so an agent can open, diff and commit them like any other.
const serializeForAgent = (m) => ({
  ...serialize(m),
  path: path.relative(m.root, m.dir),
  entry: m.entry,
});

// Registering a mod now dirties the working tree, and an uncommitted one is invisible to
// everyone else — including the merge tool, which refuses a dirty target checkout.
const commitReminder = (mod) =>
  `This mod is a file in the repo now. Commit ${path.relative(mod.root, mod.dir)}/ so it ` +
  'travels with the project (and so an uncommitted change does not block a worktree merge).';

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

/** Every write ends the same way: re-derive from disk, then tell the browser. */
function commit(msg) {
  ensureScanned(true);
  if (msg) log(msg);
  broadcastMods();
}

// --- MCP tools ---------------------------------------------------------------

function init(context) {
  if (context) ctx = context;
  ensureScanned(true);

  const tools = {
    create_project_mod: {
      description:
        'Register a PROJECT MOD: a page that belongs to ONE project (this repo) and nowhere else. ' +
        'Unlike a display tab — a one-shot snapshot that disappears with the session — a project mod is durable: ' +
        'it stays registered to the project and is reachable every session from the projects rail, a square button ' +
        'in the tab strip, or a pinned tab that opens in the background and keeps running. By default it opens as a ' +
        'VIEW: it takes over the content area, consumes no tab, and is dismissed back to whatever you were looking ' +
        'at. Pass open_mode:"tab" only if it genuinely needs to sit among the work tabs. Use it for a dashboard or ' +
        'live tooling the project should carry with it. It is stored IN THE REPO, at ' +
        '.deepsteve/mods/<name>/, so COMMIT IT — that is how it travels to another checkout or another person. ' +
        'The repo must already be part of a registered project, or there would be nothing to attach it to. ' +
        'Supply the page EITHER inline via html OR — cheaper, preferred when the page ' +
        'already exists on disk — via file_path, which the server reads itself. The page is served from the deepsteve ' +
        'origin, so use relative /api/... URLs to call back into deepsteve (never a hard-coded port), and window.deepsteve ' +
        'is injected into it (getSessions, focusSession, createSession, onActiveContextChanged, …) so it can drive the UI. ' +
        'It may load sibling files from its own directory with relative URLs (./style.css), so a mod can be more than one page.',
      schema: {
        name: z.string().describe('Display name, e.g. "Build Dashboard". Also the basis for the directory name'),
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — the project is inferred from your session\'s repo root. Omit only if you pass project'),
        html: z.string().optional().describe('Full HTML content of the page. Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads instead of you passing html. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied server-side, e.g. {"%%REPO%%": "deepsteve"} — lets a file on disk stay a reusable template'),
        icon: z.string().optional().describe('An emoji shown in the rail and on the tab-strip button. Defaults to a monogram derived from the name'),
        surfaces: z.array(z.enum(['rail', 'button', 'tab'])).optional().describe('Where the LAUNCHERS go: "rail" = an entry under the project in the projects rail (default), "button" = a square button at the top/left of the tab strip, "tab" = a pinned tab that auto-opens in the background whenever this project is active. "tab" is dropped for open_mode:"view"'),
        open_mode: z.enum(['tab', 'view']).optional().describe('What a launcher DOES. "view" (default) takes over the content area WITHOUT consuming a tab and is dismissed back to whatever you were looking at — right for a glance-at-it dashboard. "tab" opens a real, closeable tab at the end of the strip; pass it only if the page is somewhere you work rather than something you check. Stating "view" drops the "tab" surface if you pass both; asking for the "tab" surface without stating open_mode keeps it'),
        project: z.string().optional().describe('Absolute path to the project, canonicalized to its git repo root. Defaults to the calling session\'s repo root'),
      },
      handler: async ({ name, session_id, html, file_path, replacements, icon, surfaces, open_mode, project }, extra) => {
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
        // Refuse rather than write a directory into a repo nobody scans: the mod would exist
        // on disk, report success, and never appear anywhere.
        if (!scanRoots().has(proj)) return err(unregisteredProjectMsg(proj));

        const resolved = resolveHtml({ html, file_path, replacements });
        if (resolved.error) return err(resolved.error);

        // Which field the caller actually stated. With openMode now defaulting to 'view',
        // an unqualified `surfaces:[...,'tab']` would otherwise have its pin stripped by a
        // mode nobody asked for — so a caller that named surfaces and not open_mode gets
        // its surfaces honoured, and only a stated open_mode resolves the pair the other way.
        const placement = cleanPlacement(surfaces, open_mode, open_mode !== undefined ? 'openMode' : 'surfaces');
        const mod = {
          root: proj,
          dirname: uniqueDirname(proj, slugify(cleanedName)),
          entry: DEFAULT_ENTRY,
          project: proj,
          name: cleanedName,
          icon: cleanIcon(icon),
          surfaces: placement.surfaces,
          openMode: placement.openMode,
          enabled: true,
          createdAt: Date.now(),
        };
        mod.dir = path.join(projectModsDir(mod.root), mod.dirname);
        mod.id = modId(mod.root, mod.dirname);

        try {
          fs.mkdirSync(mod.dir, { recursive: true });
          writePage(mod, resolved.html);
          writeManifest(mod);
        } catch (e) {
          try { fs.rmSync(mod.dir, { recursive: true, force: true }); } catch {}
          return err(`Failed to write the project mod into ${proj}: ${e.message}`);
        }
        commit(`created ${mod.dirname} "${mod.name}" in ${proj} [${mod.surfaces.join(',')}] as ${effectiveOpenMode(mod)}`);

        return ok({
          id: mod.id, name: mod.name, project: mod.project,
          path: path.relative(mod.root, mod.dir),
          // The EFFECTIVE mode, the same thing serialize() puts on the wire — telling the
          // caller "view" for a mod its own pin will open as a tab is a lie about the only
          // question this field answers. Reachable from create only since the default moved
          // to 'view': `surfaces:['rail','tab']` with no open_mode now stores a pinned view.
          surfaces: mod.surfaces, openMode: effectiveOpenMode(mod), storedOpenMode: mod.openMode,
          commitReminder: commitReminder(mod),
        });
      },
    },

    update_project_mod: {
      description:
        'Update a project mod: replace its page (html or file_path) and/or its metadata (name, icon, surfaces, ' +
        'open_mode, enabled). Every field is optional — pass only what changes. An open tab or view showing this ' +
        'mod reloads. Writes to the mod\'s directory in the repo, so commit the result. For a small page change ' +
        'you can equally well just edit the file with your own Edit tool — the daemon notices.',
      schema: {
        mod_id: z.string().describe('The project mod id returned by create_project_mod'),
        html: z.string().optional().describe('New page content. Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied server-side'),
        name: z.string().optional().describe('New display name. Does not rename the directory'),
        icon: z.string().optional().describe('New emoji icon; pass "" to clear it back to a derived monogram'),
        surfaces: z.array(z.enum(['rail', 'button', 'tab'])).optional().describe('New launcher placements. Adding "tab" to a view-mode mod makes it open as a tab for as long as the pin is there; removing "tab" again restores the view'),
        open_mode: z.enum(['tab', 'view']).optional().describe('New open mode: "tab" opens a real tab, "view" takes over the content area and consumes no tab. Passing "view" drops the "tab" surface'),
        enabled: z.boolean().optional().describe('false hides the mod from every surface without deleting it'),
      },
      handler: async ({ mod_id, html, file_path, replacements, name, icon, surfaces, open_mode, enabled }) => {
        const mod = findMod(mod_id);
        if (!mod) return err(`Project mod "${mod_id}" not found.`);

        const wantsPage = typeof html === 'string' || (typeof file_path === 'string' && file_path.trim() !== '');
        if (wantsPage) {
          const resolved = resolveHtml({ html, file_path, replacements });
          if (resolved.error) return err(resolved.error);
          try {
            writePage(mod, resolved.html);
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
        applyPlacement(mod, surfaces, open_mode);
        if (enabled !== undefined) mod.enabled = !!enabled;

        try {
          writeManifest(mod);
        } catch (e) {
          return err(`Failed to write the project mod manifest: ${e.message}`);
        }
        commit(`updated ${mod.dirname}${wantsPage ? ' (page)' : ''}`);

        return ok({ id: mod.id, updated: true, pageReplaced: wantsPage, path: path.relative(mod.root, mod.dir) });
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

        const html = readPage(mod);
        if (html === null) return err(`Project mod "${mod_id}" has no page on disk. Use update_project_mod to rewrite it.`);

        // split-count doubles as the uniqueness check and the reported replacement count.
        const count = html.split(old_string).length - 1;
        if (count === 0) return err(`old_string not found in project mod "${mod_id}".`);
        if (count > 1 && !replace_all) {
          return err(`old_string is not unique (${count} matches). Set replace_all:true or provide a longer, unique string.`);
        }

        // split/join (not String.replace) so $-sequences in new_string stay literal.
        try {
          writePage(mod, html.split(old_string).join(new_string));
        } catch (e) {
          return err(`Failed to write the project mod page: ${e.message}`);
        }
        commit(`edited ${mod.dirname}, replacements=${count}`);

        return ok({ id: mod.id, replacements: count });
      },
    },

    list_project_mods: {
      description:
        'List project mods. Defaults to the ones registered to YOUR project; scope:"all" lists every project\'s. ' +
        'Each result carries the path its directory lives at inside the repo. ' +
        'Read-only, and never gated by the projectModsEnabled setting.',
      schema: {
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — scopes the listing to your project'),
        scope: z.enum(['project', 'all']).optional().describe('"project" (default) = this project only; "all" = every project'),
        project: z.string().optional().describe('Absolute path to list a specific project instead of your own'),
      },
      handler: async ({ session_id, scope, project }, extra) => {
        ensureScanned();
        if (scope === 'all') {
          return ok({ scope: 'all', mods: mods.map(serializeForAgent) });
        }
        const shellId = session_id || callerShellId(extra);
        const proj = resolveProject(project, shellId);
        if (!proj) {
          return ok({
            scope: 'project', project: null, mods: [],
            note: 'No project could be determined for this session — pass session_id or project, or use scope:"all".',
          });
        }
        return ok({ scope: 'project', project: proj, mods: mods.filter(m => m.project === proj).map(serializeForAgent) });
      },
    },

    delete_project_mod: {
      description:
        'Delete a project mod permanently — its whole directory is removed from the repo. Any open tab showing it ' +
        'closes. Commit the deletion.',
      schema: { mod_id: z.string().describe('The project mod id') },
      handler: async ({ mod_id }) => {
        const mod = findMod(mod_id);
        if (!mod) return err(`Project mod "${mod_id}" not found.`);
        const removed = path.relative(mod.root, mod.dir);
        try {
          removeMod(mod);
        } catch (e) {
          return err(`Failed to delete the project mod: ${e.message}`);
        }
        commit(`deleted ${mod.dirname} "${mod.name}" from ${mod.root}`);
        return ok({ id: mod.id, deleted: true, path: removed });
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
    ensureScanned();
    res.json({ mods: mods.map(serialize), enabled: featureEnabled() });
  });

  // The page itself. Serving only ids present in the scan is what keeps a crafted :id from
  // reaching outside a mod directory — the id is never concatenated into a path before it
  // has matched a scanned mod, and the path it then names is the manifest's own entry.
  app.get('/api/project-mods/:id/page', (req, res) => {
    const mod = findMod(req.params.id);
    if (!mod) return res.status(404).send('Not found');
    const html = readPage(mod);
    if (html === null) return res.status(404).send('Not found');
    if (req.method === 'HEAD') return res.type('html').end();
    res.type('html').send(html);
  });

  // Sibling files, so a mod can be a directory rather than a single document: the page is
  // served at /api/project-mods/<id>/page, so a relative "./style.css" in it lands here.
  // Declared AFTER /page, which must keep winning. resolveInMod() is what stops the wildcard
  // from reaching anything outside the mod's own directory.
  app.get('/api/project-mods/:id/*', (req, res) => {
    const mod = findMod(req.params.id);
    if (!mod) return res.status(404).send('Not found');
    let rel;
    try { rel = decodeURIComponent(req.params[0] || ''); } catch { return res.status(400).send('Bad request'); }
    if (!rel) return res.status(404).send('Not found');
    const target = resolveInMod(mod, rel);
    if (!target) return res.status(404).send('Not found');
    try {
      if (!fs.statSync(target).isFile()) return res.status(404).send('Not found');
    } catch {
      return res.status(404).send('Not found');
    }
    res.sendFile(target);
  });

  // Metadata edits from the UI (rename, icon, surfaces, enable/disable). The page
  // bytes are agent-authored and stay that way — there is no REST page write.
  app.put('/api/project-mods/:id', (req, res) => {
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
    const mod = findMod(req.params.id);
    if (!mod) return res.status(404).json({ error: 'Project mod not found' });

    const { name, icon, surfaces, openMode, enabled } = req.body || {};
    if (name !== undefined) {
      const cleaned = cleanName(name);
      if (!cleaned) return res.status(400).json({ error: 'name must not be empty' });
      mod.name = cleaned;
    }
    if (icon !== undefined) mod.icon = cleanIcon(icon);
    applyPlacement(mod, surfaces, openMode);
    if (enabled !== undefined) mod.enabled = !!enabled;

    try {
      writeManifest(mod);
    } catch (e) {
      return res.status(500).json({ error: `Failed to write the project mod manifest: ${e.message}` });
    }
    // Serialize BEFORE the rescan replaces the row this response describes.
    const body = { mod: serialize(mod) };
    commit(null);
    res.json(body);
  });

  app.delete('/api/project-mods/:id', (req, res) => {
    if (!featureEnabled()) return res.status(403).json({ error: FEATURE_OFF_MSG });
    const mod = findMod(req.params.id);
    if (!mod) return res.status(404).json({ error: 'Project mod not found' });
    try {
      removeMod(mod);
    } catch (e) {
      return res.status(500).json({ error: `Failed to delete the project mod: ${e.message}` });
    }
    commit(`deleted ${mod.dirname} "${mod.name}" from ${mod.root} (REST)`);
    res.json({ deleted: true, id: mod.id });
  });
}

// The mod loader only uses init/registerRoutes; the extra named exports are for unit tests.
module.exports = {
  init, registerRoutes,
  resolveProject, canonicalRoot, normalize, cleanSurfaces, cleanIcon, cleanName, cleanEntry,
  cleanOpenMode, cleanPlacement, applyPlacement, effectiveOpenMode,
  // scan() is the force-rescan a test needs after writing into a repo behind our back —
  // every in-process write already forces one, but a direct fs write does not.
  scan, scanRoots, modId, slugify, resolveInMod, serialize, serializeForAgent,
  SURFACES, DEFAULT_SURFACES, OPEN_MODES, DEFAULT_OPEN_MODE,
  PROJECT_SCOPE, MANIFEST_FILE, DEFAULT_ENTRY, DIRNAME_RE,
  FEATURE_OFF_MSG,
};

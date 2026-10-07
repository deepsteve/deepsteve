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
 * exactly like one written through update_project_mod, once the browser is told to refetch.
 * The daemon does not watch the disk; see SCAN_TTL_MS for what does the telling (#703).
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
const { projectModsDir, projectViewsDir } = require('../../paths');
const path = require('path');

const { resolveHtml } = require('../../html-source.js');
const projectScope = require('../../project-scope.js');

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
// enough that a read never serves a stale list for long, long enough that the burst of reads
// one broadcast triggers costs a single walk.
//
// The TTL only bounds what a READ returns. An open window refetches only when it is pinged,
// and the daemon does not watch the disk (#703), so a change made behind our back reaches the
// browser through refresh(): the refresh_project_mods tool, a landed merge (session-merge.js,
// merge_worktree), or the client refetching when a project's folders change.
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
let scannedRoots = '';   // the scanRoots() the cache was built from, as rootsKey()
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
 * Rebuild `mods` — and `views` (#726), which share the scan, the cache and the pings — from
 * the registered repos. Cheap — one readdir per repo plus one per mod directory — and total,
 * so a deleted or renamed directory disappears without bookkeeping.
 *
 * Does nothing before init() has handed us a context: with no way to ask which projects are
 * registered, an empty scan is not a fact, and caching it would hide the first real one.
 */
function scan(roots = scanRoots()) {
  if (!ctx) return;
  const out = [];
  const outViews = [];
  for (const root of roots) {
    outViews.push(...readViews(root));
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
  views = outViews.sort(compareViews);
  lastScan = Date.now();
  scannedRoots = rootsKey(roots);
}

const rootsKey = (roots) => [...roots].join('\n');

/**
 * Scan if the cache has aged out, or if it was built from a different set of repos; `force`
 * after any write, so a caller never reads stale.
 *
 * The root check is what makes adding a folder to a project show that repo's mods at once
 * (#703). The client refetches the moment a `contexts` broadcast lands, and a cache built from
 * the old roots can easily be under SCAN_TTL_MS old at that point.
 */
function ensureScanned(force = false) {
  if (force || Date.now() - lastScan > SCAN_TTL_MS) return scan();
  const roots = scanRoots();
  if (rootsKey(roots) !== scannedRoots) scan(roots);
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
 * root); otherwise inherit the calling session's repo root. Returns '' when neither
 * yields a directory — unlike a scheduled task (which can run in the homedir), a
 * project mod with no project is meaningless, so callers reject.
 *
 * The implementation moved to ../../project-scope (#659), shared with scheduled tasks
 * and with list_sessions: all three answer "which project is this?" the same way, and
 * a third copy is how a comment claiming they agree stops being true. The DEFAULTS
 * there are this mod's semantics, so no options are passed.
 *
 * BOTH branches go through findGitRoot (inside project-scope.js), and that matters now that a resolved project is
 * checked for membership in scanRoots() rather than merely recorded: findGitRoot realpaths,
 * so a session whose repoRoot is reached through a symlink (`/var/...` → `/private/var/...`
 * on macOS) would otherwise never match the same repo registered as a project, and every
 * create would be refused. Canonicalizing on both sides is what makes the comparison mean
 * "the same directory" instead of "the same string".
 */
const { canonicalRoot } = projectScope;
const resolveProject = (rawProject, shellId) => projectScope.resolveProject(rawProject, shellId, ctx);

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

const { callerShellId } = projectScope;

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
// that these are repo files, so an agent can open, diff and commit them like any other — and
// the link to put in an email (#711), which the browser never needs.
const serializeForAgent = (m) => ({
  ...serialize(m),
  path: path.relative(m.root, m.dir),
  entry: m.entry,
  url: linkUrl(m.id),
});

// --- Links (#711) ------------------------------------------------------------

// A mod's page lives at /api/project-mods/<id>/page, and that address cannot go in an email.
// A click in webmail is a cross-site navigation, so the browser withholds our SameSite=Strict
// cookie and the page answers a plain 401. So does a pasted `localhost:3000` copy of it, in
// Firefox: the canonical-host 302 to deepsteve.localhost is a cross-site redirect, and Firefox
// drops Strict cookies after one. /v1 paths get authGate's link bounce, which recovers from
// both, so /v1/project-mod/<id> is the address an email points at. It redirects to the page
// rather than serving it, so the page keeps one URL and its relative ./assets still resolve.
const LINK_TYPE = 'project-mod';
// Exactly the shape modId() mints. A link names a mod exactly, so no other spelling resolves.
const MOD_ID_RE = /^[0-9a-f]{8}$/;

const pageUrl = (id) => `/api/project-mods/${encodeURIComponent(id)}/page`;
const linkUrl = (id) => (ctx && typeof ctx.linkUrl === 'function' ? ctx.linkUrl(LINK_TYPE, id) : null);

function linkProvider() {
  return {
    name: 'project-mods',
    owns: (id) => MOD_ID_RE.test(id),
    // Neither `enabled` nor projectModsEnabled gates this, as neither gates the page route the
    // link redirects to: turning a mod off must not make it un-inspectable.
    resolve: (id) => {
      const found = findMod(id);
      return found ? { type: LINK_TYPE, mod: found } : null;
    },
    // GET only. There is no `act`, so a POST gets links.js's refusal.
    render: { [LINK_TYPE]: (req, res, resolved) => res.redirect(302, pageUrl(resolved.mod.id)) },
  };
}

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

/**
 * The same ending, for a change that happened behind our back (#703): an agent's own
 * Write into a mod directory, a git pull, a merge landing in the checkout. Exported because
 * the merge paths in deepsteve-core call it, and they run with no agent turn to call the tool.
 *
 * Always pings, with no "did the list change" gate. A window that loaded through a TTL read can
 * hold a list that was never broadcast, so "unchanged since the last ping" is not "unchanged
 * for every window". A ping costs each window one cheap GET, and render() is idempotent.
 *
 * A no-op before init(), like scan() and broadcastMods(), which is what keeps session-merge.js's
 * unit tests free of a daemon.
 */
function refresh(reason) {
  commit(reason ? `rescanned after ${reason}` : null);
}

// --- Project views (#726) ----------------------------------------------------
//
// A project view is a named view of a project's tabs ("Marketing", "Analytics"), shown as a
// row of buttons over the tab strip. The built-in "All" is the default and is never a file.
// Like a mod, a view is defined IN the repo — `<repoRoot>/.deepsteve/views/<slug>.json` — so
// it is committed and travels with the checkout, and it is found by the same scan of the
// registered projects' repos, refreshed by the same pings. Unlike a mod it is inert data (a
// name and some match rules, never a page), which is why projectModsEnabled — the kill switch
// for agent-authored HTML — does not gate it.
//
// The slug (the filename) is the view's identity everywhere: a tab's membership, the view a
// window has selected, and the `view` param of the spawn tools all name it. So a slug is never
// renamed (a rename changes `name` only), and a project whose repos both define `marketing`
// has ONE Marketing view — the client merges them.
//
// Membership is decided in the browser (public/js/project-views.js): a tab is in a view when
// one of the view's rules matches it, or when it was filed there — by hand, by being opened
// while the view was selected, or by the agent tab that opened it. This file owns only the
// definitions.

const VIEW_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED_VIEW = 'all';   // the built-in default, never a file
const VIEW_KINDS = ['agent', 'terminal', 'display-tab', 'project-mod', 'mod-tab'];
const VIEW_FILE_EXT = '.json';
const MAX_VIEW_RULES = 16;
const MAX_RULE_ITEMS = 32;
const MAX_VIEW_FILE_BYTES = 64 * 1024;
const MAX_VIEW_ORDER = 1e6;

let views = [];

const unregisteredViewMsg = (proj) =>
  `${proj} is not part of any registered project, so a view written there would never be ` +
  'discovered. Views are found by scanning the repos of the projects in the rail. Ask the user ' +
  'to add this repo to a project first (the "+ New project" entry in the projects rail).';

// Keyed apart from modId() so a view and a mod can never share an id.
const viewId = (root, slug) => createHash('sha1').update(`${root}\0views\0${slug}`).digest('hex').slice(0, 8);

/** A slug as stored: lowercase, safe in a filename and a URL, and never the reserved "all". */
function cleanViewSlug(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim().toLowerCase();
  return VIEW_SLUG_RE.test(s) && s !== RESERVED_VIEW ? s : '';
}

/**
 * A slug derived from a display name, or '' when the name has nothing to derive one from.
 * No "-2" uniquifying the way mod directories get one: the slug is the membership key, so a
 * `marketing-2` would quietly be a different view from the one the caller named.
 */
function slugifyView(name) {
  const s = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return cleanViewSlug(s);
}

const cleanNeedle = (raw) => {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(CONTROL_CHARS, '').trim().toLowerCase().slice(0, MAX_NAME_LEN);
  return s || null;
};

/**
 * A `paths` entry: relative to the view's repo, and never outside it. '' (written "." or
 * "./") is the whole repo. Backslashes are normalized before the `..` check, as cleanEntry()
 * does, so a Windows-style traversal can't slip past a `/`-oriented test.
 */
function cleanViewPath(raw) {
  if (typeof raw !== 'string') return null;
  const rel = raw.replace(CONTROL_CHARS, '').trim().replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || path.isAbsolute(rel)) return null;
  const segs = rel.split('/').filter(seg => seg && seg !== '.');
  if (segs.some(seg => seg === '..')) return null;
  return segs.join('/');
}

const cleanKind = (raw) => (VIEW_KINDS.includes(raw) ? raw : null);

function cleanRuleField(raw, clean) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const v = clean(item);
    if (v !== null && !out.includes(v)) out.push(v);
    if (out.length >= MAX_RULE_ITEMS) break;
  }
  return out;
}

/**
 * A view's `match`: a list of rules. A tab is in the view when ANY rule matches, and a rule
 * matches when EVERY field it states does (`names`: a substring of the tab name, any entry;
 * `paths`: the tab's cwd inside one of these repo subfolders; `kinds`: the tab's kind). A bare
 * object is accepted as a one-rule list.
 *
 * A rule that states a field and has none of that field's entries survive is dropped WHOLE,
 * not with the field removed: `{kinds:['display-tab'], paths:['../elsewhere']}` must not widen
 * into "every display tab in the project". An empty list is legal — a view tabs are filed into
 * only by hand.
 */
function cleanMatch(raw) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  const rules = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const rule = {};
    let lostAField = false;
    for (const [field, clean] of [['names', cleanNeedle], ['paths', cleanViewPath], ['kinds', cleanKind]]) {
      if (r[field] === undefined) continue;
      const cleaned = cleanRuleField(r[field], clean);
      if (cleaned.length) rule[field] = cleaned;
      else lostAField = true;
    }
    if (!lostAField && Object.keys(rule).length) rules.push(rule);
    if (rules.length >= MAX_VIEW_RULES) break;
  }
  return rules;
}

function cleanViewOrder(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(-MAX_VIEW_ORDER, Math.min(MAX_VIEW_ORDER, n)) : 0;
}

/** One view file → the in-memory row, or null if it is not a view we can make sense of. */
function normalizeView(raw, root, slug) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!root || !cleanViewSlug(slug) || cleanViewSlug(slug) !== slug) return null;
  return {
    id: viewId(root, slug),
    // Server-only — serializeView() keeps it off the wire.
    root,
    file: path.join(projectViewsDir(root), slug + VIEW_FILE_EXT),
    slug,
    project: root,
    name: cleanName(raw.name) || slug,
    icon: cleanIcon(raw.icon),
    order: cleanViewOrder(raw.order),
    match: cleanMatch(raw.match),
  };
}

/**
 * Every view one repo defines. Only `<slug>.json` with a valid lowercase slug counts, so the
 * `.tmp` an interrupted write leaves, an editor's swap file, a dotfile and a `Marketing.json`
 * are all skipped rather than guessed at. Oversized and corrupt files are skipped too.
 */
function readViews(root) {
  const dir = projectViewsDir(root);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];   // no .deepsteve/views in this repo, which is the common case
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(VIEW_FILE_EXT)) continue;
    const slug = e.name.slice(0, -VIEW_FILE_EXT.length);
    if (cleanViewSlug(slug) !== slug) continue;
    const file = path.join(dir, e.name);
    let raw;
    try {
      if (fs.statSync(file).size > MAX_VIEW_FILE_BYTES) continue;
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const v = normalizeView(raw, root, slug);
    if (v) out.push(v);
  }
  return out;
}

const compareViews = (a, b) =>
  (a.order - b.order) || a.name.localeCompare(b.name) || a.project.localeCompare(b.project);

/** The file's contents, in the order they read best in a diff. Empty icon / zero order are left out. */
function viewManifestOf(v) {
  const out = { name: v.name };
  if (v.icon) out.icon = v.icon;
  if (v.order) out.order = v.order;
  out.match = v.match;
  return out;
}

function writeView(v) {
  writeFileAtomic(v.file, JSON.stringify(viewManifestOf(v), null, 2) + '\n');
}

/**
 * Delete a view's file, then any now-empty `.deepsteve/views` and `.deepsteve` above it. The
 * path is re-derived from the repo root and the slug and must stay inside the views directory,
 * the same distrust removeMod() applies; the rmdir prune fails harmlessly on a directory that
 * still holds something (another view, or `.deepsteve/mods`).
 */
function removeView(v) {
  const base = path.resolve(projectViewsDir(v.root));
  const file = path.resolve(base, v.slug + VIEW_FILE_EXT);
  if (!file.startsWith(base + path.sep)) throw new Error('refusing to delete outside the views directory');
  fs.rmSync(file, { force: true });
  try { fs.rmdirSync(base); } catch {}
  try { fs.rmdirSync(path.dirname(base)); } catch {}
}

// The browser's shape. `root` and `file` stay server-side; `project` is the repo root, which
// is what the client scopes by (the same field a mod carries).
const serializeView = (v) => ({
  id: v.id, slug: v.slug, project: v.project, name: v.name, icon: v.icon, order: v.order, match: v.match,
});

const serializeViewForAgent = (v) => ({ ...serializeView(v), path: path.relative(v.root, v.file) });

const viewCommitReminder = (v) =>
  `This view is a file in the repo. Commit ${path.relative(v.root, v.file)} so it travels with the ` +
  'project (and so an uncommitted change does not block a worktree merge).';

/**
 * The trap create_project_mod has too: a worktree session's project resolves to the PARENT
 * repo (that is the root the scan knows), so the file lands in the main checkout, which the
 * worktree's own Bash cannot commit, and merge_worktree refuses a dirty target. Said out loud
 * rather than silently worked around.
 */
function worktreeViewNote(shellId, proj) {
  const entry = shellId && ctx && ctx.shells && typeof ctx.shells.get === 'function' ? ctx.shells.get(shellId) : null;
  if (!entry || !entry.worktree) return null;
  return `Your session is in a worktree, but the view was written to ${proj} — the main checkout, the repo ` +
    'the project scans. That checkout now has an uncommitted file, and merge_worktree / issue_complete refuse ' +
    'a dirty target, so ask the user to commit it there. To ship a view with your branch instead, write ' +
    '.deepsteve/views/<slug>.json inside your worktree and commit it; it appears when the merge lands.';
}

/**
 * The `view` argument of the spawn tools (open_terminal, start_issue, create_display_tab):
 * undefined = file the new tab under whatever views its opener is in; "all" = none; otherwise
 * a slug. Not checked against the views that exist — a filing into a view nobody has defined
 * yet is inert, and becomes live the moment someone does.
 */
function cleanSpawnView(raw) {
  if (raw === undefined || raw === null || raw === '') return { view: undefined };
  if (typeof raw !== 'string') return { error: 'view must be a string.' };
  const s = raw.trim().toLowerCase();
  if (s === RESERVED_VIEW) return { view: RESERVED_VIEW };
  const slug = cleanViewSlug(s);
  if (!slug) {
    return { error: `view "${raw}" is not a view slug (lowercase letters, digits and dashes, e.g. "marketing"). Pass "all" to file the tab under no view.` };
  }
  return { view: slug };
}

// The spawn tools' `view` param, described once for all three of them.
const SPAWN_VIEW_DESCRIPTION =
  'Project view to file the new tab under — a view\'s slug, e.g. "marketing" (list_project_views). OMIT it and ' +
  'the tab goes into every view YOUR tab is in, which is right for work you are handing off; pass "all" to file ' +
  'it under no view.';

const viewsIn = (proj) => { ensureScanned(); return views.filter(v => v.project === proj); };
const findViewById = (id) => { ensureScanned(); return views.find(v => v.id === id) || null; };

/**
 * Write a new view file. Shared by create_project_view and the "+ New view" REST route, so an
 * agent and a person clicking get the same validation. Returns `{view}` or `{error, status}`.
 */
function createView(proj, { name, slug, icon, order, match }) {
  const cleanedName = cleanName(name);
  if (!cleanedName) return { error: 'name is required.', status: 400 };
  const explicitSlug = slug !== undefined && slug !== null && slug !== '';
  const s = explicitSlug ? cleanViewSlug(String(slug)) : slugifyView(cleanedName);
  if (!s) {
    const asked = (explicitSlug ? String(slug) : cleanedName).trim().toLowerCase();
    const why = asked === RESERVED_VIEW
      ? '"All" is the built-in view every project already has.'
      : 'Pass a slug: lowercase letters, digits and dashes, e.g. "marketing" ("all" is reserved).';
    return { error: `No usable view slug from "${explicitSlug ? slug : cleanedName}". ${why}`, status: 400 };
  }
  const v = normalizeView({ name: cleanedName, icon, order, match }, proj, s);
  if (fs.existsSync(v.file)) {
    return {
      error: `A view "${s}" already exists in ${proj} (${path.relative(proj, v.file)}). Use update_project_view to change it.`,
      status: 409,
    };
  }
  writeView(v);
  commit(`created view ${s} "${v.name}" in ${proj} with ${v.match.length} rule(s)`);
  return { view: v };
}

// --- MCP tools ---------------------------------------------------------------

function init(context) {
  if (context) ctx = context;
  ensureScanned(true);
  // What `/v1/project-mod/<id>` means. Guarded like Inbox's, so a context without the link
  // registry (a test's fake ctx) still loads every tool.
  if (ctx && ctx.links && typeof ctx.links.registerProvider === 'function') {
    ctx.links.registerProvider(linkProvider());
  }

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
        'It may load sibling files from its own directory with relative URLs (./style.css), so a mod can be more than one page. ' +
        'The result carries `url`, the link to put in an email or anywhere else outside Deep Steve: it opens the page in a ' +
        'browser tab of its own, where window.deepsteve is absent (only the Deep Steve UI injects it). Use that `url`, never a ' +
        'hand-built /api/project-mods/... or localhost address, which a click from an email answers with 401 Unauthorized.',
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
          url: linkUrl(mod.id),
          commitReminder: commitReminder(mod),
        });
      },
    },

    update_project_mod: {
      description:
        'Update a project mod: replace its page (html or file_path) and/or its metadata (name, icon, surfaces, ' +
        'open_mode, enabled). Every field is optional — pass only what changes. An open tab or view showing this ' +
        'mod reloads. Writes to the mod\'s directory in the repo, so commit the result. For a small page change ' +
        'you can equally well edit the file with your own Edit tool, then call refresh_project_mods so open windows pick it up.',
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
        'Each result carries the path its directory lives at inside the repo, and `url`: the link that opens the mod\'s page ' +
        'from an email or anywhere else outside Deep Steve. ' +
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

    refresh_project_mods: {
      description:
        'Re-read every registered project\'s .deepsteve/mods/ and .deepsteve/views/ from disk and tell every open window ' +
        'to redraw its project mods (rail rows, tab-strip buttons, pinned tabs) and project views, with no page reload. ' +
        'The create/update/edit/delete tools already do this. Call it after changing a project mod or view ANY OTHER WAY: ' +
        'writing mod.json, a page or a view file with your own Edit/Write tool, or a git pull, checkout or rebase that ' +
        'adds, removes or renames one. (A merge through merge_worktree or issue_complete refreshes on its own.) ' +
        'Returns the mods and views now found in your project. A mod missing from the list either has no valid mod.json (it ' +
        'needs "scope": "project") or lives in a repo that is not part of a registered project.',
      schema: {
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — scopes the returned list to your project'),
        project: z.string().optional().describe('Absolute path to list a specific project instead of your own'),
      },
      handler: async ({ session_id, project }, extra) => {
        refresh('refresh_project_mods');
        const shellId = session_id || callerShellId(extra);
        const proj = resolveProject(project, shellId);
        const out = {
          refreshed: true,
          enabled: featureEnabled(),
          project: proj || null,
          mods: (proj ? mods.filter(m => m.project === proj) : mods).map(serializeForAgent),
          views: (proj ? views.filter(v => v.project === proj) : views).map(serializeViewForAgent),
        };
        // Why nothing may show up, in the order an agent would want to fix it.
        if (!out.enabled) out.note = FEATURE_OFF_MSG;
        else if (proj && !scanRoots().has(proj)) out.note = unregisteredProjectMsg(proj);
        return ok(out);
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

    // --- Project views (#726) ---

    create_project_view: {
      description:
        'Create a PROJECT VIEW: a named view of this project\'s tabs, e.g. "Marketing" or "Analytics". Views appear ' +
        'as a row of buttons over the tab strip (collapsed to one toggle by default) whenever the project is selected ' +
        'in the rail; picking one shows only the tabs in it, and the built-in "All" shows everything. A tab is in a view ' +
        'when ANY of its match rules matches — within one rule EVERY field given must match: `names` (case-insensitive ' +
        'substrings of the tab name, any of them), `paths` (folders relative to the repo root; "." is the whole repo — ' +
        'the tab\'s cwd must be inside one), `kinds` (agent, terminal, display-tab, project-mod, mod-tab). Tabs also ' +
        'join a view without any rule: a tab the user opens while the view is selected, a tab filed there from its ' +
        'right-click menu, and a tab an agent opens — which goes into every view ITS OPENER is in, unless the spawn ' +
        'tool (open_terminal, start_issue, create_display_tab) passes `view`. So a view with no rules at all is a ' +
        'manual folder, which is often what you want. Stored IN THE REPO at .deepsteve/views/<slug>.json — COMMIT IT. ' +
        'The repo must already be part of a registered project.',
      schema: {
        name: z.string().describe('Display name, e.g. "Marketing". Also the basis for the slug unless you pass one'),
        slug: z.string().optional().describe('The view\'s key and filename: lowercase letters, digits and dashes, e.g. "marketing". "all" is reserved. Spawn tools\' `view` param names this'),
        icon: z.string().optional().describe('An emoji shown on the view\'s button'),
        order: z.number().optional().describe('Sort key for the button row (ascending; ties sort by name). Default 0'),
        match: z.array(z.object({
          names: z.array(z.string()).optional().describe('Case-insensitive substrings of the tab name; any one matches'),
          paths: z.array(z.string()).optional().describe('Folders relative to the repo root ("." = the whole repo); the tab\'s cwd must be inside one. A worktree counts as its repo'),
          kinds: z.array(z.enum(VIEW_KINDS)).optional().describe('Tab kinds; any one matches'),
        })).optional().describe('Rules, OR\'d together; the fields of one rule are AND\'d. Omit for a view tabs are only filed into'),
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — the project is inferred from your session\'s repo root. Omit only if you pass project'),
        project: z.string().optional().describe('Absolute path to the project, canonicalized to its git repo root. Defaults to the calling session\'s repo root'),
      },
      handler: async ({ name, slug, icon, order, match, session_id, project }, extra) => {
        const shellId = session_id || callerShellId(extra);
        const proj = resolveProject(project, shellId);
        if (!proj) {
          return err('Could not determine which project this view belongs to. Pass your DEEPSTEVE_SESSION_ID as session_id, or an absolute path as project.');
        }
        if (!scanRoots().has(proj)) return err(unregisteredViewMsg(proj));
        let made;
        try {
          made = createView(proj, { name, slug, icon, order, match });
        } catch (e) {
          return err(`Failed to write the view into ${proj}: ${e.message}`);
        }
        if (made.error) return err(made.error);
        const out = { ...serializeViewForAgent(made.view), commitReminder: viewCommitReminder(made.view) };
        const note = worktreeViewNote(shellId, proj);
        if (note) out.worktreeNote = note;
        return ok(out);
      },
    },

    update_project_view: {
      description:
        'Change a project view: its name, icon, order and/or match rules. Pass only what changes; `match` replaces the ' +
        'whole rule list (pass [] for a view tabs are only filed into). The slug cannot change — it is the key every ' +
        'filed tab and spawn `view` param names; to rename the key, delete the view and create another. Writes the ' +
        'view\'s file in the repo, so commit the result. Editing .deepsteve/views/<slug>.json with your own tools works ' +
        'too; call refresh_project_mods afterwards so open windows redraw.',
      schema: {
        view: z.string().describe('The view\'s slug, e.g. "marketing"'),
        name: z.string().optional().describe('New display name'),
        icon: z.string().optional().describe('New emoji icon; "" clears it'),
        order: z.number().optional().describe('New sort key'),
        match: z.array(z.object({
          names: z.array(z.string()).optional(),
          paths: z.array(z.string()).optional(),
          kinds: z.array(z.enum(VIEW_KINDS)).optional(),
        })).optional().describe('The new rule list — replaces the old one'),
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — the project is inferred from your session\'s repo root'),
        project: z.string().optional().describe('Absolute path to the project instead of your own'),
      },
      handler: async ({ view, name, icon, order, match, session_id, project }, extra) => {
        const proj = resolveProject(project, session_id || callerShellId(extra));
        if (!proj) return err('Could not determine which project the view is in. Pass session_id or project.');
        const slug = cleanViewSlug(String(view || ''));
        const here = viewsIn(proj);
        const v = here.find(x => x.slug === slug);
        if (!v) {
          return err(`No view "${view}" in ${proj}. Views here: ${here.map(x => x.slug).join(', ') || '(none)'}.`);
        }
        if (name !== undefined) {
          const cleaned = cleanName(name);
          if (!cleaned) return err('name must not be empty.');
          v.name = cleaned;
        }
        if (icon !== undefined) v.icon = cleanIcon(icon);
        if (order !== undefined) v.order = cleanViewOrder(order);
        if (match !== undefined) v.match = cleanMatch(match);
        try {
          writeView(v);
        } catch (e) {
          return err(`Failed to write the view: ${e.message}`);
        }
        const out = { ...serializeViewForAgent(v), updated: true };
        commit(`updated view ${v.slug} in ${proj}`);
        return ok(out);
      },
    },

    delete_project_view: {
      description:
        'Delete a project view: its file is removed from the repo, and a window looking at it falls back to "All". ' +
        'Tabs filed into it lose nothing else. Commit the deletion.',
      schema: {
        view: z.string().describe('The view\'s slug'),
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — the project is inferred from your session\'s repo root'),
        project: z.string().optional().describe('Absolute path to the project instead of your own'),
      },
      handler: async ({ view, session_id, project }, extra) => {
        const proj = resolveProject(project, session_id || callerShellId(extra));
        if (!proj) return err('Could not determine which project the view is in. Pass session_id or project.');
        const slug = cleanViewSlug(String(view || ''));
        const v = viewsIn(proj).find(x => x.slug === slug);
        if (!v) return err(`No view "${view}" in ${proj}.`);
        const removed = path.relative(v.root, v.file);
        try {
          removeView(v);
        } catch (e) {
          return err(`Failed to delete the view: ${e.message}`);
        }
        commit(`deleted view ${v.slug} from ${proj}`);
        return ok({ slug: v.slug, deleted: true, path: removed });
      },
    },

    list_project_views: {
      description:
        'List project views. Defaults to the ones defined in YOUR project\'s repo; scope:"all" lists every registered ' +
        'repo\'s. Each carries its slug (what a spawn tool\'s `view` param names), its rules and the path of its file.',
      schema: {
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID env var — scopes the listing to your project'),
        scope: z.enum(['project', 'all']).optional().describe('"project" (default) = this project only; "all" = every project'),
        project: z.string().optional().describe('Absolute path to list a specific project instead of your own'),
      },
      handler: async ({ session_id, scope, project }, extra) => {
        ensureScanned();
        if (scope === 'all') return ok({ scope: 'all', views: views.map(serializeViewForAgent) });
        const proj = resolveProject(project, session_id || callerShellId(extra));
        if (!proj) {
          return ok({
            scope: 'project', project: null, views: [],
            note: 'No project could be determined for this session — pass session_id or project, or use scope:"all".',
          });
        }
        const out = { scope: 'project', project: proj, views: views.filter(v => v.project === proj).map(serializeViewForAgent) };
        if (!scanRoots().has(proj)) out.note = unregisteredViewMsg(proj);
        return ok(out);
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

  // --- Project views (#726) ---
  // Every view of every registered repo; the client scopes them to the selected project, the
  // same split /api/project-mods makes. Not gated: a view is data, not agent-authored HTML.
  app.get('/api/project-views', (req, res) => {
    ensureScanned();
    res.json({ views: views.map(serializeView) });
  });

  // "+ New view" — the manual mode, where a person rather than an agent makes the view. It is
  // created with no rules, so it holds exactly the tabs filed into it. The browser names the
  // PROJECT (a context id), not a path: which of the project's repos receives the file is
  // decided here — the repo holding `cwd` (the tab the user is looking at) when there is one,
  // else the project's first folder.
  app.post('/api/project-views', (req, res) => {
    const { contextId, name, icon, cwd } = req.body || {};
    const contexts = projectScope.getContexts(ctx);
    const project = contexts.find(c => c && c.id === contextId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const dirs = (Array.isArray(project.dirs) ? project.dirs : []).filter(Boolean);
    const pick = (typeof cwd === 'string' && cwd)
      ? dirs.find(d => projectScope.pathInside(cwd, d, ctx) || projectScope.pathInside(cwd, canonicalRoot(d), ctx))
      : null;
    const proj = canonicalRoot(pick || dirs[0] || '');
    if (!proj) return res.status(400).json({ error: 'This project has no folder to keep a view in' });
    let made;
    try {
      made = createView(proj, { name, icon, match: [] });
    } catch (e) {
      return res.status(500).json({ error: `Failed to write the view: ${e.message}` });
    }
    if (made.error) return res.status(made.status || 400).json({ error: made.error });
    res.status(201).json({ view: serializeView(made.view), path: path.relative(proj, made.view.file) });
  });

  // Rename / re-icon from the view button's menu. Rules stay agent- or file-edited.
  app.put('/api/project-views/:id', (req, res) => {
    const v = findViewById(req.params.id);
    if (!v) return res.status(404).json({ error: 'View not found' });
    const { name, icon } = req.body || {};
    if (name !== undefined) {
      const cleaned = cleanName(name);
      if (!cleaned) return res.status(400).json({ error: 'name must not be empty' });
      v.name = cleaned;
    }
    if (icon !== undefined) v.icon = cleanIcon(icon);
    try {
      writeView(v);
    } catch (e) {
      return res.status(500).json({ error: `Failed to write the view: ${e.message}` });
    }
    const body = { view: serializeView(v) };
    commit(`updated view ${v.slug} in ${v.root} (REST)`);
    res.json(body);
  });

  app.delete('/api/project-views/:id', (req, res) => {
    const v = findViewById(req.params.id);
    if (!v) return res.status(404).json({ error: 'View not found' });
    try {
      removeView(v);
    } catch (e) {
      return res.status(500).json({ error: `Failed to delete the view: ${e.message}` });
    }
    commit(`deleted view ${v.slug} from ${v.root} (REST)`);
    res.json({ deleted: true, id: v.id });
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
  // Not test-only: the merge paths in mods/deepsteve-core call it (#703).
  refresh,
  SURFACES, DEFAULT_SURFACES, OPEN_MODES, DEFAULT_OPEN_MODE,
  PROJECT_SCOPE, MANIFEST_FILE, DEFAULT_ENTRY, DIRNAME_RE,
  FEATURE_OFF_MSG,
  // Project views (#726). cleanSpawnView is not test-only: the spawn tools validate `view` with it.
  cleanSpawnView, SPAWN_VIEW_DESCRIPTION, cleanViewSlug, slugifyView, cleanMatch, cleanViewPath, normalizeView, viewId,
  serializeView, serializeViewForAgent, viewManifestOf,
  VIEW_KINDS, VIEW_SLUG_RE, RESERVED_VIEW,
};

/**
 * The image store behind share_result (#669).
 *
 * Two constraints shape every line of this file, and neither is obvious:
 *
 * 1. **Never inline.** workshop.json is read WHOLE on every poll of
 *    /api/workshop/inbox — a 2s cadence by default — so a base64 PNG in there is fatal
 *    to the panel's refresh, not merely wasteful. An item stores a filename; the bytes
 *    live here.
 *
 * 2. **Copy, don't reference.** The obvious design keeps the screenshot id or the path
 *    and resolves it at serve time. It does not survive contact with either end: the
 *    screenshots subsystem deletes anything older than SEVEN DAYS (server.js's boot
 *    sweep), so a durable record referencing one silently loses its evidence; and a
 *    path reference means the serve route takes an attacker-influenced string, which is
 *    a file-disclosure primitive one bug away at all times. Copying at share time makes
 *    the serve route able to read out of exactly one directory, forever.
 *
 * The validation therefore all happens ONCE, on the way in, where a refusal can be
 * explained to the agent that caused it. servePath() below is deliberately dumb.
 *
 * Kept separate from tools.js so the ingest rules are drivable from node:test with a
 * fake ctx and no daemon — the dialog-parse.js / inbox-view.js split, same reason.
 */

const fs = require('node:fs');
const path = require('node:path');
const { statePath } = require('../../paths');

// An agent making its case, not an album. Nine would collide with the panel's 1-9.
const MAX_IMAGES = 8;

// Generous for a screenshot, small enough that a mis-aimed ref at a video or a core
// dump is refused rather than copied into the state dir.
const MAX_BYTES = 8 * 1024 * 1024;

// No .svg, deliberately: an SVG is a script-bearing document, and these are rendered by
// <img> in a same-origin, allow-same-origin iframe that carries the user's authority.
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Only ever files WE named — `<itemId>-<n><ext>`, and item ids are `w<seq>`.
const SERVABLE_RE = /^w\d+-\d+\.(png|jpg|jpeg|gif|webp)$/;

// Resolved lazily, never at module scope: paths.js says so, and a unit test that
// repoints HOME before requiring this file must still land on a scratch path.
function imagesDir() {
  return statePath('workshop-images');
}

/**
 * fs.realpathSync, but a path that does not exist is a clean miss rather than a throw.
 *
 * Load-bearing for the containment check below, and for the roots it is checked
 * against: on macOS os.tmpdir() is `/var/folders/…`, itself under a symlinked `/var`,
 * so comparing a realpath'd file against a non-realpath'd root fails every time. Both
 * sides go through here or neither does.
 */
function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Where a path-shaped ref is allowed to point: the calling session's repo root and its
 * cwd. A worktree session's cwd is inside its repo root, so in practice this is one
 * directory — but a session running outside a repo has only a cwd, and a session whose
 * cwd is a subdirectory of a repo legitimately wants to name a file elsewhere in it.
 */
function allowedRoots(entry, ctx) {
  const roots = [];
  let cwd = (entry && entry.cwd) || '';
  let repoRoot = '';
  try {
    const paths = ctx.sessionPaths ? ctx.sessionPaths(entry) : null;
    if (paths) {
      cwd = paths.cwd || cwd;
      repoRoot = paths.repoRoot || '';
    }
  } catch { /* fall back to the entry's own cwd */ }
  for (const root of [repoRoot, cwd]) {
    const real = root ? realOrNull(root) : null;
    if (real && !roots.includes(real)) roots.push(real);
  }
  return roots;
}

/**
 * One ref — a screenshot id or a path — to a readable source file, or a refusal with a
 * reason the agent can act on.
 *
 * The realpath comes BEFORE the containment test, and that ordering is the whole
 * security property. ctx.pathInside is a pure string prefix test (server.js) that does
 * no canonicalization whatsoever, so `<repo>/../../../etc/passwd` and a symlink in the
 * repo pointing at ~/.ssh both satisfy it happily. Resolving first is what makes it
 * mean containment rather than spelling.
 */
function resolveRef(ref, { entry, ctx } = {}) {
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (!raw) return { ok: false, reason: 'empty' };

  // A screenshot id first: it is the intended path, and it needs no filesystem
  // reasoning at all because the id is a key in a map WE own.
  if (ctx && ctx.screenshots && ctx.screenshots.has(raw)) {
    const source = ctx.getScreenshotPath(raw);
    if (!realOrNull(source)) return { ok: false, reason: 'screenshot-file-missing' };
    return { ok: true, source, ext: '.png' };
  }

  // Anything else is only a path if it looks like one. A bare token that is not a live
  // screenshot id is far more likely a stale or invented id than a relative filename,
  // and saying so is more useful than "not found".
  if (!raw.includes('/')) return { ok: false, reason: 'unknown-screenshot-id' };

  const roots = allowedRoots(entry, ctx);
  if (roots.length === 0) return { ok: false, reason: 'no-session-directory' };

  const abs = path.isAbsolute(raw) ? raw : path.resolve(roots[roots.length - 1], raw);
  const real = realOrNull(abs);
  if (!real) return { ok: false, reason: 'not-found' };

  const inside = roots.some((root) => (ctx && ctx.pathInside ? ctx.pathInside(real, root) : false));
  if (!inside) return { ok: false, reason: 'outside-project' };

  const ext = path.extname(real).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { ok: false, reason: 'unsupported-type' };

  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
  if (stat.size > MAX_BYTES) return { ok: false, reason: 'too-large' };

  return { ok: true, source: real, ext };
}

/**
 * Copy every accepted ref into the store, named after the item that owns it.
 *
 * Returns both halves — what landed and what did not, with reasons. share_result reports
 * the skips in its own return text: an agent that thinks it attached a screenshot and
 * silently did not will write its next result the same way.
 */
function ingest(item, refs, { entry, ctx } = {}) {
  const images = [];
  const skipped = [];
  const list = Array.isArray(refs) ? refs.slice(0, MAX_IMAGES) : [];
  if (list.length === 0) return { images, skipped };

  const dir = imagesDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { images, skipped: list.map((ref) => ({ ref: String(ref), reason: 'store-unwritable' })) };
  }

  for (const ref of list) {
    const resolved = resolveRef(ref, { entry, ctx });
    if (!resolved.ok) {
      skipped.push({ ref: String(ref), reason: resolved.reason });
      continue;
    }
    // Numbered by what LANDED, not by input position, so the files an item owns are a
    // dense run and sweepOrphans has nothing to reason about.
    const file = `${item.id}-${images.length}${resolved.ext}`;
    try {
      fs.copyFileSync(resolved.source, path.join(dir, file));
      images.push({ file, ref: String(ref) });
    } catch {
      skipped.push({ ref: String(ref), reason: 'copy-failed' });
    }
  }
  return { images, skipped };
}

/**
 * Delete every file in the store no live item names.
 *
 * This is what bounds the directory: retain() evicts the oldest closed results from
 * workshop.json, and without this their PNGs would stay on disk forever. Written as a
 * sweep over what EXISTS rather than an unlink at eviction time because the two
 * lifetimes are already coupled through one file — a sweep cannot leak a file that a
 * missed callback would, and it self-heals a store left inconsistent by a crash between
 * the copy and the save.
 *
 * Never throws: it runs inside share_result, and losing a result to a readdir failure
 * would be a spectacular trade.
 */
function sweepOrphans(items) {
  const dir = imagesDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;                       // no store yet, or unreadable — nothing to sweep
  }
  const live = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    for (const img of (item && Array.isArray(item.images)) ? item.images : []) {
      if (img && img.file) live.add(img.file);
    }
  }
  let removed = 0;
  for (const file of files) {
    if (live.has(file)) continue;
    try {
      fs.unlinkSync(path.join(dir, file));
      removed++;
    } catch { /* a file we cannot remove is not worth failing a share over */ }
  }
  return removed;
}

/**
 * The absolute path a GET may serve, or null.
 *
 * Deliberately dumb, and it can afford to be: the name must match a pattern only this
 * module ever produces, and the result must still resolve inside the store. Every
 * question about where the bytes came from was settled at ingest.
 */
function servePath(file) {
  if (typeof file !== 'string' || !SERVABLE_RE.test(file)) return null;
  const dir = realOrNull(imagesDir());
  if (!dir) return null;
  const full = path.join(dir, file);
  // The regex already excludes '/' and '..', so this can only fail if something very
  // strange is going on — which is exactly when a second check earns its keep.
  if (path.dirname(full) !== dir) return null;
  return realOrNull(full);
}

module.exports = {
  imagesDir,
  resolveRef,
  ingest,
  sweepOrphans,
  servePath,
  MAX_IMAGES,
  MAX_BYTES,
  ALLOWED_EXT,
};

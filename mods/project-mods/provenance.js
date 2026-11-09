/**
 * Project-mod provenance: a mod's code runs only in a version this machine has vouched for.
 *
 * A project mod is a page from a repo, served from Deep Steve's own origin into an iframe with
 * allow-same-origin, so its scripts can do anything the UI can, including open a terminal and
 * type into it. Before this, a `.deepsteve/mods/` that arrived with a clone or a pull ran the
 * moment its project was in view. Now a VERSION (a hash over the mod's code files) may run only
 * when one of two things vouches for it:
 *
 *   - an agent wrote it through Deep Steve's own tools (create/update/edit_project_mod), which
 *     are the only agent writes the daemon can actually see; or
 *   - the user approved it, on the page the server shows in the mod's place.
 *
 * Anything else, such as a git pull, a branch switch, an agent's own Edit or Write tool or a
 * script, produces a version nobody vouched for, and the server serves the approval page
 * instead of the code. A write through the tools only carries approval FORWARD: editing an
 * unapproved mod through them does not launder the bytes it didn't write.
 *
 * What the hash covers: every file the browser could run, which is everything except DATA_EXTS
 * (JSON, text, images, audio, video, fonts). Those change constantly in mods that keep state
 * beside their page, and the asset route serves them with nosniff, so they cannot execute. The
 * entry page and mod.json are covered whatever their extension, because the page route serves
 * the entry as HTML and the manifest decides what the entry is. Approved code that turns data
 * into markup (innerHTML from a .json) is that code's own bug; the approval page says data is
 * not covered.
 *
 * Symlinks are followed only while they stay inside the mod's repo, and each link's target is
 * part of the hash, so retargeting one makes a new version. A link that leaves the repo makes
 * the mod unapprovable, rather than letting it serve whatever it points at.
 *
 * Dotfiles are skipped: the asset route never serves them, so they cannot run, and Finder's
 * .DS_Store would otherwise revoke an approval on its own. Dot-DIRECTORIES are walked, because
 * the files inside one are served.
 *
 * The record lives in the state dir, never the repo: a repo that could ship its own approval
 * would make the whole check decorative.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_FILE = 'project-mod-provenance.json';
const MANIFEST = 'mod.json';

// Inert when served: none of these MIME types runs script, and nosniff stops a browser from
// guessing otherwise. SVG is deliberately absent (it carries <script>), and so are PDF and
// anything unknown, which are covered.
const DATA_EXTS = new Set([
  'json', 'jsonl', 'ndjson', 'geojson', 'csv', 'tsv', 'txt', 'log', 'md', 'markdown',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic',
  'mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'mp4', 'm4v', 'webm', 'mov',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

// Bounds on what one approval may cover. Past these the mod is unapprovable, with the reason
// on its approval page, rather than the daemon stalling to hash it.
const MAX_FILES = 5000;
const MAX_BYTES = 100 * 1024 * 1024;
// Approvals kept. Each agent edit through the tools adds one, so this is a ring, oldest out.
const MAX_RECORDS = 5000;

const HASH_RE = /^[0-9a-f]{64}$/;

const isInside = (p, base) => p === base || p.startsWith(base + path.sep);
const toPosix = (rel) => rel.split(path.sep).join('/');

/** Is this path (relative to the mod dir) a data file the hash leaves out? */
function isData(rel) {
  return DATA_EXTS.has(path.extname(rel).slice(1).toLowerCase());
}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Walk a mod directory, collecting the files the hash covers (with the stats that say whether
 * they changed) and every symlink. Stats only, no bytes: the cache compares this walk's
 * signature and reads files only when something moved.
 *
 * ctimeMs and ino are in the signature on purpose. mtime alone can be set back by anything
 * that writes a file (`touch -d`, an archive extract); ctime cannot, short of the clock.
 */
function walk(dir, { root, entry } = {}) {
  const out = { files: [], links: [], bytes: 0, error: null };
  const realRoot = realOrResolved(root || dir);
  const entryRel = entry ? toPosix(path.normalize(entry)) : null;

  function fail(msg) { if (!out.error) out.error = msg; }

  function visitDir(abs, rel, ancestors) {
    let names;
    try {
      names = fs.readdirSync(abs, { withFileTypes: true }).map(d => d.name).sort();
    } catch {
      return fail(`cannot read ${rel || 'the mod directory'}`);
    }
    for (const name of names) {
      if (out.error) return;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let lst;
      try { lst = fs.lstatSync(childAbs); } catch { continue; }   // vanished mid-walk

      let st = lst;
      if (lst.isSymbolicLink()) {
        let target;
        try { target = fs.readlinkSync(childAbs); } catch { return fail(`cannot read the link ${childRel}`); }
        out.links.push({ rel: childRel, target });
        let real;
        try { real = fs.realpathSync(childAbs); } catch { continue; }   // dangling: serves nothing
        if (!isInside(real, realRoot)) return fail(`${childRel} links outside the repository (to ${target})`);
        try { st = fs.statSync(childAbs); } catch { continue; }
        if (st.isDirectory()) {
          if (ancestors.has(real)) return fail(`${childRel} is a symlink loop`);
          visitDir(childAbs, childRel, new Set([...ancestors, real]));
          continue;
        }
      } else if (lst.isDirectory()) {
        visitDir(childAbs, childRel, new Set([...ancestors, realOrResolved(childAbs)]));
        continue;
      }

      if (!st.isFile()) continue;
      const covered = childRel === entryRel || childRel === MANIFEST
        || (!name.startsWith('.') && !isData(childRel));
      if (!covered) continue;
      out.files.push({ rel: childRel, abs: childAbs, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino });
      out.bytes += st.size;
      if (out.files.length > MAX_FILES) return fail(`it has more than ${MAX_FILES} code files`);
      if (out.bytes > MAX_BYTES) return fail(`its code files add up to more than ${MAX_BYTES / (1024 * 1024)} MB`);
    }
  }

  const realDir = realOrResolved(dir);
  if (!isInside(realDir, realRoot)) fail('the mod directory is outside its repository');
  else visitDir(dir, '', new Set([realDir]));
  return out;
}

const signatureOf = (w) => JSON.stringify([
  w.error,
  w.links.map(l => [l.rel, l.target]),
  w.files.map(f => [f.rel, f.size, f.mtimeMs, f.ctimeMs, f.ino]),
]);

/** Hash what a walk found. Reads every covered file; the size hashed is the bytes actually read. */
function hashWalk(w) {
  if (w.error) return { hash: null, files: [], links: [], error: w.error };
  const h = crypto.createHash('sha256');
  h.update('deepsteve-project-mod-v1\0');
  for (const l of w.links) h.update(`L\0${l.rel}\0${l.target}\0`);
  const files = [];
  for (const f of w.files) {
    let buf;
    try { buf = fs.readFileSync(f.abs); } catch { return { hash: null, files: [], links: [], error: `cannot read ${f.rel}` }; }
    h.update(`F\0${f.rel}\0${buf.length}\0`);
    h.update(buf);
    h.update('\0');
    files.push({ path: f.rel, size: buf.length });
  }
  return { hash: h.digest('hex'), files, links: w.links.map(l => ({ path: l.rel, target: l.target })), error: null };
}

/** The version of a mod directory, computed from scratch. */
function versionOf(dir, opts) {
  return hashWalk(walk(dir, opts));
}

/**
 * versionOf with a cache keyed on the walk's signature, because the list route asks for every
 * mod's version on every refetch. The walk still runs each time (it is stats only); the files
 * are re-read and re-hashed only when a covered file or a link changed.
 */
function createVersionCache() {
  const cache = new Map();
  return {
    get(dir, opts = {}) {
      const w = walk(dir, opts);
      const sig = signatureOf(w);
      const hit = cache.get(dir);
      if (!opts.fresh && hit && hit.sig === sig) return hit.version;
      const version = hashWalk(w);
      cache.set(dir, { sig, version });
      return version;
    },
    clear() { cache.clear(); },
  };
}

/**
 * The approvals: version hash → who vouched for it. Loaded lazily, written atomically. A
 * missing or unreadable file is an EMPTY record, so a corrupt store fails closed (nothing runs
 * until it is approved again) rather than open.
 */
function createStore(file, { now = Date.now, max = MAX_RECORDS } = {}) {
  let versions = null;

  function load() {
    if (versions) return versions;
    versions = Object.create(null);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const v = raw && raw.versions;
      if (v && typeof v === 'object') {
        for (const [k, info] of Object.entries(v)) if (HASH_RE.test(k) && info && typeof info === 'object') versions[k] = info;
      }
    } catch { /* missing or corrupt: start empty */ }
    return versions;
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, versions }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    has(hash) {
      return typeof hash === 'string' && HASH_RE.test(hash) && hash in load();
    },
    get(hash) {
      return this.has(hash) ? { ...load()[hash] } : null;
    },
    record(hash, info = {}) {
      if (typeof hash !== 'string' || !HASH_RE.test(hash)) return false;
      const v = load();
      delete v[hash];                       // re-insert, so a re-approval counts as recent
      v[hash] = { ...info, at: now() };
      const keys = Object.keys(v);
      if (keys.length > max) {
        keys.sort((a, b) => (v[a].at || 0) - (v[b].at || 0));
        for (const k of keys.slice(0, keys.length - max)) delete v[k];
      }
      save();
      return true;
    },
    size() { return Object.keys(load()).length; },
  };
}

module.exports = {
  STORE_FILE, DATA_EXTS, MAX_FILES, MAX_BYTES, MAX_RECORDS,
  isData, walk, versionOf, createVersionCache, createStore,
};

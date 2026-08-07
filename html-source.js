/**
 * Shared "where does this HTML come from" resolver (#599, #618).
 *
 * Two features let an agent hand us a page: display tabs (mods/display-tab) and
 * Project Mods (mods/project-mods). Both take EITHER an inline `html` string OR a
 * `file_path` the server reads itself — the second form is the cheap one, because
 * the model emits a path instead of the whole document — plus an optional literal
 * `replacements` map so a file on disk can stay a reusable template.
 *
 * It lives at the repo root rather than inside either mod because cross-mod
 * require()s couple two mods that have nothing else to do with each other. Root
 * *.js files are copied by restart.sh/release.sh automatically (same reason
 * git-root.js lives here), so this ships without a deploy-script change.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SOURCE_ERR = 'Pass exactly one of html or file_path.';

/**
 * Resolve the HTML for a create/update call from either an inline string or a file on
 * disk, applying the optional literal `replacements` map. Returns { html } or { error };
 * never throws.
 */
function resolveHtml({ html, file_path, replacements }) {
  const hasHtml = typeof html === 'string';
  const hasPath = typeof file_path === 'string' && file_path.trim() !== '';
  if (hasHtml === hasPath) return { error: SOURCE_ERR };

  let source = html;
  if (hasPath) {
    let p = file_path.trim();
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) {
      return { error: `file_path must be an absolute path (got "${file_path}").` };
    }
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return { error: `Cannot read file_path "${p}": ${e.code === 'ENOENT' ? 'no such file' : e.message}.` };
    }
    if (st.isDirectory()) return { error: `file_path "${p}" is a directory, not a file.` };
    if (st.size > MAX_FILE_BYTES) {
      return { error: `file_path "${p}" is ${st.size} bytes, over the ${MAX_FILE_BYTES}-byte limit.` };
    }
    try {
      source = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return { error: `Cannot read file_path "${p}": ${e.message}.` };
    }
  }

  let applied = 0;
  let unmatched = 0;
  if (replacements && typeof replacements === 'object') {
    const keys = Object.keys(replacements);
    if (keys.some(k => k === '')) return { error: 'replacements keys must not be empty.' };
    // Longest key first so overlapping placeholders substitute deterministically.
    // split/join (not String.replace) so $-sequences in values stay literal.
    for (const key of keys.sort((a, b) => b.length - a.length)) {
      const parts = source.split(key);
      if (parts.length > 1) applied++; else unmatched++;
      source = parts.join(String(replacements[key]));
    }
  }

  return { html: source, applied, unmatched };
}

module.exports = { resolveHtml, MAX_FILE_BYTES, SOURCE_ERR };

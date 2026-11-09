/**
 * The page a project mod's URL serves while its current version is unapproved (see
 * provenance.js). It replaces the mod everywhere the mod could load: the pinned tab, the view,
 * a /v1/project-mod link opened top-level, a restored tab.
 *
 * Everything on it that came from the repo (name, icon, paths, file names, the page source) is
 * attacker-controlled, so all of it is escaped, and the CSP allows no script at all. Approval
 * is a plain form POST, which needs no script: the browser sends our Origin and the Strict
 * cookie with it, and the 303 that answers it navigates the same frame to the real page, whose
 * `load` re-injects the window.deepsteve bridge exactly as a first load would.
 *
 * The form carries the hash of the version shown, so a click approves what the user read and
 * nothing else: if the files changed while the page was open, the POST is refused and the page
 * is drawn again for the new version.
 */

const SOURCE_PREVIEW_BYTES = 200 * 1024;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'";

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {object} p
 * @param {string} p.id          mod id (8 hex, minted by the server)
 * @param {string} p.name        manifest name (untrusted)
 * @param {string} p.project     repo root
 * @param {string} p.dir         mod directory, relative to the repo
 * @param {string} p.entry       entry file, relative to the mod directory (untrusted)
 * @param {object} p.version     { hash, files, links, error } from provenance.versionOf
 * @param {string|null} p.source the entry page's source, or null
 * @param {string|null} p.notice a line to show above everything, e.g. "it changed while open"
 */
function renderApprovalPage({ id, name, project, dir, entry, version, source = null, notice = null }) {
  const files = version.files || [];
  const links = version.links || [];
  const fileRows = files.map(f => `<li><code>${escapeHtml(f.path)}</code> <span class="muted">${formatSize(f.size)}</span></li>`).join('');
  const linkRows = links.map(l => `<li><code>${escapeHtml(l.path)}</code> → <code>${escapeHtml(l.target)}</code> <span class="muted">symlink</span></li>`).join('');
  let preview = '';
  if (typeof source === 'string') {
    const clipped = source.length > SOURCE_PREVIEW_BYTES;
    preview = `<details><summary>Source of <code>${escapeHtml(entry)}</code>${clipped ? ' (first 200 KB)' : ''}</summary>`
      + `<pre>${escapeHtml(clipped ? source.slice(0, SOURCE_PREVIEW_BYTES) : source)}</pre></details>`;
  }
  const action = version.error
    ? `<p class="refused">This mod can't be approved: ${escapeHtml(version.error)}.</p>`
    : `<form method="post" action="/api/project-mods/${encodeURIComponent(id)}/approve">`
      + `<input type="hidden" name="hash" value="${escapeHtml(version.hash)}">`
      + '<button type="submit">Approve and run</button></form>';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>Approve ${escapeHtml(name)}?</title>`
    + '<style>'
    + 'body{font:14px/1.55 -apple-system,system-ui,sans-serif;max-width:46rem;margin:6vh auto;padding:0 1.5rem;color:#1d1d1f;background:#f6f5f2}'
    + 'h1{font-size:1.25rem;margin:0 0 .75rem}h2{font-size:.95rem;margin:1.5rem 0 .4rem}'
    + 'code{font:12px/1.4 ui-monospace,Menlo,monospace}ul{padding-left:1.2rem;margin:.25rem 0}li{margin:.1rem 0}'
    + '.muted{color:#6e6e73}.notice{background:#fff4d6;border:1px solid #e8c25a;padding:.6rem .8rem;border-radius:6px}'
    + '.refused{color:#b3261e;font-weight:600}dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem;margin:.75rem 0}dt{color:#6e6e73}dd{margin:0;word-break:break-all}'
    + 'pre{background:#fff;border:1px solid #ddd;padding:.75rem;overflow:auto;max-height:24rem;font:12px/1.4 ui-monospace,Menlo,monospace}'
    + 'button{font:inherit;font-weight:600;padding:.5rem 1.1rem;border-radius:6px;border:0;background:#2458c6;color:#fff;cursor:pointer;margin-top:1.25rem}'
    + '@media (prefers-color-scheme:dark){body{color:#e4e2dc;background:#131417}.muted,dt{color:#9a9890}'
    + '.notice{background:#3a3220;border-color:#7a6326}pre{background:#1c1d21;border-color:#33343a}.refused{color:#f2b8b5}}'
    + '</style></head><body>'
    + (notice ? `<p class="notice">${escapeHtml(notice)}</p>` : '')
    + `<h1>Approve “${escapeHtml(name)}” before it runs</h1>`
    + '<p>A project mod runs with the same access as Deep Steve itself: its page can open terminals and type commands into them. '
    + 'This version was not written through Deep Steve\'s own tools and you have not approved it. It may have come from a clone, '
    + 'a pull, a branch switch, or an edit made outside Deep Steve.</p>'
    + `<dl><dt>Project</dt><dd><code>${escapeHtml(project)}</code></dd>`
    + `<dt>Folder</dt><dd><code>${escapeHtml(dir)}</code></dd>`
    + `<dt>Entry page</dt><dd><code>${escapeHtml(entry)}</code></dd></dl>`
    + (version.error ? '' : `<h2>What this approval covers</h2><ul>${fileRows}${linkRows}</ul>`
      + '<p class="muted">Data files (JSON, text, images, audio, video, fonts) are not covered and can change without asking again. '
      + 'Any change to a covered file, made anywhere but Deep Steve\'s own tools, asks again.</p>')
    + preview
    + action
    + '</body></html>';
}

module.exports = { renderApprovalPage, escapeHtml, CSP, SOURCE_PREVIEW_BYTES };

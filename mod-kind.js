/**
 * What KIND of thing is this mod (#673).
 *
 * The Mods modal used to be one flat alphabetical list of mods and skills together, so the
 * nine skills — all named `/something` — sorted into a wall at the top and you scrolled past
 * them to reach a mod. It is now grouped, one section per kind, and this is the rule that
 * decides which section a manifest lands in.
 *
 * It lives at the repo root, not inside server.js, so a plain `node --test` can require it
 * without booting a daemon — the same reason html-source.js and git-root.js are here. Root
 * *.js files are copied by restart.sh and release.sh by glob, and package.json's `files` has
 * `/*.js`, so it ships with no deploy-script change.
 *
 * `kind` is a PRESENTATION GROUPING, not a behaviour predicate. getApps(), getNewTabItems()
 * and every `display === 'panel'` branch keep reading the manifest fields directly: they ask
 * "how does this mount", which is a different question from "which heading does it live
 * under". The two answers deliberately disagree for apps and for games.
 */

// Every value modKind() can return, plus the two the wire adds: 'skill' for the pseudo-mods
// GET /api/mods appends, and 'available' which the CLIENT stamps on a catalog entry that is
// not installed (see public/js/mod-groups.js — a catalog row carries no entry/display/tags,
// so running the ladder over it would file every downloadable mod under 'background').
const MOD_KINDS = ['app', 'panel', 'fullscreen', 'game', 'tab', 'background', 'skill', 'available'];

/**
 * @param {object} manifest a mod.json, or a GET /api/mods row (both carry the same fields)
 * @returns {string} one of MOD_KINDS
 */
function modKind(manifest) {
  if (!manifest) return 'fullscreen';
  // Skills reach this shape only if something calls us on a wire row; the server stamps
  // 'skill' directly. Answering here anyway keeps the function total for either input.
  if (manifest.type === 'skill') return 'skill';
  // No entry means no UI at all. Checked before `app`/`display` only because it can be:
  // validate-mods.js already rejects `app: true`, `display: "panel"` and `display: "tab"`
  // without an entry, so nothing that could be an app or a panel can fall in here. It is
  // what gives the right answer for the one real ambiguity — a tools-only mod tagged
  // `games` is not a game you can play.
  if (!manifest.entry) return 'background';
  // A stronger statement about what the thing IS than how it draws (#661).
  if (manifest.app === true) return 'app';
  // Ahead of `display` on purpose: Games is a kind, so a panel-shaped game belongs there
  // rather than swelling Panels. Today all six games are fullscreen and the order does not
  // bite, which is exactly when to decide it.
  if (Array.isArray(manifest.tags) && manifest.tags.includes('games')) return 'game';
  if (manifest.display === 'panel') return 'panel';
  if (manifest.display === 'tab') return 'tab';
  return 'fullscreen';
}

module.exports = { modKind, MOD_KINDS };

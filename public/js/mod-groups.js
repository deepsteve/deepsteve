/**
 * Grouping, search and enabled-state for the Mods modal (#673).
 *
 * Pure: no DOM, no fetch, no module state. That is the point — the modal's own rendering is
 * ~80 lines of DOM glue on top of this, and everything worth asserting (nothing vanishes,
 * the order is fixed, an empty group leaves no heading, search spans every section, the two
 * enabled-state sources stay apart) is assertable here with no fake browser at all.
 *
 * It NEVER re-derives the taxonomy. `kind` is decided once, server-side, in mod-kind.js and
 * arrives on the wire; this file only decides the order and the words. A guard test asserts
 * that `display`, `entry`, `tags` and `'games'` appear nowhere below.
 */

// Section order, top to bottom. Automations are not in here: they do not come from
// /api/mods and are not mods — the modal renders their section above these.
//
// `available` is a catalog entry that is not installed. The client stamps that kind itself
// (a /api/mods/catalog row carries no entry/display/tags, so running the server ladder over
// it would file every downloadable mod under `background`). It sits after Skills because it
// is the one section that is about what you do NOT have.
//
// `other` is the catch-all. A kind this file has not been taught about still renders under a
// heading instead of silently disappearing from the UI — the real failure mode of a group-by.
export const MOD_GROUPS = [
  { kind: 'app', label: 'Apps' },
  { kind: 'panel', label: 'Panels' },
  { kind: 'fullscreen', label: 'Fullscreen' },
  { kind: 'game', label: 'Games' },
  { kind: 'tab', label: 'Tabs' },
  { kind: 'background', label: 'Background' },
  { kind: 'skill', label: 'Skills' },
  { kind: 'available', label: 'Available' },
  { kind: 'other', label: 'Other' },
];

// The one selector three separate code paths reach a row through: _refreshCardToggles(),
// the cross-tab `storage` listener, and handleSkillsChanged(). Importing it is what keeps a
// rename from leaving one of them behind.
export const MOD_ROW_SELECTOR = '.mod-row[data-mod-id]';

const KNOWN_KINDS = new Set(MOD_GROUPS.map(g => g.kind));

/**
 * Enabled state comes from two different places and that is not an accident: a skill is
 * installed as .md files on the server (settings.enabledSkills, so `mod.enabled` off the
 * wire), a mod is a per-browser localStorage preference (the enabledMods Set). Conflating
 * them is what made the old `Enabled` filter pill a third axis jammed in with the kinds.
 */
export function isModEnabled(mod, enabledIds) {
  if (!mod) return false;
  if (mod.type === 'skill') return !!mod.enabled;
  return !!enabledIds && enabledIds.has(mod.id);
}

/** Search spans every section — that is the half of the old pills worth keeping. */
export function matchesQuery(mod, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const haystacks = [
    mod.name, mod.id, mod.description, mod.slashCommand,
    (mod.tags || []).join(' '),
    // Tool names are searchable because the expanded row now shows them: typing
    // "screenshot" should find the panel that registers screenshot_capture.
    (mod.tools || []).map(t => t && t.name).filter(Boolean).join(' '),
  ];
  return haystacks.some(h => typeof h === 'string' && h.toLowerCase().includes(q));
}

/**
 * Bucket mods into ordered sections. Empty sections are DROPPED, not returned empty — a
 * heading with nothing under it is worse than the flat list this replaces.
 *
 * There is deliberately no section argument. The chips above the list jump to a section;
 * they do not filter to one. Having no parameter to pass is what stops a future change from
 * quietly turning them back into the exclusive pills the issue was about.
 */
export function groupMods(mods, { query = '', enabledOnly = false, enabledIds = null } = {}) {
  const buckets = new Map();
  for (const mod of mods || []) {
    if (!matchesQuery(mod, query)) continue;
    if (enabledOnly && !isModEnabled(mod, enabledIds)) continue;
    const kind = KNOWN_KINDS.has(mod.kind) ? mod.kind : 'other';
    if (!buckets.has(kind)) buckets.set(kind, []);
    buckets.get(kind).push(mod);
  }
  // Input order is preserved inside a section, so GET /api/mods' localeCompare (server.js)
  // stays the only ordering and every section is alphabetical for free.
  return MOD_GROUPS
    .filter(g => buckets.get(g.kind)?.length)
    .map(g => ({ kind: g.kind, label: g.label, items: buckets.get(g.kind) }));
}

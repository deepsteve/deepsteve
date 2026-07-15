/**
 * Shortcut registry — the single source of truth for deepsteve's key bindings.
 *
 * Every module that owns a global shortcut registers it here and uses the matcher
 * this module hands back. That makes the registry load-bearing: there is no way to
 * change a binding without editing its entry, so the shortcuts overlay
 * (shortcuts-help.js) can't drift from the real bindings.
 *
 *   register({...})     — a real binding. Returns matches(e), the function the
 *                         module's keydown handler must use.
 *   registerInfo({...}) — doc-only, for bindings the matcher can't express
 *                         (hold-to-activate, chords, keys consumed inside xterm).
 *                         Lives next to the real handler so they're edited together.
 *
 * Modules call register() at module scope, not in init(), so the entry and the
 * matcher are one statement and can't be separated.
 */

export const GROUPS = ['General', 'Tabs', 'Views', 'Terminal'];

const entries = [];

export function parseShortcut(str) {
  const parts = str.split('+');
  const key = parts.pop().toLowerCase();
  const mods = {
    meta: parts.some(p => p.toLowerCase() === 'meta'),
    ctrl: parts.some(p => p.toLowerCase() === 'ctrl'),
    shift: parts.some(p => p.toLowerCase() === 'shift'),
    alt: parts.some(p => p.toLowerCase() === 'alt'),
  };
  return { key, mods };
}

export function formatShortcut(shortcutStr) {
  if (!shortcutStr) return '';
  const parts = shortcutStr.split('+');
  return parts.map(p => {
    const low = p.toLowerCase();
    if (low === 'meta') return '⌘';
    if (low === 'ctrl') return '⌃';
    if (low === 'alt') return '⌥';
    if (low === 'shift') return '⇧';
    return p.toUpperCase();
  }).join('');
}

// Strict equality on all four modifiers. This is what keeps Ctrl+F from matching
// a Meta+f binding, so it passes through to the PTY for vim's <C-f>.
function modsMatch(e, mods) {
  return mods.meta === e.metaKey && mods.ctrl === e.ctrlKey
      && mods.shift === e.shiftKey && mods.alt === e.altKey;
}

export function matchesShortcut(e, str) {
  const sc = parseShortcut(str);
  if (!e.key || e.key.toLowerCase() !== sc.key) return false;
  return modsMatch(e, sc.mods);
}

// Canonical key token -> KeyboardEvent.code. Only letters/digits have a
// mechanical mapping; null means "no code equivalent" (see register()).
function keyToCode(key) {
  if (/^[a-z]$/.test(key)) return 'Key' + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return 'Digit' + key;
  return null;
}

/**
 * Declare a real key binding and get back the matcher to use for it.
 *
 * @param {string}         entry.id           stable + unique
 * @param {string}         entry.group        one of GROUPS
 * @param {string}         entry.description  shown in the overlay
 * @param {string|string[]} [entry.shortcut]    canonical string(s) for a hard-coded binding
 * @param {() => string|string[]} [entry.getShortcut] live value for a configurable binding
 *                                            (pass exactly one of shortcut / getShortcut)
 * @param {'key'|'code'}   [entry.match='key'] compare e.key (layout character) or
 *                                            e.code (physical key). See below.
 * @param {() => boolean}  [entry.isEnabled]  live flag; overlay hides entries reporting false
 * @param {'or'|'then'}    [entry.combine='or'] how the overlay joins multiple keys
 * @returns {(e: KeyboardEvent) => boolean}
 */
export function register(entry) {
  const { id, group, description, shortcut, getShortcut, match = 'key', isEnabled, combine = 'or' } = entry;
  if (!id || !group || !description) {
    throw new Error(`[shortcuts] ${id}: id, group and description are required`);
  }
  if (!!shortcut === !!getShortcut) {
    throw new Error(`[shortcuts] ${id}: pass exactly one of shortcut / getShortcut`);
  }

  const resolve = getShortcut || (() => shortcut);
  const list = () => [].concat(resolve()).filter(Boolean);

  let matches;
  if (match === 'code') {
    // Code-space pins a binding to a physical key so it survives non-QWERTY layouts.
    // The settings recorder only ever emits e.key tokens, so a configurable shortcut
    // can't drive a code matcher — it would silently never fire. Resolve the codes
    // once, here, and throw at import time rather than shipping a dead binding.
    if (!shortcut) throw new Error(`[shortcuts] ${id}: match:'code' requires a static shortcut`);
    const specs = list().map(s => {
      const sc = parseShortcut(s);
      const code = keyToCode(sc.key);
      if (!code) throw new Error(`[shortcuts] ${id}: no KeyboardEvent.code for key '${sc.key}'`);
      return { code, mods: sc.mods };
    });
    matches = (e) => specs.some(sp => e.code === sp.code && modsMatch(e, sp.mods));
  } else {
    matches = (e) => list().some(s => matchesShortcut(e, s));
  }

  put({ id, group, description, kind: 'binding', list, isEnabled, combine });
  return matches;
}

/**
 * Declare a binding the matcher can't express. `keys` holds already-formatted
 * display tokens — one <kbd> each.
 */
export function registerInfo(entry) {
  const { id, group, description, keys, isEnabled, combine = 'or' } = entry;
  if (!id || !group || !description || !Array.isArray(keys) || !keys.length) {
    throw new Error(`[shortcuts] registerInfo needs id, group, description and keys: ${id}`);
  }
  put({ id, group, description, kind: 'info', list: () => keys, isEnabled, combine });
}

// Last-write-wins on a duplicate id, keeping the original slot. Modules are
// singletons in the browser so this never fires there — but the headless unit tests
// re-import a module with a ?v= query to reset its state, which re-runs its
// top-level register() against this (single) registry instance. Appending would
// duplicate rows.
function put(rec) {
  const i = entries.findIndex(x => x.id === rec.id);
  if (i >= 0) entries[i] = rec; else entries.push(rec);
}

// Unknown groups sort after the known ones rather than vanishing — a module that
// forgets to add its group to GROUPS still shows up in the overlay.
function groupRank(g) {
  const i = GROUPS.indexOf(g);
  return i >= 0 ? i : GROUPS.length;
}

/**
 * Snapshot for the overlay. Live: shortcut strings and enabled flags are read from
 * the owning module on every call, so a rebind needs no cache invalidation.
 *
 * @returns {Array<{id, group, description, kind, keys: string[], combine, enabled}>}
 */
export function getAll() {
  return entries
    .map((rec, i) => ({
      id: rec.id,
      group: rec.group,
      description: rec.description,
      kind: rec.kind,
      // Uniform shape: bindings format their live combos, info entries pass through.
      keys: rec.kind === 'binding' ? rec.list().map(formatShortcut) : rec.list(),
      combine: rec.combine,
      enabled: rec.isEnabled ? !!rec.isEnabled() : true,
      _i: i,
    }))
    .sort((a, b) => {
      const ra = groupRank(a.group), rb = groupRank(b.group);
      if (ra !== rb) return ra - rb;
      if (ra === GROUPS.length && a.group !== b.group) return a.group < b.group ? -1 : 1;
      return a._i - b._i; // within a group: module evaluation order
    })
    .map(({ _i, ...e }) => e);
}

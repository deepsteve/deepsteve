/**
 * Keyboard Shortcuts overlay (#549) — lists every deepsteve binding in one place.
 *
 * The list is rendered from the shortcuts.js registry, never hand-maintained, so it
 * can't drift from the real bindings. Follows the same init/setEnabled/setShortcut
 * pattern as command-palette.js.
 *
 * Default binds TWO combos. On macOS, AppKit auto-assigns ⌘⇧/ to the Help menu's
 * Search field for any app with a Help menu — Firefox and Chrome both have one — and
 * a menu-bar key equivalent is consumed before the page ever sees the keydown. When
 * that happens ⌘/ still opens this overlay, so the feature can't ship dead. (The web
 * convention of a bare `?` isn't available to us: every keystroke must reach the PTY.)
 */

import { register, getAll } from './shortcuts.js';

let enabled = true;
let shortcut = ['Meta+Shift+?', 'Meta+/'];
let isOpen = false;

let callbacks = {};
let overlay = null;

const matchesShortcut = register({
  id: 'shortcuts-help',
  group: 'General',
  description: 'Show this list of keyboard shortcuts',
  getShortcut: () => shortcut,
  isEnabled: () => enabled,
});

function onKeyDown(e) {
  if (!enabled) return;

  if (matchesShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen) close(); else open();
    return;
  }

  if (!isOpen) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    // stopPropagation from a capture-phase listener halts the whole flow, so an
    // open Settings modal's own document-level Esc handler won't also fire: with
    // both open, Esc closes only this overlay.
    e.stopPropagation();
    close();
  }
}

export function open() {
  if (isOpen) return;
  isOpen = true;

  overlay = document.createElement('div');
  overlay.className = 'shortcuts-help-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const panel = document.createElement('div');
  panel.className = 'shortcuts-help';
  panel.tabIndex = -1; // focusable: keeps stray keystrokes out of the PTY behind us

  const header = document.createElement('div');
  header.className = 'shortcuts-help-header';
  const title = document.createElement('span');
  title.className = 'shortcuts-help-title';
  title.textContent = 'Keyboard Shortcuts';
  const hint = document.createElement('span');
  hint.className = 'shortcuts-help-hint';
  hint.textContent = 'Esc to close';
  header.appendChild(title);
  header.appendChild(hint);

  const body = document.createElement('div');
  body.className = 'shortcuts-help-body';

  let lastGroup = null;
  for (const entry of getAll()) {
    if (!entry.enabled) continue; // don't advertise a disabled feature's key
    if (entry.group !== lastGroup) {
      // Emitted lazily so an all-disabled group leaves no empty heading behind.
      lastGroup = entry.group;
      const groupTitle = document.createElement('div');
      groupTitle.className = 'shortcuts-help-group-title';
      groupTitle.textContent = entry.group;
      body.appendChild(groupTitle);
    }

    const row = document.createElement('div');
    row.className = 'shortcuts-help-row';

    const keys = document.createElement('div');
    keys.className = 'shortcuts-help-keys';
    entry.keys.forEach((k, i) => {
      if (i > 0) {
        // 'or' = alternates (⌘⇧? or ⌘/); 'then' = a sequence (Hold ⌘ then 1–9).
        const sep = document.createElement('span');
        sep.className = 'shortcuts-help-sep';
        sep.textContent = entry.combine === 'then' ? 'then' : 'or';
        keys.appendChild(sep);
      }
      const kbd = document.createElement('kbd');
      kbd.className = 'shortcuts-help-key';
      kbd.textContent = k;
      keys.appendChild(kbd);
    });

    const desc = document.createElement('div');
    desc.className = 'shortcuts-help-desc';
    desc.textContent = entry.description;

    row.appendChild(keys);
    row.appendChild(desc);
    body.appendChild(row);
  }

  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => panel.focus());
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  callbacks.focusTerminal?.();
}

export function init(cbs) {
  callbacks = cbs;
  document.addEventListener('keydown', onKeyDown, true);
}

export function setEnabled(val) {
  enabled = !!val;
  if (!enabled && isOpen) close();
}

// Accepts a single combo or a list of alternates.
export function setShortcut(val) {
  const list = [].concat(val || []).filter(s => s && typeof s === 'string');
  if (list.length) shortcut = list;
}

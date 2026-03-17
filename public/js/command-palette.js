/**
 * Command Palette — quick keyboard-driven access to tabs, settings, and custom commands.
 *
 * Cmd+K (configurable) opens a filtered command list. Arrow keys navigate,
 * Enter executes, Escape closes. Follows the same init/setEnabled/setShortcut
 * pattern as cmd-tab-switch.js.
 */

let enabled = true;
let shortcut = 'Meta+k';
let isOpen = false;

let callbacks = {};
let overlay = null;
let input = null;
let list = null;
let items = [];
let selectedIndex = 0;

function parseShortcut(str) {
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

function matchesShortcut(e) {
  const sc = parseShortcut(shortcut);
  if (e.key.toLowerCase() !== sc.key) return false;
  if (sc.mods.meta !== e.metaKey) return false;
  if (sc.mods.ctrl !== e.ctrlKey) return false;
  if (sc.mods.shift !== e.shiftKey) return false;
  if (sc.mods.alt !== e.altKey) return false;
  return true;
}

function onKeyDown(e) {
  if (!enabled) return;

  if (!isOpen && matchesShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
    open();
    return;
  }

  if (!isOpen) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    selectNext();
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    selectPrev();
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    executeSelected();
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) selectPrev(); else selectNext();
    return;
  }
}

function selectNext() {
  const visible = getVisibleItems();
  if (visible.length === 0) return;
  selectedIndex = Math.min(selectedIndex + 1, visible.length - 1);
  renderSelection(visible);
}

function selectPrev() {
  const visible = getVisibleItems();
  if (visible.length === 0) return;
  selectedIndex = Math.max(selectedIndex - 1, 0);
  renderSelection(visible);
}

function getVisibleItems() {
  if (!list) return [];
  return [...list.querySelectorAll('.command-palette-item:not([style*="display: none"])')];
}

function renderSelection(visible) {
  if (!visible) visible = getVisibleItems();
  visible.forEach((el, i) => {
    el.classList.toggle('selected', i === selectedIndex);
  });
  // Scroll selected into view
  const sel = visible[selectedIndex];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function executeSelected() {
  const visible = getVisibleItems();
  if (visible.length === 0 || selectedIndex >= visible.length) return;
  const el = visible[selectedIndex];
  const cmd = items[parseInt(el.dataset.index, 10)];
  if (cmd) executeCommand(cmd);
}

async function executeCommand(cmd) {
  close();

  if (cmd.type === 'builtin') {
    switch (cmd.id) {
      case 'new-tab':
        callbacks.quickNewSession?.();
        break;
      case 'new-tab-deepsteve':
        callbacks.createSession?.('~/.deepsteve', { agentType: callbacks.getDefaultAgentType?.() || 'claude' });
        break;
      case 'new-terminal':
        callbacks.quickNewTerminal?.();
        break;
      case 'new-window':
        window.open(window.location.origin + '?fresh=1', '_blank');
        break;
      case 'close-tab':
        callbacks.closeActiveTab?.();
        break;
      case 'settings':
        callbacks.openSettings?.();
        break;
      case 'mods':
        callbacks.openMods?.();
        break;
      case 'next-tab': {
        const ids = callbacks.getOrderedTabIds?.() || [];
        const cur = callbacks.getActiveTabId?.();
        if (ids.length === 0) break;
        const idx = ids.indexOf(cur);
        const next = idx >= ids.length - 1 ? 0 : idx + 1;
        callbacks.switchToTab?.(ids[next]);
        break;
      }
      case 'prev-tab': {
        const ids = callbacks.getOrderedTabIds?.() || [];
        const cur = callbacks.getActiveTabId?.();
        if (ids.length === 0) break;
        const idx = ids.indexOf(cur);
        const prev = idx <= 0 ? ids.length - 1 : idx - 1;
        callbacks.switchToTab?.(ids[prev]);
        break;
      }
    }
  } else if (cmd.type === 'switch-tab') {
    callbacks.switchToTab?.(cmd.tabId);
  } else if (cmd.type === 'custom') {
    try {
      const activeTabId = callbacks.getActiveTabId?.();
      await fetch('/api/commands/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cmd.id, sessionId: activeTabId }),
      });
    } catch (err) {
      console.error('[command-palette] Failed to execute custom command:', err);
    }
  }
}

async function open() {
  if (isOpen) return;
  isOpen = true;

  // Fetch commands from server
  let serverCommands = [];
  try {
    const resp = await fetch('/api/commands');
    const data = await resp.json();
    serverCommands = data.commands || [];
  } catch (err) {
    console.error('[command-palette] Failed to fetch commands:', err);
  }

  // Build items list: built-in + tabs + custom
  items = [];

  // Built-in commands from server
  for (const cmd of serverCommands) {
    if (cmd.type === 'builtin') {
      items.push(cmd);
    }
  }

  // Tab switching entries
  const tabIds = callbacks.getOrderedTabIds?.() || [];
  const activeTabId = callbacks.getActiveTabId?.();
  for (const id of tabIds) {
    if (id === activeTabId) continue; // skip active tab
    const name = callbacks.getTabName?.(id) || id;
    items.push({
      id: `switch-${id}`,
      type: 'switch-tab',
      tabId: id,
      name: `Switch to: ${name}`,
      description: 'Switch to this tab',
    });
  }

  // Custom commands from server
  for (const cmd of serverCommands) {
    if (cmd.type === 'custom') {
      items.push(cmd);
    }
  }

  // Build DOM
  overlay = document.createElement('div');
  overlay.className = 'command-palette-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const palette = document.createElement('div');
  palette.className = 'command-palette';

  input = document.createElement('input');
  input.className = 'command-palette-input';
  input.type = 'text';
  input.placeholder = 'Type a command...';
  input.addEventListener('input', () => {
    filterItems();
  });

  list = document.createElement('div');
  list.className = 'command-palette-list';

  items.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'command-palette-item';
    el.dataset.index = i;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'command-palette-item-name';
    nameSpan.textContent = cmd.name;
    el.appendChild(nameSpan);

    if (cmd.description) {
      const descSpan = document.createElement('span');
      descSpan.className = 'command-palette-item-desc';
      descSpan.textContent = cmd.description;
      el.appendChild(descSpan);
    }

    el.addEventListener('click', () => executeCommand(cmd));
    el.addEventListener('mouseenter', () => {
      const visible = getVisibleItems();
      const visIdx = visible.indexOf(el);
      if (visIdx >= 0) {
        selectedIndex = visIdx;
        renderSelection(visible);
      }
    });

    list.appendChild(el);
  });

  palette.appendChild(input);
  palette.appendChild(list);
  overlay.appendChild(palette);
  document.body.appendChild(overlay);

  selectedIndex = 0;
  renderSelection();

  // Focus input after DOM insertion
  requestAnimationFrame(() => input.focus());
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  input = null;
  list = null;
  items = [];
  selectedIndex = 0;
  callbacks.focusTerminal?.();
}

function filterItems() {
  const query = input?.value.toLowerCase() || '';
  const listItems = list?.querySelectorAll('.command-palette-item') || [];
  selectedIndex = 0;

  listItems.forEach(el => {
    const idx = parseInt(el.dataset.index, 10);
    const cmd = items[idx];
    if (!cmd) return;
    const text = (cmd.name + ' ' + (cmd.description || '')).toLowerCase();
    el.style.display = text.includes(query) ? '' : 'none';
  });

  renderSelection();
}

export function init(cbs) {
  callbacks = cbs;
  document.addEventListener('keydown', onKeyDown, true);
}

export function setEnabled(val) {
  enabled = !!val;
  if (!enabled && isOpen) close();
}

export function setShortcut(val) {
  if (val && typeof val === 'string') {
    shortcut = val;
  }
}

/**
 * Terminal Search — Cmd+F to search within terminal scrollback.
 *
 * Uses xterm-addon-search for match highlighting and navigation.
 * Follows the init/setEnabled pattern from command-palette.js.
 */

let enabled = true;
let isOpen = false;
let callbacks = {};
let searchBarEl = null;
let searchInputEl = null;
let currentAddon = null;

export function attachSearchAddon(term) {
  const addon = new SearchAddon.SearchAddon();
  term.loadAddon(addon);
  return addon;
}

export function init(cbs) {
  callbacks = cbs;
  document.addEventListener('keydown', onKeyDown, true);
}

export function setEnabled(val) {
  enabled = val;
  if (!val) close();
}

export function closeIfOpen() {
  if (isOpen) close();
}

function onKeyDown(e) {
  if (!enabled) return;

  // Cmd+F to open search (Mac-native). Ctrl+F is intentionally NOT matched so it
  // passes through to the PTY for vim/terminal control sequences (e.g. <C-f>).
  if (e.metaKey && e.key === 'f' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen) {
      // Already open — focus the input and select text
      searchInputEl?.focus();
      searchInputEl?.select();
    } else {
      open();
    }
    return;
  }

  if (!isOpen) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }

  // Only handle Enter/arrows when search input is focused
  if (document.activeElement !== searchInputEl) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      findPrevious();
    } else {
      findNext();
    }
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    findPrevious();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    findNext();
    return;
  }
}

function open() {
  const session = callbacks.getActiveSession?.();
  if (!session?.searchAddon || !session.container) return;

  currentAddon = session.searchAddon;

  // Build search bar DOM
  searchBarEl = document.createElement('div');
  searchBarEl.className = 'terminal-search-bar';

  searchInputEl = document.createElement('input');
  searchInputEl.className = 'terminal-search-input';
  searchInputEl.type = 'text';
  searchInputEl.placeholder = 'Find...';
  searchInputEl.addEventListener('input', () => {
    const query = searchInputEl.value;
    if (query) {
      currentAddon.findNext(query, { incremental: true });
    } else {
      currentAddon.clearDecorations();
    }
  });

  const prevBtn = document.createElement('button');
  prevBtn.className = 'terminal-search-btn';
  prevBtn.textContent = '\u25B2';
  prevBtn.title = 'Previous match (Shift+Enter)';
  prevBtn.addEventListener('click', () => { findPrevious(); searchInputEl.focus(); });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'terminal-search-btn';
  nextBtn.textContent = '\u25BC';
  nextBtn.title = 'Next match (Enter)';
  nextBtn.addEventListener('click', () => { findNext(); searchInputEl.focus(); });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'terminal-search-btn terminal-search-close';
  closeBtn.textContent = '\u2715';
  closeBtn.title = 'Close (Escape)';
  closeBtn.addEventListener('click', close);

  searchBarEl.append(searchInputEl, prevBtn, nextBtn, closeBtn);
  session.container.appendChild(searchBarEl);
  searchInputEl.focus();
  isOpen = true;
}

function close() {
  if (currentAddon) {
    currentAddon.clearDecorations();
    currentAddon = null;
  }
  if (searchBarEl?.parentNode) {
    searchBarEl.remove();
  }
  searchBarEl = null;
  searchInputEl = null;
  isOpen = false;
  callbacks.focusTerminal?.();
}

function findNext() {
  const query = searchInputEl?.value;
  if (query && currentAddon) {
    currentAddon.findNext(query);
  }
}

function findPrevious() {
  const query = searchInputEl?.value;
  if (query && currentAddon) {
    currentAddon.findPrevious(query);
  }
}

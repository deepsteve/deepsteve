/**
 * Hash Commands — instant browser-side actions via # prefix.
 *
 * Typing # at the start of an empty input line activates an autocomplete popup.
 * Commands execute client-side (API calls or DOM) without any PTY round-trip.
 *
 * Integration: provides a `beforeSend(data)` function that terminal.js
 * calls before forwarding keystrokes to the server. Returns true to
 * consume the input.
 *
 * THE ACTIVATION GATE (#634). Two signals, ANDed:
 *
 *   1. `readInputState(term)` reads the live xterm buffer — the agent's composer
 *      box, or the caret row in a shell tab. Only a positively-read 'busy' blocks;
 *      'unknown' (a full-screen TUI, a startup banner, an idle shell prompt) falls
 *      through to the mirror below, which is why that mirror cannot be deleted.
 *   2. A per-terminal keystroke mirror, which covers the window between a
 *      keystroke and its echo — during which the screen still shows an empty
 *      composer even though the line is no longer empty.
 *
 * The mirror is per-terminal because a module-global one leaked across tabs: text
 * typed in one tab blocked # in every other. It is re-derived from the screen when
 * the screen says 'empty' and the echo has settled — never blind-wiped.
 * `setWaitingForInput(true)` used to do that wipe, and it is what made a # typed
 * mid-message open the palette: the screen classifier reports a composed-but-unsent
 * message as "waiting" by design, and a tab switch or reconnect fires the same call
 * unconditionally.
 */

import { readInputState } from './composer-caret.js';

let enabled = true;
let callbacks = {};
let active = false;
let buffer = '';         // characters typed after #
let selectedIndex = 0;
let lockedCommand = null; // set when user types space after a matching command name

let popup = null;
let inputDisplay = null;
let listEl = null;
let containerEl = null;  // terminal container to anchor popup to

// A just-typed character that has not round-tripped yet leaves an empty composer on
// screen, so "the screen says empty" only becomes trustworthy once the echo has had
// its chance. The causal half is a repaint since the keystroke — the browser twin of
// the server's outputSeq rule ("output after our write proves the child read it").
// It needs the time floor because a working turn repaints on every spinner frame,
// and the stale escape because a frozen or disconnected PTY never repaints at all
// and #close is exactly what a user wants to type there.
const ECHO_GRACE_MS = 400;
const ECHO_STALE_MS = 3000;

// Per-terminal mirror state. Keyed on the xterm Terminal so it dies with the tab.
const termState = new WeakMap();
let orphanState = null;   // for callers that pass no term (tests, future call sites)

function newState() {
  // lastKeyAt 0 means a fresh terminal reads as already settled, so # works on the
  // very first keystroke of a session.
  return { lineText: '', lastKeyAt: 0, writeSeq: 0, writeSeqAtKey: 0 };
}

function stateFor(term) {
  if (!term) {
    if (!orphanState) orphanState = newState();
    return orphanState;
  }
  let st = termState.get(term);
  if (!st) {
    st = newState();
    termState.set(term, st);
    // xterm fires this after every parsed write; the listener is disposed with the
    // terminal. Guarded because a caller may hand us a stand-in without the event.
    try { term.onWriteParsed?.(() => { st.writeSeq++; }); } catch { /* no repaint signal */ }
  }
  return st;
}

function echoSettled(st) {
  const dt = Date.now() - st.lastKeyAt;
  if (dt >= ECHO_STALE_MS) return true;
  return dt >= ECHO_GRACE_MS && st.writeSeq !== st.writeSeqAtKey;
}

const HASH_COMMANDS = [
  { id: 'terminal', name: 'terminal', description: 'Open a plain shell tab' },
  { id: 'tab',      name: 'tab',      description: 'Rename current tab',     argument: '<name>' },
  { id: 'close',    name: 'close',    description: 'Close current tab' },
  { id: 'settings', name: 'settings', description: 'Open settings' },
  { id: 'mods',     name: 'mods',     description: 'Open mods/marketplace' },
];

function executeCommand(cmd, arg) {
  switch (cmd.id) {
    case 'terminal': callbacks.quickNewTerminal?.(); break;
    case 'tab':      callbacks.renameActiveTab?.(arg?.trim()); break;
    case 'close':    callbacks.closeActiveTab?.(); break;
    case 'settings': callbacks.openSettings?.(); break;
    case 'mods':     callbacks.openMods?.(); break;
  }
}

function getFilteredCommands() {
  if (lockedCommand) return [lockedCommand];
  if (!buffer) return HASH_COMMANDS;
  const q = buffer.toLowerCase();
  return HASH_COMMANDS.filter(cmd => {
    const text = cmd.name + ' ' + cmd.description;
    return text.toLowerCase().includes(q);
  });
}

function activate(container) {
  active = true;
  buffer = '';
  selectedIndex = 0;
  lockedCommand = null;
  containerEl = container;
  createPopup();
  renderList();
}

function deactivate() {
  active = false;
  buffer = '';
  selectedIndex = 0;
  lockedCommand = null;
  containerEl = null;
  destroyPopup();
  callbacks.focusTerminal?.();
}

function createPopup() {
  popup = document.createElement('div');
  popup.className = 'hash-command-popup';

  inputDisplay = document.createElement('div');
  inputDisplay.className = 'hash-command-input';
  inputDisplay.textContent = '#';

  listEl = document.createElement('div');
  listEl.className = 'hash-command-list';

  popup.appendChild(inputDisplay);
  popup.appendChild(listEl);

  if (containerEl) {
    containerEl.style.position = 'relative';
    containerEl.appendChild(popup);
  }
}

function destroyPopup() {
  if (popup) {
    popup.remove();
    popup = null;
  }
  inputDisplay = null;
  listEl = null;
}

function renderList() {
  if (!listEl) return;

  // Update input display
  if (inputDisplay) {
    if (lockedCommand) {
      const arg = buffer.slice(lockedCommand.name.length);
      inputDisplay.innerHTML = '';
      const hashSpan = document.createElement('span');
      hashSpan.className = 'hash-command-prefix';
      hashSpan.textContent = '#';
      const cmdSpan = document.createElement('span');
      cmdSpan.className = 'hash-command-name-highlight';
      cmdSpan.textContent = lockedCommand.name;
      inputDisplay.appendChild(hashSpan);
      inputDisplay.appendChild(cmdSpan);
      if (arg) {
        const argSpan = document.createElement('span');
        argSpan.textContent = arg;
        inputDisplay.appendChild(argSpan);
      }
      // Show blinking cursor
      const cursor = document.createElement('span');
      cursor.className = 'hash-command-cursor';
      inputDisplay.appendChild(cursor);
    } else {
      inputDisplay.innerHTML = '';
      const hashSpan = document.createElement('span');
      hashSpan.className = 'hash-command-prefix';
      hashSpan.textContent = '#';
      const textSpan = document.createElement('span');
      textSpan.textContent = buffer;
      inputDisplay.appendChild(hashSpan);
      inputDisplay.appendChild(textSpan);
      const cursor = document.createElement('span');
      cursor.className = 'hash-command-cursor';
      inputDisplay.appendChild(cursor);
    }
  }

  const filtered = getFilteredCommands();
  listEl.innerHTML = '';

  filtered.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'hash-command-item' + (i === selectedIndex ? ' selected' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'hash-command-item-name';
    nameSpan.textContent = '#' + cmd.name;
    el.appendChild(nameSpan);

    if (cmd.argument) {
      const argSpan = document.createElement('span');
      argSpan.className = 'hash-command-item-arg';
      argSpan.textContent = ' ' + cmd.argument;
      el.appendChild(argSpan);
    }

    const descSpan = document.createElement('span');
    descSpan.className = 'hash-command-item-desc';
    descSpan.textContent = cmd.description;
    el.appendChild(descSpan);

    el.addEventListener('click', () => {
      selectedIndex = i;
      handleEnter();
    });
    el.addEventListener('mouseenter', () => {
      selectedIndex = i;
      renderList();
    });

    listEl.appendChild(el);
  });

  // Scroll selected into view
  const sel = listEl.querySelector('.hash-command-item.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function handleEnter() {
  const filtered = getFilteredCommands();
  if (filtered.length === 0) {
    deactivate();
    return;
  }

  const cmd = filtered[selectedIndex] || filtered[0];

  // If command takes an argument and user hasn't provided it yet, lock to it
  if (cmd.argument && !lockedCommand) {
    lockedCommand = cmd;
    buffer = cmd.name;
    selectedIndex = 0;
    renderList();
    return;
  }

  // Extract argument (everything after command name + space)
  let arg = '';
  if (cmd.argument) {
    arg = buffer.slice(cmd.name.length);
    // Remove leading space
    if (arg.startsWith(' ')) arg = arg.slice(1);
  }

  deactivate();
  executeCommand(cmd, arg);
}

function handleCharacter(ch) {
  // `# terminal` is the muscle-memory form (Claude Code's own memory feature
  // uses `# `), so a space typed before any command name is swallowed rather
  // than stored — a leading space would break every matching path below.
  // The caller consumes the keystroke either way, so it can't leak to the PTY.
  // Only fires while the buffer is empty, so the space *between* a command and
  // its argument is untouched.
  if (ch === ' ' && buffer.length === 0) return;

  buffer += ch;

  // Check if we should lock to a command (typed command name + space)
  if (!lockedCommand) {
    const parts = buffer.split(' ');
    if (parts.length > 1) {
      const cmdName = parts[0].toLowerCase();
      const match = HASH_COMMANDS.find(c => c.name === cmdName);
      if (match && match.argument) {
        lockedCommand = match;
      } else if (match) {
        // Command without arguments — execute immediately on space
        deactivate();
        executeCommand(match, '');
        return;
      }
    }
  }

  selectedIndex = 0;
  renderList();
}

function handleBackspace() {
  if (buffer.length === 0) {
    deactivate();
    return;
  }
  buffer = buffer.slice(0, -1);

  // Un-lock if we backspaced into the command name
  if (lockedCommand && buffer.length < lockedCommand.name.length) {
    lockedCommand = null;
  }

  selectedIndex = 0;
  renderList();
}

/**
 * Called by terminal.js before sending data to WebSocket.
 * Returns true if the data was consumed (should not be forwarded).
 *
 * terminal.js passes only `data`; `container` (to parent the popup) and `term` (the
 * gate's screen and its per-tab mirror) arrive from app.js's closure. Omitting
 * `term` is supported and degrades to the mirror alone.
 */
export function beforeSend(data, container, term) {
  // If hash mode is active, consume all input
  if (active) {
    // Option+Delete (word delete): \x1b\x7f
    if (data === '\x1b\x7f') {
      if (buffer.length === 0) {
        deactivate();
        return true;
      }
      // Delete backward to previous word boundary (space or start)
      const trimmed = buffer.replace(/\s+$/, ''); // strip trailing spaces first
      const lastSpace = trimmed.lastIndexOf(' ');
      buffer = lastSpace >= 0 ? buffer.slice(0, lastSpace + 1) : '';
      // Un-lock if we deleted into the command name
      if (lockedCommand && buffer.length < lockedCommand.name.length) {
        lockedCommand = null;
      }
      if (buffer.length === 0) {
        deactivate();
      } else {
        selectedIndex = 0;
        renderList();
      }
      return true;
    }

    // Handle escape sequences and control characters
    if (data === '\x1b' || data === '\x1b[A' || data === '\x1b[B' ||
        data === '\r' || data === '\x7f' || data === '\b') {
      if (data === '\x1b') {
        deactivate();
      } else if (data === '\x1b[A') {
        // Arrow up
        const filtered = getFilteredCommands();
        if (filtered.length > 0) {
          selectedIndex = Math.max(0, selectedIndex - 1);
          renderList();
        }
      } else if (data === '\x1b[B') {
        // Arrow down
        const filtered = getFilteredCommands();
        if (filtered.length > 0) {
          selectedIndex = Math.min(filtered.length - 1, selectedIndex + 1);
          renderList();
        }
      } else if (data === '\r') {
        handleEnter();
      } else if (data === '\x7f' || data === '\b') {
        handleBackspace();
      }
      return true;
    }

    // Tab — select next/cycle
    if (data === '\t') {
      const filtered = getFilteredCommands();
      if (filtered.length > 0) {
        // If only one match and not locked, auto-complete the command name
        if (filtered.length === 1 && !lockedCommand) {
          const cmd = filtered[0];
          buffer = cmd.name;
          if (cmd.argument) {
            lockedCommand = cmd;
            buffer += ' ';
          }
          selectedIndex = 0;
          renderList();
        } else {
          selectedIndex = (selectedIndex + 1) % filtered.length;
          renderList();
        }
      }
      return true;
    }

    // Ctrl+C — cancel
    if (data === '\x03') {
      deactivate();
      return true;
    }

    // Regular printable characters
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      handleCharacter(data);
      return true;
    }

    // Consume any other input while active (don't leak to PTY)
    return true;
  }

  const st = stateFor(term);
  // Read before the stamp below, or this very keystroke would reset the clock the
  // echo grace is measured against and the resync could never fire.
  const settled = echoSettled(st);

  // Mirror the current input line so the gate below has an answer even when the
  // screen is unreadable, and so a character that has not echoed yet still counts.
  // Keys that clear the line (Enter, Ctrl+C, Ctrl+U, Escape) reset it; backspace
  // drops the last char; word-kill strips the trailing word; printable chars
  // append — except '#', the trigger itself, which must never count or it could
  // never fire on an empty line.
  if (data === '\r' || data === '\n' || data === '\x03' || data === '\x15' || data === '\x1b') {
    st.lineText = '';
  } else if (data === '\x7f' || data === '\b') {
    st.lineText = st.lineText.slice(0, -1);
  } else if (data === '\x17' || data === '\x1b\x7f') {   // Ctrl+W, Option+Delete
    const trimmed = st.lineText.replace(/\s+$/, '');
    const lastSpace = trimmed.lastIndexOf(' ');
    st.lineText = lastSpace >= 0 ? st.lineText.slice(0, lastSpace + 1) : '';
  } else if (data.length === 1 && data.charCodeAt(0) >= 32 && data !== '#') {
    st.lineText += data;
  }
  st.lastKeyAt = Date.now();
  st.writeSeqAtKey = st.writeSeq;

  // Not active — only intercept # at the start of a genuinely empty input line.
  if (enabled && data.startsWith('#')) {
    const inputState = readInputState(term);
    // Re-derive the mirror from the screen rather than blind-wiping it the way
    // setWaitingForInput used to: something we never saw may have cleared the
    // composer (/clear, a server-injected prompt, Claude's own @-picker), and #
    // has to re-arm for that — but only once our own typing has had time to echo,
    // or the wipe just returns under a new name.
    if (inputState === 'empty' && settled) st.lineText = '';
    if (inputState !== 'busy' && st.lineText === '') {
      if (data === '#') {
        activate(container);
        return true;
      }
      // Pasted or batched input like "#terminal" or "#terminal\r"
      // Left-trim so a pasted/batched `# terminal` matches like `#terminal` does.
      const text = (data.endsWith('\r') ? data.slice(1, -1) : data.slice(1)).replace(/^\s+/, '');
      const spaceIdx = text.indexOf(' ');
      const cmdName = (spaceIdx >= 0 ? text.slice(0, spaceIdx) : text).toLowerCase();
      const arg = spaceIdx >= 0 ? text.slice(spaceIdx + 1) : '';
      const cmd = HASH_COMMANDS.find(c => c.name === cmdName);
      if (cmd) {
        executeCommand(cmd, arg);
        return true;
      }
    }
  }

  return false;
}

/**
 * The agent's turn started — the popup can't stay up over a running turn.
 *
 * Deliberately does NOT touch the keystroke mirror on the waiting edge. That wipe
 * was #634: the screen classifier reports a composed-but-unsent message as
 * "waiting" by design, and app.js calls this unconditionally on tab switch and on
 * reconnect too, so staged text was routinely forgotten and the next # opened the
 * palette mid-message. Whether # may activate is now decided by the live screen
 * read in beforeSend.
 */
export function setWaitingForInput(w) {
  if (!w && active) deactivate();
}

/**
 * Close the popup, whatever state it is in. The popup is parented to one tab's
 * container while `active` is module-global, so a tab switch that leaves it up
 * swallows every keystroke in the new tab with no visible UI.
 */
export function dismiss() {
  if (active) deactivate();
}

export function setEnabled(val) {
  enabled = !!val;
  if (!enabled && active) deactivate();
}

export function init(cbs) {
  callbacks = cbs;
}

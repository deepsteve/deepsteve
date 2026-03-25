/**
 * Hash Commands — instant browser-side actions via # prefix.
 *
 * When Claude is waiting for input (BEL state), typing # activates an
 * autocomplete popup. Commands execute client-side (API calls or DOM)
 * without any PTY round-trip.
 *
 * Integration: provides a `beforeSend(data)` function that terminal.js
 * calls before forwarding keystrokes to the server. Returns true to
 * consume the input.
 */

let enabled = true;
let callbacks = {};
let active = false;
let buffer = '';         // characters typed after #
let selectedIndex = 0;
let lockedCommand = null; // set when user types space after a matching command name
let waitingForInput = false;
let inputStarted = false; // true once user sends any keystroke after waitingForInput

let popup = null;
let inputDisplay = null;
let listEl = null;
let containerEl = null;  // terminal container to anchor popup to

const HASH_COMMANDS = [
  { id: 'terminal', name: 'terminal', description: 'Open a plain shell tab' },
  { id: 'tab',      name: 'tab',      description: 'Rename current tab',     argument: '<name>' },
  { id: 'close',    name: 'close',    description: 'Close current tab' },
  { id: 'restart',  name: 'restart',  description: 'Restart the daemon' },
  { id: 'settings', name: 'settings', description: 'Open settings' },
  { id: 'mods',     name: 'mods',     description: 'Open mods/marketplace' },
];

function executeCommand(cmd, arg) {
  switch (cmd.id) {
    case 'terminal': callbacks.quickNewTerminal?.(); break;
    case 'tab':      callbacks.renameActiveTab?.(arg?.trim()); break;
    case 'close':    callbacks.closeActiveTab?.(); break;
    case 'restart':  callbacks.restart?.(); break;
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
 */
export function beforeSend(data, container) {
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

  // Not active — check if we should activate (only at start of input)
  if (enabled && !inputStarted && data.startsWith('#')) {
    if (data === '#') {
      // Single # keystroke — open interactive popup
      activate(container);
      return true;
    }
    // Pasted or batched input like "#terminal" or "#terminal\r"
    const text = data.endsWith('\r') ? data.slice(1, -1) : data.slice(1);
    const spaceIdx = text.indexOf(' ');
    const cmdName = (spaceIdx >= 0 ? text.slice(0, spaceIdx) : text).toLowerCase();
    const arg = spaceIdx >= 0 ? text.slice(spaceIdx + 1) : '';
    const cmd = HASH_COMMANDS.find(c => c.name === cmdName);
    if (cmd) {
      executeCommand(cmd, arg);
      return true;
    }
  }

  // Any data reaching the PTY means user has started typing
  inputStarted = true;
  return false;
}

export function setWaitingForInput(waiting) {
  waitingForInput = waiting;
  // Reset inputStarted when Claude starts waiting — next # at start of input activates popup
  if (waiting) inputStarted = false;
  // If we lose waitingForInput while active, deactivate
  if (!waiting && active) {
    deactivate();
  }
}

export function setEnabled(val) {
  enabled = !!val;
  if (!enabled && active) deactivate();
}

export function init(cbs) {
  callbacks = cbs;
}

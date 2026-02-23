/**
 * Terminal setup and management using xterm.js
 */

export function createTerminal(container) {
  const term = new Terminal({
    fontSize: 14,
    cursorBlink: false,  // Disable - Claude has its own cursor
    theme: { background: '#0d1117' }
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  // Ensure terminal gets focus when clicked
  container.addEventListener('click', () => term.focus());

  return { term, fit };
}

export function setupTerminalIO(term, ws, { onUserInput } = {}) {
  // Note: ws.onmessage is set in app.js to handle JSON control messages
  // and route terminal data here via term.write()
  term.onData((data) => {
    ws.send(data);
    if (onUserInput) onUserInput();
  });

  // Handle Shift+Enter for multi-line input
  term.attachCustomKeyEventHandler((event) => {
    if (event.shiftKey && event.key === 'Enter') {
      if (event.type === 'keydown') {
        // Send CSI u escape sequence for Shift+Enter (like iTerm2)
        ws.send('\x1b[13;2u');
      }
      // Block all event types (keydown, keyup, keypress) for Shift+Enter
      return false;
    }
    return true;
  });
}

export function fitTerminal(term, fit, ws) {
  fit.fit();
  ws.send(JSON.stringify({
    type: 'resize',
    cols: term.cols,
    rows: term.rows
  }));
}

/**
 * Measure the cols/rows that would fit in the #terminals container
 * using a temporary hidden terminal. Returns {cols, rows} or defaults.
 */
export function measureTerminalSize() {
  const container = document.getElementById('terminals');
  if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
    return { cols: 120, rows: 40 };
  }

  // Create a temporary off-screen terminal to measure cell size
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
  container.appendChild(tmp);

  const term = new Terminal({ fontSize: 14 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(tmp);

  const dims = fit.proposeDimensions();
  term.dispose();
  tmp.remove();

  if (dims && dims.cols > 0 && dims.rows > 0) {
    return { cols: dims.cols, rows: dims.rows };
  }
  return { cols: 120, rows: 40 };
}

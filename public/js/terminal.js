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

export function setupTerminalIO(term, ws) {
  // Note: ws.onmessage is set in app.js to handle JSON control messages
  // and route terminal data here via term.write()
  term.onData((data) => ws.send(data));

  // Handle Shift+Enter for multi-line input
  term.attachCustomKeyEventHandler((event) => {
    if (event.shiftKey && event.key === 'Enter' && event.type === 'keydown') {
      // Send CSI u escape sequence for Shift+Enter (like iTerm2)
      ws.send('\x1b[13;2u');
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

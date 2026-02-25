/**
 * Terminal setup and management using xterm.js
 */

function getTerminalBackground() {
  return getComputedStyle(document.documentElement).getPropertyValue('--ds-bg-primary').trim() || '#0d1117';
}

export function createTerminal(container) {
  const term = new Terminal({
    fontSize: 14,
    cursorBlink: false,  // Disable - Claude has its own cursor
    theme: { background: getTerminalBackground() }
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  // Ensure terminal gets focus when clicked
  container.addEventListener('click', () => term.focus());

  return { term, fit };
}

/**
 * Update a terminal's background to match the current CSS variable.
 * Called after theme changes to apply the new color without recreating the terminal.
 */
export function updateTerminalTheme(term) {
  const bg = getTerminalBackground();
  term.options.theme = { ...term.options.theme, background: bg };
}

export function setupTerminalIO(term, ws, { onUserInput } = {}) {
  // Note: ws.onmessage is set in app.js to handle JSON control messages
  // and route terminal data here via term.write()

  // xterm.js attachCustomKeyEventHandler returns false to block Shift+Enter,
  // but onData still fires with \r. Use a flag to suppress the leaked \r.
  let suppressNextEnter = false;

  term.onData((data) => {
    if (suppressNextEnter && data === '\r') {
      suppressNextEnter = false;
      return;
    }
    suppressNextEnter = false;
    ws.send(data);
    if (onUserInput) onUserInput();
  });

  // Handle Shift+Enter for multi-line input
  term.attachCustomKeyEventHandler((event) => {
    if (event.shiftKey && event.key === 'Enter') {
      if (event.type === 'keydown') {
        // Send CSI u escape sequence for Shift+Enter (like iTerm2)
        ws.send('\x1b[13;2u');
        suppressNextEnter = true;
      }
      return false;
    }
    return true;
  });

  // Auto-scroll to bottom on new output, unless user has scrolled up.
  // programmaticScroll guard prevents scrollToBottom() from resetting
  // userScrolledUp via the onScroll handler (which would defeat scroll lock).
  let userScrolledUp = false;
  let programmaticScroll = false;

  term.onScroll(() => {
    if (programmaticScroll) {
      programmaticScroll = false;
      return;
    }
    const buf = term.buffer.active;
    const atBottom = buf.baseY <= buf.viewportY;
    userScrolledUp = !atBottom;
  });

  term.onWriteParsed(() => {
    if (!userScrolledUp) {
      programmaticScroll = true;
      term.scrollToBottom();
    }
  });

  return {
    scrollToBottom() {
      userScrolledUp = false;
      programmaticScroll = true;
      term.scrollToBottom();
    }
  };
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
 * Create a ResizeObserver that auto-fits the terminal when its container changes size.
 * Handles window resize, layout toggle, mod panel open/close.
 * Tab switching is handled by switchTo() calling fitTerminal() directly.
 */
export function observeTerminalResize(container, term, fit, ws) {
  let debounceTimer = null;

  const observer = new ResizeObserver(() => {
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      fit.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }, 100);
  });

  observer.observe(container);
  return observer;
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

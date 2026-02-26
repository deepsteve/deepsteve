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

export function setupTerminalIO(term, ws, { onUserInput, container } = {}) {
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
  //
  // We detect user scroll intent via wheel events (direction-aware) and
  // the DOM viewport's scroll position. We avoid xterm's onScroll and
  // buffer.baseY/viewportY because:
  // - Ink (Claude Code's UI) periodically clears and re-renders the screen,
  //   resetting the scroll buffer, which fires misleading onScroll events.
  // - During active output, baseY increases between the wheel event and the
  //   rAF check, so the user can never "catch up" to the bottom — the flag
  //   gets stuck as true.
  // The DOM viewport's scrollTop/scrollHeight is the ground truth for what
  // the user actually sees.
  let userScrolledUp = false;

  // During transitions (tab switch, reconnect, scrollback replay), suppress
  // auto-scroll from onWriteParsed and wheel state tracking to prevent races.
  let suppressAutoScroll = false;

  // Generation counter: bumped on every programmatic scrollToBottom().
  // Wheel rAF callbacks capture the generation when scheduled and ignore
  // themselves if a programmatic scroll happened since — prevents a stale
  // rAF from overwriting userScrolledUp after scrollToBottom() cleared it.
  let scrollGen = 0;

  // Floating scroll-to-bottom button
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'scroll-to-bottom';
  scrollBtn.textContent = '\u2193';
  scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
  if (container) container.appendChild(scrollBtn);

  function scrollToBottom() {
    suppressAutoScroll = false;
    userScrolledUp = false;
    scrollGen++;
    term.scrollToBottom();
    term.refresh(0, term.rows - 1);
    scrollBtn.classList.remove('visible');
  }

  scrollBtn.addEventListener('click', () => {
    scrollToBottom();
    term.focus();
  });

  // Use the DOM viewport element for scroll position checks.
  // xterm renders .xterm-viewport as the scrollable container.
  const viewport = container?.querySelector('.xterm-viewport');

  // Track scroll direction via wheel deltaY.
  // - Scroll up (deltaY < 0): set userScrolledUp = true
  // - Scroll down (deltaY > 0): check if viewport is near bottom → clear flag
  // A small tolerance (half a row height, ~10px) handles sub-pixel rounding
  // and the race where new output arrives between the wheel event and rAF.
  const BOTTOM_TOLERANCE = 10;

  term.element.addEventListener('wheel', (e) => {
    const gen = scrollGen;
    const scrollingDown = e.deltaY > 0;
    requestAnimationFrame(() => {
      if (suppressAutoScroll) return;
      if (gen !== scrollGen) return; // programmatic scroll happened since — ignore
      if (scrollingDown && viewport) {
        // User is scrolling toward the bottom — check DOM viewport position
        const gap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (gap <= BOTTOM_TOLERANCE) {
          userScrolledUp = false;
          scrollBtn.classList.remove('visible');
          return;
        }
      }
      if (!scrollingDown) {
        // Scrolling up — always mark as scrolled up (unless already at top
        // with no scrollback, in which case there's nothing to scroll)
        if (viewport && viewport.scrollTop > 0) {
          userScrolledUp = true;
          scrollBtn.classList.add('visible');
        }
        return;
      }
      // Scrolling down but not yet at bottom — keep current state
    });
  }, { passive: true });

  term.onWriteParsed(() => {
    if (suppressAutoScroll) return;
    if (!userScrolledUp) {
      scrollToBottom();
    }
  });

  return {
    scrollToBottom,
    setSuppressAutoScroll(value) {
      suppressAutoScroll = value;
    },
    /** Re-sync viewport to bottom if user hasn't intentionally scrolled up. */
    nudgeToBottom() {
      if (!userScrolledUp) {
        term.scrollToBottom();
      }
    }
  };
}

export function fitTerminal(term, fit, ws) {
  fit.fit();
  term.scrollLines(0); // Force viewport sync — eliminates RAF race with fit's internal viewport update
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
      term.scrollLines(0); // Force viewport sync after resize
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

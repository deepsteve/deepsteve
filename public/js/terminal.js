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

export function setupTerminalIO(term, ws, { onUserInput, container, beforeSend } = {}) {
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
    // Allow hash-commands (or other interceptors) to consume input
    if (beforeSend && beforeSend(data)) return;
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

  // Auto-scroll state machine.
  //
  // Three states:
  //   AUTO           — new output auto-scrolls to bottom
  //   USER_SCROLLED  — user scrolled up; output does NOT yank back
  //   SUPPRESSED     — transitions (tab switch, reconnect, init) ignore scroll events
  //
  // Transitions:
  //   AUTO → USER_SCROLLED  (scroll event detects gap > tolerance)
  //   USER_SCROLLED → AUTO  (scroll event detects gap ≤ tolerance, or scrollToBottom())
  //   * → SUPPRESSED        (suppressScroll())
  //   SUPPRESSED → AUTO     (scrollToBottom() or 500ms safety timeout)
  //
  // We listen on the .xterm-viewport `scroll` event instead of `wheel` + rAF.
  // The scroll event fires *after* the browser has updated scrollTop, so there
  // are no stale-position races with output or Ink re-renders.
  let state = 'AUTO';
  let suppressTimer = null;
  let prevScrollTop = 0;

  const BOTTOM_TOLERANCE = 10;
  const SNAP_TOLERANCE = 100; // ~5-6 lines — snap to bottom when user scrolls down near it

  // Floating scroll-to-bottom button
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'scroll-to-bottom';
  scrollBtn.textContent = '\u2193';
  scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
  if (container) container.appendChild(scrollBtn);

  function scrollToBottom() {
    state = 'AUTO';
    clearTimeout(suppressTimer);
    term.scrollToBottom();
    term.refresh(0, term.rows - 1);
    scrollBtn.classList.remove('visible');
    if (viewport) prevScrollTop = viewport.scrollTop;
    // After container visibility changes (tab switch), the viewport scroll
    // dimensions may not be recalculated yet. Force a deferred sync so the
    // scrollbar reflects the actual buffer height and the user can scroll.
    requestAnimationFrame(() => {
      term.scrollLines(0);
      if (viewport) prevScrollTop = viewport.scrollTop;
    });
  }

  function suppressScroll() {
    state = 'SUPPRESSED';
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      if (state === 'SUPPRESSED') state = 'AUTO';
    }, 500);
    if (viewport) prevScrollTop = viewport.scrollTop;
  }

  scrollBtn.addEventListener('click', () => {
    scrollToBottom();
    term.focus();
  });

  // Use the DOM viewport element for scroll position checks.
  // xterm renders .xterm-viewport as the scrollable container.
  const viewport = container?.querySelector('.xterm-viewport');

  if (viewport) {
    // Detect user scroll-up intent via wheel event. Wheel fires synchronously,
    // before the browser updates scrollTop and before the async scroll event.
    // This prevents the race where onWriteParsed (which fires between the
    // scrollTop change and the scroll event) yanks the viewport back to bottom.
    viewport.addEventListener('wheel', (e) => {
      if (state === 'SUPPRESSED') return;
      if (e.deltaY < 0 && state === 'AUTO') {
        state = 'USER_SCROLLED';
        scrollBtn.classList.add('visible');
      }
    }, { passive: true });

    viewport.addEventListener('scroll', () => {
      if (state === 'SUPPRESSED') return;

      const scrollTop = viewport.scrollTop;
      const scrolledUp = scrollTop < prevScrollTop;
      prevScrollTop = scrollTop;

      const gap = viewport.scrollHeight - scrollTop - viewport.clientHeight;

      if (gap <= BOTTOM_TOLERANCE) {
        state = 'AUTO';
        scrollBtn.classList.remove('visible');
      } else if (scrolledUp) {
        state = 'USER_SCROLLED';
        scrollBtn.classList.add('visible');
      } else if (state === 'USER_SCROLLED' && gap <= SNAP_TOLERANCE) {
        scrollToBottom();
      } else if (state === 'AUTO' && gap > SNAP_TOLERANCE) {
        // User is far from bottom in AUTO state (e.g. after suppression ended
        // while scrolled up). Transition to USER_SCROLLED so button appears.
        // Uses SNAP_TOLERANCE (not BOTTOM_TOLERANCE) to avoid flicker during
        // rapid output where auto-scroll momentarily lags.
        state = 'USER_SCROLLED';
        scrollBtn.classList.add('visible');
      }
      // USER_SCROLLED + !scrolledUp + gap>SNAP → stay USER_SCROLLED (button already visible)
    }, { passive: true });
  }

  term.onWriteParsed(() => {
    if (state === 'AUTO') {
      term.scrollLines(0); // Force viewport sync — Ink repaints can desync viewport (#188)
      if (!viewport) { term.scrollToBottom(); return; }
      const gap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (gap > BOTTOM_TOLERANCE) {
        term.scrollToBottom();
      }
    }
  });

  return {
    scrollToBottom,
    suppressScroll,
    /** Re-sync viewport to bottom if user hasn't intentionally scrolled up. */
    nudgeToBottom() {
      if (state === 'AUTO') {
        if (!viewport) { term.scrollToBottom(); return; }
        const gap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (gap > BOTTOM_TOLERANCE) {
          term.scrollToBottom();
        }
      }
    },
    /** Force xterm viewport layout sync — call after Ink repaints or state transitions. */
    syncViewport() {
      term.scrollLines(0);
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
      // Preserve scroll position across refit (layout toggle, panel resize)
      const vp = container.querySelector('.xterm-viewport');
      const wasAtBottom = vp ? (vp.scrollHeight - vp.scrollTop - vp.clientHeight) < 20 : true;
      const savedScroll = vp?.scrollTop;
      fit.fit();
      if (vp) {
        if (wasAtBottom) {
          term.scrollToBottom();
        } else {
          vp.scrollTop = savedScroll;
        }
      }
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

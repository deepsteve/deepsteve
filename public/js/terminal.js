/**
 * Terminal setup and management using xterm.js
 */

import { registerInfo } from './shortcuts.js';

function getTerminalBackground() {
  return getComputedStyle(document.documentElement).getPropertyValue('--ds-bg-primary').trim() || '#0d1117';
}

function getTerminalForeground() {
  return getComputedStyle(document.documentElement).getPropertyValue('--ds-terminal-foreground').trim() || null;
}

// #583: macOS pinch-zoom arrives as wheel events with ctrlKey=true. xterm 6
// cancels every wheel it sees (its mouse-reporting path calls preventDefault
// unconditionally), which blocks browser zoom over the terminal and, while
// pinch-zoomed, blocks panning — scroll input dead-ends. A capture-phase
// stopPropagation on the ancestor keeps ctrl-wheels away from xterm's bubble
// listeners; no preventDefault, so the browser's zoom default proceeds.
export function handleTerminalWheelCapture(e) {
  if (e.ctrlKey) e.stopPropagation();
}

export function installTerminalWheelGuard(el) {
  el.addEventListener('wheel', handleTerminalWheelCapture, { capture: true, passive: true });
}

export function createTerminal(container, { cols, rows } = {}) {
  const themeObj = { background: getTerminalBackground() };
  const fg = getTerminalForeground();
  if (fg) themeObj.foreground = fg;
  const opts = {
    fontSize: 14,
    cursorBlink: false,  // Disable - Claude has its own cursor
    theme: themeObj
  };
  // Open the terminal at the measured grid size (#566). On page refresh the
  // container is still display:none, so FitAddon can't size the terminal before
  // the server replays scrollback into it — leaving it at xterm's 80×24 default
  // garbles Ink's cursor-addressed frames until a later real resize. Passing the
  // already-measured dims makes the replay land in the correct grid immediately.
  if (Number.isFinite(cols) && cols > 0 && Number.isFinite(rows) && rows > 0) {
    opts.cols = cols;
    opts.rows = rows;
  }
  const term = new Terminal(opts);

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
  const fg = getTerminalForeground();
  const update = { ...term.options.theme, background: bg };
  if (fg) { update.foreground = fg; } else { delete update.foreground; }
  term.options.theme = update;
}

// Doc-only (shortcuts.js): Shift+Enter is consumed inside xterm's
// attachCustomKeyEventHandler below, not by a document-level matcher.
registerInfo({
  id: 'terminal-shift-enter',
  group: 'Terminal',
  description: 'Insert a newline without submitting (multi-line agent input)',
  keys: ['⇧↩'],
});

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

  // Handle Shift+Enter for multi-line input.
  // Listed in the shortcuts overlay via registerInfo('terminal-shift-enter') above.
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

  // xterm 6 follows live output and provides its own scrollbar
  // (.xterm-scrollable-element) natively. deepsteve's old AUTO/USER_SCROLLED
  // state machine + down button listened on .xterm-viewport, which xterm 6
  // turned into an inert overlay, so it never fired (#586). We keep only the
  // imperative helpers callers still need.

  function scrollToBottom() {
    term.scrollToBottom();
    term.refresh(0, term.rows - 1);
    // Container visibility just changed (tab switch); scroll dims may not be
    // recalculated yet - force a deferred sync.
    requestAnimationFrame(() => { term.scrollLines(0); });
  }

  // Force a viewport sync after each parsed frame - Ink repaints can desync the
  // viewport (#188). scrollLines(0) is a 0-delta scroll: it never yanks a
  // scrolled-up user, and xterm handles following live output to the bottom.
  term.onWriteParsed(() => { term.scrollLines(0); });

  return {
    scrollToBottom,
    /** Force xterm viewport layout sync - call after Ink repaints. */
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
 * Resize a terminal to an explicit grid, for the case fitTerminal() cannot serve:
 * a container with no layout box. FitAddon measures
 * getComputedStyle(term.element.parentElement).height, which resolves to `auto`
 * on a display:none element, so proposeDimensions() yields NaN and fit() returns
 * having done nothing — silently (the same fact createTerminal's #566 comment
 * relies on). Anything that shrinks a hidden terminal therefore cannot grow it
 * back by fitting; it has to hand the dimensions back. Overview mode is the one
 * caller: it shrinks every tab in the grid, and all but the active one are hidden
 * by the time it exits (#590).
 */
export function resizeTerminal(term, ws, cols, rows) {
  if (!(cols > 0) || !(rows > 0)) return;
  if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
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
      // Preserve scroll position across refit (layout toggle, panel resize).
      // xterm 6's .xterm-viewport is inert; re-pin to bottom only if we were
      // already following, else let xterm keep its position (#586).
      const atBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      fit.fit();
      if (atBottom) term.scrollToBottom();
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
  tmp.style.cssText = 'position:absolute;inset:0;visibility:hidden;pointer-events:none;';
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

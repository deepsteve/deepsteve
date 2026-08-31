/**
 * Terminal setup and management using xterm.js
 */

import { registerInfo } from './shortcuts.js';
import { installClipboardOsc } from './osc-clipboard.js';

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
    // #650: with tmux's mouse on, xterm hands a drag to the application instead of
    // starting a browser selection — so ⌥+drag becomes the way to select terminal text
    // with the mouse on macOS, and xterm gates that on this option, which defaults to
    // false. (`shouldForceSelection` is `altKey && macOptionClickForcesSelection` on
    // darwin and plain `shiftKey` everywhere else, so ⇧+drag already works elsewhere.)
    macOptionClickForcesSelection: true,
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

  // #650: OSC 52 in. Registered before term.open() and before app.js flushes any
  // pending data, so a scrollback replay cannot outrun it.
  installClipboardOsc(term, container);

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

// `navigator.platform` is deprecated but is the only thing every browser still
// answers; `userAgentData` is Chromium-only, so it is the preference, not the source.
export function isMacPlatform(nav = typeof navigator === 'undefined' ? null : navigator) {
  if (!nav) return false;
  const p = nav.userAgentData?.platform || nav.platform || '';
  return /^mac/i.test(p) || /Mac/.test(nav.userAgent || '');
}

// #652: ⌥←/⌥→ are the mac way to walk a line you're editing by word, and
// @xterm/xterm@5.5.0 made that work by rewriting them: on macOS its `case 37` turned
// ESC[1;3D into ESC b (and ESC[1;3C into ESC f). 6.0.0 — the build index.html loads —
// deleted that remap, so since #510 the wire byte has been the bare CSI form. The Claude
// composer understands ESC[1;3D, but zsh has no binding for it, which is why the key went
// dead at a shell prompt. ESC b / ESC f is the sequence readline, zle and the composer all
// agree means word motion (and what iTerm2's "Natural Text Editing" preset sends).
//
// Modifier matching is strict, on purpose — the same rule as shortcuts.js's `modsMatch`.
// ⌥⇧← and ⌥⌃← keep reaching xterm untouched rather than collapsing into plain word motion.
export function optionArrowSequence(event, isMac) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const seq = event.key === 'ArrowLeft' ? '\x1bb'
    : event.key === 'ArrowRight' ? '\x1bf'
      : null;
  // Platform last: this runs on every keydown and sniffing it is the expensive half.
  return seq && (isMac ?? isMacPlatform()) ? seq : null;
}

// Doc-only (shortcuts.js): both of these are consumed inside xterm's
// attachCustomKeyEventHandler below, not by a document-level matcher.
registerInfo({
  id: 'terminal-shift-enter',
  group: 'Terminal',
  description: 'Insert a newline without submitting (multi-line agent input)',
  keys: ['⇧↩'],
});

registerInfo({
  id: 'terminal-word-motion',
  group: 'Terminal',
  description: 'Move the cursor one word left / right',
  keys: ['⌥←', '⌥→'],
  isEnabled: () => isMacPlatform(),
});

export function setupTerminalIO(term, ws, { onUserInput, container, beforeSend, onInputDropped } = {}) {
  // Note: ws.onmessage is set in app.js to handle JSON control messages
  // and route terminal data here via term.write()

  // xterm.js attachCustomKeyEventHandler returns false to block Shift+Enter,
  // but onData still fires with \r. Use a flag to suppress the leaked \r.
  let suppressNextEnter = false;

  // Everything we put on the wire goes through here, so an interceptor gets the same
  // look at a key we synthesise as at one xterm emitted. Allow hash-commands (or other
  // interceptors) to consume input.
  function sendInput(data) {
    if (beforeSend && beforeSend(data)) return;
    // #677: the wrapper is deliberately inert while the socket is down — buffering
    // keystrokes to replay into a live PTY minutes later would be worse. But it used to be
    // SILENTLY inert, which is how a tab with a rejected cookie went on looking normal
    // while everything typed into it went nowhere. Report the drop; don't change it.
    if (!ws.send(data)) {
      if (onInputDropped) onInputDropped();
      return;
    }
    if (onUserInput) onUserInput();
  }

  term.onData((data) => {
    if (suppressNextEnter && data === '\r') {
      suppressNextEnter = false;
      return;
    }
    suppressNextEnter = false;
    sendInput(data);
  });

  // Handle Shift+Enter for multi-line input, and macOS ⌥←/⌥→ word motion (#652).
  // Both are listed in the shortcuts overlay via the registerInfo() calls above.
  term.attachCustomKeyEventHandler((event) => {
    if (event.shiftKey && event.key === 'Enter') {
      if (event.type === 'keydown') {
        // Send CSI u escape sequence for Shift+Enter (like iTerm2)
        ws.send('\x1b[13;2u');
        suppressNextEnter = true;
      }
      return false;
    }
    const wordMotion = optionArrowSequence(event);
    if (wordMotion) {
      if (event.type === 'keydown') {
        sendInput(wordMotion);
        // Returning false makes xterm's _keyDown bail *before* its own cancel(), so the
        // browser default survives unless we cancel it here. No suppressNextEnter twin is
        // needed: that flag exists because a blocked Enter still reaches the hidden
        // textarea and comes back as an `input` event, and an arrow key produces none.
        event.preventDefault();
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

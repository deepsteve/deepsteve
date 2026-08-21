/**
 * OSC 52 — "put this on the system clipboard" (#650).
 *
 * xterm 6.0.0 registers OSC handlers for 0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111 and
 * 112, and nothing else: a 52 is parsed and dropped on the floor. That was invisible
 * while tmux's mouse stayed off, because a drag over the terminal was a BROWSER
 * selection and ⌘C copied it. With `mouse on` the drag belongs to tmux or to the pane's
 * program instead, they copy into their own buffer, and they report the copy outward as
 * OSC 52 — so without this bridge, selecting text in a terminal would silently copy
 * nothing at all.
 *
 * The payload xterm hands us is everything after `52;`, i.e. `<Pc>;<Pd>`: Pc is any
 * subset of `c p q s 0-7`, Pd is base64. tmux emits an EMPTY Pc, so that is the common
 * case here rather than an edge case.
 */

/**
 * base64 → string, decoded as UTF-8.
 *
 * `atob()` yields BYTES in a JS string, one char per byte. Handing that straight to the
 * clipboard mojibakes every non-ASCII character — every accent, every box-drawing glyph,
 * every emoji — so the bytes have to be re-decoded. Returns null rather than throwing:
 * this runs on bytes that came off a PTY.
 */
function decodeBase64Utf8(b64) {
  try {
    const binary = atob(b64.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parse an OSC 52 payload into the text it wants copied.
 *
 * `Pd === '?'` is a clipboard READ request, and we never answer one: replying would let
 * anything running in any pane exfiltrate the user's clipboard back over the PTY. xterm
 * ships its own read side disabled for the same reason.
 *
 * @returns {{selection: string, text: string} | null}
 */
export function parseOsc52(payload) {
  if (typeof payload !== 'string') return null;
  const semi = payload.indexOf(';');
  if (semi === -1) return null;
  const selection = payload.slice(0, semi);
  const body = payload.slice(semi + 1);
  if (body === '?') return null;
  if (!/^[cpqs0-7]*$/.test(selection)) return null;
  const text = decodeBase64Utf8(body);
  return text === null ? null : { selection, text };
}

/**
 * Put text on the system clipboard, best effort, never throwing.
 *
 * `navigator.clipboard` is undefined outside a secure context. deepsteve's canonical
 * origin is http://deepsteve.localhost:3000, which browsers treat as potentially
 * trustworthy (RFC 6761 reserves `.localhost` for loopback) — but the same daemon is
 * routinely reached over plain HTTP on a LAN address, where it is not. Hence the
 * textarea fallback, which is also the path taken when writeText() REJECTS: it does
 * that for an unfocused document and for a missing permission, and an unhandled
 * rejection raised by a byte off a PTY is not an acceptable outcome.
 */
export function writeClipboardText(text) {
  const fallback = () => copyViaTextarea(text);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(() => true, fallback);
    }
  } catch {}
  return Promise.resolve(fallback());
}

function copyViaTextarea(text) {
  try {
    // Read BEFORE the textarea steals it — select() moves focus, and not putting it
    // back would leave the terminal unable to receive the next keystroke.
    const previous = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (previous && typeof previous.focus === 'function') previous.focus();
    return ok;
  } catch {
    return false;
  }
}

/**
 * The OSC 52 handler, as a factory so it can be tested with no DOM at all.
 *
 * `isArmed` is the REPLAY GUARD, and it is not optional. The daemon replays a session's
 * whole scrollback verbatim on every WebSocket connect, so every OSC 52 the pane has
 * ever emitted is re-delivered on a page refresh — and re-writing the clipboard from a
 * page load nobody asked for would silently eat whatever the user had copied elsewhere
 * meanwhile. A real copy is always downstream of a gesture in the terminal, so the
 * bridge stays inert until this terminal has seen one.
 *
 * Always returns true, i.e. "handled" — that is what keeps a `?` read request and an
 * undecodable payload from falling through to some future handler. And it NEVER returns
 * a promise: xterm pauses its parser on a thenable OSC result, so awaiting the clipboard
 * here would stall the terminal behind a browser permission prompt.
 */
export function createOsc52Handler(isArmed, write = writeClipboardText) {
  return (payload) => {
    const parsed = parseOsc52(payload);
    if (parsed && isArmed()) write(parsed.text);
    return true;
  };
}

/**
 * Wire the bridge onto a terminal. Call before the first byte is written into it, so a
 * scrollback replay cannot outrun the registration.
 */
export function installClipboardOsc(term, container) {
  let userTouched = false;
  const arm = () => { userTouched = true; };
  if (container) {
    container.addEventListener('pointerdown', arm, { passive: true });
    container.addEventListener('keydown', arm, { capture: true });
  }
  if (term.parser && typeof term.parser.registerOscHandler === 'function') {
    term.parser.registerOscHandler(52, createOsc52Handler(() => userTouched));
  }
}

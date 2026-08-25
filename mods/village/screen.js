// The live terminal, as a surface in the village.
//
// Clicking a session used to call focusSession(), which swaps the whole mod out
// for the flat terminal — you were ejected from the town to do the work the town
// was for. Instead the session is mirrored onto a board you walk up to, and the
// camera dollies in to read it. Nothing is ever handed over; the village is still
// there, still raining, behind the board.
//
// How the mirror works, and the two traps in it (both #511's, re-hit here):
//
//   1. THERE ARE THREE CANVASES. Opening an xterm Terminal with WebglAddon puts a
//      transparent 2D `.xterm-link-layer` canvas FIRST in the DOM, the real WebGL2
//      render canvas second, and a char-measure canvas third. So
//      `container.querySelector('canvas')` hands back the empty overlay, and a
//      texture sampled from it is blank. webglCanvasOf() picks by context.
//
//   2. preserveDrawingBuffer. WebglAddon's first constructor argument is exactly
//      that, and without it the WebGL buffer is cleared after compositing — the
//      readback is blank on every frame that isn't mid-render. `new WebglAddon(true)`.
//
// Only ONE mirror exists for the whole town. A per-house xterm would be a WebGL
// context per project, and browsers cap those long before a town gets interesting.
// The nearest board is lit and the rest are dark glass, which is also the thing
// the design wanted anyway.

import * as THREE from 'three';
import { SCREEN } from './config.js';

// The mirror is built in the PARENT document, not this iframe: xterm and its
// WebGL addon are loaded by the host page, and the same-origin bridge is how every
// other mod that mirrors a terminal reaches them (mods/space-station/terminal.js).
const MIRROR_ID = 'village-term-mirror';

function bridge() {
  return parent.window.__deepsteve || null;
}

/** Pick the canvas that actually holds terminal pixels — trap 1 above. */
function webglCanvasOf(container) {
  return [...container.querySelectorAll('canvas')].find((c) => c.getContext('webgl2'))
    || container.querySelector('canvas');
}

/**
 * The SGR escape that reproduces one buffer cell's attributes.
 *
 * The seed used to go through `line.translateToString()`, which returns plain
 * text — every colour and attribute stripped. That is not a cosmetic loss: a
 * shell's autosuggestion, a diff's red and green, a dimmed hint are all *only*
 * their attributes, so the board rendered a grey ghost suggestion as ordinary
 * white text that looked like something you had actually typed.
 *
 * Reset-then-set on every change rather than diffing individual attributes off:
 * the string is written once into a freshly reset terminal, so correctness is
 * worth more than the handful of bytes a minimal encoding would save.
 */
function sgrFor(cell) {
  const p = ['0'];
  if (cell.isBold()) p.push('1');
  if (cell.isDim()) p.push('2');
  if (cell.isItalic()) p.push('3');
  if (cell.isUnderline()) p.push('4');
  if (cell.isBlink()) p.push('5');
  if (cell.isInverse()) p.push('7');
  if (cell.isInvisible()) p.push('8');
  if (cell.isStrikethrough()) p.push('9');

  if (cell.isFgPalette()) {
    const c = cell.getFgColor();
    p.push(c < 8 ? `${30 + c}` : c < 16 ? `${90 + c - 8}` : `38;5;${c}`);
  } else if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    p.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  }

  if (cell.isBgPalette()) {
    const c = cell.getBgColor();
    p.push(c < 8 ? `${40 + c}` : c < 16 ? `${100 + c - 8}` : `48;5;${c}`);
  } else if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    p.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  }

  return `\x1b[${p.join(';')}m`;
}

/**
 * One buffer line as text with its attributes intact.
 *
 * `cell` is reused across the whole line — xterm hands back a view, not a copy,
 * and allocating one per column is a measurable cost over a full screen.
 */
function serializeLine(line, cols, cell) {
  let out = '';
  let last = null;
  let blanks = '';
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cell);
    const chars = cell.getChars();
    const sgr = sgrFor(cell);
    // Trailing blanks are held back and only committed when real content follows,
    // so a mostly empty line does not become 200 columns of padding.
    if (chars === '' || chars === ' ') {
      blanks += chars === '' ? ' ' : chars;
      continue;
    }
    if (blanks) { out += blanks; blanks = ''; }
    if (sgr !== last) { out += sgr; last = sgr; }
    out += chars;
    // A wide glyph occupies two columns; the second holds no chars of its own.
    if (cell.getWidth() === 2) x++;
  }
  return `${out}\x1b[0m`;
}

export class TerminalMirror {
  constructor() {
    this.term = null;
    this.canvas = null;
    this.texture = null;
    this.sessionId = null;
    this.unsub = null;
    this.lastRefresh = 0;
    this.failed = null;
    this.notice = false;
    this.noticeText = '';
  }

  /** True once there is something worth putting on a board. */
  get live() {
    return !!(this.texture && (this.sessionId || this.notice));
  }

  get aspect() {
    if (!this.canvas || !this.canvas.height) return 0;
    return this.canvas.width / this.canvas.height;
  }

  _ensure() {
    if (this.term) return true;
    const doc = parent.document;
    const Terminal = parent.window.Terminal;
    const WebglAddon = parent.window.WebglAddon?.WebglAddon;
    if (!Terminal || !WebglAddon) {
      this.failed = 'TERMINAL UNAVAILABLE — RELOAD THE PAGE';
      return false;
    }

    let container = doc.getElementById(MIRROR_ID);
    if (!container) {
      container = doc.createElement('div');
      container.id = MIRROR_ID;
      // Off-screen but not display:none — a hidden container has no layout, and
      // xterm sizes its renderer from layout. It has to be laid out and invisible,
      // which is what the near-zero opacity and the negative z-index buy.
      container.style.cssText = 'position:fixed;left:0;top:0;width:1400px;height:700px;'
        + 'overflow:hidden;z-index:-1;pointer-events:none;opacity:0.01;';
      doc.body.appendChild(container);
    }
    this.container = container;

    this.term = new Terminal({
      fontSize: SCREEN.FONT_SIZE,
      cols: SCREEN.COLS,
      rows: SCREEN.ROWS,
      allowTransparency: false,
      cursorBlink: true,
    });
    this.term.open(container);
    this.term.loadAddon(new WebglAddon(true));   // trap 2
    this._recapture();
    return true;
  }

  /** Re-find the canvas and rebuild the texture around it. */
  _recapture() {
    const found = webglCanvasOf(this.container);
    if (!found) return;
    this.canvas = found;
    this.texture = new THREE.CanvasTexture(found);
    // Linear, and no mipmaps: a mipmapped terminal is a blurry terminal, and the
    // panel is always seen close to head-on anyway.
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  /**
   * Point the mirror at a session. Returns an error string to paint on the board,
   * or null on success.
   *
   * Only sessions this browser window has open can be mirrored: the bridge reads
   * from the live xterm and its socket, both of which exist per window. data.js
   * already splits the town model into `local` and `elsewhere` for the same reason.
   */
  mount(sessionId) {
    if (this.sessionId === sessionId) return null;
    this.unmount();
    if (!sessionId) return null;
    if (!this._ensure()) return this.failed;

    const b = bridge();
    if (!b) return 'BRIDGE MISSING — RELOAD THE PAGE';
    const src = b.getTerminal(sessionId);
    if (!src) return 'THIS SESSION IS OPEN IN ANOTHER WINDOW';

    // Match the source's geometry, or every wrapped line lands in the wrong place.
    // The panel follows the canvas's aspect rather than the other way round.
    if (src.cols && src.rows && (this.term.cols !== src.cols || this.term.rows !== src.rows)) {
      this.term.resize(src.cols, src.rows);
      const next = webglCanvasOf(this.container);
      if (next && next !== this.canvas) this._recapture();
    }

    // Seed from what is on the source's screen right now, so a board does not
    // start blank and fill in only as the agent happens to type — attributes and
    // all, via serializeLine(). See sgrFor() for why plain text is not good enough.
    this.term.reset();
    const buf = src.buffer.active;
    const top = Math.max(0, buf.baseY);
    const cell = buf.getNullCell();
    const lines = [];
    for (let i = top; i < Math.min(buf.length, top + src.rows); i++) {
      const line = buf.getLine(i);
      if (line) lines.push(serializeLine(line, src.cols, cell));
    }
    while (lines.length && /^(\x1b\[0m)?$/.test(lines[lines.length - 1])) lines.pop();
    if (lines.length) this.term.write(lines.join('\r\n'));

    this.unsub = b.onSessionData(sessionId, (data) => {
      if (this.term) this.term.write(data);
    });

    this.sessionId = sessionId;
    this.lastRefresh = 0;
    return null;
  }

  /**
   * Put a line of our own on the board — "nobody home", or why a session cannot be
   * mirrored. Written into the mirror terminal rather than painted onto a second
   * canvas, so a board only ever has one thing behind its glass and the lighting,
   * the aspect and the dolly all keep working unchanged.
   */
  showNotice(text) {
    if (this.notice && this.noticeText === text) return;
    this.unmount();
    if (!this._ensure()) return;
    this.term.reset();
    this.notice = true;
    this.noticeText = text;
    const down = Math.max(0, Math.floor(this.term.rows / 2) - 1);
    const across = Math.max(0, Math.floor((this.term.cols - text.length) / 2));
    this.term.write('\r\n'.repeat(down) + ' '.repeat(across) + `\x1b[2m${text}\x1b[0m`);
    this.lastRefresh = 0;
  }

  unmount() {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.sessionId = null;
    this.notice = false;
    this.noticeText = '';
  }

  /** Keystrokes from the village, into the real session. */
  send(data) {
    if (!this.sessionId || !data) return;
    bridge()?.writeSession(this.sessionId, data);
  }

  /**
   * xterm renders on its own rAF, and a CanvasTexture only re-uploads when it is
   * told to. Both are driven here, throttled — a terminal repainted every frame is
   * a lot of GPU for text that changes a few times a second.
   */
  tick(now) {
    if (!this.live) return;
    if (now - this.lastRefresh < SCREEN.REFRESH_MS) return;
    this.lastRefresh = now;
    this.term.refresh(0, this.term.rows - 1);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.unmount();
    this.texture?.dispose();
    this.texture = null;
    try { this.term?.dispose(); } catch { /* xterm throws if already gone */ }
    this.term = null;
    this.canvas = null;
    parent.document.getElementById(MIRROR_ID)?.remove();
  }
}

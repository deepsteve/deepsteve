// Keyboard in, intent out.
//
// Both functions here turn a browser keyboard into something the village wants: a
// direction to walk, or the bytes a PTY expects. Neither touches three.js, the DOM
// or any global, which is the point of the file — layout.js and data.js are split
// out for the same reason, so the parts that are provably right can be proved in
// plain Node (test/unit/village-input.test.js).

/**
 * The camera-relative direction the held keys are asking for, as a unit {x, z}.
 *
 * `camYaw` points the camera's forward at (sin, cos) in XZ — that is the
 * convention camera-rig.js builds its shot with, and walking is relative to the
 * camera, not to the body. With Y up in three.js's right-handed space the walker's
 * right hand is therefore forward × up = (-cos, sin).
 *
 * That cross product is the whole content of this function and the one thing to
 * keep straight: the original shipped with the strafe axis negated, so D walked
 * left at every yaw while W and S were fine.
 *
 * @param {{forward:boolean, back:boolean, left:boolean, right:boolean}} keys
 * @param {number} camYaw radians
 * @returns {{x:number, z:number}} unit vector, or {0,0} when nothing is held
 */
export function walkVector(keys, camYaw) {
  let dx = 0;
  let dz = 0;
  if (keys.forward) dz += 1;
  if (keys.back) dz -= 1;
  if (keys.left) dx -= 1;
  if (keys.right) dx += 1;
  if (!dx && !dz) return { x: 0, z: 0 };

  const len = Math.hypot(dx, dz);
  dx /= len;
  dz /= len;

  const sin = Math.sin(camYaw);
  const cos = Math.cos(camYaw);
  // dz along forward (sin, cos); dx along right (-cos, sin).
  return { x: sin * dz - cos * dx, z: cos * dz + sin * dx };
}

/**
 * A browser KeyboardEvent as the bytes a PTY expects, or null when the event is
 * not input at all — which is what lets the caller keep its own bindings.
 *
 * Written out rather than borrowed from xterm because these keystrokes land on the
 * mod's canvas, not on a focused terminal: there is no xterm in this document to
 * hand them to, only a socket to write to.
 *
 * Escape deliberately encodes and goes through to the session. It is how an agent
 * is interrupted, so it cannot also be the key that walks you away from the board;
 * village.js reserves Shift+Esc for that instead.
 */
export function encodeKey(e) {
  if (e.metaKey) return null;                 // ⌘ belongs to the browser

  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k.length === 1 && k >= 'a' && k <= 'z') {
      return String.fromCharCode(k.charCodeAt(0) - 96);
    }
    switch (e.key) {
      case '[': return '\x1b';
      case '\\': return '\x1c';
      case ']': return '\x1d';
      case ' ': return '\x00';
      default: break;
    }
  }

  switch (e.key) {
    case 'Enter': return '\r';
    case 'Backspace': return e.altKey ? '\x1b\x7f' : '\x7f';
    case 'Tab': return e.shiftKey ? '\x1b[Z' : '\t';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return '\x1b[A';
    case 'ArrowDown': return '\x1b[B';
    case 'ArrowRight': return '\x1b[C';
    case 'ArrowLeft': return '\x1b[D';
    case 'Home': return '\x1b[H';
    case 'End': return '\x1b[F';
    case 'PageUp': return '\x1b[5~';
    case 'PageDown': return '\x1b[6~';
    case 'Delete': return '\x1b[3~';
    case 'Insert': return '\x1b[2~';
    default: break;
  }

  // A single printable character. Alt-prefixed is the standard meta encoding, and
  // is how ⌥-style word motion reaches the agent.
  if (e.key.length === 1) return e.altKey ? `\x1b${e.key}` : e.key;

  return null;
}

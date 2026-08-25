// Headless unit test for the Village mod's input module.
//
//   mods/village/input.js — held keys → a direction, KeyboardEvent → PTY bytes
//
// It is free of three.js, the DOM and any global, which is what lets it be driven
// straight from Node — the same split, and the same reason, as layout.js and
// data.js in test/unit/village-layout.test.js.
//
// The walkVector half exists because the mod shipped with the strafe axis negated:
// A and D were swapped at every camera yaw while W and S were correct. A comment
// asserting the cross product is not a guard; this is.
//
// Run: node --test test/unit/village-input.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let mod;
async function load() {
  if (!mod) mod = await import('../../mods/village/input.js');
  return mod;
}

const KEYS = { forward: false, back: false, left: false, right: false };
const held = (...names) => ({ ...KEYS, ...Object.fromEntries(names.map((n) => [n, true])) });

/**
 * The village's conventions, restated independently of the implementation:
 * camYaw aims the camera's forward at (sin, cos) in XZ, and with Y up in
 * three.js's right-handed space the right-hand vector is forward × up.
 */
function forwardOf(yaw) {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}
function rightOf(yaw) {
  // (fx, 0, fz) × (0, 1, 0) = (-fz·1, …, fx·1) in x and z.
  const f = forwardOf(yaw);
  return { x: -f.z, z: f.x };
}
const dot = (a, b) => a.x * b.x + a.z * b.z;

// Yaws chosen to include the axis-aligned cases (where a sign error is easiest to
// stare past) and two that are not multiples of π/2.
const YAWS = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, -2.3];

// ---------------------------------------------------------------- walkVector

test('W walks along the camera forward at every yaw', async () => {
  const { walkVector } = await load();
  for (const yaw of YAWS) {
    const v = walkVector(held('forward'), yaw);
    assert.ok(
      Math.abs(dot(v, forwardOf(yaw)) - 1) < 1e-12,
      `yaw ${yaw}: W should be +forward, got (${v.x}, ${v.z})`,
    );
  }
});

test('S walks against the camera forward at every yaw', async () => {
  const { walkVector } = await load();
  for (const yaw of YAWS) {
    assert.ok(Math.abs(dot(walkVector(held('back'), yaw), forwardOf(yaw)) + 1) < 1e-12, `yaw ${yaw}`);
  }
});

test('D strafes to the walker\'s RIGHT at every yaw — the strafe inversion', async () => {
  const { walkVector } = await load();
  for (const yaw of YAWS) {
    const v = walkVector(held('right'), yaw);
    const d = dot(v, rightOf(yaw));
    assert.ok(
      Math.abs(d - 1) < 1e-12,
      `yaw ${yaw}: D must be +right (dot 1), got dot ${d} — a dot of -1 is the original bug`,
    );
  }
});

test('A strafes to the walker\'s LEFT at every yaw', async () => {
  const { walkVector } = await load();
  for (const yaw of YAWS) {
    assert.ok(Math.abs(dot(walkVector(held('left'), yaw), rightOf(yaw)) + 1) < 1e-12, `yaw ${yaw}`);
  }
});

test('forward and right are perpendicular, so W and D cannot both be wrong the same way', async () => {
  const { walkVector } = await load();
  for (const yaw of YAWS) {
    const w = walkVector(held('forward'), yaw);
    const d = walkVector(held('right'), yaw);
    assert.ok(Math.abs(dot(w, d)) < 1e-12, `yaw ${yaw}: W and D should be orthogonal`);
  }
});

test('diagonals are normalised — holding two keys is not faster', async () => {
  const { walkVector } = await load();
  for (const yaw of YAWS) {
    const v = walkVector(held('forward', 'right'), yaw);
    assert.ok(Math.abs(Math.hypot(v.x, v.z) - 1) < 1e-12, `yaw ${yaw}: |v| should be 1`);
  }
});

test('W+D lies between forward and right, not on either', async () => {
  const { walkVector } = await load();
  const yaw = 0.7;
  const v = walkVector(held('forward', 'right'), yaw);
  const half = Math.SQRT1_2;
  assert.ok(Math.abs(dot(v, forwardOf(yaw)) - half) < 1e-12);
  assert.ok(Math.abs(dot(v, rightOf(yaw)) - half) < 1e-12);
});

test('opposing keys cancel, and nothing held is a standstill', async () => {
  const { walkVector } = await load();
  assert.deepStrictEqual(walkVector(held('left', 'right'), 1.1), { x: 0, z: 0 });
  assert.deepStrictEqual(walkVector(held('forward', 'back'), 1.1), { x: 0, z: 0 });
  assert.deepStrictEqual(walkVector(KEYS, 1.1), { x: 0, z: 0 });
});

// ---------------------------------------------------------------- encodeKey

const ev = (key, mods = {}) => ({
  key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods,
});

test('printable characters encode as themselves', async () => {
  const { encodeKey } = await load();
  assert.strictEqual(encodeKey(ev('a')), 'a');
  assert.strictEqual(encodeKey(ev('Z', { shiftKey: true })), 'Z');
  assert.strictEqual(encodeKey(ev(' ')), ' ');
  assert.strictEqual(encodeKey(ev('/')), '/');
});

test('Enter is a bare CR, which is what a PTY submits on', async () => {
  const { encodeKey } = await load();
  assert.strictEqual(encodeKey(ev('Enter')), '\r');
});

test('Escape reaches the session — it is how an agent is interrupted', async () => {
  const { encodeKey } = await load();
  assert.strictEqual(encodeKey(ev('Escape')), '\x1b');
});

test('the arrows are the standard CSI sequences', async () => {
  const { encodeKey } = await load();
  assert.strictEqual(encodeKey(ev('ArrowUp')), '\x1b[A');
  assert.strictEqual(encodeKey(ev('ArrowDown')), '\x1b[B');
  assert.strictEqual(encodeKey(ev('ArrowRight')), '\x1b[C');
  assert.strictEqual(encodeKey(ev('ArrowLeft')), '\x1b[D');
});

test('Ctrl+letter is the C0 control, so Ctrl+C can interrupt', async () => {
  const { encodeKey } = await load();
  assert.strictEqual(encodeKey(ev('c', { ctrlKey: true })), '\x03');
  assert.strictEqual(encodeKey(ev('C', { ctrlKey: true, shiftKey: true })), '\x03');
  assert.strictEqual(encodeKey(ev('d', { ctrlKey: true })), '\x04');
  assert.strictEqual(encodeKey(ev('a', { ctrlKey: true })), '\x01');
});

test('editing keys encode', async () => {
  const { encodeKey } = await load();
  assert.strictEqual(encodeKey(ev('Backspace')), '\x7f');
  assert.strictEqual(encodeKey(ev('Backspace', { altKey: true })), '\x1b\x7f');
  assert.strictEqual(encodeKey(ev('Tab')), '\t');
  assert.strictEqual(encodeKey(ev('Tab', { shiftKey: true })), '\x1b[Z');
  assert.strictEqual(encodeKey(ev('Delete')), '\x1b[3~');
});

test('Alt+char is the meta prefix, so word motion reaches the agent', async () => {
  const { encodeKey } = await load();
  assert.strictEqual(encodeKey(ev('b', { altKey: true })), '\x1bb');
  assert.strictEqual(encodeKey(ev('f', { altKey: true })), '\x1bf');
});

test('the browser keeps ⌘, and modifier-only presses are not input', async () => {
  const { encodeKey } = await load();
  // ⌘C must stay a copy, not become a stray byte in someone's prompt.
  assert.strictEqual(encodeKey(ev('c', { metaKey: true })), null);
  assert.strictEqual(encodeKey(ev('Shift', { shiftKey: true })), null);
  assert.strictEqual(encodeKey(ev('Control', { ctrlKey: true })), null);
  assert.strictEqual(encodeKey(ev('F5')), null);
});

test('Shift+Escape is still encodable — village.js claims it before calling here', async () => {
  const { encodeKey } = await load();
  // The step-back binding is a caller-side decision. If this ever returned null
  // the binding would work by accident rather than by intent, so pin the split.
  assert.strictEqual(encodeKey(ev('Escape', { shiftKey: true })), '\x1b');
});

// ---------------------------------------------------------------- sprint

test('sprint does not change direction, only the speed the caller applies', async () => {
  const { walkVector } = await load();
  // walkVector stays a pure direction: sprint is a magnitude decision that lives
  // in the Walker. Pin that split, so a future "handle sprint here" does not
  // quietly make diagonal sprinting faster than straight sprinting.
  for (const yaw of YAWS) {
    const plain = walkVector(held('forward'), yaw);
    const withSprint = walkVector({ ...held('forward'), sprint: true }, yaw);
    assert.deepStrictEqual(withSprint, plain);
    assert.ok(Math.abs(Math.hypot(plain.x, plain.z) - 1) < 1e-12);
  }
});

test('jump and sprint flags do not leak into the walk direction', async () => {
  const { walkVector } = await load();
  const still = { ...KEYS, sprint: true, jump: true };
  assert.deepStrictEqual(walkVector(still, 0.4), { x: 0, z: 0 });
});

// Headless unit test for public/js/composer-caret.js — the client-side input-line
// reader behind the # activation gate (#634).
//
// Two things are pinned here:
//
//   1. THE PORT AGREES WITH ITS ORIGIN. readComposerDraft is duplicated from the
//      server-side composer-state.js because that file is CommonJS at the repo root
//      and unreachable from the browser. Every fixture is run through both copies
//      and the results must be identical, so a parsing fix on one side cannot
//      silently skip the other.
//   2. THE VERDICTS. 'empty' / 'busy' / 'unknown' over the same fixtures, plus the
//      caret fallback used in shell tabs.
//
// No browser: an xterm Terminal is a small fake over an array of row strings.
//
// Run: node --test test/unit/composer-caret.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const FIXTURES = require('./fixtures/composer-screens');
const serverSide = require('../../composer-state');
const { fakeTerm } = require('../helpers/fake-xterm');

const MODULE_URL = new URL('../../public/js/composer-caret.js', `file://${__filename}`).href;
let modPromise = null;
const load = () => (modPromise ||= import(MODULE_URL));

// Screen fixtures. The module also exports plain strings (RULE, the prompt text the
// #656 fixtures render), and those are not screens.
const SCREENS = Object.keys(FIXTURES).filter(k => Array.isArray(FIXTURES[k]));

// ------------------------------------------------------------ the anti-drift pin

test('readComposerDraft agrees with composer-state.js on every fixture', async () => {
  const { readComposerDraft } = await load();
  for (const name of SCREENS) {
    assert.deepStrictEqual(
      readComposerDraft(FIXTURES[name]),
      serverSide.readComposerDraft(FIXTURES[name]),
      `${name} diverged — fix composer-state.js first, then mirror it into composer-caret.js`,
    );
  }
});

test('readComposerDraft agrees on the degenerate inputs too', async () => {
  const { readComposerDraft } = await load();
  for (const input of [[], null, undefined, ['']]) {
    assert.deepStrictEqual(readComposerDraft(input), serverSide.readComposerDraft(input));
  }
});

// ------------------------------------------------------------------- the verdicts

const VERDICTS = {
  EMPTY_COMPOSER: 'empty',
  PLACEHOLDER_COMPOSER: 'empty',
  SUBMITTED_TRANSCRIPT_ECHO: 'empty',
  STAGED_DRAFT: 'busy',
  STAGED_WRAPPED: 'busy',
  STAGED_MULTILINE: 'busy',
  PASTE_COLLAPSED: 'busy',
  PASTE_COLLAPSED_MATCHING: 'busy',
  PASTE_COLLAPSED_SHORT: 'busy',
  PASTE_COLLAPSED_NO_COUNT: 'busy',
  STAGED_COMPLETE: 'busy',
  STAGED_PARTIAL: 'busy',
  BOXED_COMPOSER: 'busy',
  PERMISSION_MENU: 'unknown',
  SELECTION_MENU: 'unknown',
  STARTUP_BANNER: 'unknown',
  WORKING_NO_COMPOSER: 'unknown',
};

test('every fixture has a pinned verdict', () => {
  assert.deepStrictEqual(SCREENS.slice().sort(), Object.keys(VERDICTS).sort());
});

for (const [name, expected] of Object.entries(VERDICTS)) {
  test(`readInputState: ${name} -> ${expected}`, async () => {
    const { readInputState } = await load();
    assert.strictEqual(readInputState(fakeTerm(FIXTURES[name])), expected);
  });
}

test('readInputState is unknown for a missing or shapeless terminal', async () => {
  const { readInputState } = await load();
  for (const t of [null, undefined, {}, { buffer: {} }]) {
    assert.strictEqual(readInputState(t), 'unknown');
  }
});

test('readInputState never throws — a disposed terminal reads unknown', async () => {
  const { readInputState } = await load();
  const exploding = { buffer: { active: { baseY: 0, length: 3, cursorX: 0, cursorY: 0, getLine() { throw new Error('disposed'); } } } };
  assert.strictEqual(readInputState(exploding), 'unknown');
});

// -------------------------------------------------- the frame, not the viewport

test('a scrolled-up user still reads the live frame', async () => {
  const { readInputState } = await load();
  const scrollback = Array.from({ length: 500 }, (_, i) => `old line ${i}`);
  assert.strictEqual(readInputState(fakeTerm(FIXTURES.STAGED_DRAFT, { scrollback })), 'busy');
  assert.strictEqual(readInputState(fakeTerm(FIXTURES.EMPTY_COMPOSER, { scrollback })), 'empty');
});

test('trailing blank rows below the frame are dropped', async () => {
  const { readInputState } = await load();
  assert.strictEqual(readInputState(fakeTerm(FIXTURES.EMPTY_COMPOSER, { trailingBlanks: 12 })), 'empty');
  assert.strictEqual(readInputState(fakeTerm(FIXTURES.STAGED_DRAFT, { trailingBlanks: 12 })), 'busy');
});

test('frameLines returns at most `count` rows, newest last', async () => {
  const { frameLines } = await load();
  const rows = Array.from({ length: 60 }, (_, i) => `row ${i}`);
  const lines = frameLines(fakeTerm(rows), 40);
  assert.strictEqual(lines.length, 40);
  assert.strictEqual(lines[0], 'row 20');
  assert.strictEqual(lines[39], 'row 59');
});

test('frameLines on an entirely blank buffer is empty', async () => {
  const { frameLines } = await load();
  assert.deepStrictEqual(frameLines(fakeTerm(['', '   ', ''])), []);
});

// --------------------------------------------- the shell fallback (caret row)
//
// A shell tab has no composer box, so readComposerDraft returns null and the caret
// row decides. It may only ever say 'busy' or 'unknown' — see the module header for
// why a false 'empty' here would re-open the bug.

const PROMPT = 'michael@mac ~/github/deepsteve % ';

test('shell: idle prompt with the caret at the end is unknown, not empty', async () => {
  const { readInputState } = await load();
  const term = fakeTerm(['$ ls', 'a.js  b.js', PROMPT], { cursorY: 2, cursorX: PROMPT.length });
  assert.strictEqual(readInputState(term), 'unknown');
});

test('shell: typed text left of the caret is busy', async () => {
  const { readInputState } = await load();
  const row = PROMPT + 'git st';
  const term = fakeTerm([row], { cursorY: 0, cursorX: row.length });
  assert.strictEqual(readInputState(term), 'busy');
});

test('shell: caret moved back over typed text is busy', async () => {
  const { readInputState } = await load();
  const row = PROMPT + 'git st';
  const term = fakeTerm([row], { cursorY: 0, cursorX: PROMPT.length });
  assert.strictEqual(readInputState(term), 'busy');
});

test('shell: a trailing redirect sigil never reads as an empty prompt', async () => {
  const { readInputState } = await load();
  const row = PROMPT + 'echo foo > ';
  const term = fakeTerm([row], { cursorY: 0, cursorX: row.length });
  assert.notStrictEqual(readInputState(term), 'empty');
});

test('shell: the caret parked on an output row says nothing', async () => {
  const { readInputState } = await load();
  const row = 'compiling src/index.ts ...';
  const term = fakeTerm([row], { cursorY: 0, cursorX: row.length });
  assert.strictEqual(readInputState(term), 'unknown');
});

test('shell: caret at column 0 is unknown', async () => {
  const { readInputState } = await load();
  const term = fakeTerm([PROMPT + 'git st'], { cursorY: 0, cursorX: 0 });
  assert.strictEqual(readInputState(term), 'unknown');
});

test('shell: only the LAST sigil on the row is taken as the prompt', async () => {
  const { readInputState } = await load();
  // A `>` inside the path must not be mistaken for the prompt and make "git st"
  // read as part of the prompt decoration.
  const row = 'user@host ~/a>b % git st';
  const term = fakeTerm([row], { cursorY: 0, cursorX: row.length });
  assert.strictEqual(readInputState(term), 'busy');
});

// ---------------------------------------------------- against a REAL xterm buffer
//
// Everything above runs on the fake. These run the same reader over an actual
// @xterm/headless Terminal fed real ANSI, which is what proves the fake's
// assumptions — row padding, `buffer.length` vs `viewportY`, where the cursor
// actually lands — match the emulator the browser runs.

const { Terminal } = require('@xterm/headless');

const RULE = '─'.repeat(60);

/** Paint a frame into a real terminal, optionally parking the cursor (1-based CUP). */
function realTerm(rows, { cursorRow, cursorCol, cols = 100, termRows = 24 } = {}) {
  const term = new Terminal({ cols, rows: termRows, allowProposedApi: true });
  let out = '\x1b[H\x1b[2J' + rows.join('\r\n');
  if (cursorRow !== undefined) out += `\x1b[${cursorRow + 1};${cursorCol + 1}H`;
  return new Promise((resolve) => term.write(out, () => resolve(term)));
}

test('real xterm: an empty composer reads empty even with the cursor parked off it', async () => {
  const { readInputState } = await load();
  const term = await realTerm(['⏺ Done.', RULE, '❯', RULE, '⏵⏵ auto mode on']);
  // Ink leaves the hardware cursor wherever its frame write ended — here the end of
  // the footer, not the composer. Anchoring the read on the caret would have made
  // this 'unknown' and the whole gate a no-op in every Claude tab.
  assert.notStrictEqual(term.buffer.active.cursorY, 2);
  assert.strictEqual(readInputState(term), 'empty');
});

test('real xterm: a staged draft reads busy', async () => {
  const { readInputState } = await load();
  const term = await realTerm(['⏺ Done.', RULE, '❯ fix the parser', RULE, '? for shortcuts']);
  assert.strictEqual(readInputState(term), 'busy');
});

test('real xterm: the placeholder hint still reads empty', async () => {
  const { readInputState } = await load();
  const term = await realTerm([RULE, '❯ Try "how does main.dart work?"', RULE, '? for shortcuts']);
  assert.strictEqual(readInputState(term), 'empty');
});

test('real xterm: a scrolled-back viewport still reads the live frame', async () => {
  const { readInputState } = await load();
  const term = new Terminal({ cols: 100, rows: 10, allowProposedApi: true });
  const history = Array.from({ length: 200 }, (_, i) => `old ${i}`).join('\r\n');
  await new Promise((r) => term.write(`${history}\r\n${[RULE, '❯', RULE, '? for shortcuts'].join('\r\n')}`, r));
  term.scrollToTop();
  assert.strictEqual(term.buffer.active.viewportY, 0);
  assert.ok(term.buffer.active.baseY > 0);
  assert.strictEqual(readInputState(term), 'empty');
});

test('real xterm: the shell caret cases behave as on the fake', async () => {
  const { readInputState } = await load();
  const PROMPT = 'michael@mac ~/github/deepsteve % ';
  const idle = await realTerm(['$ ls', 'a.js b.js', PROMPT], { cursorRow: 2, cursorCol: PROMPT.length });
  assert.strictEqual(readInputState(idle), 'unknown');

  const typed = await realTerm([`${PROMPT}git st`], { cursorRow: 0, cursorCol: PROMPT.length + 6 });
  assert.strictEqual(readInputState(typed), 'busy');

  const moved = await realTerm([`${PROMPT}git st`], { cursorRow: 0, cursorCol: PROMPT.length });
  assert.strictEqual(readInputState(moved), 'busy');
});

test('real xterm: rows are padded, so the pre-caret slice keeps its trailing space', async () => {
  // The fake pads rows to `cols` on this assumption; if xterm ever stopped, the
  // shell fallback's sigil match would silently change shape.
  const term = await realTerm(['❯'], { cursorRow: 0, cursorCol: 2 });
  const line = term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY);
  assert.strictEqual(line.translateToString(false, 0, 2), '❯ ');
  assert.strictEqual(line.translateToString(true, 2), '');
});

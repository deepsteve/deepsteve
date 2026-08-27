// The build guard for source-slicing anchors: no test may locate a slice of
// server.js by a comment.
//
// server.js cannot be require()d from a unit test — importing it starts the daemon —
// so a dozen suites cut the function under test out of the source text with
// indexOf() and run it in a vm. That is a fine technique with one trap: the anchor
// strings are ordinary source text, so a DOC COMMENT can be load-bearing. Repointing
// one comment in the Remote Control detector deleted the end anchor of an unrelated
// suite and red-lined all ten of its tests at once, with the only clue being
// "missing source marker: /**" — from a file that never mentions the comment.
//
// A code declaration is a far better anchor than prose: renaming a function is a
// deliberate act that greps clean, while rewording a comment is not and does not.
// So the rule stops being advice and becomes a failing build.
//
// Same idiom as tmux-sandbox-guard.test.js (#625) and ws-client-guard.test.js (#562):
// the tree is globbed rather than listed so a new suite is covered the moment it
// lands, and the first assertion proves the scan is not vacuous — a regex that
// quietly stopped matching would otherwise turn the ban into a silent no-op.
//
// Run: node --test test/unit/source-anchor-guard.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const UNIT_DIR = __dirname;

// Every string literal handed to sourceBetween(), across line breaks. Non-greedy to
// the first ')', which is the closing paren for every call shape in the tree — the
// anchors are plain strings and none of them contains a paren.
const CALL_RE = /sourceBetween\(([\s\S]*?)\)/g;
const LITERAL_RE = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;

function anchorsIn(source) {
  const found = [];
  for (const call of source.matchAll(CALL_RE)) {
    for (const lit of call[1].matchAll(LITERAL_RE)) found.push(lit[2]);
  }
  return found;
}

const files = fs.readdirSync(UNIT_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => ({ name: f, source: fs.readFileSync(path.join(UNIT_DIR, f), 'utf8') }))
  // The guard reads itself too, and its own regexes are not anchors.
  .filter((f) => f.name !== 'source-anchor-guard.test.js');

test('the scan actually finds the anchors it is meant to police', () => {
  const total = files.reduce((n, f) => n + anchorsIn(f.source).length, 0);
  assert.ok(total >= 10,
    `expected the tree to still slice server.js by anchor; found ${total}. ` +
    'A zero here means the regex stopped matching and every assertion below is vacuous.');
});

test('no anchor is a comment', () => {
  const offenders = [];
  for (const f of files) {
    for (const a of anchorsIn(f.source)) {
      if (/^\s*(\/\*|\/\/)/.test(a)) offenders.push(`${f.name}: ${JSON.stringify(a)}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'anchor a slice on a declaration (function foo / const BAR), never on comment prose — ' +
    'rewording a comment must not be able to break a suite that does not mention it');
});

test('every anchor still resolves against the real server.js', () => {
  const serverSource = fs.readFileSync(path.join(UNIT_DIR, '..', '..', 'server.js'), 'utf8');
  const missing = [];
  for (const f of files) {
    // Only suites that slice server.js itself; a few slice other files by the same helper.
    if (!/server\.js/.test(f.source)) continue;
    for (const a of anchorsIn(f.source)) {
      if (!serverSource.includes(a)) missing.push(`${f.name}: ${JSON.stringify(a)}`);
    }
  }
  assert.deepStrictEqual(missing, [],
    'a stale anchor fails its own suite with "missing source marker"; this names them all at once');
});

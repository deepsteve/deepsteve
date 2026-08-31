// Unit tests for the History pane's pure helpers (#672).
//
// The pane's layout you verify by looking at it. These four functions you cannot:
// each one fails by producing a plausible-looking wrong transcript.
//
//   - foldToolResults: a tool call and its output are two records in two
//     different turns (the result is recorded as the USER's), joined only by
//     tool_use_id. Rendered flat, every Bash call grows a phantom "you said"
//     block containing its own output.
//   - indexToolResults: the join itself, which has to survive a page boundary
//     falling between the call and the answer.
//   - groupEntries: one assistant turn arrives as several records sharing
//     message.id; without grouping, one turn draws as three loose bubbles.
//   - truncationNote: the difference between "the log ends here" and "the log
//     continues, we clipped 124 KB of it".
//
// A browser ES module driven from CommonJS with `await import()` — the
// test/unit/village-layout.test.js pattern. The module imports
// storage-namespace.js, which reads `window` at module scope, so that one global
// is stubbed; nothing else here touches the DOM.
//
// Run: node --test test/unit/session-history-client.test.js

const { test } = require('node:test');
const assert = require('node:assert');

globalThis.window = {};
globalThis.window.parent = globalThis.window; // depth 0 -> unprefixed storage keys
globalThis.document = { addEventListener: () => {} };
globalThis.sessionStorage = {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); },
};

let mod;
async function load() {
  if (!mod) mod = await import('../../public/js/session-history.js');
  return mod;
}

const entry = (over) => ({
  offset: 0, seq: 0, bytes: 10, uuid: 'u', parentUuid: null, ts: null,
  role: 'assistant', kind: 'text', groupId: null, model: null,
  meta: false, metaReason: null, truncated: false, fullBytes: 0, ...over,
});

const toolUse = (id, over = {}) => entry({ kind: 'tool_use', name: 'Bash', toolUseId: id, role: 'assistant', ...over });
const toolResult = (id, over = {}) => entry({ kind: 'tool_result', toolUseId: id, output: 'out', role: 'user', ...over });

// ------------------------------------------------------------------ folding

test('a tool_result whose call is in view is folded away', async () => {
  const { foldToolResults } = await load();
  const got = foldToolResults([
    entry({ kind: 'text', text: 'do it', role: 'user' }),
    toolUse('t1'),
    toolResult('t1'),
    entry({ kind: 'text', text: 'done' }),
  ]);
  assert.deepStrictEqual(got.map((e) => e.kind), ['text', 'tool_use', 'text']);
});

test('an orphaned tool_result survives, because its call is off the loaded page', async () => {
  // Paging backwards, the call can be in a page the reader has not fetched. The
  // result is then the only evidence the tool ran, so dropping it would be a
  // silent hole in the history.
  const { foldToolResults } = await load();
  const got = foldToolResults([toolResult('t-elsewhere'), entry({ kind: 'text', text: 'done' })]);
  assert.deepStrictEqual(got.map((e) => e.kind), ['tool_result', 'text']);
});

test('parallel tool calls each keep their own result', async () => {
  const { foldToolResults, indexToolResults } = await load();
  // Two calls in one turn, results interleaved and out of order.
  const entries = [toolUse('a'), toolUse('b'), toolResult('b', { output: 'B' }), toolResult('a', { output: 'A' })];
  assert.deepStrictEqual(foldToolResults(entries).map((e) => e.toolUseId), ['a', 'b']);
  const idx = indexToolResults(entries);
  assert.strictEqual(idx.get('a').output, 'A');
  assert.strictEqual(idx.get('b').output, 'B');
});

test('the index is built over everything loaded, so order never matters', async () => {
  const { indexToolResults } = await load();
  const idx = indexToolResults([toolResult('t1', { output: 'early' }), toolUse('t1')]);
  assert.strictEqual(idx.get('t1').output, 'early');
});

test('a tool_result with no id is left alone rather than swallowed', async () => {
  const { foldToolResults } = await load();
  const orphan = toolResult(null);
  assert.deepStrictEqual(foldToolResults([toolUse(null), orphan]).length, 2);
});

// ----------------------------------------------------------------- grouping

test('one assistant turn is one group even though it is several records', async () => {
  const { groupEntries } = await load();
  const groups = groupEntries([
    entry({ kind: 'text', text: 'ask', role: 'user', uuid: 'u1' }),
    entry({ kind: 'thinking', groupId: 'msg_1' }),
    entry({ kind: 'text', groupId: 'msg_1' }),
    entry({ kind: 'tool_use', groupId: 'msg_1', toolUseId: 't' }),
    entry({ kind: 'text', groupId: 'msg_2' }),
  ]);
  assert.deepStrictEqual(groups.map((g) => g.entries.length), [1, 3, 1]);
  assert.deepStrictEqual(groups.map((g) => g.role), ['user', 'assistant', 'assistant']);
});

test('a role change starts a new group even when the id repeats', async () => {
  // A tool_result carries the assistant's message id in some shapes but is a user
  // record; without the role check it would be absorbed into the assistant block.
  const { groupEntries } = await load();
  const groups = groupEntries([
    entry({ groupId: 'msg_1', role: 'assistant' }),
    entry({ groupId: 'msg_1', role: 'user' }),
  ]);
  assert.strictEqual(groups.length, 2);
});

test('entries with no ids at all still group one-per-row rather than merging', async () => {
  const { groupEntries } = await load();
  const groups = groupEntries([
    entry({ uuid: null, groupId: null, offset: 1, seq: 0 }),
    entry({ uuid: null, groupId: null, offset: 2, seq: 0 }),
  ]);
  assert.strictEqual(groups.length, 2);
});

// -------------------------------------------------------------- presentation

test('the truncation note reports what is missing, in bytes', async () => {
  const { truncationNote } = await load();
  assert.strictEqual(truncationNote(entry({ truncated: false })), '');
  assert.strictEqual(truncationNote(entry({ kind: 'tool_result', truncated: true, output: 'x'.repeat(4096), fullBytes: 4096 })), '',
    'nothing hidden means no note');
  assert.strictEqual(truncationNote(entry({ kind: 'tool_result', truncated: true, output: 'x'.repeat(4096), fullBytes: 200000 })), '+191 KB');
  assert.strictEqual(truncationNote(entry({ kind: 'image', truncated: true, fullBytes: 1400000 })), '+1.3 MB');
  assert.strictEqual(truncationNote(null), '');
});

test('a tool line summarises the argument worth seeing at a glance', async () => {
  const { toolSummary } = await load();
  assert.strictEqual(toolSummary(entry({ input: JSON.stringify({ command: 'git status' }) })), 'git status');
  assert.strictEqual(toolSummary(entry({ input: JSON.stringify({ file_path: '/repo/server.js', offset: 10 }) })), '/repo/server.js');
  assert.strictEqual(toolSummary(entry({ input: JSON.stringify({ pattern: 'TODO' }) })), 'TODO');
  // A truncated input is no longer valid JSON; it must degrade, not throw.
  assert.doesNotThrow(() => toolSummary(entry({ input: '{"command":"very long comm' })));
  assert.strictEqual(toolSummary(entry({ input: JSON.stringify({}) })), '');
});

test('arrow-stepping walks conversation turns, not tool plumbing', async () => {
  // "Step through turns, not pixels" is the whole reason the pane owns its own
  // viewport. Stepping onto a thinking fold or a hidden machinery record would
  // make the arrows feel broken.
  const { isTurnEntry } = await load();
  assert.strictEqual(isTurnEntry(entry({ kind: 'text' })), true);
  assert.strictEqual(isTurnEntry(entry({ kind: 'thinking' })), false);
  assert.strictEqual(isTurnEntry(entry({ kind: 'tool_use' })), false);
  assert.strictEqual(isTurnEntry(entry({ kind: 'text', meta: true, metaReason: 'machinery' })), false);
  assert.strictEqual(isTurnEntry(null), false);
});

test('byte sizes read the way a person would say them', async () => {
  const { formatBytes } = await load();
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(512), '512 B');
  assert.strictEqual(formatBytes(2048), '2 KB');
  assert.strictEqual(formatBytes(139426503), '133.0 MB');
});

// ------------------------------------------------------------------ position

test('the reading position is per session and survives being read back', async () => {
  const { rememberedAnchor } = await load();
  sessionStorage.setItem('deepsteve-history-pos', JSON.stringify({ 'shell-a': { anchor: 'uuid-1' } }));
  assert.strictEqual(rememberedAnchor('shell-a'), 'uuid-1');
  assert.strictEqual(rememberedAnchor('shell-b'), null);
});

test('a corrupt stored position is ignored, not thrown', async () => {
  const { rememberedAnchor } = await load();
  sessionStorage.setItem('deepsteve-history-pos', 'not json');
  assert.strictEqual(rememberedAnchor('shell-a'), null);
});

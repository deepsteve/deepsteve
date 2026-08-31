// Unit tests for transcript-view.js — the pure half of the History view (#672).
//
// Why these behaviours and not the pane's layout: a transcript viewer fails
// invisibly. A dropped record type means history that quietly is not there; a
// wrong meta rule means the pane shows the harness talking to itself instead of
// the conversation; and an image block shipped whole means a 1.4 MB scroll
// response for a picture the pane cannot draw. None of those look wrong in a
// screenshot. Layout you verify by looking at it.
//
// Pure module, so this is string fixtures and no I/O at all — it runs in the bare
// `unit` CI job, which has no daemon, no zsh and no node-pty.
//
// Run: node --test test/unit/transcript-view.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const view = require('../../transcript-view.js');
const { normalizeLines, normalizeRecord } = view;

// A line record as transcript-window.js hands them over.
let nextOffset = 0;
function line(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const rec = { offset: nextOffset, bytes: Buffer.byteLength(text), text, oversize: false };
  nextOffset += rec.bytes + 1;
  return rec;
}
const run = (...objs) => normalizeLines({ lines: objs.map(line) });

const userRec = (content, extra = {}) => ({ type: 'user', uuid: 'u1', message: { role: 'user', content }, ...extra });
const asstRec = (content, extra = {}) => ({
  type: 'assistant', uuid: 'a1',
  message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5', content },
  ...extra,
});

// ------------------------------------------------------------- content shapes

test('message.content is either a string or an array of blocks', () => {
  // Both forms occur in real transcripts — 219 string-content user records in a
  // 40-file sample — and a reader that handles only the array form loses them.
  const asString = run(userRec('plain text')).entries;
  const asBlocks = run(userRec([{ type: 'text', text: 'plain text' }])).entries;
  assert.strictEqual(asString.length, 1);
  assert.strictEqual(asString[0].kind, 'text');
  assert.strictEqual(asString[0].text, 'plain text');
  assert.strictEqual(asBlocks[0].text, 'plain text');
});

test('every measured block shape becomes its own kind', () => {
  const { entries } = run(
    asstRec([{ type: 'text', text: 'prose' }]),
    asstRec([{ type: 'thinking', thinking: 'weighing', signature: 'sig' }]),
    asstRec([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]),
    userRec([{ type: 'tool_result', tool_use_id: 'tu1', content: 'total 0' }]),
  );
  assert.deepStrictEqual(entries.map((e) => e.kind), ['text', 'thinking', 'tool_use', 'tool_result']);
  assert.strictEqual(entries[1].text, 'weighing');
  assert.strictEqual(entries[2].name, 'Bash');
  assert.strictEqual(entries[2].toolUseId, 'tu1');
  assert.strictEqual(entries[3].output, 'total 0');
  assert.strictEqual(entries[3].toolUseId, 'tu1');
  // The signature is cryptographic padding — nothing renders it, so it must not
  // be on the wire.
  assert.ok(!('signature' in entries[1]));
});

test('an is_error tool_result is flagged so the pane can colour it', () => {
  const { entries } = run(userRec([{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }]));
  assert.strictEqual(entries[0].isError, true);
});

test('an unknown block type still renders rather than vanishing', () => {
  // A format that grows a block we have never seen must degrade to something
  // visible: a silent drop is how a history view starts lying about what happened.
  const { entries } = run(asstRec([{ type: 'redacted_thinking', data: 'xyz' }]));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'unknown');
  assert.strictEqual(entries[0].name, 'redacted_thinking');
});

// ------------------------------------------------------------------- images

test('a base64 image becomes a placeholder, and the payload never reaches the wire', () => {
  // THE load-bearing test. The longest single line measured on the development
  // machine is 1,365,762 bytes and it is a screenshot; one file held eight.
  const payload = 'QkFTRTY0SU1BR0VQQVlMT0FE'.repeat(4000);
  const { entries } = run(userRec([{
    type: 'tool_result', tool_use_id: 'tu1',
    content: [{ type: 'text', text: 'captured' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload } }],
  }]));
  const wire = JSON.stringify(entries);
  assert.ok(!wire.includes('QkFTRTY0SU1BR0VQQVlMT0FE'), 'base64 leaked into the output');
  assert.ok(wire.length < 5000, `entries serialized to ${wire.length} bytes`);

  const img = entries.find((e) => e.kind === 'image');
  assert.ok(img, 'no image placeholder produced');
  assert.strictEqual(img.mediaType, 'image/png');
  assert.ok(img.fullBytes > 60000, 'the placeholder must report how big it was');
  // The sibling text survives — an image does not swallow the rest of the result.
  assert.strictEqual(entries.find((e) => e.kind === 'tool_result').output, 'captured');
});

test('a top-level image block (a pasted screenshot) is a placeholder too', () => {
  const { entries } = run(userRec([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA'.repeat(1000) } }]));
  assert.strictEqual(entries[0].kind, 'image');
  assert.strictEqual(entries[0].mediaType, 'image/jpeg');
});

// --------------------------------------------------------------- truncation

test('an oversized field is cut, flagged, and reports its real size', () => {
  const big = 'y'.repeat(200000);
  const { entries, stats } = run(userRec([{ type: 'tool_result', tool_use_id: 't', content: big }]));
  assert.strictEqual(entries[0].truncated, true);
  assert.strictEqual(entries[0].output.length, view.TOOL_RESULT_LIMIT);
  // fullBytes is what lets the pane say "+191 KB not shown" instead of ending
  // mid-word with no explanation.
  assert.strictEqual(entries[0].fullBytes, 200000);
  assert.strictEqual(stats.truncatedEntries, 1);
});

test('conversation text gets a far more generous budget than tool output', () => {
  assert.ok(view.TEXT_LIMIT > view.TOOL_RESULT_LIMIT * 3,
    'prose is what the reader came for; a build log is not');
  const { entries } = run(asstRec([{ type: 'text', text: 'z'.repeat(view.TEXT_LIMIT - 1) }]));
  assert.strictEqual(entries[0].truncated, false);
});

// ------------------------------------------------------------- drop vs flag

test('bookkeeping record types produce no entries at all', () => {
  // 5,208 of 11,910 records in a 40-file sample. `attachment` alone was 1,832.
  const noise = ['attachment', 'mode', 'permission-mode', 'ai-title', 'last-prompt',
    'file-history-snapshot', 'file-history-delta', 'worktree-state', 'atis-latch',
    'queue-operation', 'cost-state', 'bridge-session', 'pr-link'];
  const { entries, stats } = normalizeLines({ lines: noise.map((type) => line({ type, sessionId: 's' })) });
  assert.deepStrictEqual(entries, []);
  assert.strictEqual(stats.dropped, noise.length);
});

test('a record type nobody has seen yet is ignored, not rendered', () => {
  const { entries, stats } = run({ type: 'something-invented-in-2027', sessionId: 's' });
  assert.deepStrictEqual(entries, []);
  assert.strictEqual(stats.dropped, 1);
});

test('machinery, isMeta and sidechain records are KEPT and flagged', () => {
  // Flagged rather than dropped on purpose. "[Request interrupted by user]" is a
  // real event, and a slash command is often exactly what someone scrolled back
  // to find — hiding them by default is the client's call, not this module's.
  const { entries } = run(
    userRec('<command-name>/deepsteve:merge</command-name>'),
    userRec('[Request interrupted by user]'),
    userRec('a skill body', { isMeta: true }),
    userRec('a subagent turn', { isSidechain: true }),
    userRec('something a person typed'),
  );
  assert.deepStrictEqual(entries.map((e) => e.metaReason),
    ['machinery', 'machinery', 'isMeta', 'sidechain', null]);
  assert.deepStrictEqual(entries.map((e) => e.meta), [true, true, true, true, false]);
});

test('an assistant message is never treated as machinery', () => {
  // Only a user record carries those tags; matching them on assistant prose would
  // hide a real answer that happened to quote one.
  const { entries } = run(asstRec([{ type: 'text', text: '<command-name>x</command-name>' }]));
  assert.strictEqual(entries[0].meta, false);
});

test('system records are flagged by TYPE, not by isMeta', () => {
  // The turn_duration records sampled on this machine carry isMeta:false, so an
  // isMeta gate would let timing chatter through as conversation.
  const { entries } = run({ type: 'system', subtype: 'turn_duration', content: 'took 41s', isMeta: false, durationMs: 41000 });
  assert.strictEqual(entries[0].kind, 'system');
  assert.strictEqual(entries[0].meta, true);
  assert.strictEqual(entries[0].metaReason, 'system');
  assert.strictEqual(entries[0].subtype, 'turn_duration');
});

test('toolUseResult is dropped — it duplicates the tool_result block', () => {
  // 147 of 223 sampled toolUseResult records had stdout byte-identical to the
  // block's content. Shipping both roughly doubles tool payload for nothing.
  const { entries } = run(userRec([{ type: 'tool_result', tool_use_id: 't', content: 'hello' }], {
    toolUseResult: { stdout: 'hello', stderr: '', interrupted: false, isImage: false },
  }));
  assert.strictEqual(JSON.stringify(entries).includes('toolUseResult'), false);
  assert.strictEqual(entries[0].output, 'hello');
});

// -------------------------------------------------------------- robustness

test('a line cut mid-JSON is skipped and counted, not thrown', () => {
  // The first line of a byte window is routinely half a record, and a transcript
  // being appended to can end mid-record. Both are normal.
  const { entries, stats } = normalizeLines({
    lines: [line('{"type":"user","messa'), line(userRec('real')), line('')],
  });
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(stats.unparsed, 1);
});

test('a record too large for the read window becomes a visible gap', () => {
  const { entries, stats } = normalizeLines({
    lines: [{ offset: 100, bytes: 3000000, text: null, oversize: true }],
  });
  assert.strictEqual(stats.oversize, 1);
  assert.strictEqual(entries[0].kind, 'oversize');
  assert.strictEqual(entries[0].fullBytes, 3000000);
});

test('malformed records do not throw', () => {
  for (const bad of [null, 42, 'text', {}, { type: 'user' }, { type: 'assistant', message: null },
    { type: 'user', message: { content: 7 } }, { type: 'user', message: { content: [null, 3] } }]) {
    assert.doesNotThrow(() => normalizeRecord(bad, { offset: 0, bytes: 0 }));
  }
});

// ------------------------------------------------------------------ grouping

test('one assistant turn keeps one groupId across its several records', () => {
  // Claude Code writes thinking, prose and a tool call as SEPARATE records that
  // share message.id. Without carrying that id the pane draws three unrelated
  // bubbles where there was one turn.
  const { entries } = run(
    asstRec([{ type: 'thinking', thinking: 'hm', signature: 's' }]),
    asstRec([{ type: 'text', text: 'here goes' }]),
    asstRec([{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }]),
  );
  assert.deepStrictEqual([...new Set(entries.map((e) => e.groupId))], ['msg_1']);
});

test('entries carry the byte offset of their source line', () => {
  // The offset is the deep-link and the seed for any future expand-one-record
  // endpoint, so it has to be the real position, not an index.
  const a = line(userRec('first'));
  const b = line(userRec('second'));
  const { entries } = normalizeLines({ lines: [a, b] });
  assert.strictEqual(entries[0].offset, a.offset);
  assert.strictEqual(entries[1].offset, b.offset);
  assert.strictEqual(entries[1].bytes, b.bytes);
});

// --------------------------------------------------------------- invariants

test('normalizing is deterministic', () => {
  // The endpoint's cursor is a byte offset, which only means anything if the same
  // bytes always yield the same entries. No clock, no randomness, no filtering
  // that depends on a request parameter.
  const lines = [line(userRec('a')), line(asstRec([{ type: 'text', text: 'b' }]))];
  assert.deepStrictEqual(normalizeLines({ lines }), normalizeLines({ lines }));
});

test('the module never touches the filesystem', () => {
  // The whole reason for splitting transcript-window.js off. If this fails, the
  // pure half stopped being testable without a temp directory.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'transcript-view.js'), 'utf8');
  // Comments stripped first: the module's own header explains this rule by
  // quoting the very call it forbids, and a naive grep flags that.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/require\(['"](node:)?fs['"]\)/.test(code), 'transcript-view.js must not require fs');
});

test('the machinery pattern is a copy of the delivery checker, not a shared object', () => {
  // They answer different questions and are expected to diverge; sharing one
  // would let a change to this pane silently alter #656's truncation verdicts.
  const { MACHINERY_RE } = require('../../prompt-delivery-check.js');
  assert.notStrictEqual(view.META_RE, MACHINERY_RE,
    'META_RE must be its own regex, not prompt-delivery-check.js\'s');
});

test('empty input is empty output, not a throw', () => {
  assert.deepStrictEqual(normalizeLines({}).entries, []);
  assert.deepStrictEqual(normalizeLines().entries, []);
});

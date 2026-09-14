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

test('arrow-stepping walks prompts and answers, not the work between them', async () => {
  // "Step through turns, not pixels" is the whole reason the pane owns its own
  // viewport. Since #704 a step is a prompt or a final answer: landing on narration
  // folded inside a work line would move the selection somewhere you cannot see.
  const { isStepEntry } = await load();
  assert.strictEqual(isStepEntry(entry({ role: 'user', kind: 'text' })), true, 'a prompt');
  assert.strictEqual(isStepEntry(entry({ kind: 'text', stopReason: 'end_turn' })), true, 'an answer');
  assert.strictEqual(isStepEntry(entry({ kind: 'text', stopReason: 'tool_use' })), false, 'narration before a tool call');
  assert.strictEqual(isStepEntry(entry({ kind: 'text', stopReason: null })), false, 'no stop reason is not an answer');
  assert.strictEqual(isStepEntry(entry({ kind: 'thinking', stopReason: 'end_turn' })), false);
  assert.strictEqual(isStepEntry(entry({ kind: 'tool_use' })), false);
  assert.strictEqual(isStepEntry(entry({ role: 'user', kind: 'text', meta: true, metaReason: 'machinery' })), false);
  assert.strictEqual(isStepEntry(null), false);
});

// ---------------------------------------------------------- prompt → answer
//
// #704. Each exchange is a prompt, then its work and its final answers in file
// order. The failure is quiet: an answer shown under the wrong prompt, or not at
// all, still looks like a transcript.

let at = 0;
const ts = (sec) => new Date(Date.UTC(2026, 8, 13, 12, 0, sec)).toISOString();
const prompt = (text, over = {}) => entry({ role: 'user', kind: 'text', text, offset: ++at, uuid: `p${at}`, ...over });
const answer = (text, over = {}) => entry({ kind: 'text', text, stopReason: 'end_turn', offset: ++at, uuid: `a${at}`, ...over });
const narration = (text, over = {}) => entry({ kind: 'text', text, stopReason: 'tool_use', offset: ++at, uuid: `n${at}`, ...over });
const call = (id, over = {}) => toolUse(id, { offset: ++at, uuid: `c${at}`, ...over });
const output = (id, over = {}) => toolResult(id, { offset: ++at, uuid: `r${at}`, ...over });

// [prompt text | null, 'work:<n entries>' | 'answer:<text>', ...] per exchange.
const shape = (exchanges) => exchanges.map((x) => [
  x.prompt ? x.prompt.text : null,
  ...x.items.map((i) => (i.type === 'answer' ? `answer:${i.entry.text}` : `work:${i.entries.length}`)),
]);

test('a prompt with no final answer keeps its work and says it was not answered', async () => {
  // 57 of 166 measured prompts had no end_turn answer: interrupted, or still running.
  const { groupByPrompt } = await load();
  const got = groupByPrompt([prompt('run the suite'), call('t1'), output('t1'), narration('still going')]);
  assert.deepStrictEqual(shape(got), [['run the suite', 'work:3']]);
  assert.strictEqual(got[0].answered, false);
});

test('a prompt with one answer is prompt, work, answer', async () => {
  const { groupByPrompt } = await load();
  const got = groupByPrompt([
    prompt('why is it red?'), entry({ kind: 'thinking', offset: ++at }), call('t1'), output('t1'), answer('the fixture raced'),
  ]);
  assert.deepStrictEqual(shape(got), [['why is it red?', 'work:3', 'answer:the fixture raced']]);
  assert.strictEqual(got[0].answered, true);
});

test('several answers keep the work between them where it happened', async () => {
  // Auto mode, or a background task waking the agent. 32 of ~35 measured prompts with
  // several answers did work BETWEEN them, so hoisting it all above the first answer
  // would misplace it. The trailing turn_duration notice is work too, not a new exchange.
  const { groupByPrompt } = await load();
  const got = groupByPrompt([
    prompt('fix it'),
    call('t1'), output('t1'),
    answer('first pass done'),
    prompt('<task-notification>build finished</task-notification>', { meta: true, metaReason: 'machinery' }),
    call('t2'), output('t2'),
    answer('all green'),
    entry({ role: 'system', kind: 'system', meta: true, metaReason: 'system', offset: ++at }),
  ]);
  assert.deepStrictEqual(shape(got), [['fix it', 'work:2', 'answer:first pass done', 'work:3', 'answer:all green', 'work:1']]);
});

test('an answer with no work before it has no empty work line', async () => {
  const { groupByPrompt } = await load();
  assert.deepStrictEqual(shape(groupByPrompt([prompt('hi'), answer('hello')])), [['hi', 'answer:hello']]);
});

test('a prompt on an older page does not orphan its answer', async () => {
  // The newest page starts mid-exchange. Its answer must still show, under an exchange
  // with no prompt; loading the older page and rebuilding re-attaches it.
  const { groupByPrompt } = await load();
  const older = [prompt('the original ask'), narration('looking')];
  const newest = [call('t1'), output('t1'), answer('the late answer'), prompt('next'), answer('ok')];

  assert.deepStrictEqual(shape(groupByPrompt(newest)), [
    [null, 'work:2', 'answer:the late answer'],
    ['next', 'answer:ok'],
  ]);
  assert.deepStrictEqual(shape(groupByPrompt(older.concat(newest))), [
    ['the original ask', 'work:3', 'answer:the late answer'],
    ['next', 'answer:ok'],
  ]);
});

test('machinery, compaction summaries and tool results never open an exchange', async () => {
  const { groupByPrompt } = await load();
  const got = groupByPrompt([
    prompt('do the thing'),
    prompt('<command-name>/compact</command-name>', { meta: true, metaReason: 'machinery' }),
    prompt('This session is being continued from a previous conversation.', { meta: true, metaReason: 'compact-summary' }),
    call('t1'), output('t1'),
    answer('done'),
  ]);
  assert.deepStrictEqual(shape(got), [['do the thing', 'work:4', 'answer:done']]);
});

test('a work line counts what a reader sees and how long it took', async () => {
  const { groupByPrompt, formatWorkSummary } = await load();
  const got = groupByPrompt([
    prompt('go', { ts: ts(0) }),
    call('t1', { ts: ts(5) }), output('t1', { ts: ts(6) }),
    narration('now the other file', { ts: ts(30) }),
    call('t2', { ts: ts(40) }), output('t2', { ts: ts(41) }),
    // A subagent's own tool call is meta: hidden by default, so not counted.
    call('side', { ts: ts(50), meta: true, metaReason: 'sidechain' }),
    answer('done', { ts: new Date(Date.UTC(2026, 8, 13, 12, 4, 0)).toISOString() }),
  ]);
  const work = got[0].items[0];
  assert.strictEqual(work.stats.toolCalls, 2);
  assert.strictEqual(work.stats.notes, 1);
  // From the prompt to the answer, not from the first to the last tool call.
  assert.strictEqual(work.stats.durationMs, 4 * 60 * 1000);
  assert.strictEqual(formatWorkSummary(work.stats), '2 tool calls · 1 note · 4m');
});

test('the work summary reads the way a person would say it', async () => {
  const { formatWorkSummary } = await load();
  assert.strictEqual(formatWorkSummary({ toolCalls: 12, notes: 3, durationMs: 4 * 60 * 1000 + 10000 }), '12 tool calls · 3 notes · 4m');
  assert.strictEqual(formatWorkSummary({ toolCalls: 1 }), '1 tool call');
  assert.strictEqual(formatWorkSummary({ toolCalls: 1, durationMs: 72 * 60 * 1000 }), '1 tool call · 1h 12m');
  assert.strictEqual(formatWorkSummary({ thinking: 2, durationMs: 42000 }), 'thinking · 42s');
  assert.strictEqual(formatWorkSummary({ durationMs: 400 }), 'notices', 'meta-only work, shown with ⚙ on');
  assert.strictEqual(formatWorkSummary(null), 'notices');
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

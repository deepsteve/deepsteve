// Unit test for the pure chat-view parser in public/js/chat-view.js (#481).
//
// The chat view re-renders a Claude Code session as a collapsible tree by
// classifying xterm buffer lines on their prefix glyphs. This locks the parser
// against a clean transcript fixture (and the messy real screen tails, as a
// graceful-degradation smoke test), with no browser — the fast loop for the
// three correctness bugs that got the first implementation reverted.
//
// chat-view.js is an ES module, so it's loaded with dynamic import(); the pure
// exports touch no DOM, so no globals need stubbing.
//
// Run: node --test test/unit/chat-view.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { CHAT_TRANSCRIPT, CHROME_LINES } = require('./fixtures/chat-transcript.js');
const { fixtures: screenTails } = require('./fixtures/screen-tails.js');

let mod;
async function load() {
  if (!mod) mod = await import('../../public/js/chat-view.js');
  return mod;
}

// Flatten all text a viewer would see (user lines + block text) for leak checks.
function allText(turns) {
  const parts = [];
  for (const t of turns) {
    if (t.user !== null) parts.push(t.user);
    for (const b of t.blocks) parts.push(b.text);
  }
  return parts.join('\n');
}

test('parses the transcript into two turns (trailing draft dropped)', async () => {
  const { parseTurns } = await load();
  const turns = parseTurns(CHAT_TRANSCRIPT);
  assert.strictEqual(turns.length, 2, 'the bare `❯ an unsent draft` composer must not become a 3rd turn');
  assert.strictEqual(turns[0].user, 'user question one');
  assert.strictEqual(turns[1].user, 'user question two');
});

test('Bug 1: the unsent draft is never rendered as a sent user message', async () => {
  const { parseTurns } = await load();
  const turns = parseTurns(CHAT_TRANSCRIPT);
  assert.ok(!turns.some((t) => t.user === 'an unsent draft'), 'draft leaked as a user turn');
});

test('turn 1 block kinds, order, and collapsibility', async () => {
  const { parseTurns } = await load();
  const blocks = parseTurns(CHAT_TRANSCRIPT)[0].blocks;
  assert.deepStrictEqual(blocks.map((b) => b.kind), ['thinking', 'agent', 'tool', 'status', 'agent']);
  assert.deepStrictEqual(blocks.map((b) => b.collapsible), [true, false, true, true, false]);
});

test('Bug 2b: thinking body survives the blank line and keeps both paragraphs', async () => {
  const { parseTurns } = await load();
  const thinking = parseTurns(CHAT_TRANSCRIPT)[0].blocks[0];
  assert.strictEqual(thinking.kind, 'thinking');
  assert.match(thinking.text, /The user wants X/);
  assert.match(thinking.text, /second thinking paragraph/, 'the post-blank thinking body was dropped');
});

test('Bug 2b: multi-paragraph agent reply is not truncated', async () => {
  const { parseTurns } = await load();
  const agent = parseTurns(CHAT_TRANSCRIPT)[0].blocks[1];
  assert.strictEqual(agent.kind, 'agent');
  assert.match(agent.text, /primary answer/);
  assert.match(agent.text, /second paragraph that must survive/, 'the reply was truncated to its first paragraph');
});

test('Bug 2a: a ⏺ Tool(...) call is a collapsible tool block that captures its ⎿ output', async () => {
  const { parseTurns } = await load();
  const tool = parseTurns(CHAT_TRANSCRIPT)[0].blocks[2];
  assert.strictEqual(tool.kind, 'tool');
  assert.strictEqual(tool.collapsible, true);
  assert.match(tool.text, /^Bash\(git status\)/, 'tool header should be the summary line');
  assert.match(tool.text, /nothing to commit/, 'the ⎿ output must fold into the tool block');
  assert.match(tool.text, /an extra output line/, 'output after a blank line was dropped');
});

test('a plain ⏺ reply that looks like prose stays a non-collapsible agent block', async () => {
  const { parseTurns } = await load();
  const reply = parseTurns(CHAT_TRANSCRIPT)[0].blocks[4];
  assert.strictEqual(reply.kind, 'agent');
  assert.strictEqual(reply.collapsible, false);
  assert.match(reply.text, /Tracked\./);
});

test('Bug 3: multiple spinner frames all classify as status', async () => {
  const { classifyLine } = await load();
  for (const line of ['✻ Brewed for 13s', '✽ Baking…', '✳ Ionizing…', '✶ Simmering…']) {
    assert.strictEqual(classifyLine(line).kind, 'status', `frame not recognised: ${line}`);
  }
  // Forward-compat: an un-catalogued sparkle frame still lands as status.
  assert.strictEqual(classifyLine('✷ Percolating…').kind, 'status');
});

test('tool-header detection distinguishes tool calls from agent prose', async () => {
  const { isToolHeader } = await load();
  assert.ok(isToolHeader('Bash(git status)'));
  assert.ok(isToolHeader('Read(/path/to/file)'));
  assert.ok(isToolHeader('TodoWrite(items)'));
  assert.ok(isToolHeader('mcp__deepsteve__get_session_info(x)'));
  assert.ok(isToolHeader('deepsteve - read_session_screen (MCP)(session_id: "a")'));
  assert.ok(!isToolHeader('Tracked. Which one do you prefer?'));
  assert.ok(!isToolHeader('I updated the config to fix(the bug)'));
});

test('chrome lines are recognised and never leak into rendered content', async () => {
  const { parseTurns, isChrome } = await load();
  for (const line of CHROME_LINES) {
    assert.ok(isChrome(line), `not recognised as chrome: ${line}`);
  }
  const text = allText(parseTurns(CHAT_TRANSCRIPT));
  for (const line of CHROME_LINES) {
    assert.ok(!text.includes(line), `chrome leaked into content: ${line}`);
  }
});

test('unanswered-message guard: a just-sent message is kept, the empty composer is dropped', async () => {
  const { parseTurns } = await load();
  const turns = parseTurns(['❯ my q', '✻ Ionizing… (esc to interrupt · 3s)', '❯']);
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].user, 'my q');
  assert.strictEqual(turns[0].blocks.length, 1);
  assert.strictEqual(turns[0].blocks[0].kind, 'status');
});

test('robustness: the messy real screen tails parse without throwing', async () => {
  const { parseTurns } = await load();
  for (const f of screenTails) {
    assert.doesNotThrow(() => {
      const turns = parseTurns(String(f.tail).split('\n'));
      assert.ok(Array.isArray(turns));
    }, `threw on tail: ${f.name}`);
  }
});

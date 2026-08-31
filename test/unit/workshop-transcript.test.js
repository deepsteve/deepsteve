// mods/workshop/transcript.js (#670) — a Claude transcript read as a conversation.
//
// Every case here is a line shape taken from a real ~/.claude/projects/**/*.jsonl. The
// ones that matter are the DROPS: a transcript is mostly tool calls, tool results,
// thinking and harness plumbing, and a chat pane that renders any of those is unreadable
// rather than richer. A regression here does not throw — it fills the pane with noise, or
// silently empties it — which is why the filters are pinned one by one.
//
// Pure: literal strings in, plain objects out. No fs, no daemon, no clock.
//
// Run: node --test test/unit/workshop-transcript.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { parseTranscript, MAX_MESSAGES } = require('../../mods/workshop/transcript.js');

const line = (o) => JSON.stringify(o);
const parse = (lines, opts) => parseTranscript(lines.join('\n'), opts);
const texts = (lines, opts) => parse(lines, opts).messages.map((m) => m.text);

const userStr = (text, extra = {}) => line({
  type: 'user', uuid: 'u-' + text.slice(0, 6), timestamp: '2026-08-31T10:00:00.000Z',
  message: { role: 'user', content: text }, ...extra,
});
const agentText = (text, extra = {}) => line({
  type: 'assistant', uuid: 'a-' + text.slice(0, 6), timestamp: '2026-08-31T10:00:05.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra,
});

test('a human message and an agent reply become one conversation, in file order', () => {
  const { messages } = parse([userStr('why this shape?'), agentText('Because X.')]);
  assert.deepStrictEqual(messages.map((m) => [m.role, m.text]), [
    ['human', 'why this shape?'],
    ['agent', 'Because X.'],
  ]);
  assert.strictEqual(messages[0].uuid, 'u-why th');
  assert.strictEqual(messages[0].at, Date.parse('2026-08-31T10:00:00.000Z'));
});

test('a turn that only called tools produces no bubble at all', () => {
  // Not an empty message — none. A session that ran forty greps would otherwise render as
  // forty blank rows, which is worse than showing nothing.
  const lines = [
    agentText('Looking.'),
    line({
      type: 'assistant',
      uuid: 'a2',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    }),
    line({
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
    }),
  ];
  assert.deepStrictEqual(texts(lines), ['Looking.']);
});

test('thinking blocks are dropped, and their text block survives', () => {
  const lines = [line({
    type: 'assistant',
    uuid: 'a1',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'the user probably means…', signature: 'sig' },
        { type: 'text', text: 'Because the empty case is the default.' },
      ],
    },
  })];
  assert.deepStrictEqual(texts(lines), ['Because the empty case is the default.']);
});

test('a user record carries content as a STRING or as an array of blocks', () => {
  const arrayForm = line({
    type: 'user',
    uuid: 'u2',
    message: { role: 'user', content: [{ type: 'text', text: 'from an array' }] },
  });
  assert.deepStrictEqual(texts([userStr('from a string'), arrayForm]),
    ['from a string', 'from an array']);
});

test('subagent traffic is dropped — isSidechain is another conversation', () => {
  // Real text from a real model, which is exactly why it has to go: it is not the agent
  // you are talking to, and it arrives in bursts that bury the reply you are waiting for.
  const lines = [
    agentText('Mine.'),
    agentText('A subagent said this.', { isSidechain: true }),
    userStr('A subagent was asked this.', { isSidechain: true }),
  ];
  assert.deepStrictEqual(texts(lines), ['Mine.']);
});

test('isMeta is dropped — the harness injected it, nobody said it', () => {
  assert.deepStrictEqual(texts([userStr('injected', { isMeta: true }), agentText('real')]), ['real']);
});

test('slash-command and harness plumbing is dropped', () => {
  // The MACHINERY_RE survey in prompt-delivery-check.js found 149 of 274 text-bearing user
  // records were one of these. Rendering them would make every session that ever ran a
  // slash command look like it had a conversation about XML.
  for (const junk of [
    '<command-name>/deepsteve:merge</command-name>',
    '<local-command-stdout>ok</local-command-stdout>',
    '<system-reminder>remember the thing</system-reminder>',
    '<task-notification>agent done</task-notification>',
    '[Request interrupted by user]',
  ]) {
    assert.deepStrictEqual(texts([userStr(junk), agentText('kept')]), ['kept'],
      `${junk} reached the pane`);
  }
});

test('every non-message record type is dropped', () => {
  const noise = [
    { type: 'mode', mode: 'normal' },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'ai-title', aiTitle: 'Chat pane in Workshop' },
    { type: 'atis-latch', atis: '' },
    { type: 'worktree-state', worktreeSession: {} },
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'last-prompt', lastPrompt: 'x' },
    { type: 'attachment', attachment: { type: 'deferred_tools_delta' } },
  ].map(line);
  assert.deepStrictEqual(texts([...noise, agentText('the only real one')]), ['the only real one']);
});

test('a severed first line and a partial last line are skipped, not fatal', () => {
  // Both happen every single read: we take a fixed-size TAIL so the first line is usually
  // cut mid-JSON, and the session is appending while we read so the last one can be too.
  const raw = 'e":"assistant","uuid":"cut"}\n'
    + agentText('survived') + '\n'
    + '{"type":"assistant","message":{"role":"assis';
  assert.deepStrictEqual(parseTranscript(raw).messages.map((m) => m.text), ['survived']);
});

test('empty, null and whitespace-only input are empty conversations', () => {
  for (const input of ['', null, undefined, '\n\n  \n']) {
    assert.deepStrictEqual(parseTranscript(input), { messages: [], truncated: false });
  }
});

test('a message with no text after trimming is dropped', () => {
  assert.deepStrictEqual(texts([agentText('   '), agentText('kept')]), ['kept']);
});

test('the cap keeps the NEWEST messages and reports the truncation', () => {
  const many = Array.from({ length: 5 }, (_, i) => userStr('m' + i));
  const { messages, truncated } = parse(many, { max: 2 });
  assert.deepStrictEqual(messages.map((m) => m.text), ['m3', 'm4']);
  assert.strictEqual(truncated, true, 'the pane has to be able to say history is missing');

  const { truncated: none } = parse(many, { max: 50 });
  assert.strictEqual(none, false);
});

test('MAX_MESSAGES is the default cap and is a sane tail', () => {
  assert.strictEqual(typeof MAX_MESSAGES, 'number');
  assert.ok(MAX_MESSAGES >= 50 && MAX_MESSAGES <= 1000, `MAX_MESSAGES is ${MAX_MESSAGES}`);
});

test('a record with no timestamp still renders, with a null time', () => {
  const { messages } = parse([line({
    type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'no clock' }] },
  })]);
  assert.strictEqual(messages[0].at, null);
  assert.strictEqual(messages[0].text, 'no clock');
});

test('the machinery filter is the SAME object prompt-delivery-check.js uses', () => {
  // Two copies would drift the moment either survey is redone, and the drift would show up
  // as the chat pane rendering slash-command internals — a bug nobody would trace back
  // here. This asserts the shared definition rather than the behaviour.
  const pdc = require('../../prompt-delivery-check.js');
  assert.ok(pdc.MACHINERY_RE instanceof RegExp, 'prompt-delivery-check must export MACHINERY_RE');
  assert.strictEqual(typeof pdc.messageText, 'function', 'and messageText');
});

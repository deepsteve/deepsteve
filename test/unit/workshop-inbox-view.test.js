// Unit test for mods/workshop/inbox-view.js — the parts of the Workshop panel that
// break invisibly (#660).
//
// Why these five behaviours and not the rest of the panel: the panel re-reads the
// server every two seconds and rewrites the list under a live cursor. A comparator
// that is not a TOTAL order makes the list jitter; a selection rule that follows the
// index instead of the item makes the cursor wander; a typing guard that is too loose
// makes the letter `e` archive the item you were describing. None of those look wrong
// in a screenshot, and all of them are infuriating in use. Everything else in
// workshop.jsx is layout, which you verify by looking at it.
//
// The module is a browser ES module with zero imports, driven here with `await
// import()` from CommonJS — the test/unit/village-layout.test.js pattern, which Node
// resolves by detecting module syntax. No DOM stubs at all, which is the point of
// keeping it pure and is why this survives the bare `unit` CI job.
//
// Run: node --test test/unit/workshop-inbox-view.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let view;
async function load() {
  if (!view) view = await import('../../mods/workshop/inbox-view.js');
  return view;
}

const NOW = 1_700_000_000_000;

const item = (over = {}) => ({
  id: over.id || 'w1',
  kind: 'question',
  urgency: 'normal',
  createdAt: NOW,
  project: '/repo/a',
  projectName: 'a',
  headline: 'Something',
  context: '',
  options: [],
  ...over,
});

// ── ordering ─────────────────────────────────────────────────────────────────

test('blocking, then normal, then fyi', async () => {
  const { sortItems } = await load();
  const list = [
    item({ id: 'w1', urgency: 'fyi', createdAt: NOW + 1 }),
    item({ id: 'w2', urgency: 'normal', createdAt: NOW + 2 }),
    item({ id: 'w3', urgency: 'blocking', createdAt: NOW + 3 }),
    item({ id: 'w4', urgency: 'normal', createdAt: NOW + 4 }),
    item({ id: 'w5', urgency: 'blocking', createdAt: NOW + 5 }),
  ];
  assert.deepStrictEqual(sortItems(list).map((i) => i.id), ['w3', 'w5', 'w2', 'w4', 'w1']);
});

test('oldest first inside a rank — the longest wait is the top of the queue', async () => {
  const { sortItems } = await load();
  const list = [
    item({ id: 'w1', urgency: 'blocking', createdAt: NOW + 900 }),
    item({ id: 'w2', urgency: 'blocking', createdAt: NOW + 100 }),
    item({ id: 'w3', urgency: 'blocking', createdAt: NOW + 500 }),
  ];
  assert.deepStrictEqual(sortItems(list).map((i) => i.id), ['w2', 'w3', 'w1']);
});

test('an unknown urgency ranks as normal rather than falling off the list', async () => {
  const { sortItems } = await load();
  const list = [
    item({ id: 'w1', urgency: 'fyi', createdAt: NOW }),
    item({ id: 'w2', urgency: 'URGENT!!', createdAt: NOW }),
    item({ id: 'w3', urgency: 'blocking', createdAt: NOW }),
  ];
  assert.deepStrictEqual(sortItems(list).map((i) => i.id), ['w3', 'w2', 'w1']);
});

test('the sort is a TOTAL order, so a poll cannot reshuffle the list', async () => {
  const { sortItems } = await load();
  // Identical urgency AND timestamp is the common case for derived rows: the server
  // rebuilds them per request, so array order carries no information and JS sort
  // stability buys nothing.
  const base = Array.from({ length: 9 }, (_, i) =>
    item({ id: 'blocked:s' + i, urgency: 'blocking', createdAt: NOW }));
  const expected = sortItems(base).map((i) => i.id);
  for (let round = 0; round < 20; round++) {
    const shuffled = base.slice().sort(() => Math.random() - 0.5);
    assert.deepStrictEqual(
      sortItems(shuffled).map((i) => i.id), expected,
      'compareItems needs the id tiebreak — without it the list jitters under the '
      + 'cursor at every 2s poll, which is unusable and looks like a rendering bug',
    );
  }
});

test('sortItems does not mutate its input', async () => {
  const { sortItems } = await load();
  const list = [item({ id: 'w1', urgency: 'fyi' }), item({ id: 'w2', urgency: 'blocking' })];
  sortItems(list);
  assert.deepStrictEqual(list.map((i) => i.id), ['w1', 'w2']);
});

// ── grouping, and the render order the cursor walks ──────────────────────────

test('grouping keeps every item and floats the most urgent project up', async () => {
  const { groupByProject, flattenGroups } = await load();
  const list = [
    item({ id: 'w1', project: '/repo/a', projectName: 'a', urgency: 'normal', createdAt: NOW }),
    item({ id: 'w2', project: '/repo/b', projectName: 'b', urgency: 'blocking', createdAt: NOW }),
    item({ id: 'w3', project: '/repo/a', projectName: 'a', urgency: 'fyi', createdAt: NOW }),
  ];
  const groups = groupByProject(list);
  assert.deepStrictEqual(groups.map((g) => g.name), ['b', 'a']);
  assert.deepStrictEqual(flattenGroups(groups).map((i) => i.id).sort(), ['w1', 'w2', 'w3']);
});

test('order matches the rendered list exactly, grouped or not', async () => {
  const { visibleItems } = await load();
  const list = [
    item({ id: 'w1', project: '/repo/a', projectName: 'a' }),
    item({ id: 'w2', project: '/repo/b', projectName: 'b', urgency: 'blocking' }),
    item({ id: 'w3', project: '/repo/a', projectName: 'a' }),
  ];
  for (const grouped of [false, true]) {
    const v = visibleItems(list, { groupByProject: grouped });
    assert.deepStrictEqual(
      v.order, v.list.map((i) => i.id),
      'the cursor indexes into `order` while the DOM renders `list`/`groups`. If they '
      + 'ever disagree, arrow keys select a different row from the one highlighted.',
    );
  }
});

test('showBriefings:false drops briefings and only briefings', async () => {
  const { visibleItems } = await load();
  const list = [
    item({ id: 'w1', kind: 'briefing', urgency: 'fyi' }),
    item({ id: 'w2', kind: 'question' }),
    item({ id: 'w3', kind: 'blocked', urgency: 'blocking' }),
  ];
  assert.deepStrictEqual(visibleItems(list, { showBriefings: false }).order, ['w3', 'w2']);
  assert.deepStrictEqual(visibleItems(list, { showBriefings: true }).order, ['w3', 'w2', 'w1']);
});

test('blockingOnly filters on urgency, not kind', async () => {
  const { visibleItems } = await load();
  const list = [
    item({ id: 'w1', kind: 'question', urgency: 'blocking' }),
    item({ id: 'w2', kind: 'blocked', urgency: 'blocking' }),
    item({ id: 'w3', kind: 'question', urgency: 'normal' }),
  ];
  assert.deepStrictEqual(
    visibleItems(list, { blockingOnly: true }).order.sort(), ['w1', 'w2'],
    'a workshop_ask question can be blocking too — filtering on kind would hide it',
  );
});

test('an empty or junk list is an empty render, not a throw', async () => {
  const { visibleItems } = await load();
  for (const bad of [null, undefined, [], [null, undefined]]) {
    const v = visibleItems(bad, {});
    assert.deepStrictEqual(v.order, []);
    assert.deepStrictEqual(v.list, []);
  }
});

// ── age ──────────────────────────────────────────────────────────────────────

test('formatAge covers seconds through days', async () => {
  const { formatAge } = await load();
  const cases = [
    [0, '0s'], [999, '0s'], [1000, '1s'], [42_000, '42s'], [59_999, '59s'],
    [60_000, '1m'], [185_000, '3m 5s'], [420_000, '7m'],
    [3_600_000, '1h'], [3_840_000, '1h 4m'],
    [86_400_000, '1d'], [200_000_000, '2d'],
  ];
  for (const [ms, want] of cases) assert.strictEqual(formatAge(ms), want, `formatAge(${ms})`);
  assert.strictEqual(formatAge(NaN), '0s');
  assert.strictEqual(formatAge(-5), '0s');
});

test('age colour boundaries match Action Required exactly', async () => {
  const { ageColor, AGE_WARN_MS, AGE_ALERT_MS } = await load();
  assert.strictEqual(AGE_WARN_MS, 30_000);
  assert.strictEqual(AGE_ALERT_MS, 60_000);
  const msg = 'these thresholds and hexes are Action Required\'s (action-required.jsx '
    + '`urgency`); the two surfaces describe the same wait — change both or neither';
  assert.strictEqual(ageColor(0, 'normal'), '#8b949e', msg);
  assert.strictEqual(ageColor(29_999, 'normal'), '#8b949e', msg);
  assert.strictEqual(ageColor(30_001, 'normal'), '#f0883e', msg);
  assert.strictEqual(ageColor(59_999, 'normal'), '#f0883e', msg);
  assert.strictEqual(ageColor(60_001, 'normal'), '#f85149', msg);
});

test('an fyi never turns orange — a day-old briefing is not urgent', async () => {
  const { ageColor } = await load();
  assert.strictEqual(ageColor(999_999, 'fyi'), '#6e7681');
});

// ── the row subject ──────────────────────────────────────────────────────────

test('a generic permission headline folds in the tool line above it', async () => {
  const { itemSubject } = await load();
  const subject = itemSubject(item({
    headline: 'Do you want to proceed?',
    context: 'deepsteve - read_session_screen (MCP)',
  }));
  assert.match(
    subject, /read_session_screen/,
    'eight rows all reading "Do you want to proceed?" is no improvement on Action '
    + "Required's tab names, which is the entire premise of this feature",
  );
});

test('a specific headline is left alone', async () => {
  const { itemSubject } = await load();
  assert.strictEqual(
    itemSubject(item({ headline: 'Which retry policy?', context: 'chatter' })),
    'Which retry policy?',
  );
});

test('a missing headline falls back rather than rendering blank', async () => {
  const { itemSubject } = await load();
  assert.strictEqual(itemSubject(item({ headline: '', context: 'Bash(rm -rf x)' })), 'Bash(rm -rf x)');
  assert.strictEqual(itemSubject(item({ headline: '', context: '', question: 'Go?' })), 'Go?');
  assert.strictEqual(itemSubject(null), '');
});

// ── the keyboard ─────────────────────────────────────────────────────────────

test('isTypingTarget is true for fields and false for buttons', async () => {
  const { isTypingTarget } = await load();
  for (const tag of ['TEXTAREA', 'INPUT', 'SELECT']) {
    assert.strictEqual(isTypingTarget({ tagName: tag }), true, tag);
  }
  assert.strictEqual(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  const why = 'a false negative means typing `e` in the reply box archives the item; a '
    + 'false positive means 1-9 die the moment you click an option, which is exactly '
    + 'when you would reach for them';
  for (const tag of ['DIV', 'BUTTON', 'A', 'PRE', 'SPAN']) {
    assert.strictEqual(isTypingTarget({ tagName: tag }), false, `${tag}: ${why}`);
  }
  assert.strictEqual(isTypingTarget(null), false);
});

test('the key map', async () => {
  const { keyAction } = await load();
  const opts = { optionCount: 3 };
  assert.deepStrictEqual(keyAction('ArrowDown', opts), { type: 'move', delta: 1 });
  assert.deepStrictEqual(keyAction('j', opts), { type: 'move', delta: 1 });
  assert.deepStrictEqual(keyAction('ArrowUp', opts), { type: 'move', delta: -1 });
  assert.deepStrictEqual(keyAction('k', opts), { type: 'move', delta: -1 });
  assert.deepStrictEqual(keyAction('Home', opts), { type: 'first' });
  assert.deepStrictEqual(keyAction('End', opts), { type: 'last' });
  assert.deepStrictEqual(keyAction('Enter', opts), { type: 'send' });
  assert.deepStrictEqual(keyAction('e', opts), { type: 'archive' });
  assert.deepStrictEqual(keyAction('o', opts), { type: 'open' });
  assert.deepStrictEqual(keyAction('r', opts), { type: 'focusReply' });
  assert.deepStrictEqual(keyAction('?', opts), { type: 'help' });
  assert.deepStrictEqual(keyAction('Escape', opts), { type: 'escape' });
});

test('digits stage an option, and only one that exists', async () => {
  const { keyAction } = await load();
  assert.deepStrictEqual(keyAction('1', { optionCount: 3 }), { type: 'pick', index: 0 });
  assert.deepStrictEqual(keyAction('3', { optionCount: 3 }), { type: 'pick', index: 2 });
  assert.strictEqual(keyAction('4', { optionCount: 3 }), null, 'no fourth option to pick');
  assert.strictEqual(keyAction('1', { optionCount: 0 }), null);
  assert.strictEqual(keyAction('0', { optionCount: 3 }), null);
});

test('shifted letters and unknown keys do nothing', async () => {
  const { keyAction } = await load();
  for (const k of ['E', 'O', 'R', 'J', 'K', 'x', 'F1', 'Tab', ' ', '']) {
    assert.strictEqual(keyAction(k, { optionCount: 3 }), null, `key ${JSON.stringify(k)}`);
  }
});

test('auto-repeat navigates but never commits', async () => {
  const { keyAction } = await load();
  const held = { optionCount: 3, repeat: true };
  assert.deepStrictEqual(keyAction('ArrowDown', held), { type: 'move', delta: 1 });
  assert.strictEqual(keyAction('Enter', held), null, 'holding Enter must not fire ten answers');
  assert.strictEqual(keyAction('e', held), null, 'holding `e` must not archive the whole inbox');
});

// ── the cursor across a poll ─────────────────────────────────────────────────

test('the cursor follows the item, not the index', async () => {
  const { nextSelection } = await load();
  // A row can change rank between polls with the human doing nothing at all.
  assert.strictEqual(nextSelection('w2', ['w1', 'w2', 'w3'], ['w3', 'w2', 'w1']), 'w2');
});

test('when the selected item goes, its place is taken', async () => {
  const { nextSelection } = await load();
  // Answered here, or resolved in its own terminal — either way the next thing should
  // already be selected rather than the cursor jumping home.
  assert.strictEqual(nextSelection('w2', ['w1', 'w2', 'w3'], ['w1', 'w3']), 'w3');
  assert.strictEqual(nextSelection('w3', ['w1', 'w2', 'w3'], ['w1', 'w2']), 'w2', 'clamped to the last row');
  assert.strictEqual(nextSelection('w1', ['w1'], []), null);
});

test('nothing selected plus a non-empty list selects the first row', async () => {
  const { nextSelection } = await load();
  assert.strictEqual(nextSelection(null, [], ['w1', 'w2']), 'w1');
  assert.strictEqual(nextSelection('gone', [], ['w1', 'w2']), 'w1');
});

// ── what gets POSTed ─────────────────────────────────────────────────────────

test('a picked option wins, and carries text along for a question', async () => {
  const { answerPayload } = await load();
  const q = item({ kind: 'question', options: [{ label: 'A' }, { label: 'B' }] });
  assert.deepStrictEqual(answerPayload(q, { picked: 1, draft: ' because ' }),
    { optionIndex: 1, text: 'because' });
  assert.deepStrictEqual(answerPayload(q, { picked: 0 }), { optionIndex: 0 });
  assert.deepStrictEqual(answerPayload(q, { draft: 'freeform' }), { text: 'freeform' });
});

test('nothing staged is nothing to send', async () => {
  const { answerPayload } = await load();
  const q = item({ kind: 'question', options: [{ label: 'A' }] });
  assert.strictEqual(answerPayload(q, {}), null);
  assert.strictEqual(answerPayload(q, { draft: '   ' }), null);
  assert.strictEqual(answerPayload(q, { picked: 5 }), null, 'an out-of-range pick is not a pick');
  assert.strictEqual(answerPayload(item({ kind: 'briefing' }), { draft: 'x' }), null);
  assert.strictEqual(answerPayload(null, { draft: 'x' }), null);
});

test('a blocked item posts an option and a fingerprint, never text', async () => {
  const { answerPayload, fingerprint } = await load();
  const blocked = item({ kind: 'blocked', options: [{ label: 'Yes' }, { label: '  No  ' }] });
  assert.deepStrictEqual(
    answerPayload(blocked, { picked: 1, draft: 'please just do it' }),
    { optionIndex: 1, expect: fingerprint('No') },
    'a live modal has no text field, and the fingerprint is what stops a swapped '
    + 'dialog being answered by index',
  );
  assert.strictEqual(
    answerPayload(blocked, { draft: 'do the second one' }), null,
    'text alone against a dialog must not even be attempted — the server 400s it',
  );
});

test('the fingerprint matches dialog-parse.js byte for byte', async () => {
  // Both sides of the verify step must normalize identically, or the server compares
  // the clicked label against the live one, never matches, and refuses every answer.
  const { fingerprint } = await load();
  const server = require('../../mods/workshop/dialog-parse.js').fingerprint;
  for (const label of [
    'Yes', '  Yes,   and   don\'t ask ', 'NO', '', null, undefined,
    'x'.repeat(500), 'Retry 3. times, then give up',
  ]) {
    assert.strictEqual(
      fingerprint(label), server(label),
      `fingerprint drift on ${JSON.stringify(label)} — the client's expect value would `
      + 'never match the server\'s live read, and every dialog answer would be refused',
    );
  }
});

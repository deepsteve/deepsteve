// Unit tests for public/js/one-liners.js — a tab's one-liner (its Custom Label, else Claude
// Code's title, else its first prompt on one line) and the cache the task board and overview
// mode each keep of the facts behind it.
//
// No browser, no daemon: fetch is stubbed, and the module is plain ESM with no imports.
//
// Run: node --test test/unit/one-liners.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../../public/js/one-liners.js');

/** A fake cards route. `facts[id]` overrides the default answer: a prompt, no title yet. */
function stubCards(facts = {}) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const ids = decodeURIComponent(url.split('ids=')[1]).split(',');
    asked.push(ids);
    if (facts.fail) return { ok: false, status: 500, json: async () => ({ error: 'down' }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ prompts: Object.fromEntries(ids.map(id => [id, {
        prompt: `prompt of ${id}`, title: null, customLabel: null, supported: true, ...(facts[id] || {}),
      }])) }),
    };
  };
  return asked;
}

test('oneLiner: the Custom Label, else the Summary, else the first prompt on one line', async () => {
  const { oneLiner } = await load();
  const f = (o) => ({ at: 0, prompt: null, title: null, customLabel: null, supported: true, ...o });
  assert.deepStrictEqual(oneLiner(f({ customLabel: 'Mine', title: 'T', prompt: 'p' })), { text: 'Mine', empty: false });
  assert.deepStrictEqual(oneLiner(f({ title: 'Tuba carols', prompt: 'p' })), { text: 'Tuba carols', empty: false });
  assert.deepStrictEqual(oneLiner(f({ prompt: '  fix the\n\n  tuba  ' })), { text: 'fix the tuba', empty: false });
  assert.deepStrictEqual(oneLiner(f({})), { text: 'No prompt yet', empty: true });
  assert.strictEqual(oneLiner(f({ supported: false })).empty, true, 'an agent with no transcript');
  assert.strictEqual(oneLiner(f({ supported: false, customLabel: 'Codex run' })).text, 'Codex run', 'still takes a Custom Label');
  assert.deepStrictEqual(oneLiner(undefined), { text: 'Loading…', empty: true });
});

test('want() asks only about tabs worth asking, in one request, and says what changed', async () => {
  const { createOneLiners } = await load();
  const asked = stubCards({ a: { title: 'Alpha' }, t: { prompt: null, supported: false } });
  const changes = [];
  const src = createOneLiners({ onChange: (ids) => changes.push(ids) });

  assert.strictEqual(src.text('a'), null, 'nothing before the first answer');
  await src.want(['a', 'b', 't', 'a']);
  assert.deepStrictEqual(asked, [['a', 'b', 't']], 'each once');
  assert.deepStrictEqual(changes, [['a', 'b', 't']]);
  assert.strictEqual(src.text('a'), 'Alpha', 'the Summary');
  assert.strictEqual(src.text('b'), 'prompt of b', 'no title yet: the first line');
  assert.strictEqual(src.text('t'), null, 'a plain terminal has none');

  await src.want(['a', 'b', 't']);
  assert.deepStrictEqual(asked.at(-1), ['b'], 'b is still missing its title; a has both; t keeps no transcript');

  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    await src.want(['a', 't']);
  } finally {
    Date.now = realNow;
  }
  assert.deepStrictEqual(asked.at(-1), ['a', 't'], 'everything is asked again after five minutes (a /clear)');
});

test('one request at a time; a failure reads as "no prompt yet" and is retried', async () => {
  const { createOneLiners } = await load();
  const asked = stubCards({ fail: true });
  const src = createOneLiners();
  const first = src.want(['a']);
  await src.want(['b']);   // while the first is in flight: nothing
  await first;
  assert.deepStrictEqual(asked, [['a']]);
  assert.deepStrictEqual(src.get('a') && [src.get('a').prompt, src.get('a').supported], [null, true]);
  await src.want(['a']);
  assert.strictEqual(asked.length, 2, 'asked again');
});

test('a Custom Label from a ping replaces the one-liner, and one for a tab never asked about waits', async () => {
  const { createOneLiners } = await load();
  stubCards({ a: { title: 'Alpha' } });
  const changes = [];
  const src = createOneLiners({ onChange: (ids) => changes.push(ids) });
  await src.want(['a']);
  src.onCustomLabel('a', 'Mine');
  assert.strictEqual(src.text('a'), 'Mine');
  assert.deepStrictEqual(changes.at(-1), ['a']);
  src.onCustomLabel('a', null);
  assert.strictEqual(src.text('a'), 'Alpha', 'cleared: the Summary is back');

  const n = changes.length;
  src.onCustomLabel('z', 'x');
  assert.strictEqual(src.has('z'), false);
  assert.strictEqual(changes.length, n, 'nothing to redraw');
});

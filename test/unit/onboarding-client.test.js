// Headless unit test for public/js/onboarding.js — the client half of first-run
// onboarding (#695).
//
// No browser, no Docker: stub the globals the module touches BEFORE importing it, then
// drive the exported API the way app.js does. Two harness details are load-bearing and
// have both bitten before:
//
//   - `window.parent = window` keeps storage-namespace.js at depth 0. Without it nsKey()
//     silently prefixes every key with `ds1-`, and the assertions below would pass
//     against a key the real page never writes.
//   - Each test re-imports with a unique ?query, so SEEN_KEY and any module state start
//     fresh rather than carrying the previous test's flag.
//
// What is actually worth pinning here is the storage TIER. "Has been shown around" is a
// browser-wide preference, so it must be localStorage: the daemon opens a brand-new
// browser tab at login, and that tab has no sessionStorage at all — a flag stored there
// would offer the tour again after every machine restart, forever.
//
// Run: node --test test/unit/onboarding-client.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const localMap = new Map();
const sessionMap = new Map();

function store(map, { throws = false } = {}) {
  return {
    getItem: (k) => { if (throws) throw new Error('SecurityError'); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (throws) throw new Error('SecurityError'); map.set(k, String(v)); },
    removeItem: (k) => { if (throws) throw new Error('SecurityError'); map.delete(k); },
  };
}

globalThis.localStorage = store(localMap);
globalThis.sessionStorage = store(sessionMap);

function fakeButton(id) {
  return { id, disabled: false, textContent: '', onclick: null, focus() { this.focused = true; } };
}

const byId = new Map();
globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
  addEventListener: () => {},
};
globalThis.window = { dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window;

// --------------------------------------------------------------------- harness

const KEY = 'deepsteve-onboarded';
let importCount = 0;

async function load() {
  const url = new URL('../../public/js/onboarding.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  return import(url.href);
}

/** The four card elements app.js's index.html provides, wired into the fake document. */
function mountCard() {
  const classes = new Set();
  const empty = {
    id: 'empty-state',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
  const els = {
    'empty-state': empty,
    'onboard-card': { id: 'onboard-card' },
    'onboard-start': fakeButton('onboard-start'),
    'onboard-skip': fakeButton('onboard-skip'),
    'onboard-error': { id: 'onboard-error', textContent: '' },
  };
  byId.clear();
  for (const [id, el] of Object.entries(els)) byId.set(id, el);
  return { ...els, hasClass: (c) => classes.has(c) };
}

function reset() {
  localMap.clear();
  sessionMap.clear();
  byId.clear();
  globalThis.localStorage = store(localMap);
}

// ----------------------------------------------------------------------- tests

test('the flag is off until marked, and lives in localStorage', async () => {
  reset();
  const mod = await load();

  assert.strictEqual(mod.hasOnboarded(), false, 'a fresh browser has not been onboarded');
  mod.markOnboarded();
  assert.strictEqual(mod.hasOnboarded(), true);

  // The tier, not just the value. sessionStorage would re-ask after every login-opened tab.
  assert.strictEqual(localMap.get(KEY), '1', `expected ${KEY} in localStorage`);
  assert.strictEqual(sessionMap.has(KEY), false,
    'onboarding-seen is a browser-wide preference, not a per-window place — it must not be in sessionStorage');
});

test('the flag survives a reload and can be cleared', async () => {
  reset();
  const first = await load();
  first.markOnboarded();

  // A fresh import is what a page reload looks like to this module.
  const second = await load();
  assert.strictEqual(second.hasOnboarded(), true, 'the flag must persist across reloads');

  second.resetOnboarded();
  assert.strictEqual(second.hasOnboarded(), false);
  assert.strictEqual(localMap.has(KEY), false);
});

test('storage that throws reads as "not onboarded" instead of exploding', async () => {
  // A private window throws on the first access. The landing path awaits this, so a throw
  // here would take the whole first run down; showing the card is the right answer.
  reset();
  globalThis.localStorage = store(localMap, { throws: true });
  const mod = await load();

  assert.strictEqual(mod.hasOnboarded(), false);
  assert.doesNotThrow(() => mod.markOnboarded(), 'marking must swallow a storage failure');
  assert.doesNotThrow(() => mod.resetOnboarded());
});

test('startTour posts the window id to the onboarding endpoint', async () => {
  reset();
  const mod = await load();
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve(JSON.stringify({ id: 'abc123', name: 'Guide' })),
    });
  };

  const out = await mod.startTour({ windowId: 'win-7' });
  assert.strictEqual(out.id, 'abc123');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/api/start-onboarding');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { windowId: 'win-7' },
    'the browser only says "now, in this window" — the prompt and tools stay server-side');
});

test('taking the tour marks the flag and drops the card', async () => {
  reset();
  const card = mountCard();
  const mod = await load();
  globalThis.fetch = () => Promise.resolve({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve('{"id":"abc123"}'),
  });

  let skipped = false;
  mod.showWelcomeCard({ windowId: 'win-1', onSkip: () => { skipped = true; } });
  assert.ok(card.hasClass('onboarding'), 'the .onboarding class is the single switch that shows the card');

  await card['onboard-start'].onclick();

  assert.strictEqual(mod.hasOnboarded(), true);
  assert.ok(!card.hasClass('onboarding'), 'the card must come down once the session is on its way');
  assert.strictEqual(skipped, false, 'taking the tour must not also open the directory picker');
});

test('a refused start leaves the tour still owed', async () => {
  // The one case where the flag must NOT be set: a start the server rejected is not an
  // onboarding the user has had, so the card is still theirs on the next load.
  reset();
  const card = mountCard();
  const mod = await load();
  globalThis.fetch = () => Promise.resolve({
    ok: false, status: 400,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve('{"error":"Working directory no longer exists"}'),
  });

  mod.showWelcomeCard({ windowId: 'win-1', onSkip: () => {} });
  await card['onboard-start'].onclick();

  assert.strictEqual(mod.hasOnboarded(), false, 'a failed start must not consume the one offer');
  assert.ok(card.hasClass('onboarding'), 'the card stays up so it can be retried or skipped');
  assert.match(card['onboard-error'].textContent, /Working directory/,
    "the server's own reason must be shown, not a generic failure");
  assert.strictEqual(card['onboard-start'].disabled, false, 'the buttons must come back');
  assert.strictEqual(card['onboard-skip'].disabled, false);
});

test('skipping marks the flag and hands back to the directory picker', async () => {
  reset();
  const card = mountCard();
  const mod = await load();

  let skipped = 0;
  mod.showWelcomeCard({ windowId: 'win-1', onSkip: () => { skipped++; } });
  card['onboard-skip'].onclick();

  assert.strictEqual(mod.hasOnboarded(), true, 'being asked and declining still counts as asked');
  assert.ok(!card.hasClass('onboarding'));
  assert.strictEqual(skipped, 1,
    'skip must land exactly where a bare first run landed before this existed (#597)');
});

test('a missing card falls through to the picker rather than swallowing the first run', async () => {
  // An index.html cached from before this shipped. The old behaviour is the safe one.
  reset();
  byId.clear();
  const mod = await load();

  let skipped = 0;
  mod.showWelcomeCard({ windowId: 'win-1', onSkip: () => { skipped++; } });
  assert.strictEqual(skipped, 1, 'no card in the DOM must not mean no landing surface at all');
});

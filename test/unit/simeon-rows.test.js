// Unit test for the Simeon row language — mods/simeon/rows.js and mods/simeon/store.js.
//
// These two files are the whole contract between a language model and a rendered
// interface, and every failure in them is silent: a mis-tokenized quote drops a title, a
// binding that is not indexed leaves a number frozen at its first value, and a child that
// arrives before its parent vanishes instead of waiting. None of that throws, and none of
// it looks wrong in a screenshot of a page that rendered *something*.
//
// Both modules are browser ES modules with no DOM and no imports beyond each other, driven
// here with `await import()` from CommonJS — the test/unit/workshop-inbox-view.test.js
// pattern. No stubs at all, which is why this survives the bare `unit` CI job.
//
// Run: node --test test/unit/simeon-rows.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let rows, store;
async function load() {
  if (!rows) {
    rows = await import('../../mods/simeon/rows.js');
    store = await import('../../mods/simeon/store.js');
  }
  return { rows, store };
}

// ── tokenizer ───────────────────────────────────────────────────────────────────────

test('a quoted value stays one token, spaces and all', async () => {
  const { rows } = await load();
  const op = rows.parseRow('n app screen title="Mission Control"');
  assert.strictEqual(op.props.title, 'Mission Control');
});

test('a JSON array value stays one token despite its spaces', async () => {
  const { rows } = await load();
  const op = rows.parseRow('n h spark @c series=[3, 9, 4] tone=accent');
  assert.deepStrictEqual(op.props.series, [3, 9, 4]);
  assert.strictEqual(op.props.tone, 'accent');
});

test('# starts a comment only at a token boundary, so a hex colour survives', async () => {
  const { rows } = await load();
  assert.strictEqual(rows.parseRow('n b row @a color=#0ff').props.color, '#0ff');
  assert.deepStrictEqual(rows.parseRow('n b row @a gap=lg # trailing note').props, { gap: 'lg' });
  assert.strictEqual(rows.parseRow('# whole line'), null);
});

// ── row kinds ───────────────────────────────────────────────────────────────────────

test('$value is a binding, not a string', async () => {
  const { rows } = await load();
  const op = rows.parseRow('n cpu stat @k label=CPU value=$sys.cpu');
  assert.ok(rows.isBinding(op.props.value), 'value should be a binding');
  assert.strictEqual(op.props.value.$bind, 'sys.cpu');
  assert.strictEqual(rows.isBinding(op.props.label), false);
});

test('omitting the type makes the row a patch', async () => {
  const { rows } = await load();
  const op = rows.parseRow('n cpu tone=alert');
  assert.strictEqual(op.type, null);
  assert.deepStrictEqual(op.props, { tone: 'alert' });
});

test('an unparseable line yields null rather than throwing', async () => {
  const { rows } = await load();
  // The realistic case: a model narrating between tool calls.
  for (const junk of ['', '   ', 'Here is your dashboard:', 'z nope', '{"json":true}']) {
    assert.doesNotThrow(() => rows.parseRow(junk));
  }
  assert.strictEqual(rows.parseRow('Here is your dashboard:'), null);
});

test('parseRows drops the empty lines and keeps the order', async () => {
  const { rows } = await load();
  const ops = rows.parseRows('n a screen\n\n  \nd x 1\nx a\nc');
  assert.deepStrictEqual(ops.map(o => o.op), ['node', 'data', 'remove', 'clear']);
});

// ── store: order independence ───────────────────────────────────────────────────────

test('a child that arrives before its parent waits, then mounts in tree order', async () => {
  const { rows, store } = await load();
  const mounted = [];
  const s = store.createStore({ onMount: n => mounted.push(n.id) });
  // Deliberately inverted: leaf, then branch, then root.
  for (const op of rows.parseRows('n cpu stat @kpis label=CPU\nn kpis row @app\nn app screen')) s.apply(op);
  assert.deepStrictEqual(mounted, ['app', 'kpis', 'cpu']);
  assert.strictEqual(s.snapshot().children[0].children[0].children[0].id, 'cpu');
});

test('an orphan whose parent never arrives is kept, not dropped', async () => {
  const { rows, store } = await load();
  const s = store.createStore({});
  s.apply(rows.parseRow('n lonely stat @missing label=X'));
  assert.ok(s.nodes.has('lonely'), 'the node still exists');
  assert.strictEqual(s.nodes.get('lonely').mounted, false);
  s.apply(rows.parseRow('n missing card'));
  assert.strictEqual(s.nodes.get('lonely').mounted, true);
});

// ── store: the design/data split ────────────────────────────────────────────────────

test('a data row repaints only the nodes bound to that path', async () => {
  const { rows, store } = await load();
  const updated = [];
  const s = store.createStore({ onUpdate: (n, i) => { if (i.fromData) updated.push(n.id); } });
  for (const op of rows.parseRows(`n app screen
n a stat @app value=$sys.cpu
n b stat @app value=$sys.mem
n c stat @app value=17`)) s.apply(op);

  updated.length = 0;
  s.apply(rows.parseRow('d sys.cpu 99'));
  assert.deepStrictEqual(updated, ['a'], 'only the node bound to sys.cpu');
  assert.strictEqual(s.resolve(s.nodes.get('a')).value, 99);
  assert.strictEqual(s.resolve(s.nodes.get('c')).value, 17, 'a literal is untouched');
});

test('a binding reads through an object stored at a shorter path', async () => {
  const { rows, store } = await load();
  const s = store.createStore({});
  for (const op of rows.parseRows('n app screen\nn a stat @app value=$sys.cpu')) s.apply(op);
  s.apply(rows.parseRow('d sys {"cpu":42,"mem":71}'));
  assert.strictEqual(s.resolve(s.nodes.get('a')).value, 42);
});

test('writing the parent path invalidates a binding on a child path, and vice versa', async () => {
  const { store } = await load();
  assert.strictEqual(store.pathAffects('sys', 'sys.cpu'), true);
  assert.strictEqual(store.pathAffects('sys.cpu', 'sys'), true);
  assert.strictEqual(store.pathAffects('sys.cpu', 'sys.cpuX'), false, 'prefix is not a path segment');
  assert.strictEqual(store.pathAffects('other', 'sys.cpu'), false);
});

test('a re-emitted node merges props and re-indexes its bindings', async () => {
  const { rows, store } = await load();
  const s = store.createStore({});
  for (const op of rows.parseRows('n app screen\nn a stat @app label=CPU value=$sys.cpu')) s.apply(op);
  s.apply(rows.parseRow('n a value=$sys.mem tone=alert'));

  assert.deepStrictEqual([...s.binds.keys()], ['sys.mem'], 'the old binding is dropped');
  const props = s.resolve(s.nodes.get('a'));
  assert.strictEqual(props.label, 'CPU', 'an omitted prop is left alone');
  assert.strictEqual(props.tone, 'alert');
});

// ── store: removal ──────────────────────────────────────────────────────────────────

test('removing a node removes its subtree and every binding under it', async () => {
  const { rows, store } = await load();
  const removed = [];
  const s = store.createStore({ onRemove: n => removed.push(n.id) });
  for (const op of rows.parseRows(`n app screen
n card card @app
n a stat @card value=$sys.cpu
n keep stat @app value=$sys.mem`)) s.apply(op);

  s.apply(rows.parseRow('x card'));
  assert.deepStrictEqual(removed, ['a', 'card'], 'children before parents');
  assert.strictEqual(s.nodes.has('a'), false);
  assert.deepStrictEqual([...s.binds.keys()], ['sys.mem'], 'only the surviving binding is indexed');
  assert.strictEqual(s.snapshot().children[0].children.length, 1);
});

test('clear empties the tree, the data and the index', async () => {
  const { rows, store } = await load();
  let cleared = 0;
  const s = store.createStore({ onClear: () => cleared++ });
  for (const op of rows.parseRows('n app screen\nn a stat @app value=$sys.cpu\nd sys.cpu 1')) s.apply(op);
  s.apply(rows.parseRow('c'));
  assert.strictEqual(cleared, 1);
  assert.deepStrictEqual([...s.nodes.keys()], [store.ROOT]);
  assert.strictEqual(s.data.size, 0);
  assert.strictEqual(s.binds.size, 0);
});

// ── the root, by its many names ─────────────────────────────────────────────────────

test('@root and its variants attach to the root instead of parking as orphans', async () => {
  const { rows, store } = await load();
  // A real run wrote exactly this. Before the alias it parked the whole tree.
  for (const spelling of ['root', '#root', 'canvas']) {
    const mounted = [];
    const s = store.createStore({ onMount: n => mounted.push(n.id) });
    s.apply(rows.parseRow(`n app col @${spelling} gap=lg`));
    s.apply(rows.parseRow('n kid text @app value=hi'));
    assert.deepStrictEqual(mounted, ['app', 'kid'], `@${spelling} should mean the root`);
    assert.strictEqual(s.orphans.size, 0, `@${spelling} left an orphan`);
  }
});

test('a genuinely unknown parent still parks, so the alias did not swallow real waits', async () => {
  const { rows, store } = await load();
  const s = store.createStore({});
  s.apply(rows.parseRow('n a text @nonexistent value=x'));
  assert.strictEqual(s.nodes.get('a').mounted, false);
  assert.strictEqual(s.orphans.size, 1);
});

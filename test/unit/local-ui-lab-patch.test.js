// Unit test for Local UI Lab's text layer: mods/local-ui-lab/patch.js and prompts.js.
//
// This is everything between a small model's token stream and the page it changes. Every
// failure in it is silent: a block lost at a chunk boundary is an edit that "the model never
// made", and a fence mistaken for markup is a page that "failed to render". Either one would
// be written up as a finding about the model when it was a finding about this parser.
//
// Both are browser ES modules with no DOM and no imports, loaded with `await import()` from
// CommonJS (the simeon-rows.test.js pattern). No stubs, so this runs in the bare `unit` CI job.
//
// Run: node --test test/unit/local-ui-lab-patch.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let patch, prompts;
async function load() {
  if (!patch) {
    patch = await import('../../mods/local-ui-lab/patch.js');
    prompts = await import('../../mods/local-ui-lab/prompts.js');
  }
  return { patch, prompts };
}

const REPLY = [
  'Here are the edits:',
  '<<<<<<< SEARCH',
  '    <h1>Todo</h1>',
  '=======',
  '    <h1>My tasks</h1>',
  '>>>>>>> REPLACE',
  '',
  '<<<<<<< SEARCH',
  '  background: #fff;',
  '=======',
  '  background: #111;',
  '  color: #eee;',
  '>>>>>>> REPLACE',
].join('\n');

const EXPECTED = [
  { search: '    <h1>Todo</h1>', replace: '    <h1>My tasks</h1>' },
  { search: '  background: #fff;', replace: '  background: #111;\n  color: #eee;' },
];

function parseAll(chunks) {
  const p = patch.createPatchParser();
  const blocks = [];
  for (const c of chunks) blocks.push(...p.feed(c));
  const end = p.end();
  blocks.push(...end.blocks);
  return { blocks, unterminated: end.unterminated, stats: p.stats };
}

test('a reply split at every possible byte offset yields the same blocks', async () => {
  await load();
  for (let i = 0; i <= REPLY.length; i++) {
    const { blocks, unterminated } = parseAll([REPLY.slice(0, i), REPLY.slice(i)]);
    assert.deepStrictEqual(blocks, EXPECTED, `split at ${i}`);
    assert.strictEqual(unterminated, false);
  }
  // And one character at a time, which is what a slow token stream looks like.
  assert.deepStrictEqual(parseAll([...REPLY]).blocks, EXPECTED);
});

test('a block is emitted the moment its REPLACE line completes, not at the end', async () => {
  await load();
  const p = patch.createPatchParser();
  const firstBlockEnd = REPLY.indexOf('>>>>>>> REPLACE') + '>>>>>>> REPLACE\n'.length;
  assert.deepStrictEqual(p.feed(REPLY.slice(0, firstBlockEnd - 1)), [], 'no newline yet: not a block');
  assert.deepStrictEqual(p.feed('\n'), [EXPECTED[0]]);
});

test('prose and fences outside blocks are counted, and a cut-off block is reported', async () => {
  await load();
  const { stats } = parseAll(['```\n', REPLY, '\n```\nDone!']);
  assert.strictEqual(stats.blocks, 2);
  assert.strictEqual(stats.fences, 2);
  assert.strictEqual(stats.prose, 2, '"Here are the edits:" and "Done!"');

  const cut = parseAll(['<<<<<<< SEARCH\n<p>a</p>\n=======\n<p>b']);
  assert.deepStrictEqual(cut.blocks, []);
  assert.strictEqual(cut.unterminated, true);
});

test('marker variants a small model produces are accepted, and CRLF is stripped', async () => {
  await load();
  const reply = '<<<<<<SEARCH\r\n<b>x</b>\r\n========\r\n<b>y</b>\r\n>>>>>>>> REPLACE';
  assert.deepStrictEqual(parseAll([reply]).blocks, [{ search: '<b>x</b>', replace: '<b>y</b>' }]);
});

test('applyBlock: exact, whitespace-tolerant, and the failures it reports', async () => {
  await load();
  const page = '<body>\n    <h1>Todo</h1>\n    <p>one</p>\n    <p>one</p>\n</body>';

  const exact = patch.applyBlock(page, { search: '    <h1>Todo</h1>', replace: '    <h1>Tasks</h1>' });
  assert.strictEqual(exact.ok, true);
  assert.strictEqual(exact.how, 'exact');
  assert.strictEqual(exact.occurrences, 1);
  assert.match(exact.html, /\n {4}<h1>Tasks<\/h1>\n/);

  const twice = patch.applyBlock(page, { search: '<p>one</p>', replace: '<p>two</p>' });
  assert.strictEqual(twice.ok, true);
  assert.strictEqual(twice.occurrences, 2, 'an ambiguous SEARCH is applied once and flagged');
  assert.strictEqual((twice.html.match(/<p>two<\/p>/g) || []).length, 1);

  // Indentation wrong, and the two lines joined differently: still the same text.
  const loose = patch.applyBlock(page, {
    search: '<h1>Todo</h1>\n  <p>one</p>',
    replace: '  <h1>Tasks</h1>\n  <p>first</p>',
  });
  assert.strictEqual(loose.ok, true);
  assert.strictEqual(loose.how, 'whitespace');
  assert.strictEqual(loose.html, '<body>\n    <h1>Tasks</h1>\n  <p>first</p>\n    <p>one</p>\n</body>');

  const missing = patch.applyBlock(page, { search: '<h2>Nope</h2>', replace: '' });
  assert.deepStrictEqual({ ok: missing.ok, reason: missing.reason, same: missing.html === page },
    { ok: false, reason: 'not-found', same: true });

  assert.strictEqual(patch.applyBlock(page, { search: '  \n', replace: 'x' }).reason, 'empty-search');

  // Regex metacharacters in a SEARCH are literal text, not a pattern.
  const css = 'a { width: calc(100% - 2rem); }';
  const meta = patch.applyBlock(css, { search: 'calc(100%  -  2rem)', replace: 'calc(50%)' });
  assert.strictEqual(meta.ok, true);
  assert.strictEqual(meta.html, 'a { width: calc(50%); }');
});

test('extractHtml: clean, fenced with prose around it, and mid-stream', async () => {
  await load();
  const doc = '<!DOCTYPE html>\n<html><body><p>hi</p></body></html>';

  assert.deepStrictEqual(patch.extractHtml(doc), { html: doc, fenced: false, prose: false, complete: true });

  const wrapped = `Sure! Here is your page:\n\n\`\`\`html\n${doc}\n\`\`\`\n\nEnjoy.`;
  assert.deepStrictEqual(patch.extractHtml(wrapped), { html: doc, fenced: true, prose: true, complete: true });

  // Mid-stream: the fence has not closed and neither has the document.
  const partial = patch.extractHtml('```html\n<!DOCTYPE html>\n<html><head><style>body{');
  assert.strictEqual(partial.fenced, true);
  assert.strictEqual(partial.complete, false);
  assert.strictEqual(partial.html, '<!DOCTYPE html>\n<html><head><style>body{');

  // Still receiving the ```html line itself: nothing to render yet, and nothing broken.
  assert.strictEqual(patch.extractHtml('```ht').html, '');

  // A backtick run inside the page's own script does not end the document.
  const withTemplate = '<!DOCTYPE html><html><script>const s = `a```;</script></html>';
  assert.strictEqual(patch.extractHtml(withTemplate).html, withTemplate);
});

test('createThinkFilter drops a leading think block across chunk splits, and nothing else', async () => {
  await load();
  const reply = '<think>\n\n</think>\n\n<!DOCTYPE html><html></html>';
  for (let i = 0; i <= reply.length; i++) {
    const f = patch.createThinkFilter();
    const out = f.push(reply.slice(0, i)) + f.push(reply.slice(i)) + f.end();
    assert.strictEqual(out, '<!DOCTYPE html><html></html>', `split at ${i}`);
    assert.strictEqual(f.thought, true);
  }

  // A reply that starts with `<` but is not a think block passes through byte for byte,
  // including the `<` held back while it could still have become one.
  const plain = patch.createThinkFilter();
  assert.strictEqual(plain.push('<') + plain.push('!DOCTYPE html>') + plain.end(), '<!DOCTYPE html>');
  assert.strictEqual(plain.thought, false);
});

test('buildMessages: one standalone request per mode, carrying the page for an edit', async () => {
  await load();
  const gen = prompts.buildMessages('generate', '', '  a todo list ');
  assert.deepStrictEqual(gen.map(m => m.role), ['system', 'user']);
  assert.strictEqual(gen[0].content, prompts.GENERATE_PROMPTS[prompts.DEFAULT_ORDER]);
  assert.strictEqual(gen[1].content, 'a todo list');

  // The two orders differ only in where the CSS goes, which is the variable being measured.
  const styleFirst = prompts.buildMessages('generate', '', 'x', { order: 'style-first' })[0].content;
  const markupFirst = prompts.buildMessages('generate', '', 'x', { order: 'markup-first' })[0].content;
  assert.match(styleFirst, /<style> element inside <head>, before the body/);
  assert.match(markupFirst, /After the content, still inside <body>, put all CSS/);
  assert.throws(() => prompts.buildMessages('generate', '', 'x', { order: 'css-last' }), /unknown order/);

  const page = '<!DOCTYPE html><html><body><h1>Todo</h1></body></html>';
  for (const mode of ['patch', 'rewrite']) {
    const msgs = prompts.buildMessages(mode, page, 'rename the heading');
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].content, mode === 'patch' ? prompts.PATCH_PROMPT : prompts.REWRITE_PROMPT);
    assert.ok(msgs[1].content.includes(page), 'the page is sent verbatim, or SEARCH cannot match it');
    assert.ok(msgs[1].content.endsWith('CHANGE: rename the heading'));
  }

  assert.throws(() => prompts.buildMessages('regenerate', page, 'x'), /unknown mode/);
  assert.deepStrictEqual(prompts.MODES, ['generate', 'patch', 'rewrite']);
});

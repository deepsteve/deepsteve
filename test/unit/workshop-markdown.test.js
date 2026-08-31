// mods/workshop/markdown.js (#670) — just enough markdown for a review conversation.
//
// Assertions are on the AST, never on HTML, because there IS no HTML: workshop.jsx maps
// these tokens to React elements, which is what makes agent-authored text unable to become
// markup. The URL tests are the load-bearing ones. React will happily render
// <a href="javascript:…">, so "we never build an HTML string" is not on its own enough —
// the scheme allowlist is the other half, and a regression in it is a real XSS in a page
// that is same-origin with the auth cookie.
//
// Run: node --test test/unit/workshop-markdown.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// A browser ES module (workshop.jsx imports it), driven from CommonJS with `await
// import()` — the workshop-inbox-view.test.js pattern. Requiring it would pass here and
// still be a blank pane in the browser, which is the bug this shape prevents.
let md;
async function load() {
  if (!md) md = await import('../../mods/workshop/markdown.js');
  return md;
}

const flat = (ss) => ss.map((s) => s.type);

// ── blocks ───────────────────────────────────────────────────────────────────

test('a paragraph is a paragraph', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  const [b] = tokenize('just some prose');
  assert.strictEqual(b.type, 'para');
  assert.deepStrictEqual(b.spans, [{ type: 'text', text: 'just some prose' }]);
});

test('a fenced block keeps its language and its body verbatim', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  const [b] = tokenize('```js\nconst a = 1;\n```');
  assert.deepStrictEqual(b, { type: 'code', lang: 'js', text: 'const a = 1;' });
});

test('a fence with no language still fences', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.deepStrictEqual(tokenize('```\nplain\n```'), [{ type: 'code', lang: '', text: 'plain' }]);
});

test('~~~ fences too', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.deepStrictEqual(tokenize('~~~py\nx = 1\n~~~'), [{ type: 'code', lang: 'py', text: 'x = 1' }]);
});

test('an UNCLOSED fence runs to the end of input', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  // A reply that is still being written, or one that forgot the closing fence, must show
  // its code as code. The alternative — abandoning the fence — silently reinterprets the
  // rest of the message as markdown, which is how a diff turns into headings and lists.
  const [b, ...rest] = tokenize('```sh\nrm -rf /tmp/x\n# still code\n* not a list');
  assert.strictEqual(b.type, 'code');
  assert.strictEqual(b.text, 'rm -rf /tmp/x\n# still code\n* not a list');
  assert.deepStrictEqual(rest, []);
});

test('NOTHING inside a fence is markup', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  const [b] = tokenize('```\n# not a heading\n**not bold**\n- not a list\n> not a quote\n```');
  assert.strictEqual(b.type, 'code');
  assert.ok(b.text.includes('**not bold**'), 'the asterisks are part of the code');
});

test('headings carry their level', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.deepStrictEqual(tokenize('# One\n\n### Three').map((b) => [b.type, b.level]),
    [['heading', 1], ['heading', 3]]);
  // Seven hashes is not a heading.
  assert.strictEqual(tokenize('####### nope')[0].type, 'para');
  // A hash with no space is a hash.
  assert.strictEqual(tokenize('#nope')[0].type, 'para');
});

test('lists group by marker kind, so a bulleted run and a numbered run stay separate', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  const blocks = tokenize('- one\n- two\n1. first\n2. second');
  assert.deepStrictEqual(blocks.map((b) => [b.type, b.ordered, b.items.length]),
    [['list', false, 2], ['list', true, 2]]);
});

test('blockquotes fold their run into one block', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  const [b] = tokenize('> a caveat\n> continued');
  assert.strictEqual(b.type, 'quote');
  assert.deepStrictEqual(b.spans, [{ type: 'text', text: 'a caveat\ncontinued' }]);
});

test('a horizontal rule is a rule, and a bullet is not', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.deepStrictEqual(kinds('---'), ['hr']);
  assert.deepStrictEqual(kinds('***'), ['hr']);
  assert.deepStrictEqual(kinds('- item'), ['list']);
});

test('blank lines separate paragraphs and are not blocks themselves', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.deepStrictEqual(kinds('one\n\n\ntwo'), ['para', 'para']);
});

test('empty and nullish input produce no blocks', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  for (const input of ['', null, undefined]) assert.deepStrictEqual(tokenize(input), []);
});

test('CRLF is normalised', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.deepStrictEqual(tokenize('a\r\n\r\nb').map((b) => b.type), ['para', 'para']);
});

// ── inline ───────────────────────────────────────────────────────────────────

test('inline code wins over everything inside it', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  // Code first is not a style choice: a backtick span has to be able to hold a literal
  // ** or a bare URL without either being interpreted, which is most of what makes a
  // technical reply readable.
  assert.deepStrictEqual(spans('`**not bold** https://x.test`'),
    [{ type: 'code', text: '**not bold** https://x.test' }]);
});

test('bold, italic and underscore emphasis', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.deepStrictEqual(flat(spans('**b** and *i* and _u_')),
    ['strong', 'text', 'em', 'text', 'em']);
});

test('a link keeps its href and re-scans its label', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  const [link] = spans('[**bold** label](https://example.test/a)');
  assert.strictEqual(link.type, 'link');
  assert.strictEqual(link.href, 'https://example.test/a');
  assert.deepStrictEqual(flat(link.children), ['strong', 'text']);
});

test('an image is an image, and its src is checked separately from a link href', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  const [img] = spans('![a shot](https://example.test/a.png)');
  assert.deepStrictEqual(img, { type: 'image', src: 'https://example.test/a.png', alt: 'a shot' });
});

test('a bare URL is linkified — agents paste them constantly', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  const out = spans('see https://example.test/x now');
  assert.deepStrictEqual(flat(out), ['text', 'link', 'text']);
  assert.strictEqual(out[1].href, 'https://example.test/x');
});

// ── URL safety ───────────────────────────────────────────────────────────────

test('safeUrl allows exactly the schemes it should, for links', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  for (const ok of ['https://x.test/a', 'http://x.test', 'mailto:a@b.test', '/repo/file.js', '#anchor']) {
    assert.strictEqual(safeUrl(ok, 'link'), ok, `${ok} should be allowed`);
  }
});

test('safeUrl refuses every code-bearing scheme, for links', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  for (const bad of [
    'javascript:alert', 'JavaScript:alert', 'vbscript:x', 'data:text/html,<script>',
    'file:///etc/passwd', 'jAvAsCrIpT:x',
  ]) {
    assert.strictEqual(safeUrl(bad, 'link'), null, `${bad} must not become an href`);
  }
});

test('a control character or a space inside a URL rejects the whole candidate', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  // This is how a scheme check gets walked around: browsers strip a tab out of
  // "java\tscript:", a naive allowlist does not.
  for (const bad of ['java\tscript:x', 'java\nscript:x', 'java script:x', 'https://x.test/ a']) {
    assert.strictEqual(safeUrl(bad, 'link'), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test('an image src takes raster data URLs but never SVG', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.ok(safeUrl('data:image/png;base64,AAAA', 'image'));
  assert.ok(safeUrl('data:image/webp;base64,AAAA', 'image'));
  // An SVG carries <script>. It is a code URL wearing an image's name.
  assert.strictEqual(safeUrl('data:image/svg+xml;base64,AAAA', 'image'), null);
  assert.strictEqual(safeUrl('data:text/html;base64,AAAA', 'image'), null);
});

test('a refused link degrades to TEXT that still shows the URL', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  // Refusing to link is not the same as hiding: the reader should still be able to see
  // what the agent wrote and judge it.
  const out = spans('[click](javascript:alert)');
  assert.deepStrictEqual(out, [{ type: 'text', text: 'click (javascript:alert)' }]);
});

test('a refused image degrades to its alt text', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  assert.deepStrictEqual(spans('![the evidence](data:image/svg+xml;base64,AA)'),
    [{ type: 'text', text: 'the evidence' }]);
});

test('no token type can carry raw HTML', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  // The whole design rests on there being no passthrough. If a token type ever appears
  // that holds markup, the React mapping in workshop.jsx has to render it somehow, and
  // the only ways to do that are the two escape hatches the shape test bans.
  const md = '<script>alert(1)</script>\n\n<b>bold</b>\n\n<img onerror=x src=y>';
  const walk = (ss) => ss.forEach((s) => {
    assert.ok(['text', 'code', 'link', 'image', 'strong', 'em'].includes(s.type),
      `unexpected span type ${s.type}`);
    if (s.children) walk(s.children);
  });
  for (const b of tokenize(md)) {
    assert.ok(['para', 'code', 'heading', 'list', 'quote', 'hr'].includes(b.type));
    if (b.spans) walk(b.spans);
    if (b.items) b.items.forEach(walk);
  }
  // And the angle brackets survive as literal text, for React to escape.
  assert.ok(JSON.stringify(tokenize(md)).includes('script'));
});

test('a long pathological input terminates', async () => {
  const { tokenize, spans, safeUrl } = await load();
  const kinds = (src) => tokenize(src).map((b) => b.type);
  // A tokenizer's one remaining denial-of-service is a quadratic scan. This is a smoke
  // test with a hard budget rather than a complexity proof.
  const big = ('`'.repeat(200) + '\n' + '*'.repeat(200) + '\n[a](' + 'b'.repeat(2000) + ')\n').repeat(200);
  const t0 = Date.now();
  tokenize(big);
  assert.ok(Date.now() - t0 < 3000, `tokenize took ${Date.now() - t0}ms`);
});

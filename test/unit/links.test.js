// Unit test for links.js — the typed, versioned link scheme (#705).
//
// A link that has been sent is a promise: it must open, redirect or explain itself for as long
// as it could still be sitting in someone's inbox. Every branch of decide() is one of the ways
// that promise is kept, so each is pinned here. The handlers are driven with a fake req/res, so
// this runs in the bare `unit` CI job with no daemon and no Inbox.
//
// Run: node --test test/unit/links.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const links = require('../../links.js');

const served = { type: 'decision', item: { id: 'w1' } };
const base = { type: 'decision', id: 'w1', owned: true, providerCount: 1, hasHandler: true, resolved: served };

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, location: null, contentType: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.type = (t) => { res.contentType = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.redirect = (code, loc) => { res.statusCode = code; res.location = loc; return res; };
  return res;
}

const req = (type, id, body = {}) => ({ params: { type, id }, body });

// ── the scheme itself ────────────────────────────────────────────────────────

test('the v1 type table is what #705 specified, plus project-mod (#711)', () => {
  assert.strictEqual(links.LINK_VERSION, 'v1');
  assert.deepStrictEqual({ ...links.TYPE_STATES },
    { decision: 'active', 'project-mod': 'active', markdown: 'reserved', html: 'reserved' });
});

test('the unavailable page names the link type, not one particular mod', () => {
  // Two providers exist since #711, so "check that Inbox loaded" would misdirect a
  // project-mod link.
  const page = links.explain({ kind: 'unavailable' }, { type: 'project-mod', id: 'abc12345' });
  assert.match(page.paragraphs.join(' '), /"project-mod" links/);
  assert.doesNotMatch(page.paragraphs.join(' '), /Inbox/);
});

test('a type is never both live and removed', () => {
  // Removing a type means MOVING it into REMOVED_TYPES. Leaving it in both would make the
  // 410 unreachable for that type's links, or the reverse.
  for (const type of Object.keys(links.REMOVED_TYPES)) {
    assert.ok(!(type in links.TYPE_STATES), `"${type}" is listed as both live and removed`);
  }
});

// ── decide(): every way the promise is kept ──────────────────────────────────

test('a stored item of the named type is served', () => {
  assert.deepStrictEqual(links.decide(base), { kind: 'serve', status: 200 });
});

test('a removed type answers 410 before anything is resolved, for GET and POST alike', () => {
  const removed = { poll: 'Polls were folded into decisions.' };
  for (const method of ['GET', 'POST']) {
    const d = links.decide({ method, type: 'poll', id: 'w1', removed, owned: false, providerCount: 0 });
    assert.strictEqual(d.kind, 'removed');
    assert.strictEqual(d.status, 410, 'a removed type is Gone, not Not Found — the link was real');
    assert.strictEqual(d.reason, removed.poll);
  }
});

test('an unknown type and a malformed id are 404s', () => {
  assert.strictEqual(links.decide({ ...base, type: 'spreadsheet' }).kind, 'unknown-type');
  for (const id of ['', '../etc', 'w 1', 'x'.repeat(65)]) {
    assert.strictEqual(links.decide({ ...base, id }).kind, 'bad-id', `id ${JSON.stringify(id)}`);
  }
});

test('with no provider registered at all the link is unavailable, not missing', () => {
  // Mods mount asynchronously, and an Inbox that failed to load must not tell someone their
  // decision does not exist.
  const d = links.decide({ ...base, owned: false, providerCount: 0, resolved: null });
  assert.deepStrictEqual(d, { kind: 'unavailable', status: 503 });
  assert.strictEqual(links.decide({ ...base, owned: false, providerCount: 2, resolved: null }).kind, 'not-found');
});

test('never issued is 404; issued and since cleared is 410; not linkable is 404', () => {
  assert.strictEqual(links.decide({ ...base, resolved: null }).status, 404);
  assert.deepStrictEqual(links.decide({ ...base, resolved: { gone: true } }), { kind: 'gone', status: 410 });
  assert.strictEqual(links.decide({ ...base, resolved: { type: null } }).kind, 'not-linkable');
});

test('the stored item decides the type: GET redirects, POST is refused', () => {
  const resolved = { type: 'markdown', item: {} };
  const get = links.decide({ ...base, type: 'decision', resolved });
  assert.deepStrictEqual(get, { kind: 'redirect', status: 302, location: '/v1/markdown/w1' });
  const post = links.decide({ ...base, method: 'POST', type: 'decision', resolved });
  assert.strictEqual(post.kind, 'wrong-type');
  assert.strictEqual(post.status, 409, 'an answer to the wrong address must not be silently re-aimed');
  assert.strictEqual(post.location, '/v1/markdown/w1');
});

test('a reserved type explains itself with a 501 once the id resolves to it', () => {
  const d = links.decide({ ...base, type: 'markdown', resolved: { type: 'markdown', item: {} } });
  assert.deepStrictEqual(d, { kind: 'reserved', status: 501 });
});

test('an owner without a handler for the type is unavailable', () => {
  assert.strictEqual(links.decide({ ...base, hasHandler: false }).kind, 'unavailable');
});

// ── escaping ─────────────────────────────────────────────────────────────────

test('escapeHtml covers all five characters, including the single quote', () => {
  assert.strictEqual(links.escapeHtml(`<a href="x" onclick='y'>&</a>`),
    '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('jsonForScript cannot close its script element, and round-trips', () => {
  const value = { headline: '</script><script>alert(1)</script> & <!--' };
  const out = links.jsonForScript(value);
  assert.ok(!/[<>&]/.test(out), `unescaped markup characters in ${out}`);
  assert.deepStrictEqual(JSON.parse(out), value);
});

test('an explanation page escapes the id it echoes', () => {
  const html = links.renderPage({ ...links.explain({ kind: 'not-found' }, { type: 'decision', id: '<img src=x>' }) });
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
});

// ── the handlers ─────────────────────────────────────────────────────────────

function world() {
  const calls = { render: 0, act: 0 };
  const store = new Map([
    ['w1', { type: 'decision', item: { id: 'w1' } }],
    ['w2', { type: 'markdown', item: { id: 'w2' } }],
  ]);
  const registry = links.createLinks({ baseUrl: 'http://deepsteve.localhost:3000' });
  registry.registerProvider({
    name: 'fake',
    owns: (id) => /^w\d+$/.test(id),
    resolve: (id) => store.get(id) || (id === 'w9' ? { gone: true } : null),
    render: { decision: (rq, rs) => { calls.render++; rs.status(200).type('html').send('page'); } },
    act: { decision: (rq, rs) => { calls.act++; rs.json({ ok: true }); } },
  });
  return { registry, calls };
}

test('opening a link renders and never acts, with the page headers set', () => {
  const { registry, calls } = world();
  const res = fakeRes();
  registry.handleGet(req('decision', 'w1'), res);
  assert.deepStrictEqual(calls, { render: 1, act: 0 }, 'a GET must never reach the answer handler');
  assert.strictEqual(res.body, 'page');
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('a GET to the wrong type redirects to the stored type', () => {
  const { registry } = world();
  const res = fakeRes();
  registry.handleGet(req('decision', 'w2'), res);
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.location, '/v1/markdown/w2');
});

test('the redirect target explains itself rather than 404ing', () => {
  const { registry, calls } = world();
  const res = fakeRes();
  registry.handleGet(req('markdown', 'w2'), res);
  assert.strictEqual(res.statusCode, 501);
  assert.strictEqual(res.contentType, 'html');
  assert.match(res.body, /Not available yet/);
  assert.strictEqual(calls.render, 0);
});

test('a POST acts only at the matching, active address', () => {
  const { registry, calls } = world();
  const ok = fakeRes();
  registry.handlePost(req('decision', 'w1', { action: 'answer' }), ok);
  assert.strictEqual(calls.act, 1);

  const wrong = fakeRes();
  registry.handlePost(req('decision', 'w2', { action: 'answer' }), wrong);
  assert.strictEqual(wrong.statusCode, 409);
  assert.strictEqual(wrong.body.error, 'wrong-type');

  const reserved = fakeRes();
  registry.handlePost(req('markdown', 'w2', { action: 'answer' }), reserved);
  assert.strictEqual(reserved.statusCode, 501);
  assert.strictEqual(calls.act, 1, 'neither refusal reached the answer handler');
});

test('gone, missing and unknown links each get their own page', () => {
  const { registry } = world();
  const gone = fakeRes();
  registry.handleGet(req('decision', 'w9'), gone);
  assert.strictEqual(gone.statusCode, 410);
  assert.match(gone.body, /No longer stored/);

  const missing = fakeRes();
  registry.handleGet(req('decision', 'w404'), missing);
  assert.strictEqual(missing.statusCode, 404);

  const unknown = fakeRes();
  registry.handleGet(req('spreadsheet', 'w1'), unknown);
  assert.strictEqual(unknown.statusCode, 404);
  assert.match(unknown.body, /Not a Deep Steve link/);
});

test('a provider that throws while resolving yields a 404 page, not a crash', () => {
  const registry = links.createLinks();
  registry.registerProvider({ name: 'broken', owns: () => true, resolve: () => { throw new Error('boom'); } });
  const res = fakeRes();
  assert.doesNotThrow(() => registry.handleGet(req('decision', 'w1'), res));
  assert.strictEqual(res.statusCode, 404);
});

test('re-registering a provider by name replaces it', () => {
  const registry = links.createLinks();
  const p = { name: 'inbox', owns: () => false, resolve: () => null };
  registry.registerProvider(p);
  registry.registerProvider({ ...p });
  assert.strictEqual(registry._providers.length, 1, 'a re-run init must not stack providers');
});

test('urlFor builds the absolute, versioned address an email carries', () => {
  const { registry } = world();
  assert.strictEqual(registry.urlFor('decision', 'w42'), 'http://deepsteve.localhost:3000/v1/decision/w42');
});

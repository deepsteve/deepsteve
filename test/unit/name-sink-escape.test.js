// Drift guard for #747: a directory name or a session name must never become markup.
//
// Three surfaces put such a name on screen: the directory picker's tree (a raw readdir
// of whatever the user browses, cloned repos included), the new-tab menu's recent dirs
// (the leaf of a session cwd), and the sessions dropdown (a name that defaults to the
// cwd's leaf, or is a GitHub issue title). The UI page sends no CSP, so a raw `${name}`
// in any of their innerHTML templates ran a directory called `<img onerror=…>` as
// script on our origin.
//
// Each surface is rendered here with hostile names against a fake DOM that records
// every element it is asked to create AND every string written through innerHTML /
// outerHTML / insertAdjacentHTML. The start tags in those strings count as created
// elements too, so this fails whether a regression builds the payload's element
// directly or interpolates it into a template. The last test pins that app.js and
// dir-picker.js still render through the builders exercised here.
//
// No browser, no jsdom: same approach as tab-autopilot-menu.test.js.
//
// Run: node --test test/unit/name-sink-escape.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The issue's repro payload. A path segment can't hold `/`, so it is spelled \x2f.
const IMG_LEAF = `<img src=x onerror="fetch('\\x2fapi\\x2fversion').then(r=>document.title='PWNED '+r.status)">`;
// An attribute breakout needs no `<` at all.
const ATTR_LEAF = `x" onmouseover="alert(1)" data-x="`;
// A session named from an issue title, as startIssueSession names it.
const ISSUE_NAME = '#747 <svg onload=alert()>';
const REPO = '/tmp/evilrepo';

// ---------------------------------------------------------------- fake DOM

const created = [];      // tag names, from createElement and from parsed HTML writes
const htmlWrites = [];   // every string handed to an HTML-parsing sink

function recordHtml(html) {
  html = String(html);
  htmlWrites.push(html);
  for (const m of html.matchAll(/<([a-zA-Z][^\s/>]*)/g)) created.push(m[1].toLowerCase());
}

class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.dataset = {};
    this.className = '';
    this.title = '';
    created.push(tag.toLowerCase());
  }
  appendChild(child) { this.childNodes.push(child); return child; }
  append(...children) {
    for (const c of children) this.appendChild(typeof c === 'string' ? new FakeText(c) : c);
  }
  get children() { return this.childNodes.filter(c => c instanceof FakeElement); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { this.childNodes = v === '' || v == null ? [] : [new FakeText(v)]; }
  set innerHTML(v) { recordHtml(v); this.childNodes = []; }
  set outerHTML(v) { recordHtml(v); }
  insertAdjacentHTML(_pos, v) { recordHtml(v); }
}

globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
};

function reset() { created.length = 0; htmlWrites.length = 0; }

// Nothing the hostile input carries may become an element or an attribute.
function assertNoMarkupFrom(label) {
  for (const html of htmlWrites) {
    assert.ok(!/<(img|svg)\b/i.test(html), `${label}: an HTML write contains the payload's tag: ${html}`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${label}: an HTML write carries an inline handler: ${html}`);
  }
  assert.ok(!created.includes('img'), `${label}: an <img> element was created from a name`);
  assert.ok(!created.includes('svg'), `${label}: an <svg> element was created from a name`);
}

function find(el, pred) {
  if (pred(el)) return el;
  for (const c of el.children || []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

async function load(rel) {
  return import(new URL(rel, `file://${__filename}`).href);
}

// ---------------------------------------------------------------- dir picker

test('dir picker: a hostile directory name renders as text and its path as data', async () => {
  const { renderDirTree } = await load('../../public/js/dir-picker.js');
  reset();
  const tree = new FakeElement('div');
  const dirs = [path.join(REPO, IMG_LEAF), path.join(REPO, ATTR_LEAF), path.join(REPO, 'benign')];
  const items = renderDirTree(tree, dirs);

  assertNoMarkupFrom('dir picker');
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(items.map(i => i.dataset.path), dirs, 'data-path is the exact path, unmangled');
  assert.ok(items[0].textContent.endsWith(IMG_LEAF), 'the leaf is shown verbatim');
  assert.ok(items[1].textContent.endsWith(ATTR_LEAF));
  assert.deepStrictEqual(tree.children, items, 'the rows are what the tree holds');
});

test('dir picker: an empty listing says so', async () => {
  const { renderDirTree } = await load('../../public/js/dir-picker.js');
  reset();
  const tree = new FakeElement('div');
  assert.deepStrictEqual(renderDirTree(tree, []), []);
  assert.strictEqual(tree.textContent, 'No subdirectories');
});

// ---------------------------------------------------------------- recent dirs

test('recent-dirs menu: a hostile leaf renders as text, the path as data and title', async () => {
  const { recentDirItem } = await load('../../public/js/menu-rows.js');
  for (const leaf of [IMG_LEAF, ATTR_LEAF, `${IMG_LEAF} (evilrepo)`]) {
    reset();
    const p = path.join(REPO, leaf);
    const el = recentDirItem(p, leaf);
    assertNoMarkupFrom('recent dirs');
    assert.strictEqual(el.textContent, leaf);
    assert.strictEqual(el.dataset.path, p);
    assert.strictEqual(el.dataset.action, 'recent', 'selectItem() dispatches on data-action');
    assert.strictEqual(el.title, p);
  }
});

// ---------------------------------------------------------------- sessions dropdown

function row(sessionRow, over) {
  return sessionRow({
    id: 'abc123', cwd: path.join(REPO, IMG_LEAF), name: IMG_LEAF, agentLabel: 'Terminal',
    statusText: 'connected', statusClass: 'active', isThisTab: true, ...over,
  });
}

test('sessions dropdown: a session named after its hostile cwd renders as text', async () => {
  const { sessionRow } = await load('../../public/js/menu-rows.js');
  reset();
  const el = row(sessionRow, {});
  assertNoMarkupFrom('sessions dropdown');
  assert.strictEqual(el.dataset.name, IMG_LEAF);
  assert.strictEqual(el.dataset.cwd, path.join(REPO, IMG_LEAF), 'data-cwd is the exact cwd');
  const nameEl = find(el, e => e.className === 'session-name');
  assert.strictEqual(nameEl.textContent, `${IMG_LEAF} Terminal`, 'name, then the agent badge');
});

test('sessions dropdown: an issue-titled session renders as text, live and as a closed tombstone', async () => {
  const { sessionRow } = await load('../../public/js/menu-rows.js');
  for (const over of [
    { name: ISSUE_NAME, cwd: REPO },
    { name: ISSUE_NAME, cwd: REPO, isThisTab: false, isClosed: true, canClose: true,
      statusText: 'closed just now', statusClass: 'closed' },
    { name: ATTR_LEAF, cwd: path.join(REPO, ATTR_LEAF), isThisTab: false, isOtherWindow: true,
      statusText: 'other window', statusClass: 'other-window' },
  ]) {
    reset();
    const el = row(sessionRow, over);
    assertNoMarkupFrom(`sessions dropdown (${over.statusText || 'connected'})`);
    assert.strictEqual(el.dataset.name, over.name);
    assert.strictEqual(find(el, e => e.className === 'session-name').childNodes[0].textContent, over.name);
  }
});

test('sessions dropdown: the row keeps the data attributes its handlers read', async () => {
  const { sessionRow } = await load('../../public/js/menu-rows.js');
  const closed = row(sessionRow, { isThisTab: false, isClosed: true, canClose: true, statusText: 'closed', statusClass: 'closed' });
  assert.strictEqual(closed.className, 'dropdown-item clickable closed');
  const close = find(closed, e => e.className === 'session-close');
  assert.deepStrictEqual({ ...close.dataset }, { id: 'abc123', closed: '1' });
  assert.strictEqual(find(closed, e => e.className.startsWith('session-status')).className, 'session-status closed');

  const other = row(sessionRow, { isThisTab: false, isOtherWindow: true, statusText: 'other window' });
  assert.strictEqual(other.dataset.otherWindow, 'true');
  assert.strictEqual(find(other, e => e.className === 'session-close'), null, 'no ✕ unless canClose');

  const live = row(sessionRow, { agentLabel: '' });
  assert.strictEqual(live.className, 'dropdown-item connected');
  assert.strictEqual(find(live, e => e.className === 'session-agent-badge'), null);
});

// ---------------------------------------------------------------- the wiring

test('app.js and dir-picker.js still render these surfaces through the builders above', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  const app = read('public/js/app.js');
  const picker = read('public/js/dir-picker.js');

  assert.match(app, /import \{[^}]*\brecentDirItem\b[^}]*\bsessionRow\b[^}]*\} from '\.\/menu-rows\.js'/);
  assert.match(app, /sessionsMenu\.replaceChildren\(\.\.\.visibleShells\.map\(/, 'the dropdown is built from row elements');
  assert.match(app, /return sessionRow\(\{/);
  assert.match(app, /return recentDirItem\(d\.path, label\)/);
  assert.match(picker, /renderDirTree\(tree, r\.dirs\)/, 'refreshTree renders through renderDirTree');

  // The exact shapes #747 found. Any of them coming back is the bug coming back.
  assert.doesNotMatch(app, /data-cwd="\$\{/);
  assert.doesNotMatch(app, /data-path="\$\{p\}"/);
  assert.doesNotMatch(app, /<span class="session-name">\$\{/);
  assert.doesNotMatch(picker, /data-path="\$\{d\}"/);
  assert.doesNotMatch(picker, /value="\$\{defaultPath\}"/);
});

// issue-hooks.js: the seams an issue session's lifecycle exposes to optional mods. With
// nothing registered every call must be a no-op — that is what keeps a session on an install
// without the GitHub Webhooks mod byte-for-byte unchanged — and no mod may wedge a session's
// first prompt or a merge by failing.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const hooks = require('../../issue-hooks');

afterEach(() => hooks._reset());

test('nothing registered: empty extras, no gate, and closing notifies nobody', async () => {
  assert.deepStrictEqual(await hooks.collectPromptExtras({ id: 'a', number: 1 }), { discussion: '', commentRule: '' });
  assert.equal(await hooks.checkMergeGates({ id: 'a' }), null);
  assert.doesNotThrow(() => hooks.notifyIssueClosed({ id: 'a', number: 1 }));
});

test('extras from several mods are joined, and a failing one is dropped and logged', async () => {
  const logs = [];
  hooks.registerPromptExtras('one', async () => ({ discussion: 'D1', commentRule: 'R1' }));
  hooks.registerPromptExtras('broken', async () => { throw new Error('boom'); });
  hooks.registerPromptExtras('two', () => ({ discussion: 'D2' }));
  const out = await hooks.collectPromptExtras({ id: 'a', number: 1 }, { log: m => logs.push(m) });
  assert.deepStrictEqual(out, { discussion: 'D1\n\nD2', commentRule: 'R1' });
  assert.ok(logs.some(l => /prompt extras from broken failed: boom/.test(l)));
});

test('a slow provider cannot hold the first prompt past the deadline', async () => {
  const logs = [];
  hooks.registerPromptExtras('slow', () => new Promise(r => setTimeout(() => r({ discussion: 'late' }), 500)));
  const t0 = Date.now();
  const out = await hooks.collectPromptExtras({ id: 'a', number: 9 }, { log: m => logs.push(m), deadlineMs: 50 });
  assert.ok(Date.now() - t0 < 400);
  assert.deepStrictEqual(out, { discussion: '', commentRule: '' });
  assert.ok(logs.some(l => /#9 missed the 50ms deadline/.test(l)));
});

test('the first refusing gate answers, named; a throwing gate allows the merge', async () => {
  const logs = [];
  hooks.registerMergeGate('broken', () => { throw new Error('nope'); });
  hooks.registerMergeGate('quiet', async () => null);
  hooks.registerMergeGate('held', async ({ id }) => ({ next: 'read_new_context', instruction: `hold ${id}` }));
  const r = await hooks.checkMergeGates({ id: 'x' }, { log: m => logs.push(m) });
  assert.deepStrictEqual(r, { gate: 'held', next: 'read_new_context', instruction: 'hold x' });
  assert.ok(logs.some(l => /merge gate broken threw, allowing the merge: nope/.test(l)));
});

test('issue-closed listeners are told, and one that rejects does not stop the rest', async () => {
  const heard = [];
  const logs = [];
  hooks.registerIssueClosed('rejects', async () => { throw new Error('later'); });
  hooks.registerIssueClosed('ok', (a) => { heard.push(a.number); });
  hooks.notifyIssueClosed({ id: 'a', number: 4 }, { log: m => logs.push(m) });
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(heard, [4]);
  assert.ok(logs.some(l => /issue-closed rejects failed: later/.test(l)));
});

test('the comment marker is one definition, used by the merge comment and the mod alike', () => {
  const { markerFor, markerSession } = require('../../mods/github-webhooks/issue-context');
  assert.equal(hooks.commentMarker('abc12345'), '<!-- deepsteve:session=abc12345 -->');
  assert.equal(markerFor('abc12345'), hooks.commentMarker('abc12345'));
  assert.equal(markerSession(`Merged into main.\n\n${hooks.commentMarker('abc12345')}`), 'abc12345');
});

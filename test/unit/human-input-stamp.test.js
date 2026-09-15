// The daemon's record that a PERSON replied in a session (#710).
//
// Workshop supersedes a question the moment someone replies in the asking tab, and later from
// the stamp that reply leaves on the session entry. Keeping that stamp is server.js's job, and
// these tests pin the server half:
//   - where the observer sits in the WebSocket input path
//   - that the observer registry is keyed by name
//   - that the stamp survives a restart and the session closing
//
// Run: node --test test/unit/human-input-stamp.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return serverSource.slice(from, to);
}

test('the stamp is serialized, so state.json and every closed record carry it', () => {
  const code = sourceBetween('function serializeShellEntry', 'function tombstoneSession');
  const context = {};
  vm.runInNewContext(`${code}
result = JSON.stringify([
  serializeShellEntry({ cwd: '/repo', lastHumanInputAt: 1234 }),
  serializeShellEntry({ cwd: '/repo' }),
]);`, context);
  const [stamped, never] = JSON.parse(context.result);
  assert.strictEqual(stamped.lastHumanInputAt, 1234);
  assert.strictEqual(never.lastHumanInputAt, null);
});

test('the WS restore path, which hand-lists its fields, reads the stamp back', () => {
  // tmux reattach copies the saved record wholesale; this is the path that would silently
  // drop the field, and the next save would then wipe it from state.json.
  assert.ok(serverSource.includes('lastHumanInputAt: restored.lastHumanInputAt || null'),
    'the WS restore shells.set must carry lastHumanInputAt');
});

test('observers see a submitted line only after the report and blocked-input drops, and before the PTY write', () => {
  const report = serverSource.indexOf('if (isTerminalReport(str)) {');
  const blocked = serverSource.indexOf('if (entry.inputBlocked) return;', report);
  const notify = serverSource.indexOf('if (submitKeyObservers.size && hasSubmitKey(str)) notifySubmitKey(id, entry);', blocked);
  const write = serverSource.indexOf('getEngine(id).write(id, str);', notify);
  assert.ok(report > 0 && blocked > report, 'the input path moved; re-anchor this test');
  assert.ok(notify > blocked,
    'a terminal report is not a person, and blocked input never reaches the agent, so neither may be observed');
  assert.ok(write > notify && write - notify < 120,
    'observed just before the write, so a dialog this Enter is about to answer is still on screen');
  assert.strictEqual(serverSource.split('notifySubmitKey(id, entry);').length - 1, 1, 'one call site');
});

test('the registry is keyed by name, and an observer that throws does not stop the rest', () => {
  const code = sourceBetween('const submitKeyObservers', 'const AUTO_APPLY_GRACE_MS');
  const logs = [];
  const context = { log: (m) => logs.push(m) };
  vm.runInNewContext(`${code}
const calls = [];
registerSubmitKeyObserver('workshop', (id) => calls.push('first:' + id));
registerSubmitKeyObserver('workshop', (id) => calls.push('second:' + id));
registerSubmitKeyObserver('broken', () => { throw new Error('boom'); });
registerSubmitKeyObserver('later', (id, entry) => calls.push('later:' + entry.name));
registerSubmitKeyObserver('', () => calls.push('nameless'));
notifySubmitKey('s1', { name: 'tab' });
result = JSON.stringify({ calls, size: submitKeyObservers.size });`, context);
  const { calls, size } = JSON.parse(context.result);
  assert.deepStrictEqual(calls, ['second:s1', 'later:tab'],
    'a second initMCP replaces an observer rather than doubling it (#670)');
  assert.strictEqual(size, 3);
  assert.match(logs[0], /observer broken threw: boom/);
});

test('the mod ctx carries the registry', () => {
  const lines = serverSource.split('\n').filter((l) => l.startsWith('initMCP({'));
  assert.strictEqual(lines.length, 1, 'one initMCP call (#670)');
  assert.match(lines[0], /\bregisterSubmitKeyObserver\b/);
});

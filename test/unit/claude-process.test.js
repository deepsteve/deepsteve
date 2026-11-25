// Unit tests for claude-process.js: reading Claude Code's own record of a running process
// (`<config dir>/sessions/<pid>.json`) to learn which conversation a tab is on after a /resume
// typed inside it. The record is Claude Code's internal state, so the tests pin what we believe
// and, mostly, what we refuse to.
//
// Run: node --test test/unit/claude-process.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { conversationOf, newestConversation, watchClaudeProcess, processAlive } = require('../../claude-process');

const A = 'f663d201-c777-482a-80a9-64a033c24e02';
const B = '5ec8535e-e7f2-462a-8612-da087d56c95b';
const alive = (pids) => (pid) => pids.includes(pid);

// The shape Claude Code 2.1.322 wrote for a tab /resume'd onto conversation A.
const record = (over = {}) => ({
  pid: 76034, sessionId: A, cwd: '/repo', startedAt: 1000, updatedAt: 2000,
  version: '2.1.322', kind: 'interactive', tmux: 'ds-9853118f:@45.%45', status: 'busy', ...over,
});

test('a tmux tab is matched by its session name, and only a live process is believed', () => {
  const opts = { shellId: '9853118f', isAlive: alive([76034]) };
  assert.strictEqual(conversationOf(record(), opts), A);
  assert.strictEqual(conversationOf(record({ tmux: 'ds-1234abcd:@1.%1' }), opts), null, 'another tab');
  assert.strictEqual(conversationOf(record({ tmux: 'ds-9853118f0:@1.%1' }), opts), null, 'a name that only starts with ours');
  assert.strictEqual(conversationOf(record({ tmux: 'work:@1.%1' }), opts), null, 'a tmux session that is not ours at all');
  assert.strictEqual(conversationOf(record(), { ...opts, isAlive: alive([]) }), null, 'a crash leftover');
});

test('a node-pty tab has no tmux name and is matched by pid', () => {
  const rec = record({ tmux: undefined });
  assert.strictEqual(conversationOf(rec, { shellId: 'x', pid: 76034, isAlive: alive([76034]) }), A);
  assert.strictEqual(conversationOf(rec, { shellId: 'x', pid: 1111, isAlive: alive([76034]) }), null, 'another process');
  assert.strictEqual(conversationOf(rec, { shellId: 'x', pid: null, isAlive: alive([76034]) }), null, 'no pid to match');
});

test('anything malformed is ignored', () => {
  const opts = { shellId: '9853118f', isAlive: () => true };
  for (const bad of [null, 'text', 42, {}, record({ sessionId: 'not-a-uuid' }), record({ sessionId: null }), record({ sessionId: 7 })]) {
    assert.strictEqual(conversationOf(bad, opts), null, JSON.stringify(bad));
  }
  assert.strictEqual(conversationOf(record(), { isAlive: () => true }), null, 'no shell id');
});

test('of several records, the newest live one that is ours wins', () => {
  const opts = { shellId: '9853118f', isAlive: alive([76034, 80000]) };
  assert.strictEqual(newestConversation([
    record({ pid: 70000, sessionId: B, updatedAt: 9999 }),                 // ours, but dead
    record({ pid: 80000, sessionId: B, updatedAt: 3000, tmux: 'ds-other:@1.%1' }),
    record({ pid: 76034, sessionId: A, updatedAt: 2000 }),
  ], opts), A);
  assert.strictEqual(newestConversation([], opts), null);
});

test('processAlive: this process is, a pid nobody has is not', () => {
  assert.strictEqual(processAlive(process.pid), true);
  assert.strictEqual(processAlive(0), false);
  assert.strictEqual(processAlive(-1), false);
  assert.strictEqual(processAlive('76034'), false);
});

const until = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 20)); }
  return pred();
};

test('watchClaudeProcess reports what is there, then each change of conversation once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-claude-sessions-'));
  const write = (name, rec) => fs.writeFileSync(path.join(dir, name), JSON.stringify(rec));
  write('76034.json', record({ sessionId: B }));
  write('76034.0123abcd.key', 'not a record');
  write('99999.json', record({ pid: 99999, tmux: 'ds-other:@1.%1', sessionId: A }));
  fs.writeFileSync(path.join(dir, '55555.json'), '{"pid":55555,"sessionId":');   // mid-write

  const seen = [];
  const w = watchClaudeProcess({ dir, shellId: '9853118f', isAlive: alive([76034, 99999]), onConversation: (id) => seen.push(id) });
  try {
    assert.ok(await until(() => seen.length === 1), 'the scan at start reports the record already there');
    assert.deepStrictEqual(seen, [B]);

    write('76034.json', record({ sessionId: B, status: 'idle', updatedAt: 2500 }));
    write('99999.json', record({ pid: 99999, tmux: 'ds-other:@1.%1', sessionId: B }));
    await new Promise(r => setTimeout(r, 400));
    assert.deepStrictEqual(seen, [B], 'a status change on the same conversation, and another tab, report nothing');

    write('76034.json', record({ sessionId: A, updatedAt: 3000 }));   // the /resume
    assert.ok(await until(() => seen.length === 2));
    assert.deepStrictEqual(seen, [B, A]);
  } finally {
    w.close();
  }
  write('76034.json', record({ sessionId: B, updatedAt: 4000 }));
  await new Promise(r => setTimeout(r, 300));
  assert.deepStrictEqual(seen, [B, A], 'closed: nothing more');
});

test('watchClaudeProcess creates a missing records directory, since Claude may start after it', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-claude-home-')), 'sessions');
  const seen = [];
  const w = watchClaudeProcess({ dir, shellId: '9853118f', isAlive: alive([76034]), onConversation: (id) => seen.push(id) });
  try {
    assert.ok(fs.statSync(dir).isDirectory());
    fs.writeFileSync(path.join(dir, '76034.json'), JSON.stringify(record()));
    assert.ok(await until(() => seen.length === 1), 'a record written after the watch started');
    assert.deepStrictEqual(seen, [A]);
  } finally {
    w.close();
  }
});

test('watchClaudeProcess where no directory can be made logs once and reports nothing', async () => {
  const logs = [];
  const seen = [];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-claude-file-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  const w = watchClaudeProcess({ dir: path.join(file, 'sessions'), shellId: 'x', onConversation: (id) => seen.push(id), log: (m) => logs.push(m) });
  await new Promise(r => setTimeout(r, 100));
  w.close();
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /not watching Claude process records/);
  assert.deepStrictEqual(seen, []);
});

test('server.js hands the id to adoptClaudeSession and closes the watcher with the session watch', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  assert.match(src, /onConversation: \(id\) => \{[^}]*adoptClaudeSession\(shellId, id, 'claude-process'\);\s*\}/);
  assert.match(src, /entry\.claudeProcessWatcher\.close\(\);\s*entry\.claudeProcessWatcher = null;/);
  // A tmux tab is matched by name: asking tmux for its pid is a subprocess, which the WS create
  // path that starts this watcher must not run (#553).
  assert.match(src, /getPid: \(\) => \(entry\.engineType === 'tmux' \? null :/);
});

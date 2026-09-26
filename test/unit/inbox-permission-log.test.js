// Unit test for mods/inbox/permission-log.js — the record of what agents have asked
// to be allowed to do.
//
// Two things here are worth a test and the rest is bookkeeping:
//
//   parseSubject  the log's whole readability rests on splitting "Bash(git push)" into a
//                 tool and a target. Get it wrong and the list is a wall of raw lines
//                 that cannot be grouped or scanned.
//   observe       the de-dupe. This is called on EVERY poll for as long as a dialog is
//                 on screen — twice a second — and it must produce exactly one entry,
//                 including across the frames where the poll's own view of "is a dialog
//                 up" flickers false and the sweep closes the entry underneath it.
//
// HOME is repointed before the require, as in inbox-items.test.js, because the store
// persists under stateDir().
//
// Run: node --test test/unit/inbox-permission-log.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-inbox-perm-'));
process.env.HOME = SCRATCH;
delete process.env.DEEPSTEVE_HOME;

const log = require('../../mods/inbox/permission-log.js');

const NOW = 1_700_000_000_000;

/** A fresh store for each test — the module is a singleton over one file. */
function reset() {
  try { fs.rmSync(log.logFile(), { force: true }); } catch {}
  log.load();
}

const ask = (over = {}) => ({
  sessionId: 's1',
  sessionName: 'issue 691',
  project: '/repo/a',
  projectName: 'a',
  fingerprint: 'fp-1',
  subject: 'Bash(git push origin main)',
  question: 'Do you want to proceed?',
  options: ['Yes', 'Yes, and don’t ask again', 'No'],
  ...over,
});

// ── parseSubject ─────────────────────────────────────────────────────────────

test('a tool call splits into the tool and what it was called with', () => {
  assert.deepStrictEqual(
    log.parseSubject('Bash(git push origin main)'),
    { tool: 'Bash', target: 'git push origin main' },
  );
  assert.deepStrictEqual(log.parseSubject('Read(/etc/hosts)'), { tool: 'Read', target: '/etc/hosts' });
});

test('an inner bracket does not truncate the command', () => {
  // The parenthesised argument runs to the END of the line. A non-greedy match would cut
  // "$(date)" in half and the log would show a command nobody ran.
  assert.deepStrictEqual(
    log.parseSubject('Bash(echo $(date) > /tmp/x)'),
    { tool: 'Bash', target: 'echo $(date) > /tmp/x' },
  );
});

test('an MCP permission splits into the server and the tool', () => {
  assert.deepStrictEqual(
    log.parseSubject('deepsteve - read_session_screen (MCP)'),
    { tool: 'deepsteve', target: 'read_session_screen' },
  );
});

test('an unrecognised subject keeps the whole line as the tool', () => {
  // Truthful, and it still groups: an unknown shape gets its own bucket rather than
  // being silently merged into a neighbour's.
  assert.deepStrictEqual(
    log.parseSubject('Something entirely new'),
    { tool: 'Something entirely new', target: '' },
  );
  assert.deepStrictEqual(log.parseSubject(''), { tool: '', target: '' });
  assert.deepStrictEqual(log.parseSubject(null), { tool: '', target: '' });
});

// ── observe: the de-dupe that makes a 2s poll produce one entry ──────────────

test('polling the same dialog for a minute writes exactly one entry', () => {
  reset();
  const first = log.observe(ask(), NOW);
  assert.ok(first, 'the first sighting mints the entry');
  assert.strictEqual(first.tool, 'Bash');

  for (let t = 0; t < 30; t++) {
    assert.strictEqual(log.observe(ask(), NOW + t * 2000), null, 'a repeat poll adds nothing');
  }
  assert.strictEqual(log.all().length, 1);
});

test('a flicker that closes the entry does not mint a second one', () => {
  // The failure this de-dupe exists for. `waitingForInput` drops false for a frame during
  // a repaint, that frame's scrape reports no dialog, the sweep resolves the entry — and
  // the next poll has the identical dialog still on screen. Without the re-ask window
  // that is a duplicate every time the screen redraws.
  reset();
  log.observe(ask(), NOW);
  log.resolve('s1', 'fp-1', {}, NOW + 100);
  assert.strictEqual(log.all()[0].status, 'resolved');

  assert.strictEqual(log.observe(ask(), NOW + 200), null, 'still the same dialog');
  assert.strictEqual(log.all().length, 1);
  assert.strictEqual(log.all()[0].status, 'open', 'and it is re-opened, because it never went away');
});

test('the same permission asked again much later is a second entry', () => {
  // The other half: real repeats are minutes apart, and collapsing them would make the
  // log say a command ran once when it ran twice.
  reset();
  log.observe(ask(), NOW);
  log.resolve('s1', 'fp-1', {}, NOW + 1000);
  // Measured from when it was last SEEN (the resolve), not from when it was first asked.
  const again = log.observe(ask(), NOW + 1000 + log.REASK_WINDOW_MS + 1);
  assert.ok(again, 'past the window it is a new ask');
  assert.strictEqual(log.all().length, 2);
});

test('a different dialog in the same session closes the one before it', () => {
  // Otherwise a session that answers three dialogs quickly leaves two entries open
  // forever, and the "waiting" marker stops meaning anything.
  reset();
  log.observe(ask(), NOW);
  log.observe(ask({ fingerprint: 'fp-2', subject: 'Bash(rm -rf build)' }), NOW + 5000);

  const all = log.all();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].status, 'resolved', 'the earlier dialog is gone from the screen');
  assert.strictEqual(all[1].status, 'open');
});

test('two sessions asking the same thing are two entries', () => {
  reset();
  log.observe(ask({ sessionId: 's1' }), NOW);
  log.observe(ask({ sessionId: 's2' }), NOW);
  assert.strictEqual(log.all().length, 2, 'the de-dupe is per session, not per question');
});

// ── what was answered, and what we refuse to guess ───────────────────────────

test('an answer is recorded only when it came through the panel', () => {
  // The honesty rule. A human answering in the terminal just makes the dialog vanish and
  // no repaint says which key they pressed, so the log says "resolved" and nothing more.
  // A guess here would make the whole list untrustworthy.
  reset();
  log.observe(ask(), NOW);
  log.resolve('s1', 'fp-1', {}, NOW + 1000);
  assert.strictEqual(log.all()[0].answer, null);
  assert.strictEqual(log.all()[0].answeredVia, null);

  reset();
  log.observe(ask(), NOW);
  log.resolve('s1', 'fp-1', { answer: 'Yes', via: 'inbox' }, NOW + 1000);
  assert.strictEqual(log.all()[0].answer, 'Yes');
  assert.strictEqual(log.all()[0].answeredVia, 'inbox');
});

test('resolving a dialog that is not the open one changes nothing', () => {
  reset();
  log.observe(ask(), NOW);
  assert.strictEqual(log.resolve('s1', 'a-different-fp', {}, NOW + 1000), null);
  assert.strictEqual(log.all()[0].status, 'open');
});

// ── shape ────────────────────────────────────────────────────────────────────

test('the rollup counts by tool, busiest first', () => {
  reset();
  const entries = [
    { tool: 'Bash', at: 3 }, { tool: 'Bash', at: 1 },
    { tool: 'Read', at: 2 }, { tool: 'Bash', at: 4 }, { tool: 'Edit', at: 9 },
  ];
  assert.deepStrictEqual(
    log.summarize(entries).map((s) => [s.tool, s.count]),
    [['Bash', 3], ['Edit', 1], ['Read', 1]],
  );
});

test('the log is capped, oldest dropped', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, at: i }));
  const kept = log.retain(entries, 5);
  assert.strictEqual(kept.length, 5);
  assert.deepStrictEqual(kept.map((e) => e.at), [15, 16, 17, 18, 19]);
});

test('a corrupt file is an empty log, never a throw', () => {
  // This module is required at daemon boot; a throw here drops the whole mod.
  fs.mkdirSync(path.dirname(log.logFile()), { recursive: true });
  fs.writeFileSync(log.logFile(), '{ not json');
  assert.doesNotThrow(() => log.load());
  assert.deepStrictEqual(log.all(), []);
});

test('ids never repeat across a reload, even if nextSeq is lost', () => {
  reset();
  log.observe(ask(), NOW);
  log.observe(ask({ fingerprint: 'fp-2' }), NOW + 5000);
  log.saveNow();

  const raw = JSON.parse(fs.readFileSync(log.logFile(), 'utf8'));
  delete raw.nextSeq;
  fs.writeFileSync(log.logFile(), JSON.stringify(raw));

  log.load();
  const next = log.observe(ask({ sessionId: 's9', fingerprint: 'fp-9' }), NOW + 9000);
  assert.ok(!log.all().slice(0, -1).some((e) => e.id === next.id), 'a reissued id would overwrite a record');
});

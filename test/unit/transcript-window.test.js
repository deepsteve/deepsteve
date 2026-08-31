// Unit tests for transcript-window.js — the byte-window pager behind the History
// view (#672).
//
// The headline test is the ROUND TRIP: page a file backwards to offset 0 and
// assert the concatenation equals a straight full-file read, line for line and
// offset for offset. That single property covers partial-first-line handling,
// line-boundary cutting and cursor arithmetic together, and it is what caught the
// one real bug in this module — a window can end exactly on the previous record's
// newline and still contain no COMPLETE line, which is not the same condition as
// "no newline at all". Getting that wrong returned a cursor equal to the one
// passed in, so a client's "load more" loop would spin forever on the same bytes
// while the earlier history stayed invisible.
//
// Real files under os.tmpdir(), which is correct HERE: a unit test runs no
// daemon, so its filesystem is its own (the ban on os.tmpdir() is a
// test/integration/** rule, where the daemon is in another container). Precedent:
// test/unit/prompt-delivery-check.test.js.
//
// Run: node --test test/unit/transcript-window.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readBackwardWindow, readForwardWindow, DEFAULT_WINDOW, MAX_LINE } = require('../../transcript-window.js');

// async/await, not try/finally around a sync call: every caller's body is async,
// and a synchronous finally deletes the directory before the body has read it.
async function withFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, contents);
  try { return await fn(file, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** `n` JSONL records, each tagged with its index so order is checkable. */
function transcript(n, pad = 0) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ type: 'user', i, message: { role: 'user', content: 'x'.repeat(pad) } }));
  }
  return lines.join('\n') + '\n';
}

/** Page backwards to the start, returning every line oldest-first. */
async function pageAll(file, opts = {}) {
  const pages = [];
  let before = null;
  for (let guard = 0; guard < 5000; guard++) {
    const page = await readBackwardWindow(file, { ...opts, before });
    pages.unshift(page.lines);
    if (page.atStart || page.start === 0) return { lines: pages.flat(), pages: pages.length };
    assert.ok(before === null || page.start < before,
      `cursor did not advance: ${page.start} >= ${before}`);
    before = page.start;
  }
  throw new Error('paging did not terminate');
}

// -------------------------------------------------------- the round trip

test('paging backwards recovers the whole file, exactly, at every window size', async () => {
  const body = transcript(5000, 60);
  const truth = body.split('\n').filter(Boolean);
  await withFile(body, async (file) => {
    // A window far smaller than a line, one near a line, and the real default.
    for (const window of [4096, 65536, DEFAULT_WINDOW]) {
      const { lines } = await pageAll(file, { window });
      assert.strictEqual(lines.length, truth.length, `line count at window=${window}`);
      let offset = 0;
      for (let i = 0; i < truth.length; i++) {
        assert.strictEqual(lines[i].text, truth[i], `line ${i} at window=${window}`);
        assert.strictEqual(lines[i].offset, offset, `offset of line ${i} at window=${window}`);
        assert.strictEqual(lines[i].bytes, Buffer.byteLength(truth[i]), `bytes of line ${i}`);
        offset += lines[i].bytes + 1;
      }
    }
  });
});

test('offsets are BYTE offsets, so multibyte content does not shift them', async () => {
  // All searching is done on the buffer, never on the decoded string: a character
  // index is not a byte offset the moment a transcript contains a — or an emoji,
  // and every cursor here is a byte offset.
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '— em dashes — everywhere 🙂' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'ascii' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'ünïcödé ✓ ✗ ⧗' } }),
  ];
  await withFile(lines.join('\n') + '\n', async (file) => {
    const { lines: got } = await pageAll(file, { window: 4096 });
    assert.deepStrictEqual(got.map((l) => l.text), lines);
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      assert.strictEqual(got[i].offset, off);
      off += Buffer.byteLength(lines[i]) + 1;
    }
  });
});

// ------------------------------------------------------------ long records

test('a single line larger than the window is found by growing the window', async () => {
  // Not hypothetical: the longest line measured across the transcripts on the
  // development machine is 1,365,762 bytes — a tool_result carrying a base64
  // screenshot — and one file held eight of them.
  const huge = JSON.stringify({ type: 'user', message: { role: 'user', content: 'z'.repeat(1200000) } });
  const body = `${JSON.stringify({ type: 'user', i: 0 })}\n${huge}\n${JSON.stringify({ type: 'user', i: 2 })}\n`;
  await withFile(body, async (file) => {
    const { lines } = await pageAll(file, { window: 512 * 1024 });
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[1].text, huge);
    assert.strictEqual(lines[1].oversize, false);
  });
});

test('the window ending exactly on a newline is still "no complete line"', async () => {
  // THE REGRESSION. Line 1 is longer than the window, and the window's last byte
  // is line 0's terminating newline — so a "did I find any newline?" test says
  // yes while there is no whole record in view. The cursor then never moves.
  const long = JSON.stringify({ type: 'user', message: { role: 'user', content: 'q'.repeat(20000) } });
  const body = `${JSON.stringify({ type: 'user', i: 0 })}\n${long}\n`;
  await withFile(body, async (file) => {
    const size = fs.statSync(file).size;
    // A window that lands precisely on the boundary between the two records.
    const window = size - JSON.stringify({ type: 'user', i: 0 }).length - 1;
    const page = await readBackwardWindow(file, { window, maxLine: MAX_LINE });
    assert.ok(page.start < size, 'cursor must advance off the tail');
    const { lines } = await pageAll(file, { window });
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1].text, long);
  });
});

test('a record past maxLine becomes a visible gap AND the cursor still advances', async () => {
  // Anti-livelock. If `start` did not move here, the pane's "load more" loop
  // would ask for the same bytes forever and the reader would see nothing.
  const monster = 'k'.repeat(300000);
  const body = `${JSON.stringify({ type: 'user', i: 0 })}\n${monster}\n`;
  await withFile(body, async (file) => {
    const page = await readBackwardWindow(file, { window: 4096, maxLine: 8192 });
    assert.strictEqual(page.lines.length, 1);
    assert.strictEqual(page.lines[0].oversize, true);
    assert.strictEqual(page.lines[0].text, null);
    assert.ok(page.start < page.end, 'the cursor must advance past an unreadable record');
    // And paging still terminates over that record.
    const { lines } = await pageAll(file, { window: 4096, maxLine: 8192 });
    assert.ok(lines.some((l) => l.oversize), 'the gap is reported, not hidden');
  });
});

// ------------------------------------------------------------ growth & edges

test('a file that grows does not invalidate a cursor already handed out', async () => {
  // Claude Code appends only, which is the single property that makes a byte
  // offset a stable cursor. Appending must not change what an older page holds.
  await withFile(transcript(400, 40), async (file) => {
    const first = await readBackwardWindow(file, { window: 16384 });
    const second = await readBackwardWindow(file, { window: 16384, before: first.start });
    fs.appendFileSync(file, transcript(50, 40));
    const again = await readBackwardWindow(file, { window: 16384, before: first.start });
    assert.deepStrictEqual(again.lines, second.lines, 'an older page changed under an append');
    assert.ok(again.size > first.size, 'the new size is reported');
  });
});

test('a shrunk or replaced file rejects the stale cursor rather than lying', async () => {
  await withFile(transcript(400, 40), async (file) => {
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, transcript(3));
    await assert.rejects(
      () => readBackwardWindow(file, { before: size }),
      (e) => e.code === 'REWOUND');
    await assert.rejects(
      () => readForwardWindow(file, { after: size }),
      (e) => e.code === 'REWOUND');
  });
});

test('an empty file, and a file of one unterminated line', async () => {
  await withFile('', async (file) => {
    const page = await readBackwardWindow(file, {});
    assert.deepStrictEqual(page.lines, []);
    assert.strictEqual(page.atStart, true);
  });
  // A file that is ONE unterminated line is a transcript mid-first-write: all
  // 1,273 settled transcripts on the development machine end with a newline, so
  // an absent one means the record is not finished. Withhold it — half a JSON
  // object rendered as a parse failure is worse than one poll of patience — and
  // do it without growing the window, since at offset 0 the buffer already holds
  // the whole file and no larger read can find a boundary that is not there.
  await withFile('{"type":"user","i":0}', async (file) => {
    const page = await readBackwardWindow(file, {});
    assert.deepStrictEqual(page.lines, []);
    assert.strictEqual(page.atStart, true);
  });
  // ...and it appears the moment the newline lands.
  await withFile('{"type":"user","i":0}\n', async (file) => {
    const page = await readBackwardWindow(file, {});
    assert.strictEqual(page.lines.length, 1);
    assert.strictEqual(page.lines[0].text, '{"type":"user","i":0}');
  });
});

test('a half-written final record is withheld until its newline lands', async () => {
  // A 1 MB append is not atomic from a reader's side, so file.size is not always
  // a record boundary. Handing half a JSON object to the pane would show it as a
  // parse failure on every poll until the write finished.
  const complete = transcript(20);
  await withFile(complete + '{"type":"user","i":20,"partial', async (file) => {
    const page = await readBackwardWindow(file, {});
    assert.strictEqual(page.lines.length, 20, 'the partial line must not be returned');
    assert.ok(!page.lines.some((l) => l.text.includes('partial')));
  });
});

// ------------------------------------------------------------------ forward

test('tailing reads only the delta, and nothing at all at EOF', async () => {
  await withFile(transcript(30), async (file) => {
    const size = fs.statSync(file).size;
    const idle = await readForwardWindow(file, { after: size });
    assert.deepStrictEqual(idle.lines, []);
    assert.strictEqual(idle.nextAfter, size, 'the cursor must not drift when nothing changed');

    fs.appendFileSync(file, JSON.stringify({ type: 'user', i: 30 }) + '\n');
    const delta = await readForwardWindow(file, { after: size });
    assert.strictEqual(delta.lines.length, 1);
    assert.strictEqual(JSON.parse(delta.lines[0].text).i, 30);
    assert.strictEqual(delta.nextAfter, fs.statSync(file).size);
  });
});

test('tailing does not advance past a record still being appended', async () => {
  await withFile(transcript(10), async (file) => {
    const size = fs.statSync(file).size;
    fs.appendFileSync(file, '{"type":"user","i":10,"half');
    const page = await readForwardWindow(file, { after: size });
    assert.deepStrictEqual(page.lines, []);
    assert.strictEqual(page.nextAfter, size,
      'advancing here would skip the record once it completes');

    fs.appendFileSync(file, '":1}\n');
    const done = await readForwardWindow(file, { after: size });
    assert.strictEqual(done.lines.length, 1);
    assert.strictEqual(JSON.parse(done.lines[0].text).i, 10);
  });
});

test('forward paging walks the whole file in windows too', async () => {
  const body = transcript(800, 50);
  const truth = body.split('\n').filter(Boolean);
  await withFile(body, async (file) => {
    const got = [];
    let after = 0;
    for (let guard = 0; guard < 5000; guard++) {
      const page = await readForwardWindow(file, { after, window: 8192 });
      got.push(...page.lines);
      if (page.nextAfter === after || page.nextAfter >= page.size) { after = page.nextAfter; break; }
      after = page.nextAfter;
    }
    assert.deepStrictEqual(got.map((l) => l.text), truth);
  });
});

// ------------------------------------------------------------------- limits

test('a missing file rejects with ENOENT rather than inventing an empty history', async () => {
  await assert.rejects(
    () => readBackwardWindow(path.join(os.tmpdir(), 'ds-does-not-exist-672.jsonl'), {}),
    (e) => e.code === 'ENOENT');
});

test('the module opens no descriptor it does not close', async () => {
  // This daemon runs for weeks; a leaked fd here is EMFILE, which takes every
  // session with it.
  await withFile(transcript(50), async (file) => {
    const before = process.report ? Object.keys(process.report.getReport().libuv).length : 0;
    for (let i = 0; i < 200; i++) await readBackwardWindow(file, {});
    const after = process.report ? Object.keys(process.report.getReport().libuv).length : 0;
    assert.ok(after - before < 50, `descriptor count grew by ${after - before} over 200 reads`);
  });
});

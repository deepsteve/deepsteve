/**
 * Bounded byte windows over a Claude Code transcript (#672).
 *
 * The History pane scrolls backwards through a file that can be very large: the
 * biggest transcript on the development machine is 139 MB, and the median is
 * 215 KB. Reading the whole thing to show the last twenty messages is the naive
 * version. This reads ONE window per request, from the end, and hands back a
 * cursor -- paging that 139 MB file all the way back took 5 ms in a prototype.
 *
 * Byte offsets are the cursor because Claude Code APPENDS ONLY: a line's start
 * offset never changes once written, which is the single property that makes an
 * offset stable across a growing file. A "skip N lines from the end" cursor
 * shifts under every append; a uuid cursor needs a scan to resolve.
 *
 * `fs.promises`, never `readSync`. /api/recoverable-sessions once did ~448 ms of
 * synchronous reads on a request path and stalled every live PTY on the daemon
 * (see the comment at its handler in server.js). The sync readers this file sits
 * next to -- deriveSessionLabel, prompt-delivery-check.js -- are each ONE bounded
 * read from an already-synchronous caller. This is a scroll: a dragged scrollbar
 * fires it five to ten times a second, so sync would compound.
 *
 * Two things that look like bugs and are not:
 *
 *   - All searching is done on the BUFFER (`buf.indexOf(0x0A)`), never on the
 *     decoded string. A character index is not a byte offset once a transcript
 *     contains anything non-ASCII, and every offset here is a byte offset.
 *   - A window may begin mid-codepoint, and decoding it yields a leading U+FFFD.
 *     That is harmless by construction: 0x0A can never be a UTF-8 continuation
 *     byte (those are 0x80-0xBF), so the first newline found is always a true
 *     record boundary and the mangled prefix is always inside the partial line
 *     that gets discarded anyway.
 */

const fsp = require('fs').promises;

// One window holds ~290 lines of a typical transcript and costs ~4 ms to parse.
const DEFAULT_WINDOW = 512 * 1024;

// A single line CAN exceed the window -- the longest measured is 1,365,762 bytes,
// a tool_result carrying a base64 screenshot, and one file held eight of them. So
// the window grows when it finds no record boundary. This is the cap on that
// growth: 2 MB is comfortably past anything observed, and bounds one request's
// memory. Past it, the line becomes an `oversize` placeholder.
const MAX_LINE = 2 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * The file shrank or was replaced, so a cursor minted against the old bytes means
 * nothing. Distinct from a bad request: the cursor was valid when it was issued.
 */
class TranscriptRewound extends Error {
  constructor(size) {
    super('transcript rewound');
    this.code = 'REWOUND';
    this.size = size;
  }
}

/**
 * Split a buffer of COMPLETE lines (it must end at a newline, or at the buffer's
 * end for a final unterminated line the caller has decided to keep) into line
 * records carrying their absolute byte offsets.
 */
function splitLines(buf, baseOffset) {
  const lines = [];
  let at = 0;
  while (at < buf.length) {
    let nl = buf.indexOf(NEWLINE, at);
    if (nl < 0) nl = buf.length;
    lines.push({
      offset: baseOffset + at,
      bytes: nl - at,
      text: buf.toString('utf8', at, nl),
      oversize: false,
    });
    at = nl + 1;
  }
  return lines;
}

async function withFile(file, fn) {
  const fh = await fsp.open(file, 'r');
  // This daemon runs for weeks. A leaked fd here is EMFILE, which takes every
  // session with it -- hence finally, not a close on the happy path.
  try {
    return await fn(fh);
  } finally {
    try { await fh.close(); } catch { /* already gone */ }
  }
}

/**
 * Read the window of complete lines ending at `before` (default: end of file).
 *
 * @param {string} file
 * @param {{before?: number|null, window?: number, maxLine?: number}} opts
 * @returns {Promise<{start:number, end:number, lines:object[], size:number,
 *                    mtimeMs:number, atStart:boolean}>}
 *   `start` is the offset of the first line returned -- feed it back as `before`
 *   to get the previous page. `atStart` is true when there is nothing older.
 */
async function readBackwardWindow(file, opts = {}) {
  const { before = null, window = DEFAULT_WINDOW, maxLine = MAX_LINE } = opts;
  return withFile(file, async (fh) => {
    const st = await fh.stat();
    const size = st.size;
    const mtimeMs = st.mtimeMs;

    if (before != null && before > size) throw new TranscriptRewound(size);

    const end = before == null ? size : Math.max(0, Math.min(before, size));
    if (end === 0) return { start: 0, end: 0, lines: [], size, mtimeMs, atStart: true };

    let w = Math.min(window, maxLine);
    for (;;) {
      const start = Math.max(0, end - w);
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);

      // Head: everything before the first newline belongs to the line the window
      // cut in half, and is the previous page's business. At offset 0 there is no
      // such line -- the file starts there.
      const firstNl = start > 0 ? buf.indexOf(NEWLINE) : -1;
      const from = start > 0 ? firstNl + 1 : 0; // firstNl < 0 => from === 0, caught below

      // Tail: everything after the last newline is a record still being written.
      // All 1,273 settled transcripts on the development machine end with a
      // newline, so an unterminated final line always means an append is in
      // flight -- dropping it costs nothing and keeps half a record off the wire.
      const lastNl = buf.lastIndexOf(NEWLINE);

      // At offset 0 the buffer already holds everything up to `end`, so growing
      // the window cannot reveal a boundary that is not there: the file simply
      // begins with a record whose newline has not landed yet. Return nothing and
      // let the next read pick it up whole, rather than paying for a 2 MB read to
      // report a "too large" record that is merely half-written.
      if (start === 0 && lastNl < 0) {
        return { start: 0, end, lines: [], size, mtimeMs, atStart: true };
      }

      // No COMPLETE line in this window. Note this is not the same test as "no
      // newline at all": a window can end exactly on the previous record's
      // newline and still hold nothing but the interior of one huge line, which
      // is how a round-trip over a real transcript first caught this. Getting it
      // wrong returns a cursor equal to the one passed in, and the client's
      // "load more" loop spins forever on the same bytes.
      if ((start > 0 && firstNl < 0) || lastNl < from) {
        if (w < maxLine) { w = Math.min(w * 2, maxLine); continue; }
        // Past the cap: report the gap rather than hiding it, and ADVANCE THE
        // CURSOR ANYWAY -- `start` is strictly less than `end` whenever end > 0,
        // so paging always terminates even across a pathologically long record.
        return {
          start, end,
          lines: [{ offset: start, bytes: end - start, text: null, oversize: true }],
          size, mtimeMs, atStart: start === 0,
        };
      }

      const body = buf.subarray(from, lastNl + 1);
      return {
        start: start + from,
        end,
        lines: splitLines(body, start + from),
        size, mtimeMs,
        atStart: start === 0,
      };
    }
  });
}

/**
 * Read complete lines written since `after`. This is the tail: when nothing has
 * been appended it is one stat and ZERO reads, which is why the pane needs no
 * separate "has it changed?" endpoint.
 *
 * @returns {Promise<{lines:object[], size:number, mtimeMs:number, nextAfter:number}>}
 *   `nextAfter` never advances past an incomplete final line, so a record still
 *   being written is picked up on the following poll rather than lost.
 */
async function readForwardWindow(file, opts = {}) {
  const { after = 0, window = DEFAULT_WINDOW, maxLine = MAX_LINE } = opts;
  return withFile(file, async (fh) => {
    const st = await fh.stat();
    const size = st.size;
    const mtimeMs = st.mtimeMs;

    if (after > size) throw new TranscriptRewound(size);
    const start = Math.max(0, after);
    if (start >= size) return { lines: [], size, mtimeMs, nextAfter: size };

    let w = Math.min(window, maxLine);
    for (;;) {
      const end = Math.min(size, start + w);
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);

      const lastNl = buf.lastIndexOf(NEWLINE);
      if (lastNl < 0) {
        // No boundary yet. If the window stops short of the end there is more to
        // look at, so grow; if it reached the end, the record is simply still
        // being written and the next poll will find its newline.
        if (end < size && w < maxLine) { w = Math.min(w * 2, maxLine); continue; }
        if (end < size) {
          return {
            lines: [{ offset: start, bytes: end - start, text: null, oversize: true }],
            size, mtimeMs, nextAfter: end,
          };
        }
        return { lines: [], size, mtimeMs, nextAfter: start };
      }

      const body = buf.subarray(0, lastNl + 1);
      return {
        lines: splitLines(body, start),
        size, mtimeMs,
        nextAfter: start + lastNl + 1,
      };
    }
  });
}

module.exports = {
  readBackwardWindow, readForwardWindow,
  TranscriptRewound,
  DEFAULT_WINDOW, MAX_LINE,
};

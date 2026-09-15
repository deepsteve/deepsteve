/**
 * Local UI Lab: turning a small model's raw token stream into a page, or into edits to one.
 *
 * Pure, with no DOM and no imports, so the browser and test/unit/local-ui-lab-patch.test.js
 * load the same file.
 *
 * WHY EDITS ARE SEARCH/REPLACE BLOCKS AND NOT A REWRITE. WebLLM serves Qwen3.5-4B with a
 * 4096-token context window. The current page, the request and a whole rewritten page do not
 * reliably fit in that, and a rewrite pays for every token of the page to change one colour.
 * A block is the smallest edit a model can express without line numbers it cannot count.
 *
 * WHY NOTHING HERE THROWS. A SEARCH that is not in the page, a code fence around the HTML,
 * a sentence of prose before the doctype: each of those is a result the experiment is
 * measuring. They come back as flags and `{ ok: false, reason }`, never as exceptions.
 */

// Markers are matched loosely: a small model writes six or eight `<` as readily as seven,
// and drops the space before SEARCH. Rejecting those would measure typing, not editing.
const SEARCH_RE = /^\s*<{5,9}\s*SEARCH\s*$/;
const DIVIDER_RE = /^\s*={5,9}\s*$/;
const REPLACE_RE = /^\s*>{5,9}\s*REPLACE\s*$/;
const FENCE_RE = /^\s*```/;

/**
 * An incremental SEARCH/REPLACE parser.
 *
 * `feed(chunk)` returns every block whose closing `>>>>>>> REPLACE` line arrived in that
 * chunk, so each edit can land on the page while the model is still writing the next one.
 * A block is not a block until its closing line is complete, which is what makes an arbitrary
 * split between chunks harmless.
 */
export function createPatchParser() {
  let buf = '';
  let state = 'outside';   // 'outside' | 'search' | 'replace'
  let search = [];
  let replace = [];
  const stats = { blocks: 0, prose: 0, fences: 0 };

  function onLine(raw) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (state === 'outside') {
      if (SEARCH_RE.test(line)) { state = 'search'; search = []; replace = []; }
      else if (FENCE_RE.test(line)) stats.fences++;
      else if (line.trim()) stats.prose++;
      return null;
    }
    if (state === 'search') {
      if (DIVIDER_RE.test(line)) state = 'replace';
      else search.push(line);
      return null;
    }
    if (REPLACE_RE.test(line)) {
      state = 'outside';
      stats.blocks++;
      return { search: search.join('\n'), replace: replace.join('\n') };
    }
    replace.push(line);
    return null;
  }

  function drain(final) {
    const out = [];
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const block = onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (block) out.push(block);
    }
    if (final && buf) {
      const block = onLine(buf);
      buf = '';
      if (block) out.push(block);
    }
    return out;
  }

  return {
    feed(chunk) {
      buf += String(chunk ?? '');
      return drain(false);
    },
    /** Flush a last line that had no newline. `unterminated` means the reply stopped mid-block. */
    end() {
      const blocks = drain(true);
      return { blocks, unterminated: state !== 'outside' };
    },
    get stats() { return { ...stats }; },
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatches(haystack, re) {
  const global = new RegExp(re.source, 'g');
  let n = 0;
  while (global.exec(haystack) && n < 100) n++;
  return n;
}

/**
 * Apply one block to a page.
 *
 * Exact first. Failing that, a match that ignores how whitespace is laid out, because the
 * most common near-miss is a SEARCH copied with the wrong indentation. When the SEARCH
 * occurs more than once, the first occurrence is replaced and `occurrences` says so.
 *
 * @returns {{ ok: true, html: string, how: 'exact'|'whitespace', occurrences: number }
 *         | { ok: false, html: string, reason: 'empty-search'|'not-found' }}
 */
export function applyBlock(html, { search, replace }) {
  const page = String(html ?? '');
  const find = String(search ?? '');
  const repl = String(replace ?? '');
  if (!find.trim()) return { ok: false, html: page, reason: 'empty-search' };

  const at = page.indexOf(find);
  if (at >= 0) {
    return {
      ok: true,
      html: page.slice(0, at) + repl + page.slice(at + find.length),
      how: 'exact',
      occurrences: countMatches(page, new RegExp(escapeRegExp(find))),
    };
  }

  const loose = new RegExp(find.trim().split(/\s+/).map(escapeRegExp).join('\\s+'));
  const m = loose.exec(page);
  if (m) {
    // The match starts and ends on non-whitespace, so the replacement is trimmed the same
    // way. Otherwise its own indentation would be added on top of what the page already has.
    return {
      ok: true,
      html: page.slice(0, m.index) + repl.trim() + page.slice(m.index + m[0].length),
      how: 'whitespace',
      occurrences: countMatches(page, loose),
    };
  }
  return { ok: false, html: page, reason: 'not-found' };
}

/**
 * Pull the HTML document out of a reply that was asked to be nothing but one.
 *
 * Works on a partial reply as well as a finished one, because the preview calls it on every
 * frame while the reply streams. `fenced` and `prose` record what the model added that it
 * was told not to; `complete` means `</html>` has arrived.
 */
export function extractHtml(text) {
  const src = String(text ?? '');
  const out = { html: '', fenced: false, prose: false, complete: false };

  let body = src;
  const firstTag = src.search(/<[a-zA-Z!]/);
  const fenceAt = src.indexOf('```');
  if (fenceAt >= 0 && (firstTag < 0 || fenceAt < firstTag)) {
    out.fenced = true;
    if (src.slice(0, fenceAt).trim()) out.prose = true;
    const nl = src.indexOf('\n', fenceAt);
    if (nl < 0) return out;   // still receiving the ```html line itself
    const close = src.indexOf('\n```', nl);
    body = close >= 0 ? src.slice(nl + 1, close) : src.slice(nl + 1);
    if (close >= 0 && src.slice(close + 4).trim()) out.prose = true;
  }

  const lower = body.toLowerCase();
  let start = lower.search(/<!doctype|<html/);
  if (start < 0) start = lower.search(/<[a-z!]/);
  if (start < 0) {
    if (body.trim()) out.prose = true;
    return out;
  }
  if (body.slice(0, start).trim()) out.prose = true;

  const end = lower.lastIndexOf('</html>');
  if (end >= start) {
    if (body.slice(end + 7).trim()) out.prose = true;
    out.html = body.slice(start, end + 7);
    out.complete = true;
  } else {
    out.html = body.slice(start);
  }
  return out;
}

/**
 * Drop a leading `<think>…</think>` from a token stream.
 *
 * Thinking is switched off on both runtimes, but a Qwen chat template can still open the
 * reply with an empty think block. Left in, it reads as prose and the patch parser counts
 * it against the model. `thought` records that one was stripped.
 */
export function createThinkFilter() {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let pending = '';
  let state = 'start';   // 'start' | 'think' | 'after' | 'pass'
  let thought = false;

  return {
    push(chunk) {
      const text = String(chunk ?? '');
      if (state === 'pass') return text;
      pending += text;
      if (state === 'start') {
        const head = pending.trimStart();
        if (!head || OPEN.startsWith(head)) return '';
        if (!head.startsWith(OPEN)) {
          state = 'pass';
          const out = pending;
          pending = '';
          return out;
        }
        state = 'think';
        thought = true;
      }
      if (state === 'think') {
        const close = pending.indexOf(CLOSE);
        if (close < 0) return '';
        pending = pending.slice(close + CLOSE.length);
        state = 'after';
      }
      // The blank lines between </think> and the reply are not part of the reply, and they
      // can arrive in a later chunk than the </think> itself.
      const rest = pending.replace(/^\s+/, '');
      pending = '';
      if (!rest) return '';
      state = 'pass';
      return rest;
    },
    /** Whatever was held back as a possible `<think>` that never became one. */
    end() {
      const out = state === 'start' ? pending : '';
      pending = '';
      return out;
    },
    get thought() { return thought; },
  };
}

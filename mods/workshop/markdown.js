/**
 * Just enough markdown for a review conversation (#670).
 *
 * Agents write markdown. A chat pane that renders it as one flat run of characters throws
 * away the structure the agent used to make the answer readable — the fenced diff, the
 * numbered list of what changed, the link to the file. So this tokenizes.
 *
 * ── Why a tokenizer and not a library ──
 *
 * The output is an AST of plain objects, which workshop.jsx maps to React ELEMENTS. There
 * is no HTML string anywhere in this file and no dangerouslySetInnerHTML at the other end,
 * which means agent-authored text cannot become markup no matter what it contains — the
 * whole class of injection is absent by construction rather than filtered out by a
 * sanitizer that has to be kept current. It also means this runs in the bare `unit` CI job
 * with no React and no browser, which a renderer that returned elements could not.
 *
 * The cost is that this is NOT CommonMark and must not pretend to be: no tables, no
 * reference links, no HTML passthrough, no nested lists, no setext headings. #670 named
 * the requirement — code blocks, images and links — and the rest is what fell out cheaply.
 * When something here renders a construct wrong, the fix is to render it as literal text,
 * never to add an HTML escape hatch.
 *
 * PURE, like inbox-view.js. No DOM, no React, no fs.
 */

// A URL we are willing to put in an href or a src. Deliberately a tiny allowlist rather
// than a blocklist of `javascript:` and friends: an agent quoting a link from a page it
// read is untrusted input, and enumerating the bad schemes is how you miss `vbscript:`,
// a leading tab inside the scheme, or the next one nobody has thought of. Anything that
// does not match renders as plain text and still SHOWS the user the URL — refusing to
// link is not the same as hiding.
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/)/i;
// Raster only, deliberately. An SVG carries <script>, so `data:image/svg+xml` is a code
// URL wearing an image's name and never belongs in a src we build from agent text.
const SAFE_IMG = /^(?:https?:\/\/|data:image\/(?:png|jpe?g|gif|webp);base64,|\/)/i;

const FENCE_RE = /^(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;

/** Is this a URL we will hand to an anchor / an img? */
export function safeUrl(raw, kind) {
  const url = String(raw == null ? '' : raw).trim();
  if (!url) return null;
  // A control character or a space inside a URL is how a scheme check gets walked
  // around (`java\tscript:`), so the whole candidate is rejected rather than trimmed.
  if (/[\u0000-\u0020]/.test(url)) return null;
  return (kind === 'image' ? SAFE_IMG : SAFE_HREF).test(url) ? url : null;
}

/**
 * Inline spans within one run of text.
 *
 * Order matters and is not arbitrary: code first, because a backtick span must be able to
 * contain a literal `**` or a bare URL without either being interpreted. Everything after
 * it only sees text that was not inside code.
 */
export function spans(text) {
  const out = [];
  let rest = String(text == null ? '' : text);

  // One pass, one regex, alternatives tried left to right. `\[` before the bare-URL
  // alternative so the label of a markdown link is never eaten as a URL first.
  const INLINE = new RegExp([
    '(`+)([\\s\\S]*?)\\1',                          // 1,2  code
    '!\\[([^\\]]*)\\]\\(([^()\\s]+)\\)',            // 3,4  image
    '\\[([^\\]]+)\\]\\(([^()\\s]+)\\)',             // 5,6  link
    '\\*\\*([^*]+)\\*\\*',                          // 7    strong
    '(?:\\*([^*\\n]+)\\*|_([^_\\n]+)_)',            // 8,9  em
    '(https?://[^\\s<>()\\[\\]]+)',                 // 10   bare url
  ].join('|'), 'g');

  let last = 0;
  let m;
  while ((m = INLINE.exec(rest)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: rest.slice(last, m.index) });
    last = m.index + m[0].length;

    if (m[1] !== undefined) {
      out.push({ type: 'code', text: m[2] });
    } else if (m[3] !== undefined) {
      const src = safeUrl(m[4], 'image');
      // An image we will not load still has an alt worth reading; degrade to it rather
      // than dropping the author's words along with the URL.
      out.push(src ? { type: 'image', src, alt: m[3] } : { type: 'text', text: `${m[3] || m[4]}` });
    } else if (m[5] !== undefined) {
      const href = safeUrl(m[6], 'link');
      out.push(href
        ? { type: 'link', href, children: spans(m[5]) }
        : { type: 'text', text: `${m[5]} (${m[6]})` });
    } else if (m[7] !== undefined) {
      out.push({ type: 'strong', children: spans(m[7]) });
    } else if (m[8] !== undefined || m[9] !== undefined) {
      out.push({ type: 'em', children: spans(m[8] !== undefined ? m[8] : m[9]) });
    } else if (m[10] !== undefined) {
      const href = safeUrl(m[10], 'link');
      out.push(href ? { type: 'link', href, children: [{ type: 'text', text: m[10] }] }
        : { type: 'text', text: m[10] });
    }
  }
  if (last < rest.length) out.push({ type: 'text', text: rest.slice(last) });
  return out.length ? out : [{ type: 'text', text: '' }];
}

/**
 * Block structure. Returns a flat array of block tokens.
 *
 * The fence is handled before everything else and swallows lines verbatim, which is the
 * one rule that has to hold absolutely: inside ``` an agent may write anything at all,
 * including text that looks like a heading or a list, and none of it is markup.
 */
export function tokenize(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];      // buffered plain lines, flushed as one paragraph
  let i = 0;

  const flush = () => {
    if (!para.length) return;
    blocks.push({ type: 'para', spans: spans(para.join('\n')) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);

    if (fence) {
      flush();
      const lang = fence[1] || '';
      const body = [];
      i++;
      // An UNCLOSED fence runs to the end of input rather than being abandoned. A reply
      // that is still being written — or one that simply forgot the closing ``` — must
      // show its code as code, not silently reinterpret the whole rest of the message.
      while (i < lines.length && !FENCE_RE.test(lines[i])) { body.push(lines[i]); i++; }
      i++;   // the closing fence, or one past the end
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (!line.trim()) { flush(); i++; continue; }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1].length, spans: spans(heading[2]) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) { flush(); blocks.push({ type: 'hr' }); i++; continue; }

    if (QUOTE_RE.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) { body.push(QUOTE_RE.exec(lines[i])[1]); i++; }
      blocks.push({ type: 'quote', spans: spans(body.join('\n')) });
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      flush();
      const ordered = OL_RE.test(line);
      const items = [];
      // A run only continues while the marker KIND matches, so a numbered list directly
      // under a bulleted one is two lists rather than one confused one.
      while (i < lines.length) {
        const re = ordered ? OL_RE : UL_RE;
        const item = re.exec(lines[i]);
        if (!item) break;
        items.push(spans(item[1]));
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    para.push(line);
    i++;
  }

  flush();
  return blocks;
}

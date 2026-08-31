/**
 * Claude Code transcript -> renderable entries (#672).
 *
 * An agent tab has no scrollback: Claude Code repaints inside its own alternate
 * screen, so tmux history and xterm scrollback are both 0 rows and there is no
 * buffer for a scrollbar to attach to (docs/terminal-engines.md). The transcript
 * on disk is the only record outside the process, and this module is what turns
 * it into something a pane can draw.
 *
 * PURE. No `fs`, no server globals, no clock, no randomness. The bytes-to-lines
 * half lives in ./transcript-window, the path derivation and the HTTP envelope in
 * server.js. That seam is the same one fork-resolve.js has, and for the same
 * reason: the interesting decisions become testable without a daemon, a PTY or a
 * temp directory. A unit test greps this file for `require('fs')`; keep it absent.
 *
 * THE DROP SET IS UNCONDITIONAL, AND MUST STAY THAT WAY. The endpoint's cursor is
 * a byte offset, which is only meaningful if the same (before, window) always
 * yields the same entries. A `?hideMeta=1` parameter would make pages
 * irreproducible: a cursor minted under one filter would land somewhere else
 * under another, and `limit` would stop predicting scroll distance. Filtering is
 * the client's job, which is why records a UI might want to hide are FLAGGED
 * (`meta: true`) rather than dropped. Only records no UI could ever render are
 * dropped here.
 *
 * Shapes below were surveyed across the real transcripts on this machine (2,248
 * files, 3.2 GB), not inferred from documentation.
 */

// Records that are bookkeeping, not conversation. 5,208 of 11,910 records in a
// 40-file sample -- `attachment` alone (mostly total_tokens_reminder) was 1,832.
// A type absent from this set and from the user/assistant/system cases below is
// ignored too; the list exists so `stats.dropped` can distinguish "known noise"
// from "a record type that appeared after this was written".
const DROP_TYPES = new Set([
  'attachment', 'mode', 'permission-mode', 'worktree-state', 'last-prompt',
  'ai-title', 'agent-name', 'atis-latch', 'file-history-snapshot',
  'file-history-delta', 'cost-state', 'bridge-session', 'frame-link', 'pr-link',
  'relocated', 'queue-operation',
]);

// Text-bearing `type:"user"` records that are not something a human typed:
// slash-command plumbing, bash-tool echoes, interrupt markers, harness notices.
//
// DELIBERATELY A COPY of MACHINERY_RE in prompt-delivery-check.js:53, not an
// import. That one answers "is this the prompt we delivered?" and drives a
// truncation verdict; this one answers "should a reader see this by default?".
// They will diverge, and sharing them would let a change to the history pane
// silently alter #656's delivery checks. Keep them in sync by hand or not at all.
const META_RE = /^\s*(?:<(?:command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|user-prompt-submit-hook)>|\[Request interrupted)/;

// What survives to the wire. Conversation text is what the reader came for, so it
// is generous; a tool's input can be a whole file and its output a whole build
// log, so those are not. Every truncation reports `fullBytes`, so the pane can
// say "+124 KB" instead of ending mid-sentence with no explanation.
const TEXT_LIMIT = 16384;
const TOOL_INPUT_LIMIT = 4096;
const TOOL_RESULT_LIMIT = 4096;

/** UTF-8 byte length. */
function byteLen(s) {
  return typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0;
}

/**
 * Cut a string to `limit` CHARACTERS, reporting its full size in BYTES.
 * Characters for the cut because that is what bounds the rendered line; bytes for
 * the report because that is what the reader is being told they cannot see.
 */
function clip(text, limit) {
  const s = text == null ? '' : String(text);
  if (s.length <= limit) return { value: s, truncated: false, fullBytes: byteLen(s) };
  return { value: s.slice(0, limit), truncated: true, fullBytes: byteLen(s) };
}

/**
 * A tool_result's `content` is a string most of the time, an array of blocks
 * sometimes, and occasionally something else entirely. Returns the text and any
 * images found, NEVER the image bytes.
 */
function readToolResultContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) {
    return { text: content == null ? '' : JSON.stringify(content), images: [] };
  }
  const parts = [];
  const images = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') parts.push(b.text == null ? '' : String(b.text));
    else if (b.type === 'image') images.push(imageOf(b));
    else parts.push(JSON.stringify(b));
  }
  return { text: parts.join(''), images };
}

/**
 * An image block -> its description only.
 *
 * THIS IS THE RULE THAT KEEPS A PAGE RESPONSE SMALL. The longest single line
 * measured on this machine is 1,365,762 bytes, and it is a tool_result holding a
 * base64 screenshot; one file had eight of them. Shipping the payload would put
 * megabytes of base64 into a scroll response that the pane cannot display anyway
 * (it draws text). A unit test asserts the base64 appears nowhere in the output.
 */
function imageOf(block) {
  const src = (block && block.source) || {};
  const data = typeof src.data === 'string' ? src.data : '';
  return {
    mediaType: src.media_type || src.mediaType || 'image',
    // Base64 carries 3 bytes per 4 characters; close enough to report a size.
    fullBytes: Math.floor((data.length * 3) / 4),
  };
}

/** The reason a record should be hidden by default, or null if it is real conversation. */
function metaReasonOf(record, text) {
  if (record.isMeta) return 'isMeta';
  if (record.isSidechain) return 'sidechain';
  // Only user records carry machinery text; an assistant never writes these tags.
  if (record.type === 'user' && text && META_RE.test(text)) return 'machinery';
  return null;
}

/**
 * One transcript record -> zero or more entries.
 *
 * Zero or more, not one, because a tool_result carrying both text and an image
 * becomes two entries, and because a record we drop becomes none. In current
 * Claude Code a user/assistant record carries exactly ONE content block (3,920 of
 * 3,920 assistant records sampled), so the common case is exactly one entry --
 * but `seq` is recorded anyway, because absorbing a format that goes back to
 * multi-block records is cheaper than retrofitting an index later.
 *
 * @param {object} record  a parsed transcript line
 * @param {{offset:number, bytes:number}} loc  where the line sits in the file
 * @returns {object[]}
 */
function normalizeRecord(record, loc) {
  if (!record || typeof record !== 'object') return [];
  const { offset = 0, bytes = 0 } = loc || {};
  const type = record.type;

  if (DROP_TYPES.has(type)) return [];

  // `system` records are turn timings, away summaries and local-command notices.
  // Gate on the TYPE, not on isMeta: the turn_duration records sampled here carry
  // isMeta:false, so an isMeta gate would let them through as conversation.
  if (type === 'system') {
    const { value, truncated, fullBytes } = clip(record.content, TEXT_LIMIT);
    return [{
      offset, bytes, seq: 0,
      uuid: record.uuid || null,
      parentUuid: record.parentUuid || null,
      ts: record.timestamp || null,
      role: 'system',
      kind: 'system',
      groupId: null,
      model: null,
      meta: true,
      metaReason: 'system',
      subtype: record.subtype || null,
      text: value,
      truncated,
      fullBytes,
    }];
  }

  if (type !== 'user' && type !== 'assistant') return [];

  const msg = record.message;
  if (!msg || typeof msg !== 'object') return [];

  const content = msg.content;
  const blocks = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content) ? content : [];

  const base = {
    offset, bytes,
    uuid: record.uuid || null,
    parentUuid: record.parentUuid || null,
    ts: record.timestamp || null,
    role: msg.role || type,
    // message.id is what stitches one assistant TURN back together: its thinking,
    // its prose and its tool calls arrive as separate records sharing this id.
    groupId: msg.id || null,
    model: msg.model || null,
  };

  const out = [];
  let seq = 0;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const at = { ...base, seq: seq++ };

    if (b.type === 'text') {
      const { value, truncated, fullBytes } = clip(b.text, TEXT_LIMIT);
      const reason = metaReasonOf(record, value);
      out.push({ ...at, kind: 'text', meta: !!reason, metaReason: reason, text: value, truncated, fullBytes });
    } else if (b.type === 'thinking') {
      const { value, truncated, fullBytes } = clip(b.thinking, TEXT_LIMIT);
      const reason = metaReasonOf(record, null);
      out.push({ ...at, kind: 'thinking', meta: !!reason, metaReason: reason, text: value, truncated, fullBytes });
    } else if (b.type === 'tool_use') {
      const raw = typeof b.input === 'string' ? b.input : JSON.stringify(b.input == null ? {} : b.input);
      const { value, truncated, fullBytes } = clip(raw, TOOL_INPUT_LIMIT);
      const reason = metaReasonOf(record, null);
      out.push({
        ...at, kind: 'tool_use', meta: !!reason, metaReason: reason,
        name: b.name || 'tool', toolUseId: b.id || null,
        input: value, truncated, fullBytes,
      });
    } else if (b.type === 'tool_result') {
      const { text, images } = readToolResultContent(b.content);
      const { value, truncated, fullBytes } = clip(text, TOOL_RESULT_LIMIT);
      const reason = metaReasonOf(record, null);
      out.push({
        ...at, kind: 'tool_result', meta: !!reason, metaReason: reason,
        toolUseId: b.tool_use_id || null, isError: !!b.is_error,
        output: value, truncated, fullBytes,
      });
      for (const img of images) {
        out.push({
          ...at, seq: seq++, kind: 'image', meta: !!reason, metaReason: reason,
          toolUseId: b.tool_use_id || null,
          mediaType: img.mediaType, truncated: true, fullBytes: img.fullBytes,
        });
      }
    } else if (b.type === 'image') {
      const img = imageOf(b);
      const reason = metaReasonOf(record, null);
      out.push({
        ...at, kind: 'image', meta: !!reason, metaReason: reason,
        mediaType: img.mediaType, truncated: true, fullBytes: img.fullBytes,
      });
    } else {
      // A block type that did not exist when this was written. Render it as
      // something rather than vanishing -- a silent drop is how a history view
      // starts quietly lying about what happened.
      const { value, truncated, fullBytes } = clip(JSON.stringify(b), TOOL_RESULT_LIMIT);
      const reason = metaReasonOf(record, null);
      out.push({
        ...at, kind: 'unknown', meta: !!reason, metaReason: reason,
        name: String(b.type || 'block'), text: value, truncated, fullBytes,
      });
    }
  }
  return out;
}

/**
 * Line records -> entries, oldest-first, plus what happened to the rest.
 *
 * `lines` comes from transcript-window.js: `{ offset, bytes, text, oversize }`,
 * in file order. A line with `text: null` is one the window could not bound (a
 * single record larger than the read cap) and becomes an `oversize` placeholder
 * rather than being skipped -- a gap the reader cannot see is worse than a gap
 * labelled as one.
 *
 * @param {{lines: object[]}} input
 * @returns {{entries: object[], stats: object}}
 */
function normalizeLines({ lines } = {}) {
  const entries = [];
  const stats = { lines: 0, entries: 0, dropped: 0, unparsed: 0, oversize: 0, truncatedEntries: 0 };
  for (const line of lines || []) {
    stats.lines++;
    if (line.oversize || line.text == null) {
      stats.oversize++;
      entries.push({
        offset: line.offset, bytes: line.bytes, seq: 0,
        uuid: null, parentUuid: null, ts: null,
        role: 'system', kind: 'oversize', groupId: null, model: null,
        meta: false, metaReason: null,
        truncated: true, fullBytes: line.bytes,
      });
      continue;
    }
    if (!line.text.trim()) continue;
    let obj;
    // A window boundary can cut a line mid-JSON, and a transcript being appended
    // to can end mid-record. Both parse-fail, both are normal, neither is an error.
    try { obj = JSON.parse(line.text); } catch { stats.unparsed++; continue; }
    const produced = normalizeRecord(obj, line);
    if (!produced.length) { stats.dropped++; continue; }
    for (const e of produced) {
      entries.push(e);
      if (e.truncated) stats.truncatedEntries++;
    }
  }
  stats.entries = entries.length;
  return { entries, stats };
}

module.exports = {
  normalizeLines, normalizeRecord,
  DROP_TYPES, META_RE,
  TEXT_LIMIT, TOOL_INPUT_LIMIT, TOOL_RESULT_LIMIT,
};

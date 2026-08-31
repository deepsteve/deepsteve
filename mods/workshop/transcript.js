/**
 * A Claude Code transcript, read as a conversation (#670).
 *
 * The Workshop chat pane needs the two halves of a dialogue — what the human asked and
 * what the agent answered — out of a file that is mostly neither. A transcript is an
 * append-only JSONL of everything the harness did: tool calls, tool results, thinking
 * blocks, mode switches, title updates, file-history snapshots, subagent traffic. Of a
 * typical session's lines the ones a person would recognise as "the conversation" are a
 * small minority, and showing the rest is not a richer view, it is an unreadable one.
 *
 * PURE, like inbox-view.js: no fs, no ctx, no clock. The caller reads the bytes and hands
 * them over, which is what lets every rule below be tested from node:test with a string
 * literal and no daemon. The one impure decision — which file, and how much of its tail —
 * belongs to the route, because only the route can re-derive a path that moves (a fork
 * rotates the transcript id under us; see server.js's transcriptPath).
 */

// The two filters are IMPORTED, not restated. prompt-delivery-check.js surveyed the real
// transcripts on a real machine to decide what counts as machinery rather than text (149
// of 274 text-bearing user records were plumbing), and a second opinion here would drift
// until the pane started rendering slash-command internals as chat.
const { messageText, MACHINERY_RE } = require('../../prompt-delivery-check');

// The pane is a review surface, not an archive: the tail is what a conversation is about.
// Anything older is still in the tab, which is what the `truncated` flag says.
const MAX_MESSAGES = 200;

/**
 * One transcript record -> one chat message, or null.
 *
 * Returning null is the common case and the important one. A turn that only called tools
 * says nothing to a reader, so it produces no bubble at all rather than an empty one —
 * otherwise a session that ran forty greps renders as forty blank rows.
 */
function toMessage(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // A sidechain is a subagent's conversation with itself, threaded into the same file.
  // It is real text from a real model, which is exactly why it has to go: it is not the
  // agent you are talking to, and it arrives in bursts that would bury the reply you are
  // waiting for. isMeta marks what the harness injected rather than what anyone said.
  if (obj.isSidechain || obj.isMeta) return null;

  const role = obj.type === 'assistant' ? 'agent' : obj.type === 'user' ? 'human' : null;
  if (!role) return null;   // mode, ai-title, attachment, file-history-*, worktree-state, …

  // messageText keeps `text` blocks and lets tool_result fall out on its own; thinking and
  // tool_use are not text blocks, so they never arrive here.
  const body = messageText(obj.message);
  if (!body) return null;
  const text = body.trim();
  if (!text) return null;
  if (MACHINERY_RE.test(text)) return null;

  return {
    uuid: typeof obj.uuid === 'string' ? obj.uuid : null,
    role,
    text,
    at: Date.parse(obj.timestamp) || null,
  };
}

/**
 * Turn a slice of transcript JSONL into an ordered conversation.
 *
 * `text` may begin mid-line — the caller reads a fixed-size TAIL, so the first line is
 * usually severed — and may end mid-line too, because a live session is appending to this
 * file while we read it. Both are handled by the same rule: a line that will not parse is
 * not an error, it is a line that is not ours.
 *
 * Returns { messages: [{ uuid, role, text, at }], truncated }.
 */
function parseTranscript(text, { max = MAX_MESSAGES } = {}) {
  const messages = [];
  let dropped = 0;

  for (const line of String(text == null ? '' : text).split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = toMessage(obj);
    if (!msg) continue;
    messages.push(msg);
    // Trim as we go rather than at the end: a 256KB tail of a busy session is thousands
    // of records, and holding them all to throw most away is the cost this avoids.
    if (messages.length > max) { messages.shift(); dropped++; }
  }

  return { messages, truncated: dropped > 0 };
}

module.exports = { parseTranscript, MAX_MESSAGES };

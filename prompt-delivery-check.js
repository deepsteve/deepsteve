/**
 * Did the agent actually receive the prompt we delivered? (#656)
 *
 * Every layer of the #607 submission machinery reads the *screen* — the composer
 * box, the transcript tail, the spinner. That is the only signal available while a
 * prompt is being typed, and it is a proxy: `isPromptStaged` and `isPromptOnScreen`
 * compare the first COMPOSER_MATCH_CHARS of the draft against the first chars of
 * what we wrote, so a delivery that lost its HEAD reads as "not staged" (and is
 * never retried) and a submitted *fragment* whose head did land reads as
 * "submitted". A truncated delivery is therefore indistinguishable from a clean one
 * at every screen-side layer, and is logged as a success.
 *
 * There is an exact oracle, and it is already on disk: Claude Code records the
 * message it accepted in its session transcript. Comparing that record against the
 * string we handed the engine is not a heuristic — it is the same correlation you
 * would do by hand after the fact, done by the daemon, once per delivery.
 *
 * This module is deliberately pure I/O plus comparison, with no server dependencies,
 * so it is unit-testable without a daemon. The caller owns the polling, the gating
 * and the logging; see `checkDeliveredPrompt` in server.js.
 *
 * Two facts from the observed failures shape `compareDelivered`:
 *   - the loss was contiguous and at the HEAD, so a prefix test alone cannot see it;
 *   - the surviving fragment ran to the very end of the prompt, so a suffix test
 *     alone cannot see it either.
 * Both ends are checked, and the lengths are reported.
 */

const fs = require('fs');

// How much of the transcript tail to read. The record we want is the last user
// message, written the moment Claude accepts it, so the tail is where it is. Sized
// generously because a single record can itself be large (a pasted file, an image
// placeholder), and a 100MB transcript must cost the same as a small one.
const TAIL_READ_BYTES = 256 * 1024;

// How many characters of each end must agree. Matches COMPOSER_MATCH_CHARS in
// composer-state.js — long enough to be unique in practice, short enough that it
// cannot be split by a hard wrap.
const EDGE_MATCH_CHARS = 40;

// How many candidate records to walk back through before giving up. Claude appends
// tool_result records fast, and those carry no text at all, so this only has to
// outrun the handful of text-bearing machinery records below.
const MAX_CANDIDATES = 40;

// Transcript records that are `type:"user"` and carry text, but are not anything we
// delivered: slash-command plumbing, bash-tool echoes, interrupt markers, and the
// harness's own task notifications. Surveyed across the real transcripts on this
// machine — 149 of 274 text-bearing user records were one of these. Treating one as
// "what the agent received" would report a false truncation on every session that
// had ever run a slash command.
const MACHINERY_RE = /^\s*(?:<(?:command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|user-prompt-submit-hook)>|\[Request interrupted)/;

// Whitespace is not preserved end to end: a TUI composer re-wraps and Claude Code
// may normalise. Compare on the same collapsed form composer-state.js uses.
function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function messageText(msg) {
  if (!msg) return null;
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // tool_result blocks are also `type:"user"` records; they carry no text block,
    // so they fall out here rather than needing their own rule.
    const t = c.filter(b => b && b.type === 'text').map(b => b.text).join('');
    return t || null;
  }
  return null;
}

/**
 * The most recent real user messages in a Claude Code transcript, newest first.
 *
 * "Real" excludes `isMeta` (system reminders, skill bodies, hook output),
 * `isSidechain` (subagent turns) and the machinery records above — none of them is
 * something we delivered. Returns [] for a missing, empty or unreadable file, which
 * is the normal case for a session that has not accepted a message yet.
 *
 * @param {string} file  Absolute path to <claudeSessionId>.jsonl
 * @returns {string[]}
 */
function readRecentUserMessages(file, limit = MAX_CANDIDATES) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.size) return [];
    const len = Math.min(stat.size, TAIL_READ_BYTES);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, stat.size - len);
    const lines = buf.toString('utf8').split('\n');
    const out = [];
    // Walk backwards: the first line may be cut mid-JSON by the read window, and
    // the record we want is the most recent one anyway.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'user' || obj.isMeta || obj.isSidechain) continue;
      const text = messageText(obj.message);
      if (!text || MACHINERY_RE.test(text)) continue;
      out.push(text);
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/** Back-compat convenience: the newest real user message, or null. */
function readLastUserMessage(file) {
  const all = readRecentUserMessages(file, 1);
  return all.length ? all[0] : null;
}

/**
 * Compare what we wrote against what the agent recorded.
 *
 * `candidates` is newest-first. A record only counts as *ours* if at least one end
 * still matches — otherwise it is some other message and we know nothing, which is
 * reported as `known: false`. That distinction is the whole point: reporting a
 * truncation against a stale record would be worse than reporting nothing, and the
 * #607 lesson is that silence must never be read as failure.
 *
 * @param {string} expected              The text handed to the engine.
 * @param {string|string[]|null} candidates  Transcript records, newest first.
 * @returns {{ok: boolean, known: boolean, expected: number, got: number,
 *            missingHead: boolean, missingTail: boolean}}
 */
function compareDelivered(expected, candidates) {
  const want = norm(expected);
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  const unknown = { ok: false, known: false, expected: want.length, got: 0, missingHead: false, missingTail: false };
  if (!want.length) return { ...unknown, known: true, ok: true };

  const k = Math.min(EDGE_MATCH_CHARS, want.length);
  const wantHead = want.slice(0, k);
  const wantTail = want.slice(-k);

  for (const raw of list) {
    const got = norm(raw);
    if (!got.length) continue;
    const headOk = got.slice(0, k) === wantHead;
    const tailOk = got.slice(-k) === wantTail;
    if (!headOk && !tailOk) continue;            // not our message at all
    // Claude Code collapses a large paste in its own display but records the full
    // text, so an exact length match is the normal outcome. Anything shorter with
    // one end intact is the #656 signature.
    return {
      ok: headOk && tailOk && got.length >= want.length,
      known: true,
      expected: want.length,
      got: got.length,
      missingHead: !headOk,
      missingTail: !tailOk,
    };
  }
  return unknown;
}

module.exports = {
  readRecentUserMessages, readLastUserMessage, compareDelivered,
  TAIL_READ_BYTES, EDGE_MATCH_CHARS, MAX_CANDIDATES,
};

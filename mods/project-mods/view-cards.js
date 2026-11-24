/**
 * Superviews — the server half: the first prompt each card shows.
 *
 * A view can carry `cards: true` (see the "Project views" section of tools.js): while it is the
 * selected view, a superview sits at the head of the tab strip and opens a grid of cards, one per
 * agent tab in the view, each showing what that tab was first asked. public/js/view-cards.js draws
 * them; this file answers "what was session X first asked".
 *
 * The answer is the first prompt in the session's Claude Code transcript, found with the same
 * reader and the same meta rules as the History pane (transcript-window.js, transcript-view.js),
 * so a slash command, an inherited `/rc`, a hook's output or a compaction summary is never taken
 * for the prompt. It lands near the head of the file, so only the first few windows are read.
 *
 * The same pass picks up the conversation's title: the `ai-title` record Claude Code writes into
 * its own transcript during the first reply, a few words naming what the conversation is for
 * (the header row's Summary). Claude Code appends it again now and then, but in 300 transcripts
 * measured on the development machine it never changed, so the first one is the one. It usually
 * sits a few hundred KB in, after the first turn's request records; 299 of those 300 had it in
 * the first 2 MB, and one had it 13 MB in.
 *
 * Neither ever changes once written, so a found one is cached for good (keyed by file — a /clear
 * starts a new transcript, which is a new conversation with its own first prompt and title).
 * Until both are found the cache keeps the read cursor too, and the next ask reads on from it:
 * Claude Code only appends, so nothing before the cursor can change. A session that never gets a
 * title costs one stat per ask once the cursor reaches the end.
 */

const { readForwardWindow } = require('../../transcript-window');
const { normalizeLines } = require('../../transcript-view');

// Enough for any card: the browser clamps the text to a few lines on top.
const PROMPT_CHARS = 1200;
// Claude Code's titles run to about eight words; this only guards against a malformed record.
const TITLE_CHARS = 200;
// The most one ask reads, 4 × 512 KB; the next ask reads on from where it stopped.
const MAX_WINDOWS = 4;
const CACHE_MAX = 500;

/** The first prompt among normalized transcript entries — real user text, not machinery — or null. */
function firstPrompt(entries) {
  for (const e of entries || []) {
    if (e.role !== 'user' || e.kind !== 'text' || e.meta) continue;
    const text = String(e.text || '').trim();
    if (text) return text.length > PROMPT_CHARS ? text.slice(0, PROMPT_CHARS - 1).trimEnd() + '…' : text;
  }
  return null;
}

/**
 * The first `ai-title` among raw transcript lines, or null. transcript-view.js drops these records
 * as bookkeeping, so they are read off the lines themselves, and only a line that names the type
 * is parsed.
 */
function aiTitle(lines) {
  for (const l of lines || []) {
    if (!l || typeof l.text !== 'string' || !l.text.includes('"ai-title"')) continue;
    let obj;
    try { obj = JSON.parse(l.text); } catch { continue; }
    const t = obj && obj.type === 'ai-title' && typeof obj.aiTitle === 'string' ? obj.aiTitle.replace(/\s+/g, ' ').trim() : '';
    if (t) return t.length > TITLE_CHARS ? t.slice(0, TITLE_CHARS - 1).trimEnd() + '…' : t;
  }
  return null;
}

/**
 * The card lookups, made once per daemon. `transcriptPath` and `getAgentConfig` are server.js's,
 * from the mod context; `readWindow` is the transcript reader, swappable in a test.
 */
function createPromptSource({ transcriptPath, getAgentConfig, readWindow = readForwardWindow, log = () => {} } = {}) {
  // transcript file → { prompt, title, after }: what was found, and where the next read starts.
  const cache = new Map();

  function remember(file, got) {
    if (!cache.has(file) && cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(file, got);
  }

  /** Read on from `got.after` for whichever of the prompt and the title is still missing. */
  async function readOn(file, got) {
    let after = got.after;
    for (let i = 0; i < MAX_WINDOWS && !(got.prompt && got.title); i++) {
      const page = await readWindow(file, { after });
      if (!got.prompt) got.prompt = firstPrompt(normalizeLines({ lines: page.lines }).entries);
      if (!got.title) got.title = aiTitle(page.lines);
      if (page.nextAfter <= after) break;
      after = page.nextAfter;
      if (after >= page.size) break;
    }
    got.after = after;
    return got;
  }

  /**
   * `{ prompt, title, supported }` for one shell entry. `supported: false` is an agent that keeps
   * no transcript we can read (anything but Claude today), so its card says so instead of waiting.
   */
  async function promptFor(entry) {
    const agentType = (entry && entry.agentType) || 'claude';
    const config = typeof getAgentConfig === 'function' ? getAgentConfig(agentType) : null;
    if (!config || !config.supportsSessionWatch) return { prompt: null, title: null, supported: false };
    const file = typeof transcriptPath === 'function' ? transcriptPath(entry) : null;
    if (!file) return { prompt: null, title: null, supported: true };
    const known = cache.get(file);
    const got = known ? { ...known } : { prompt: null, title: null, after: 0 };
    if (!(got.prompt && got.title)) {
      try {
        await readOn(file, got);
      } catch (e) {
        // Shorter than the cursor: not the file we were reading. Keep what was found and start
        // the rest over next time.
        if (e && e.code === 'REWOUND') got.after = 0;
        // ENOENT is the common case, a session not prompted yet; anything else is worth a line.
        else if (e && e.code !== 'ENOENT') log(`[view-cards] reading ${file} failed: ${e.message}`);
      }
      remember(file, got);
    }
    return { prompt: got.prompt, title: got.title, supported: true };
  }

  return { promptFor };
}

/**
 * A tab's one-liner from its facts — `{ customLabel, title, prompt }` — or null when it has none:
 * the Custom Label, else Claude Code's title, else the first prompt on one line. The server twin
 * of oneLiner() in public/js/one-liners.js, which the header row, the task board and overview
 * tiles draw with; this one is what an agent reads (get_session_info, list_sessions), so the two
 * must say the same words. test/unit/view-cards.test.js pins them together.
 *
 * `max` cuts a long one (a first prompt runs to PROMPT_CHARS) for a roster of many rows.
 */
function summaryOf(f, max = Infinity) {
  if (!f) return null;
  const text = f.customLabel || f.title || (f.prompt ? String(f.prompt).replace(/\s+/g, ' ').trim() : '');
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

module.exports = { createPromptSource, firstPrompt, aiTitle, summaryOf, PROMPT_CHARS, TITLE_CHARS };

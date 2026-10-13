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
 * A first prompt never changes once written, so a found one is cached for good (keyed by file —
 * a /clear starts a new transcript, which is a new conversation with its own first prompt). A
 * session with no prompt yet is read again next time it is asked about.
 */

const { readForwardWindow } = require('../../transcript-window');
const { normalizeLines } = require('../../transcript-view');

// Enough for any card: the browser clamps the text to a few lines on top.
const PROMPT_CHARS = 1200;
// A head of 4 × 512 KB with no prompt in it is a session nobody has asked anything yet.
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
 * The card lookups, made once per daemon. `transcriptPath` and `getAgentConfig` are server.js's,
 * from the mod context; `readWindow` is the transcript reader, swappable in a test.
 */
function createPromptSource({ transcriptPath, getAgentConfig, readWindow = readForwardWindow, log = () => {} } = {}) {
  const cache = new Map();   // transcript file → its first prompt (only found ones)

  async function readFirstPrompt(file) {
    let after = 0;
    for (let i = 0; i < MAX_WINDOWS; i++) {
      const page = await readWindow(file, { after });
      const hit = firstPrompt(normalizeLines({ lines: page.lines }).entries);
      if (hit) return hit;
      if (page.nextAfter <= after || page.nextAfter >= page.size) return null;
      after = page.nextAfter;
    }
    return null;
  }

  /**
   * `{ prompt, supported }` for one shell entry. `supported: false` is an agent that keeps no
   * transcript we can read (anything but Claude today), so its card says so instead of waiting.
   */
  async function promptFor(entry) {
    const agentType = (entry && entry.agentType) || 'claude';
    const config = typeof getAgentConfig === 'function' ? getAgentConfig(agentType) : null;
    if (!config || !config.supportsSessionWatch) return { prompt: null, supported: false };
    const file = typeof transcriptPath === 'function' ? transcriptPath(entry) : null;
    if (!file) return { prompt: null, supported: true };
    if (cache.has(file)) return { prompt: cache.get(file), supported: true };
    let prompt = null;
    try {
      prompt = await readFirstPrompt(file);
    } catch (e) {
      // ENOENT is the common case, a session not prompted yet; anything else is worth a line.
      if (e && e.code !== 'ENOENT') log(`[view-cards] reading ${file} failed: ${e.message}`);
    }
    if (prompt) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(file, prompt);
    }
    return { prompt, supported: true };
  }

  return { promptFor };
}

module.exports = { createPromptSource, firstPrompt, PROMPT_CHARS };

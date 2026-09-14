/**
 * History — scroll an agent tab's Claude Code transcript (#672).
 *
 * An agent tab cannot have a scrollbar. Claude Code repaints inside its own
 * alternate screen, so tmux history and xterm scrollback are both 0 rows and no
 * transcript line ever leaves the process (docs/terminal-engines.md). This pane
 * reads the file the agent writes instead, which is the only record that exists
 * outside it — a different feature from a terminal scrollbar, and deliberately a
 * different shape.
 *
 * IT BELONGS TO A TAB, NOT TO THE WINDOW. The pane mounts inside that session's
 * `.terminal-container` (the ⌘F search-bar precedent) rather than over the whole
 * app, so switching tabs hides it with its container and coming back finds it
 * exactly as you left it — which is most of what "return to where you were"
 * means. The rest is the anchor below. Unlike the search bar, switchTo() does NOT
 * close it; see focusIfOpen(), which is what stops the terminal behind it from
 * stealing focus.
 *
 * THE VIEW IS A WINDOW ONTO THE FILE, EXTENSIBLE AT BOTH ENDS. `entries` is one
 * contiguous byte range: `?before=` extends it backwards, `?after=` forwards, and
 * "Beginning" / "Latest" jump to an end by reloading rather than by walking there
 * (the largest transcript on the development machine is 139 MB, so walking is not
 * a jump). Rendering is a full rebuild of that range, which is what lets a
 * tool_use find the tool_result it pairs with even when a page boundary fell
 * between them — the two are separate records, joined only by tool_use_id.
 *
 * IT READS AS PROMPT → ANSWER (#704). Each exchange is what you typed, then the
 * agent's final answers in full, with the work between them folded to one line.
 * The same full rebuild is what keeps an answer attached to a prompt that sits on
 * an older page.
 */

import { nsKey } from './storage-namespace.js';
import { register } from './shortcuts.js';

// Where the reader was, per session, keyed by MESSAGE UUID rather than by a pixel
// offset: a transcript grows and a window resizes, and both move a pixel. Session
// storage because a reading position is a place, not a preference -- it survives
// a reload and dies with the window (docs/frontend.md).
const POS_KEY = nsKey('deepsteve-history-pos');

// How many extra pages to walk back hunting for a remembered anchor before giving
// up and staying at the tail. Bounded because the anchor may be megabytes back, or
// may no longer exist at all.
const ANCHOR_SEARCH_PAGES = 5;

const TAIL_POLL_MS = 2000;

// ⌘H (#704). Claimed on EVERY tab, not only the ones with a History: macOS gives
// ⌘H to the browser's Hide item, and Firefox skips that item only when the page
// called preventDefault. A press on a terminal tab is therefore a no-op rather
// than the whole browser vanishing. Strict modifiers keep Ctrl+H — backspace, to a
// terminal — reaching the PTY.
const matchesHistory = register({
  id: 'session-history',
  group: 'Terminal',
  description: 'Toggle History: each prompt and its final answers (agent tabs)',
  shortcut: 'Meta+h',
});

let callbacks = {};
// sessionId -> pane. More than one can be open at a time, because a pane hides
// with its tab instead of closing.
const panes = new Map();

// ---------------------------------------------------------------- pure helpers
//
// Exported for test/unit/session-history-client.test.js. The join and the
// grouping are the two things that go silently wrong (a tool line with no output,
// a turn split into three bubbles, an answer hung off the wrong prompt) and none
// of them is visible in a screenshot.

/** tool_use_id -> the tool_result entry that answers it. */
export function indexToolResults(entries) {
  const byId = new Map();
  for (const e of entries || []) {
    if (e.kind === 'tool_result' && e.toolUseId) byId.set(e.toolUseId, e);
  }
  return byId;
}

/**
 * Drop the tool_result entries that are already shown inside a tool line.
 *
 * A tool call and its answer are two records, in two different turns -- the call
 * is the assistant's, the result is recorded as the USER's -- joined only by
 * tool_use_id. Rendered flat, every Bash call produces a second "you said" block
 * containing its own output, which is both wrong and twice the rows. A result
 * survives only when its call is NOT in view, which happens at the edge of the
 * loaded range and is exactly when it is worth showing on its own.
 */
export function foldToolResults(entries) {
  const claimed = new Set();
  for (const e of entries || []) {
    if (e.kind === 'tool_use' && e.toolUseId) claimed.add(e.toolUseId);
  }
  return (entries || []).filter((e) => !(e.kind === 'tool_result' && claimed.has(e.toolUseId)));
}

/**
 * One assistant TURN arrives as several records -- thinking, then prose, then a
 * tool call -- sharing `message.id`. Group by that, and by uuid for everything
 * else, so the pane draws one speaker block instead of three loose bubbles.
 */
export function groupEntries(entries) {
  const groups = [];
  for (const e of entries || []) {
    const key = e.groupId || e.uuid || `${e.offset}:${e.seq}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key && last.role === e.role) last.entries.push(e);
    else groups.push({ key, role: e.role, entries: [e] });
  }
  return groups;
}

/** Something a person typed: the head of an exchange. */
export function isPromptEntry(e) {
  return !!e && e.role === 'user' && e.kind === 'text' && !e.meta;
}

/**
 * A final answer: assistant text that ended its turn. Text whose stopReason is
 * `tool_use` is narration written just before a tool call, and belongs to the work.
 */
export function isAnswerEntry(e) {
  return !!e && e.role === 'assistant' && e.kind === 'text' && !e.meta && e.stopReason === 'end_turn';
}

/** The rows a reader steps through with the arrows: prompts and answers, not the work between. */
export function isStepEntry(e) {
  return isPromptEntry(e) || isAnswerEntry(e);
}

/**
 * Loaded entries -> exchanges: a prompt, then its work and its answers
 * interleaved in file order.
 *
 * Interleaved, not "all the work, then all the answers": in the transcripts
 * measured for #704, 32 of ~35 prompts with several answers did work BETWEEN
 * them (auto mode, a background task waking the agent), and hoisting that work
 * above the first answer would put it in the wrong place.
 *
 * Runs over everything loaded, unfiltered, so the ⚙ toggle changes what a work
 * line shows and never where an exchange starts. Entries ahead of the first
 * prompt become an exchange with `prompt: null`: at the edge of the loaded range
 * the prompt is simply further back, and its answers must not vanish with it.
 *
 * @returns {Array<{key, prompt, answered, items: Array<{type:'work', key, entries, stats}|{type:'answer', entry}>}>}
 */
export function groupByPrompt(entries) {
  const exchanges = [];
  let cur = null;
  let work = null;
  // When the prompt or answer the open work follows was written.
  let since = null;

  const endWork = (until) => {
    if (work) work.stats = workStats(work.entries, since, until);
    work = null;
  };

  for (const e of entries || []) {
    if (isPromptEntry(e)) {
      endWork(null);
      cur = { key: keyOf(e), prompt: e, items: [], answered: false };
      exchanges.push(cur);
      since = e.ts || null;
      continue;
    }
    if (!cur) {
      cur = { key: `lead:${keyOf(e)}`, prompt: null, items: [], answered: false };
      exchanges.push(cur);
    }
    if (isAnswerEntry(e)) {
      endWork(e.ts || null);
      cur.items.push({ type: 'answer', entry: e });
      cur.answered = true;
      since = e.ts || null;
      continue;
    }
    if (!work) {
      work = { type: 'work', key: keyOf(e), entries: [], stats: null };
      cur.items.push(work);
    }
    work.entries.push(e);
  }
  endWork(null);
  return exchanges;
}

/**
 * What one stretch of work amounts to. Counts skip meta records, which the pane
 * hides by default; the duration runs from the step the work follows to the
 * answer it produced, or to its own last record when nothing followed.
 */
function workStats(entries, since, until) {
  let toolCalls = 0, notes = 0, thinking = 0, nonMeta = 0;
  let first = null, last = null;
  for (const e of entries) {
    if (e.ts) { if (!first) first = e.ts; last = e.ts; }
    if (e.meta) continue;
    nonMeta++;
    if (e.kind === 'tool_use') toolCalls++;
    else if (e.kind === 'thinking') thinking++;
    else if (e.kind === 'text' && e.role === 'assistant') notes++;
  }
  const start = Date.parse(since || first);
  const end = Date.parse(until || last);
  return { toolCalls, notes, thinking, nonMeta, durationMs: end > start ? end - start : 0 };
}

/** "12 tool calls · 3 notes · 4m" — what a folded work line says. */
export function formatWorkSummary(stats) {
  const s = stats || {};
  const bits = [];
  if (s.toolCalls) bits.push(plural(s.toolCalls, 'tool call'));
  if (s.notes) bits.push(plural(s.notes, 'note'));
  if (!bits.length) bits.push(s.thinking ? 'thinking' : 'notices');
  const took = formatDuration(s.durationMs);
  if (took) bits.push(took);
  return bits.join(' · ');
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function formatDuration(ms) {
  const sec = Math.floor((ms || 0) / 1000);
  if (sec < 1) return '';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** A one-line summary of a tool call: the argument worth seeing at a glance. */
export function toolSummary(entry) {
  let input = entry.input;
  try { input = JSON.parse(entry.input); } catch { /* truncated or already a string */ }
  if (input && typeof input === 'object') {
    const pick = input.command || input.file_path || input.path || input.pattern
      || input.query || input.description || input.url;
    if (pick) return String(pick);
    return Object.keys(input).length ? JSON.stringify(input) : '';
  }
  return typeof input === 'string' ? input : '';
}

/** "+124 KB" for a clipped field, or '' when nothing was cut. */
export function truncationNote(entry) {
  if (!entry || !entry.truncated) return '';
  const shown = (entry.text || entry.output || entry.input || '').length;
  const hidden = Math.max(0, (entry.fullBytes || 0) - shown);
  if (!hidden) return '';
  if (hidden < 1024) return `+${hidden} B`;
  if (hidden < 1024 * 1024) return `+${Math.round(hidden / 1024)} KB`;
  return `+${(hidden / (1024 * 1024)).toFixed(1)} MB`;
}

// ------------------------------------------------------------------- position

function readPositions() {
  try { return JSON.parse(sessionStorage.getItem(POS_KEY)) || {}; } catch { return {}; }
}

function savePosition(sessionId, anchor) {
  try {
    const all = readPositions();
    if (anchor) all[sessionId] = { anchor };
    else delete all[sessionId];
    sessionStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch { /* private mode, quota — a lost reading position is not worth throwing over */ }
}

export function rememberedAnchor(sessionId) {
  const rec = readPositions()[sessionId];
  return rec && rec.anchor ? rec.anchor : null;
}

// ----------------------------------------------------------------------- data

async function fetchPage(sessionId, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/shells/${encodeURIComponent(sessionId)}/transcript${qs ? '?' + qs : ''}`);
  if (!res.ok) {
    // 409 means the file was replaced under a cursor we minted. Not an error the
    // reader can act on — reload from the tail.
    if (res.status === 409) return { rewound: true };
    throw new Error(`history unavailable (${res.status})`);
  }
  return res.json();
}

/** Replace the loaded range with a fresh one anchored at an end of the file. */
async function loadEnd(p, which) {
  p.loading = true;
  render(p);
  try {
    const data = await fetchPage(p.id, which === 'start' ? { after: 0 } : {});
    if (!panes.has(p.id)) return;
    applyMeta(p, data);
    p.entries = data.entries || [];
    if (which === 'start') {
      p.backCursor = 0; p.hasOlder = false;
      p.fwdCursor = data.cursor ? data.cursor.after : 0;
      p.hasNewer = true;
      p.stickBottom = false;
    } else {
      p.backCursor = data.cursor ? data.cursor.before : null;
      p.hasOlder = !!(data.cursor && data.cursor.hasMore);
      p.fwdCursor = data.file ? data.file.size : 0;
      p.hasNewer = false;
      p.stickBottom = true;
    }
    p.error = null;
  } catch (e) {
    p.error = e.message;
  } finally {
    p.loading = false;
    if (panes.has(p.id)) render(p, { scrollTo: which === 'start' ? 'top' : 'bottom' });
  }
}

/** Carry over the fields that describe the transcript rather than a page of it. */
function applyMeta(p, data) {
  // The id can rotate mid-read: a fork or a plan-mode exit makes Claude Code
  // start a NEW transcript, and a byte cursor into the old file means nothing in
  // the new one. Drop everything and start again from its tail.
  if (p.claudeSessionId && data.claudeSessionId && p.claudeSessionId !== data.claudeSessionId) {
    p.entries = [];
    p.open.clear();
    p.rotated = true;
  }
  p.claudeSessionId = data.claudeSessionId || null;
  p.supported = data.supported !== false;
  p.exists = !!data.exists;
  p.reason = data.reason || null;
  p.closed = !!data.closed;
  p.liveSession = !!data.live;
  p.agentType = data.agentType || null;
  p.size = data.file ? data.file.size : 0;
}

async function loadOlder(p) {
  if (p.loading || !p.hasOlder || p.backCursor == null) return;
  p.loading = true;
  try {
    const data = await fetchPage(p.id, { before: p.backCursor });
    if (!panes.has(p.id)) return;
    if (data.rewound) { await loadEnd(p, 'end'); return; }
    applyMeta(p, data);
    p.entries = (data.entries || []).concat(p.entries);
    p.backCursor = data.cursor ? data.cursor.before : null;
    // hasMore, never entries.length: a window can be entirely bookkeeping and
    // legitimately yield zero entries while there is still history behind it.
    p.hasOlder = !!(data.cursor && data.cursor.hasMore);
  } catch (e) {
    p.error = e.message;
    p.hasOlder = false;   // stop the scroll handler from retrying forever
  } finally {
    p.loading = false;
    if (panes.has(p.id)) render(p);
  }
}

async function loadNewer(p, { poll = false } = {}) {
  if (p.loading || p.fwdCursor == null) return;
  if (!poll && !p.hasNewer) return;
  p.loading = true;
  const entriesBefore = p.entries;
  const hadNewer = p.hasNewer;
  try {
    const data = await fetchPage(p.id, { after: p.fwdCursor });
    if (!panes.has(p.id)) return;
    if (data.rewound) { await loadEnd(p, 'end'); return; }
    applyMeta(p, data);
    const fresh = data.entries || [];
    if (fresh.length) p.entries = p.entries.concat(fresh);
    const next = data.cursor ? data.cursor.after : p.fwdCursor;
    p.hasNewer = next < (data.file ? data.file.size : 0);
    p.fwdCursor = next;
  } catch {
    // A failed tail poll is not worth surfacing; the next tick retries.
  } finally {
    p.loading = false;
    if (panes.has(p.id)) {
      // An idle tail poll brings nothing. Rebuilding anyway would snap shut the
      // work line or tool output the reader just opened, every two seconds.
      if (p.entries !== entriesBefore || p.hasNewer !== hadNewer) {
        render(p, { scrollTo: p.stickBottom ? 'bottom' : null });
      } else {
        renderHeader(p);
      }
    }
  }
}

// ----------------------------------------------------------------- open/close

export function isOpen(sessionId) { return panes.has(sessionId); }

export function toggle(sessionId) {
  if (panes.has(sessionId)) close(sessionId); else open(sessionId);
}

/**
 * Toggle the active tab's pane, if it is a tab that can have one. Only Claude
 * Code writes a transcript, so on any other tab this does nothing — the tab's ⧗
 * glyph is absent there for the same reason.
 */
export function toggleActive() {
  const id = callbacks.getActiveSessionId?.();
  const session = id ? callbacks.getSession?.(id) : null;
  if (session && session.agentType === 'claude') toggle(id);
}

export async function open(sessionId) {
  if (panes.has(sessionId)) { focusIfOpen(sessionId); return; }
  const session = callbacks.getSession?.(sessionId);
  if (!session || !session.container) return;

  const p = {
    id: sessionId, entries: [], backCursor: null, fwdCursor: null,
    hasOlder: false, hasNewer: false, loading: true, error: null,
    showMeta: false, selected: null, stickBottom: true, rotated: false,
    claudeSessionId: null, supported: true, exists: false, reason: null,
    closed: false, liveSession: false, size: 0, rows: new Map(), pollTimer: null,
    // Keys of the work lines and tool outputs the reader opened. Kept on the pane
    // rather than in the DOM, because every render is a full rebuild.
    open: new Set(),
  };
  panes.set(sessionId, p);
  build(p, session.container);
  render(p);

  await loadEnd(p, 'end');
  if (!panes.has(sessionId)) return;
  await restoreAnchor(p);
  startPolling(p);
}

/**
 * Walk back a bounded number of pages looking for the message the reader was last
 * sitting on. Bounded because it may be tens of megabytes behind, or gone.
 */
async function restoreAnchor(p) {
  const anchor = rememberedAnchor(p.id);
  if (!anchor) return;
  for (let i = 0; i <= ANCHOR_SEARCH_PAGES; i++) {
    if (p.entries.some((e) => e.uuid === anchor)) {
      p.stickBottom = false;
      render(p, { scrollTo: anchor });
      return;
    }
    if (!p.hasOlder) return;
    await loadOlder(p);
    if (!panes.has(p.id)) return;
  }
}

export function close(sessionId) {
  const p = panes.get(sessionId);
  if (!p) return;
  savePosition(sessionId, topVisibleAnchor(p));
  stopPolling(p);
  if (p.el && p.el.parentNode) p.el.remove();
  panes.delete(sessionId);
  callbacks.focusTerminal?.(sessionId);
}

/** A session went away — drop its pane without touching focus. */
export function discard(sessionId) {
  const p = panes.get(sessionId);
  if (!p) return;
  stopPolling(p);
  if (p.el && p.el.parentNode) p.el.remove();
  panes.delete(sessionId);
}

/**
 * Take focus if this tab has a pane up. switchTo() calls this BEFORE focusing the
 * terminal: without it the terminal behind a visible pane takes the keyboard, and
 * every arrow key goes to the agent instead of to the history you are reading.
 */
export function focusIfOpen(sessionId) {
  const p = panes.get(sessionId);
  if (!p || !p.panel) return false;
  requestAnimationFrame(() => p.panel.focus());
  return true;
}

function startPolling(p) {
  stopPolling(p);
  if (!p.liveSession) return;
  p.pollTimer = setInterval(() => {
    // Only while the reader is at the bottom: following a live agent is what the
    // poll is for, and yanking the view while someone reads further up is not.
    if (!panes.has(p.id) || p.loading || !p.stickBottom) return;
    loadNewer(p, { poll: true });
  }, TAIL_POLL_MS);
}

function stopPolling(p) {
  if (p.pollTimer) { clearInterval(p.pollTimer); p.pollTimer = null; }
}

// -------------------------------------------------------------------- keyboard

function onKeyDown(e) {
  // ⌘H before the focus gate below: it has to close a pane that does not hold
  // focus, and it has to be claimed on a tab that has no pane at all.
  if (matchesHistory(e)) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) toggleActive();
    return;
  }

  const p = activePane();
  if (!p || !p.panel) return;
  // Only when the pane actually holds focus, so a keystroke meant for another
  // tab's terminal is never swallowed.
  if (!p.panel.contains(document.activeElement) && document.activeElement !== p.panel) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    // Capture-phase stopPropagation, as in the shortcuts overlay: with a modal
    // also open, Esc closes only this pane.
    e.stopPropagation();
    close(p.id);
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); e.stopPropagation(); step(p, -1); return; }
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); e.stopPropagation(); step(p, 1); return; }
  if (e.key === 'Home' || e.key === 'g') { e.preventDefault(); e.stopPropagation(); loadEnd(p, 'start'); return; }
  if (e.key === 'End' || e.key === 'G') { e.preventDefault(); e.stopPropagation(); loadEnd(p, 'end'); return; }
}

/**
 * Claim ⌘H inside a same-origin iframe (a mod, a project mod, a display tab).
 *
 * A keystroke in an iframe never reaches the listener init() puts on the top
 * document, so without this ⌘H hides the browser whenever an App or a display tab
 * has focus. The claim does nothing else: none of those tabs has a History.
 * Called on every `load`, beside wrapRealmFetch, because a reloaded page is a new
 * realm with no listener on it.
 */
export function claimHistoryKey(win) {
  try { win.addEventListener('keydown', preventHistoryKey, true); } catch { /* gone, or not same-origin */ }
}

function preventHistoryKey(e) {
  if (matchesHistory(e)) e.preventDefault();
}

function activePane() {
  const id = callbacks.getActiveSessionId?.();
  return id ? panes.get(id) : null;
}

/** Move the selection to the previous or next prompt or answer, not one screenful. */
function step(p, dir) {
  const steps = p.entries.filter(isStepEntry);
  if (!steps.length) return;
  let i = steps.findIndex((e) => keyOf(e) === p.selected);
  if (i < 0) i = dir > 0 ? -1 : steps.length;
  const next = steps[Math.max(0, Math.min(steps.length - 1, i + dir))];
  if (!next) return;
  p.selected = keyOf(next);
  p.stickBottom = false;
  const el = p.rows.get(p.selected);
  if (el) {
    el.scrollIntoView({ block: 'nearest' });
    markSelection(p);
  }
  // Stepping off the oldest loaded step is the natural cue to fetch more.
  if (i + dir <= 0 && p.hasOlder) loadOlder(p);
}

function keyOf(e) { return `${e.offset}:${e.seq}`; }

// ---------------------------------------------------------------------- build

function build(p, container) {
  const el = document.createElement('div');
  el.className = 'sess-hist';

  const panel = document.createElement('div');
  panel.className = 'sess-hist-panel';
  // Focusable and focused on open: without moving focus off the terminal, every
  // keystroke would still be typed into the agent behind this pane.
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'sess-hist-header';
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'sess-hist-body';
  body.addEventListener('scroll', () => onScroll(p));
  panel.appendChild(body);

  el.appendChild(panel);
  container.appendChild(el);

  p.el = el; p.panel = panel; p.header = header; p.body = body;
  requestAnimationFrame(() => panel.focus());
}

let scrollSaveTimer = null;
function onScroll(p) {
  const body = p.body;
  const nearTop = body.scrollTop < 80;
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  p.stickBottom = nearBottom;
  if (nearTop && p.hasOlder && !p.loading) loadOlder(p);
  if (nearBottom && p.hasNewer && !p.loading) loadNewer(p);
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    if (panes.has(p.id)) savePosition(p.id, topVisibleAnchor(p));
  }, 400);
}

/** The uuid of the message currently at the top of the viewport. */
function topVisibleAnchor(p) {
  if (!p.body) return null;
  const top = p.body.scrollTop;
  for (const e of p.entries) {
    const el = p.rows.get(keyOf(e));
    if (el && el.offsetTop + el.offsetHeight > top) return e.uuid || null;
  }
  return null;
}

// --------------------------------------------------------------------- render

function render(p, { scrollTo = null } = {}) {
  if (!p.body) return;

  // Anchor the rebuild on whatever is under the top of the viewport, so
  // prepending an older page does not yank the page out from under the reader.
  const body = p.body;
  const keepKey = scrollTo ? null : topVisibleKey(p);
  const keepOffset = keepKey && p.rows.get(keepKey)
    ? p.rows.get(keepKey).offsetTop - body.scrollTop : 0;

  renderHeader(p);
  body.textContent = '';
  p.rows = new Map();

  if (!p.supported) {
    const what = p.agentType === 'terminal' ? 'A plain terminal' : `A ${p.agentType || 'non-Claude'} session`;
    body.appendChild(note(`${what} keeps no transcript on disk. Only Claude Code writes one, so there is no history to read here.`));
    return;
  }
  if (!p.exists) {
    body.appendChild(note(p.reason === 'never-prompted'
      ? 'Nothing yet. Claude Code writes its transcript when it accepts the first message, so a tab that has not been prompted has no history.'
      : 'No transcript found for this session.'));
    return;
  }
  if (p.error) body.appendChild(warn(p.error));

  if (p.hasOlder) body.appendChild(loadMarker(p, 'older'));

  // The index is built over EVERYTHING loaded, not over what is visible: a result
  // hidden by the meta filter must still fill in its tool line.
  const results = indexToolResults(p.entries);
  const exchanges = groupByPrompt(p.entries);
  let shown = 0;
  exchanges.forEach((x, i) => {
    const el = renderExchange(p, x, results, i === exchanges.length - 1);
    if (el) { body.appendChild(el); shown++; }
  });
  if (!shown) {
    body.appendChild(note(p.loading ? 'Loading…' : 'Nothing to show in this stretch of the transcript.'));
  }

  if (p.hasNewer) body.appendChild(loadMarker(p, 'newer'));

  markSelection(p);

  // Restore the viewport last, after the rebuild has its real heights.
  if (scrollTo === 'bottom') body.scrollTop = body.scrollHeight;
  else if (scrollTo === 'top') body.scrollTop = 0;
  else if (scrollTo) {
    const target = p.entries.find((e) => e.uuid === scrollTo);
    const el = target && p.rows.get(keyOf(target));
    if (el) body.scrollTop = el.offsetTop - 12;
  } else if (keepKey && p.rows.get(keepKey)) {
    body.scrollTop = p.rows.get(keepKey).offsetTop - keepOffset;
  } else if (p.stickBottom) {
    body.scrollTop = body.scrollHeight;
  }
}

function topVisibleKey(p) {
  const top = p.body.scrollTop;
  for (const [key, el] of p.rows) {
    if (el.offsetTop + el.offsetHeight > top) return key;
  }
  return null;
}

function renderHeader(p) {
  const h = p.header;
  h.textContent = '';

  const title = document.createElement('span');
  title.className = 'sess-hist-title';
  title.textContent = 'History';
  h.appendChild(title);

  const sub = document.createElement('span');
  sub.className = 'sess-hist-sub';
  const bits = [];
  if (p.exists) bits.push(`${p.entries.length} loaded`);
  if (p.size) bits.push(formatBytes(p.size));
  if (p.closed) bits.push('closed session');
  if (p.loading) bits.push('loading…');
  sub.textContent = bits.join(' · ');
  h.appendChild(sub);

  const spacer = document.createElement('span');
  spacer.className = 'sess-hist-spacer';
  h.appendChild(spacer);

  if (p.exists) {
    h.appendChild(button('⤒', 'Beginning', () => loadEnd(p, 'start')));
    h.appendChild(button('↑', 'Previous prompt or answer', () => step(p, -1)));
    h.appendChild(button('↓', 'Next prompt or answer', () => step(p, 1)));
    h.appendChild(button('⤓', 'Latest', () => loadEnd(p, 'end')));
    const meta = button(p.showMeta ? '⚙' : '⚙', p.showMeta ? 'Hide tool plumbing and system notices' : 'Show tool plumbing and system notices', () => {
      p.showMeta = !p.showMeta;
      render(p);
    });
    if (p.showMeta) meta.classList.add('on');
    h.appendChild(meta);
  }
  h.appendChild(button('✕', 'Close (⌘H or Esc)', () => close(p.id)));
}

function button(glyph, label, onClick) {
  const b = document.createElement('button');
  b.className = 'sess-hist-btn';
  b.textContent = glyph;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function note(text) {
  const el = document.createElement('div');
  el.className = 'sess-hist-note';
  el.textContent = text;
  return el;
}

function warn(text) {
  const el = document.createElement('div');
  el.className = 'sess-hist-warn';
  el.textContent = text;
  return el;
}

function marker(text) {
  const el = document.createElement('div');
  el.className = 'sess-hist-marker';
  el.textContent = text;
  return el;
}

function loadMarker(p, dir) {
  const el = document.createElement('button');
  el.className = 'sess-hist-more';
  el.textContent = p.loading ? 'Loading…' : (dir === 'older' ? '↑ older' : '↓ newer');
  el.addEventListener('click', () => (dir === 'older' ? loadOlder(p) : loadNewer(p)));
  return el;
}

/**
 * One exchange: the prompt, then its work lines and answers in file order. Null
 * when nothing in it is visible (all meta, with ⚙ off), so a stretch of pure
 * bookkeeping draws nothing rather than an empty block.
 */
function renderExchange(p, x, results, isLast) {
  const parts = [];
  for (const item of x.items) {
    if (item.type === 'answer') {
      const g = renderGroup(p, { role: 'assistant', entries: [item.entry] }, results);
      g.classList.add('is-answer');
      parts.push(g);
    } else {
      const w = renderWork(p, item, results);
      if (w) parts.push(w);
    }
  }
  if (!x.prompt && !parts.length) return null;

  const el = document.createElement('div');
  el.className = 'sess-hist-exchange';
  if (x.prompt) {
    el.appendChild(renderGroup(p, { role: 'user', entries: [x.prompt] }, results));
  } else if (p.hasOlder) {
    // The loaded range starts mid-exchange. Its prompt is on an older page, and
    // the next load older re-attaches everything below to it.
    el.appendChild(marker('↑ the prompt for this is further back'));
  }
  for (const part of parts) el.appendChild(part);

  if (x.prompt && !x.answered) {
    el.appendChild(marker(isLast && p.hasNewer
      ? '↓ the answer may be further on'
      : 'no final answer (interrupted or still running)'));
  }
  return el;
}

/** A folded line summarising a stretch of work; opened, today's detailed rows. */
function renderWork(p, work, results) {
  const shown = work.entries.filter((e) => p.showMeta || !e.meta);
  if (!shown.length) return null;
  const openKey = `work:${work.key}`;
  const isOpen = p.open.has(openKey);

  const el = document.createElement('div');
  el.className = 'sess-hist-work';

  const line = document.createElement('button');
  line.className = 'sess-hist-foldline sess-hist-workline';
  const caret = document.createElement('span');
  caret.className = 'sess-hist-glyph';
  caret.textContent = isOpen ? '▾' : '▸';
  const s = document.createElement('span');
  s.className = 'sess-hist-summary';
  s.textContent = formatWorkSummary(work.stats);
  line.append(caret, s);
  line.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (p.open.has(openKey)) p.open.delete(openKey); else p.open.add(openKey);
    // A rebuild rather than a local toggle: which element stands for each entry
    // changes with it, and p.rows has to follow.
    render(p);
  });
  el.appendChild(line);

  if (!isOpen) {
    // Folded entries still have a position. Point each at this line, so the
    // viewport anchor and a remembered reading position inside the work land here.
    for (const e of work.entries) p.rows.set(keyOf(e), line);
    return el;
  }

  const inner = document.createElement('div');
  inner.className = 'sess-hist-work-body';
  for (const group of groupEntries(foldToolResults(shown))) {
    inner.appendChild(renderGroup(p, group, results));
  }
  el.appendChild(inner);
  return el;
}

const ROLE_LABEL = { user: 'you', assistant: 'claude', system: 'system' };

function renderGroup(p, group, results) {
  const el = document.createElement('div');
  el.className = `sess-hist-group role-${group.role}`;

  const head = document.createElement('div');
  head.className = 'sess-hist-role';
  const who = document.createElement('span');
  who.className = 'sess-hist-who';
  who.textContent = ROLE_LABEL[group.role] || group.role;
  head.appendChild(who);
  const when = group.entries.find((e) => e.ts);
  if (when) {
    const t = document.createElement('span');
    t.className = 'sess-hist-when';
    t.textContent = formatTime(when.ts);
    head.appendChild(t);
  }
  el.appendChild(head);

  for (const e of group.entries) el.appendChild(renderEntry(p, e, results));
  return el;
}

function renderEntry(p, e, results) {
  const row = document.createElement('div');
  row.className = `sess-hist-row kind-${e.kind}`;
  if (e.meta) row.classList.add('is-meta');
  p.rows.set(keyOf(e), row);
  row.addEventListener('click', () => {
    p.selected = keyOf(e);
    markSelection(p);
  });

  const key = keyOf(e);
  if (e.kind === 'text') {
    row.appendChild(body(e.text, e));
  } else if (e.kind === 'thinking') {
    row.appendChild(disclosure(p, key, '⋯', 'thinking', `${wordCount(e.text)} words`, e.text, e));
  } else if (e.kind === 'tool_use') {
    const result = results.get(e.toolUseId);
    const detail = [e.input, result ? `\n\n${result.isError ? '! ' : ''}${result.output}` : ''].join('');
    const d = disclosure(p, key, '⚒', e.name, toolSummary(e), detail, result && result.truncated ? result : e);
    if (result && result.isError) d.classList.add('is-error');
    row.appendChild(d);
  } else if (e.kind === 'tool_result') {
    // Only reached when the tool_use it answers is outside the loaded range;
    // otherwise it is folded into the tool line above.
    row.appendChild(disclosure(p, key, '⚒', 'result', e.isError ? 'error' : '', e.output, e));
  } else if (e.kind === 'image') {
    row.appendChild(oneLine('▣', `${e.mediaType} · ${formatBytes(e.fullBytes)} (not shown)`));
  } else if (e.kind === 'oversize') {
    row.appendChild(oneLine('⚠', `one record of ${formatBytes(e.fullBytes)} was too large to read`));
  } else if (e.kind === 'system') {
    row.appendChild(oneLine('·', `${e.subtype || 'system'}${e.text ? ' — ' + firstLine(e.text) : ''}`));
  } else {
    row.appendChild(disclosure(p, key, '?', e.name || e.kind, '', e.text || '', e));
  }
  return row;
}

function body(text, entry) {
  const el = document.createElement('div');
  el.className = 'sess-hist-text';
  el.textContent = text || '';
  const cut = truncationNote(entry);
  if (cut) {
    const more = document.createElement('span');
    more.className = 'sess-hist-cut';
    more.textContent = ` ${cut} not shown`;
    el.appendChild(more);
  }
  return el;
}

/** A one-line summary that opens to its detail on click, and stays open across rebuilds. */
function disclosure(p, key, glyph, name, summary, detail, entry) {
  const el = document.createElement('div');
  el.className = 'sess-hist-fold';
  const startOpen = p.open.has(key);

  const line = document.createElement('button');
  line.className = 'sess-hist-foldline';
  const g = document.createElement('span');
  g.className = 'sess-hist-glyph';
  g.textContent = glyph;
  const n = document.createElement('span');
  n.className = 'sess-hist-name';
  n.textContent = name;
  const s = document.createElement('span');
  s.className = 'sess-hist-summary';
  s.textContent = summary || '';
  const caret = document.createElement('span');
  caret.className = 'sess-hist-caret';
  caret.textContent = startOpen ? '▾' : '▸';
  line.append(g, n, s, caret);

  const pre = document.createElement('pre');
  pre.className = 'sess-hist-detail';
  pre.hidden = !startOpen;
  pre.textContent = detail || '';
  const cut = truncationNote(entry);
  if (cut) {
    const more = document.createElement('div');
    more.className = 'sess-hist-cut';
    more.textContent = `${cut} not shown`;
    pre.appendChild(more);
  }

  line.addEventListener('click', (ev) => {
    ev.stopPropagation();
    pre.hidden = !pre.hidden;
    caret.textContent = pre.hidden ? '▸' : '▾';
    if (pre.hidden) p.open.delete(key); else p.open.add(key);
  });

  el.append(line, pre);
  return el;
}

function oneLine(glyph, text) {
  const el = document.createElement('div');
  el.className = 'sess-hist-oneline';
  const g = document.createElement('span');
  g.className = 'sess-hist-glyph';
  g.textContent = glyph;
  const t = document.createElement('span');
  t.textContent = text;
  el.append(g, t);
  return el;
}

function markSelection(p) {
  for (const [key, el] of p.rows) el.classList.toggle('selected', key === p.selected);
}

// ------------------------------------------------------------------ formatting

function wordCount(s) { return s ? s.trim().split(/\s+/).length : 0; }
function firstLine(s) { return String(s || '').split('\n')[0].slice(0, 120); }

export function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts) {
  try { return new Date(ts).toLocaleTimeString(); } catch { return ''; }
}

// ----------------------------------------------------------------------- init

export function init(cbs) {
  callbacks = cbs || {};
  document.addEventListener('keydown', onKeyDown, true);
}

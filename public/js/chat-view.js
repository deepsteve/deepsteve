/**
 * Chat-style view of a Claude Code session.
 *
 * Walks xterm's already-RESOLVED buffer (term.buffer.active) line by line and
 * groups output into a tree of turns by Claude's prefix glyphs:
 *
 *   ❯  user message      → starts a new turn
 *   ⏺  agent response    → primary message in the current turn (non-collapsible)
 *   ⏺  tool call         → ⏺ Tool(args) whose ⎿ output is collapsible
 *   ∴  thinking          → collapsible child
 *   ✻✽✳✶ status spinner  → collapsible child (multi-frame)
 *   ※  recap             → collapsible child
 *
 * The parser reads the RESOLVED grid (cursor motion already applied, no
 * overlapping frames) — NOT the server's raw scrollback, which is unresolved
 * ANSI. That is why this lives client-side.
 *
 * Design notes for the re-land (#481). The first cut had three bugs, all fixed
 * here:
 *   1. It rendered the unsent input-composer draft (a bare `❯ <text>` line at
 *      the bottom, no box border) as a sent user message. Fixed by dropping the
 *      trailing turn that has a user line but zero blocks.
 *   2a. Tool calls share the `⏺` glyph with agent text, so their ⎿ output was
 *      dumped inline. Fixed by detecting tool calls (header shape and/or a ⎿
 *      output line) and rendering them as collapsible blocks.
 *   2b. It closed a block on ANY blank line, orphaning thinking/recap bodies
 *      (header, blank, indented body) and truncating multi-paragraph replies.
 *      Fixed: a block closes only on the next glyph line or EOF; interior blank
 *      lines are kept and only edge blanks are trimmed.
 *   3. The spinner cycles through several glyphs; only `✻` was matched. Fixed
 *      with a glyph set plus a dingbat/sparkle-range net.
 * Real buffers also carry chrome (separators, footer hints, token counts, the
 * version line) which is filtered out before classification.
 *
 * The pure functions (parseTurns, classifyLine, isToolHeader, isChrome) touch no
 * DOM and are exported for unit testing. Re-parses on a 150 ms debounce off
 * term.onWriteParsed while active; detaches when inactive.
 */

// Structural glyphs that begin a top-level element (glyph → kind).
const PREFIX = {
  '❯': 'user',     // ❯  U+276F
  '⏺': 'agent',    // ⏺  U+23FA (agent OR tool — disambiguated below)
  '∴': 'thinking', // ∴  U+2234
  '※': 'recap',    // ※  U+203B
};

// Spinner/status frames. Confirmed off live captures: ✻ U+273B, ✽ U+273D,
// ✳ U+2733, ✶ U+2736. The set documents the known frames; isStarGlyph is the
// forward-compat net for the "there are more frames" ones (dingbat asterisks /
// stars / sparkles). The chat view keys on the glyph — not on "esc to interrupt"
// as screen-classifier.js does — because it must collapse BOTH the live spinner
// (`✻ Ionizing… (esc to interrupt · 8s)`) and the finished line (`✻ Brewed for
// 13s`), and the finished one has no interrupt hint.
const STATUS_GLYPHS = new Set(['✻', '✽', '✳', '✶']);
const isStarGlyph = (cp) => cp >= 0x2720 && cp <= 0x2747;

const GUTTER = '⎿'; // ⎿  tool-result output gutter

const COLLAPSIBLE_KINDS = new Set(['thinking', 'status', 'recap', 'tool']);

// A structural glyph only counts at (near) column 0, so a glyph that appears
// inside indented tool/file output (a diff line, a `⎿` body) does not split the
// block. Claude renders top-level glyphs at column 0; bodies are indented.
const STRUCTURAL_MAX_INDENT = 1;

// Tool-call header detection, applied to the text AFTER the ⏺ glyph is stripped.
// A single Capitalized/CamelCase token immediately followed by `(` (Bash(, Read(,
// Edit(, WebFetch(, TodoWrite(…), or an MCP-style name. Agent prose fails these
// (`Tracked.` is followed by `.`, `I ran…` by a space).
const TOOL_HEADER = /^[A-Z][A-Za-z0-9]*\(/;
const MCP_UNDERSCORE = /^mcp__\w+\(/;
const MCP_DASH = /^[\w.-]+\s+-\s+[\w.]+\s*\(/;   // "deepsteve - read_session_screen ("
const MCP_MARKER = /\(MCP\)\s*\(/;               // "… (MCP)(args)"

// Chrome (non-content) lines — best-effort, anchored to minimise false positives.
// These are the composer/footer region that surrounds the live conversation.
const CHROME = [
  /^[─-╿]{4,}$/,                  // ──── separator / box-drawing run
  /⏵⏵/,                            // ⏵⏵ auto/plan mode footer
  /\bshift\+tab to cycle\b/i,
  /^\?\s*for shortcuts\b/i,                  // "? for shortcuts"
  /←\s*for agents\b/,                   // "← for agents"
  /^esc to interrupt$/i,                     // STANDALONE hint (a live spinner line
                                             //   starts with a glyph, not "esc")
  /^\d[\d.,]*\s*[km]?\s+tokens?\b/i,         // "160565 tokens", "0 tokens", "160.6k tokens"
  /\bnew task\?\s*\/clear to save\b/i,       // large-context idle hint
  /^current:\s*[\d.]+.*\blatest:/i,          // "current: 2.1.211 · latest: 2.1.211 …"
  /\bchecking for updates?\b/i,
];

function isChrome(line) {
  const t = line.trim();
  if (!t) return false;
  return CHROME.some((re) => re.test(t));
}

function isToolHeader(rest) {
  return TOOL_HEADER.test(rest) || MCP_UNDERSCORE.test(rest)
      || MCP_DASH.test(rest) || MCP_MARKER.test(rest);
}

/**
 * Classify one buffer line.
 * Returns { kind, indent, rest } where `rest` is the text after the leading
 * glyph (glyph stripped, left-trimmed) for structural kinds, or the whole
 * left-trimmed line when kind is null (a continuation line).
 */
function classifyLine(raw) {
  const rest0 = raw.trimStart();
  const indent = raw.length - rest0.length;
  const first = rest0[0];
  const rest = rest0.slice(1).trimStart();
  const base = PREFIX[first];
  if (base === 'user') return { kind: 'user', indent, rest };
  if (base === 'thinking') return { kind: 'thinking', indent, rest };
  if (base === 'recap') return { kind: 'recap', indent, rest };
  if (base === 'agent') return { kind: isToolHeader(rest) ? 'tool' : 'agent', indent, rest };
  if (first && (STATUS_GLYPHS.has(first) || isStarGlyph(first.codePointAt(0)))) {
    return { kind: 'status', indent, rest };
  }
  return { kind: null, indent, rest: rest0 };
}

// Strip the common leading indentation from a block body; blank lines pass
// through as ''.
function dedent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const n = l.match(/^\s*/)[0].length;
    if (n < min) min = n;
  }
  if (!isFinite(min) || min === 0) return lines.slice();
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(min)));
}

function trimEdgeBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/**
 * Parse logical buffer lines into an array of turns.
 * A turn = { user: string|null, blocks: [{ kind, text, collapsible }] }.
 * The first turn may have user === null if the buffer starts mid-conversation.
 */
function parseTurns(lines) {
  const turns = [];
  let current = { user: null, blocks: [] };
  let open = null; // { kind, header, bodyLines: [], hasGutter }
  let lastRaw = null;

  const closeBlock = () => {
    if (!open) return;
    const body = trimEdgeBlank(dedent(open.bodyLines));
    let kind = open.kind;
    // A tool call whose header we didn't recognise is still a tool if it emitted
    // ⎿ output — fold that output into the collapsed block instead of inline.
    if (kind === 'agent' && open.hasGutter) kind = 'tool';
    const text = body.length ? open.header + '\n' + body.join('\n') : open.header;
    if (text.trim()) {
      current.blocks.push({ kind, text, collapsible: COLLAPSIBLE_KINDS.has(kind) });
    }
    open = null;
  };

  const startTurn = () => {
    closeBlock();
    if (current.user !== null || current.blocks.length) turns.push(current);
    current = { user: null, blocks: [] };
  };

  for (const raw of lines) {
    // Identical adjacent non-blank rows happen when Ink's last frame lingers next
    // to its just-printed copy. Collapse them (blanks excepted, they're structural).
    if (raw !== '' && raw === lastRaw) continue;
    lastRaw = raw;

    // Chrome (footer/separator/counter/version) is skipped WITHOUT closing the
    // open block — it can appear interleaved with the live footer.
    if (isChrome(raw)) continue;

    if (raw.trim() === '') {
      // Blank line: a body candidate, never closes a block (fixes 2b).
      if (open) open.bodyLines.push('');
      continue;
    }

    const { kind, indent, rest } = classifyLine(raw);
    const structural = kind !== null && indent <= STRUCTURAL_MAX_INDENT;

    if (structural && kind === 'user') {
      startTurn();
      current.user = rest;
      continue;
    }

    if (structural) {
      closeBlock();
      open = { kind, header: rest, bodyLines: [], hasGutter: false };
      continue;
    }

    // Continuation: plain text, ⎿ output, or an indented body line (kept RAW so
    // dedent can preserve relative indentation at close).
    if (open) {
      open.bodyLines.push(raw);
      if (raw.trimStart().startsWith(GUTTER)) open.hasGutter = true;
    }
  }

  closeBlock();
  if (current.user !== null || current.blocks.length) turns.push(current);

  // Bug 1: drop the trailing input-composer/draft turn — the last turn with a
  // user line but zero blocks. A just-sent message survives because it gains a
  // spinner block within a frame; the empty `❯` composer beneath it is the
  // zero-block turn that gets dropped.
  const last = turns[turns.length - 1];
  if (last && last.user !== null && last.blocks.length === 0) turns.pop();

  return turns;
}

/**
 * Rebuild LOGICAL lines from xterm's buffer, re-joining hard-wrapped rows via
 * BufferLine.isWrapped so a wide user/agent line isn't split (and its wrapped
 * tail, which has no leading glyph, isn't misfiled as a continuation).
 */
function readBufferLines(term) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const row = buf.getLine(i);
    if (!row) continue;
    const text = row.translateToString(false);
    if (row.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  return out.map((s) => s.replace(/\s+$/, '')); // right-trim each logical line
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function kindGlyph(kind) {
  switch (kind) {
    case 'thinking': return '∴'; // ∴
    case 'status': return '✻';   // ✻
    case 'recap': return '※';    // ※
    case 'tool': return '⏺';     // ⏺
    case 'agent': return '⏺';    // ⏺
    case 'user': return '❯';     // ❯
    default: return '';
  }
}

function labelFor(kind) {
  switch (kind) {
    case 'thinking': return 'Thinking…';
    case 'status': return 'Status';
    case 'recap': return 'Recap';
    case 'tool': return 'Tool';
    default: return '';
  }
}

function renderBlock(block) {
  if (block.collapsible) {
    const details = document.createElement('details');
    details.className = `chat-msg chat-msg-${block.kind} collapsible`;
    const summary = document.createElement('summary');
    // Show the first line so a collapsed block still conveys what's inside
    // (e.g. "✻ Brewed for 13s", "⏺ Bash(git status)").
    const firstLine = block.text.split('\n', 1)[0];
    summary.textContent = `${kindGlyph(block.kind)} ${firstLine || labelFor(block.kind)}`.trim();
    details.appendChild(summary);
    const body = block.text.split('\n').slice(1).join('\n').trim();
    if (body) details.appendChild(el('pre', 'chat-msg-body', body));
    return details;
  }
  // agent (and any other non-collapsible kind)
  const div = el('div', `chat-msg chat-msg-${block.kind}`);
  div.appendChild(el('pre', 'chat-msg-body', block.text));
  return div;
}

function renderTurn(turn) {
  const wrap = el('div', 'chat-turn');
  if (turn.user !== null) {
    const userEl = el('div', 'chat-msg chat-msg-user');
    userEl.appendChild(el('pre', 'chat-msg-body', turn.user));
    wrap.appendChild(userEl);
  }
  for (const block of turn.blocks) {
    wrap.appendChild(renderBlock(block));
  }
  return wrap;
}

/**
 * Create a chat view bound to a session.
 * Caller inserts `element` into the DOM (as a sibling of the .xterm element
 * inside the .terminal-container) and toggles visibility via the
 * `chat-view-active` class on the container.
 */
export function createChatView(session) {
  const root = document.createElement('div');
  root.className = 'chat-view';

  const inner = document.createElement('div');
  inner.className = 'chat-view-inner';
  root.appendChild(inner);

  let active = false;
  let pending = null;
  let onWriteParsedDisposable = null;
  let atBottom = true;

  const empty = () => {
    inner.replaceChildren();
    inner.appendChild(el('div', 'chat-empty', 'No Claude-style messages detected in the visible buffer.'));
  };

  const render = () => {
    if (!session.term) { empty(); return; }
    const turns = parseTurns(readBufferLines(session.term));
    if (!turns.length) { empty(); return; }

    // Preserve open/closed state of <details> across re-renders by remembering
    // which (turn index, block index) keys were open.
    const openSet = new Set();
    inner.querySelectorAll('details[open]').forEach((d) => {
      if (d.dataset.key) openSet.add(d.dataset.key);
    });

    const frag = document.createDocumentFragment();
    turns.forEach((turn, ti) => {
      const turnEl = renderTurn(turn);
      turnEl.querySelectorAll('details').forEach((d, bi) => {
        const key = `${ti}:${bi}`;
        d.dataset.key = key;
        if (openSet.has(key)) d.open = true;
      });
      frag.appendChild(turnEl);
    });

    inner.replaceChildren(frag);
    if (atBottom) root.scrollTop = root.scrollHeight;
  };

  root.addEventListener('scroll', () => {
    atBottom = (root.scrollHeight - root.scrollTop - root.clientHeight) < 40;
  }, { passive: true });

  const scheduleRender = () => {
    if (!active || pending) return;
    pending = setTimeout(() => {
      pending = null;
      render();
    }, 150);
  };

  return {
    element: root,
    isActive: () => active,
    setActive(on) {
      if (on === active) return;
      active = on;
      if (active) {
        atBottom = true;
        render();
        if (session.term && session.term.onWriteParsed) {
          onWriteParsedDisposable = session.term.onWriteParsed(scheduleRender);
        }
        requestAnimationFrame(() => { if (active) render(); });
      } else {
        if (pending) { clearTimeout(pending); pending = null; }
        if (onWriteParsedDisposable && onWriteParsedDisposable.dispose) {
          onWriteParsedDisposable.dispose();
          onWriteParsedDisposable = null;
        }
      }
    },
    refresh: scheduleRender,
    dispose() {
      this.setActive(false);
      root.remove();
    },
  };
}

// Pure exports for unit testing (DOM-free).
export { parseTurns, classifyLine, isToolHeader, isChrome, PREFIX, STATUS_GLYPHS, COLLAPSIBLE_KINDS, CHROME, TOOL_HEADER };

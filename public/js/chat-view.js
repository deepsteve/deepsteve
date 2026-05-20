/**
 * Chat-style view of a Claude Code session.
 *
 * Walks xterm's already-rendered buffer (term.buffer.active) line by line
 * and groups output by Claude's prefix glyphs:
 *
 *   ❯  user message      → starts a new turn
 *   ⏺  agent response    → primary message in the current turn
 *   ∴  thinking          → collapsible child
 *   ✻  status spinner    → collapsible child
 *   ※  recap             → collapsible child
 *
 * Lines that don't start with one of those glyphs are treated as continuation
 * of the previous block (the body of a thinking block, multi-line agent reply,
 * etc.). Lines that are pure box-drawing or input-prompt chrome (e.g. lines
 * beginning with `│ ❯ ` for the Ink input box) fall out naturally because the
 * leading `│` isn't in the prefix set.
 *
 * Re-parses on a 150 ms debounce off term.onWriteParsed while active. When
 * inactive, the parser detaches and does nothing.
 */

const PREFIX = {
  '❯': 'user',    // ❯
  '⏺': 'agent',   // ⏺
  '∴': 'thinking',// ∴
  '✻': 'status',  // ✻
  '※': 'recap',   // ※
};

const COLLAPSIBLE_KINDS = new Set(['thinking', 'status', 'recap']);

function readBufferLines(term) {
  const buf = term.buffer.active;
  const lines = [];
  // length includes both scrollback and the visible viewport.
  for (let i = 0; i < buf.length; i++) {
    const row = buf.getLine(i);
    if (!row) continue;
    // translateToString(true) trims trailing whitespace.
    lines.push(row.translateToString(true));
  }
  return lines;
}

/**
 * Parse buffer rows into an array of turns.
 * A turn = { user: string|null, blocks: [{kind, text}] }.
 * The first turn may have user === null if the buffer starts mid-conversation
 * or before the first user message.
 */
function parseTurns(lines) {
  const turns = [];
  let current = { user: null, blocks: [] };
  let openBlock = null;
  let lastAppendedLine = null;

  const closeBlock = () => {
    if (openBlock && openBlock.text.trim()) {
      current.blocks.push(openBlock);
    }
    openBlock = null;
  };

  const startTurn = () => {
    closeBlock();
    if (current.user !== null || current.blocks.length) turns.push(current);
    current = { user: null, blocks: [] };
  };

  for (const raw of lines) {
    // Identical adjacent rows happen when Ink's last frame is still resident
    // in the buffer next to its just-printed copy. Collapse them.
    if (raw === lastAppendedLine) continue;

    const trimmed = raw.trimStart();
    if (!trimmed) {
      // Blank line ends the current block but doesn't start a new turn.
      closeBlock();
      lastAppendedLine = raw;
      continue;
    }

    const first = trimmed[0];
    const kind = PREFIX[first];

    if (kind === 'user') {
      startTurn();
      current.user = trimmed.slice(1).trimStart();
      lastAppendedLine = raw;
      continue;
    }

    if (kind) {
      closeBlock();
      openBlock = { kind, text: trimmed.slice(1).trimStart() };
      lastAppendedLine = raw;
      continue;
    }

    // Continuation line — append to the open block if there is one.
    if (openBlock) {
      openBlock.text += '\n' + trimmed;
    }
    lastAppendedLine = raw;
  }

  closeBlock();
  if (current.user !== null || current.blocks.length) turns.push(current);
  return turns;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderBlock(block) {
  if (COLLAPSIBLE_KINDS.has(block.kind)) {
    const details = document.createElement('details');
    details.className = `chat-msg chat-msg-${block.kind} collapsible`;
    const summary = document.createElement('summary');
    // Show the first line in the summary so collapsed blocks still convey
    // what's inside (e.g. "✻ Brewed for 13s").
    const firstLine = block.text.split('\n', 1)[0];
    summary.textContent = `${kindGlyph(block.kind)} ${firstLine || labelFor(block.kind)}`;
    details.appendChild(summary);
    const body = block.text.split('\n').slice(1).join('\n').trim();
    if (body) {
      const bodyEl = el('pre', 'chat-msg-body', body);
      details.appendChild(bodyEl);
    }
    return details;
  }
  // agent (and any other non-collapsible kind)
  const div = el('div', `chat-msg chat-msg-${block.kind}`);
  const pre = el('pre', 'chat-msg-body', block.text);
  div.appendChild(pre);
  return div;
}

function kindGlyph(kind) {
  switch (kind) {
    case 'thinking': return '∴';
    case 'status': return '✻';
    case 'recap': return '※';
    case 'agent': return '⏺';
    case 'user': return '❯';
    default: return '';
  }
}

function labelFor(kind) {
  switch (kind) {
    case 'thinking': return 'Thinking…';
    case 'status': return 'Status';
    case 'recap': return 'Recap';
    default: return '';
  }
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
 * Caller is responsible for inserting `element` into the DOM (as a sibling
 * of the .xterm element inside the .terminal-container) and toggling
 * visibility via the `chat-view-active` class on the container.
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

  const empty = () => {
    inner.replaceChildren();
    const placeholder = el('div', 'chat-empty', 'No Claude-style messages detected in the visible buffer.');
    inner.appendChild(placeholder);
  };

  const render = () => {
    if (!session.term) { empty(); return; }
    const lines = readBufferLines(session.term);
    const turns = parseTurns(lines);
    if (!turns.length) { empty(); return; }

    // Preserve open/closed state of <details> across re-renders by remembering
    // which (turn index, block index) combos were open.
    const openSet = new Set();
    inner.querySelectorAll('details[open]').forEach(d => {
      const key = d.dataset.key;
      if (key) openSet.add(key);
    });

    const frag = document.createDocumentFragment();
    turns.forEach((turn, ti) => {
      const turnEl = renderTurn(turn);
      // Tag each <details> with a stable key so we can reapply its open state.
      turnEl.querySelectorAll('details').forEach((d, bi) => {
        const key = `${ti}:${bi}`;
        d.dataset.key = key;
        if (openSet.has(key)) d.open = true;
      });
      frag.appendChild(turnEl);
    });

    inner.replaceChildren(frag);

    // Auto-scroll to bottom on re-render if we were already at/near it.
    if (atBottom) root.scrollTop = root.scrollHeight;
  };

  let atBottom = true;
  root.addEventListener('scroll', () => {
    atBottom = (root.scrollHeight - root.scrollTop - root.clientHeight) < 40;
  }, { passive: true });

  const scheduleRender = () => {
    if (!active) return;
    if (pending) return;
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
        // Ensure we render with the latest viewport content next tick.
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

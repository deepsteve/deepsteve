import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import {
  visibleItems, nextSelection, keyAction, isTypingTarget,
  formatAge, ageColor, itemSubject, answerPayload,
} from './inbox-view.js';

const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;

// ─── Tokens ──────────────────────────────────────────────────────────────────
// The host does not pass theme variables into a mod iframe, so these are literal.
const C = {
  bg: '#0d1117',
  surface: '#161b22',
  raised: '#1c2128',
  sunken: '#010409',      // the screen preview reads as inset, below the page
  hairline: '#21262d',    // 40 rows of #30363d reads as a spreadsheet
  border: '#30363d',
  text: '#c9d1d9',
  bright: '#f0f6fc',
  dim: '#8b949e',
  dimmer: '#6e7681',
  faint: '#484f58',
  blue: '#58a6ff',
  orange: '#f0883e',
  red: '#f85149',
  green: '#238636',
  greenHi: '#2ea043',
};

// Mono for anything that came off a terminal or names a machine thing; system-ui for
// anything an agent wrote for a human to read. The split says "this is what the
// machine said" without a legend.
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace';
const SANS = 'system-ui, -apple-system, sans-serif';

const KINDS = {
  blocked: { glyph: '⏸', color: C.orange, tint: 'rgba(240,136,62,0.14)', label: 'Blocked' },
  question: { glyph: '?', color: C.blue, tint: 'rgba(88,166,255,0.14)', label: 'Question' },
  briefing: { glyph: 'i', color: C.dim, tint: 'rgba(139,148,158,0.12)', label: 'Briefing' },
};
const kindOf = (item) => KINDS[item && item.kind] || KINDS.question;

const DEFAULTS = {
  pollSeconds: 2,
  showBriefings: true,
  groupByProject: false,
  compactRows: false,
  blockingOnly: false,
  seenAutoCycleNote: false,
};

// What the send bar says is about to happen. The three answer paths behave completely
// differently and the user has to know which one Enter will fire BEFORE pressing it.
const PATH_HINT = {
  held: 'resolves the agent’s pending workshop_ask — nothing is typed',
  prompt: 'delivers as a new prompt when the agent is next idle',
  dialog: 'moves the cursor in its real dialog, re-reads the screen, then commits',
};

// ─── Small pieces ────────────────────────────────────────────────────────────

/** The signature: every affordance wears its key. Teaches the keyboard while you mouse. */
function Key({ children, active }) {
  return (
    <kbd style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 20, height: 20, padding: '0 5px', flexShrink: 0,
      border: `1px solid ${active ? C.blue : C.border}`, borderRadius: 4,
      background: C.bg, font: `600 11px ${MONO}`,
      color: active ? C.blue : C.dim,
    }}>{children}</kbd>
  );
}

function Stamp({ item, pulse }) {
  const k = kindOf(item);
  return (
    <span
      title={k.label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 18, borderRadius: 4, flexShrink: 0,
        background: k.tint, color: k.color, font: `600 11px ${SANS}`,
        animation: pulse ? 'ws-pulse 2s ease-in-out infinite' : 'none',
      }}
    >{k.glyph}</span>
  );
}

function Toggle({ on, label, onClick, title }) {
  return (
    <button
      type="button" onClick={onClick} title={title}
      style={{
        border: `1px solid ${on ? C.blue : C.border}`, borderRadius: 4,
        background: on ? 'rgba(88,166,255,0.10)' : 'transparent',
        color: on ? C.blue : C.dim,
        font: `600 11px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase',
        padding: '3px 7px', cursor: 'pointer', transition: 'background 120ms, color 120ms',
      }}
    >{label}</button>
  );
}

// ─── List ────────────────────────────────────────────────────────────────────

const ItemRow = memo(function ItemRow({ item, selected, ageMs, compact, onSelect }) {
  const k = kindOf(item);
  return (
    <div
      onClick={() => onSelect(item.id)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 9,
        padding: compact ? '7px 12px 7px 0' : '10px 12px 10px 0',
        borderBottom: `1px solid ${C.hairline}`,
        borderLeft: `3px solid ${selected ? k.color : k.color + '59'}`,
        paddingLeft: 12,
        background: selected ? C.raised : 'transparent',
        cursor: 'pointer', transition: 'background 120ms',
      }}
    >
      <Stamp item={item} pulse={item.urgency === 'blocking'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          font: `${selected ? 600 : 400} 13px/1.4 ${SANS}`,
          color: selected ? C.bright : C.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{itemSubject(item)}</div>
        {!compact && (
          <div style={{
            font: `12px/1.4 ${MONO}`, color: C.dimmer, marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {item.sessionName || item.sessionId || 'unknown'}
            {item.projectName ? ` · ${item.projectName}` : ''}
            {item.worktree ? ` · ${item.worktree}` : ''}
          </div>
        )}
      </div>
      <span style={{
        font: `13px ${MONO}`, color: ageColor(ageMs, item.urgency),
        fontVariantNumeric: 'tabular-nums', flexShrink: 0, paddingTop: 1,
      }}>{formatAge(ageMs)}</span>
    </div>
  );
});

function GroupHeader({ name, count }) {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 1,
      display: 'flex', alignItems: 'center', gap: 8, height: 24, padding: '0 12px',
      background: C.bg, borderBottom: `1px solid ${C.hairline}`,
      font: `600 11px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase',
      color: C.dim,
    }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <span style={{ color: C.faint }}>{count}</span>
    </div>
  );
}

// ─── Reading pane ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{ padding: '18vh 32px 0', maxWidth: 420 }}>
      <div style={{ fontSize: 28, color: C.hairline, lineHeight: 1 }}>{'⏸'}</div>
      <div style={{ font: `15px ${SANS}`, color: C.dim, margin: '18px 0 8px' }}>Nothing needs you</div>
      <div style={{ font: `13px/1.7 ${SANS}`, color: C.faint }}>
        Blocked sessions land here the moment an agent hits a permission prompt. Agents can
        also post here directly with <code style={{ font: `12px ${MONO}` }}>workshop_ask</code> and{' '}
        <code style={{ font: `12px ${MONO}` }}>workshop_brief</code>.
      </div>
    </div>
  );
}

function ScreenPreview({ lines, open, onToggle }) {
  return (
    <div style={{ marginTop: 18 }}>
      <button
        type="button" onClick={onToggle}
        style={{
          border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
          font: `600 11px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase',
          color: C.dim,
        }}
      >{open ? '▾' : '▸'} Terminal ({lines.length} lines)</button>
      {open && (
        <pre style={{
          background: C.sunken, border: `1px solid ${C.hairline}`, borderRadius: 6,
          padding: '10px 12px', marginTop: 8,
          font: `12px/1.45 ${MONO}`, color: C.dim,
          whiteSpace: 'pre', overflowX: 'auto',
        }}>
          {lines.map((line, i) => (
            <div key={i} style={String(line).trimStart().startsWith('❯')
              ? { color: C.bright, background: 'rgba(88,166,255,0.08)', margin: '0 -12px', padding: '0 12px' }
              : undefined}
            >{line || ' '}</div>
          ))}
        </pre>
      )}
    </div>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

function Workshop() {
  const [bridgeReady, setBridgeReady] = useState(() => !!window.deepsteve);
  const [settings, setSettings] = useState(DEFAULTS);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [picked, setPicked] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState(false);
  const [screen, setScreen] = useState(null);
  const [screenOpen, setScreenOpen] = useState(false);
  const [localIds, setLocalIds] = useState(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [helpOpen, setHelpOpen] = useState(false);

  // Refs, for the long-lived timers and listeners that must not close over stale state.
  const rootRef = useRef(null);
  const replyRef = useRef(null);
  const sendingRef = useRef(false);
  const orderRef = useRef([]);
  const selectedIdRef = useRef(null);

  useEffect(() => { sendingRef.current = sending; }, [sending]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const pollMs = Math.max(1, Math.min(30, Number(settings.pollSeconds) || 2)) * 1000;

  // ── Bridge (settings, this window's own tabs). The inbox itself does NOT wait on
  // it: /api/workshop/inbox is a plain same-origin fetch, so the list renders on the
  // first frame even if the bridge is slow to arrive.
  useEffect(() => {
    if (window.deepsteve) { setBridgeReady(true); return undefined; }
    let n = 0;
    const poll = setInterval(() => {
      if (window.deepsteve) { clearInterval(poll); setBridgeReady(true); }
      else if (++n > 100) clearInterval(poll);   // 10s, then give up
    }, 100);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    if (!bridgeReady || !window.deepsteve.onSettingsChanged) return undefined;
    return window.deepsteve.onSettingsChanged((s) => setSettings({ ...DEFAULTS, ...s }));
  }, [bridgeReady]);

  useEffect(() => {
    // window-scoped: getSessions()/onSessionsChanged report THIS window's own tabs,
    // not the server's live session set. That is wrong for the inbox — which is why
    // the inbox comes from /api/workshop/inbox — and exactly right for the only
    // question asked here: can `o` actually reach this session from this window?
    if (!bridgeReady || !window.deepsteve.onSessionsChanged) return undefined;
    return window.deepsteve.onSessionsChanged((list) => {
      setLocalIds(new Set((list || []).map((s) => s.id)));
    });
  }, [bridgeReady]);

  const setSetting = useCallback((key, value) => {
    setSettings((s) => ({ ...s, [key]: value }));
    // updateSetting accepts keys that are not in mod.json (tasks.jsx already stores
    // its filters this way), and a fullscreen iframe is DESTROYED on hide — so the
    // host's localStorage is the only place a view toggle can survive.
    window.deepsteve?.updateSetting?.(key, value);
  }, []);

  // ── Poll. A self-scheduling timeout, not an interval: that IS the answer to
  // overlapping fetches, since the next one is only armed once this one settles.
  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function tick() {
      if (cancelled) return;
      // Never read on top of a write. A response that raced an in-flight POST would
      // resurrect the row you just answered for one frame, and at 2s that is very
      // visible.
      if (!sendingRef.current) {
        try {
          const r = await fetch('/api/workshop/inbox', { cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          if (cancelled) return;
          setItems(Array.isArray(data.items) ? data.items : []);
          setError(null);
        } catch (e) {
          // Keep the last good list. An inbox that empties itself because the network
          // hiccuped is worse than a stale one.
          if (!cancelled) setError(`Can’t reach the inbox — ${e.message}`);
        }
        if (!cancelled) setLoading(false);
      }
      if (cancelled) return;
      timer = setTimeout(tick, document.visibilityState === 'hidden' ? 10000 : pollMs);
    }

    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [pollMs]);

  // One root tick drives every row's age. Action Required puts an interval inside each
  // row, which is 40 timers at 40 rows; don't copy that.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Derived view. `order` is render order, and the cursor walks it — never the
  // sorted array, or arrows select a different row from the one highlighted.
  const view = useMemo(
    () => visibleItems(items, {
      showBriefings: settings.showBriefings,
      blockingOnly: settings.blockingOnly,
      groupByProject: settings.groupByProject,
    }),
    [items, settings.showBriefings, settings.blockingOnly, settings.groupByProject],
  );

  useEffect(() => {
    const next = nextSelection(selectedIdRef.current, orderRef.current, view.order);
    orderRef.current = view.order;
    if (next !== selectedIdRef.current) setSelectedId(next);
  }, [view.order]);

  const selected = useMemo(
    () => view.list.find((i) => i.id === selectedId) || null,
    [view.list, selectedId],
  );

  // Reset the staged answer only when the SELECTION changes, never on a poll.
  useEffect(() => { setPicked(null); setDraft(''); setScreenOpen(false); }, [selectedId]);

  // ── Live screen preview, its own loop, armed only for a blocked selection.
  // Keyed on [selectedId, pollMs] and deliberately NOT on `items`, which would tear it
  // down and rebuild it on every poll.
  useEffect(() => {
    const id = selectedId;
    if (!id || !String(id).startsWith('blocked:')) { setScreen(null); return undefined; }
    let cancelled = false;
    let timer = null;
    async function tick() {
      if (cancelled) return;
      try {
        const r = await fetch(`/api/workshop/items/${encodeURIComponent(id)}/screen`, { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          if (!cancelled) setScreen({ id, lines: d.lines || [] });
        }
      } catch { /* the row itself will go on the next inbox poll */ }
      if (!cancelled) timer = setTimeout(tick, Math.max(2000, pollMs));
    }
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [selectedId, pollMs]);

  // ── Actions
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/workshop/inbox', { cache: 'no-store' });
      if (r.ok) setItems((await r.json()).items || []);
    } catch { /* the poll will pick it up */ }
  }, []);

  const archive = useCallback(async () => {
    const item = view.list.find((i) => i.id === selectedIdRef.current);
    if (!item || sendingRef.current) return;
    if (item.kind === 'blocked') {
      setError('A live dialog can’t be archived — answer it, or press o to open the tab.');
      return;
    }
    setSending(true);
    sendingRef.current = true;
    try {
      const r = await fetch(`/api/workshop/items/${encodeURIComponent(item.id)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'archived' }),
      });
      if (!r.ok) setError('Couldn’t archive that.');
    } catch (e) {
      setError(`Couldn’t archive that — ${e.message}`);
    } finally {
      setSending(false);
      sendingRef.current = false;
      refresh();
    }
  }, [view.list, refresh]);

  const send = useCallback(async (indexOverride) => {
    const item = view.list.find((i) => i.id === selectedIdRef.current);
    if (!item || sendingRef.current) return;

    // Enter on a briefing archives it. An inbox where the primary key does nothing on
    // a whole item kind is just annoying.
    if (item.kind === 'briefing') { archive(); return; }
    const payload = answerPayload(item, {
      picked: Number.isInteger(indexOverride) ? indexOverride : picked,
      draft,
    });
    if (!payload) return;

    setSending(true);
    sendingRef.current = true;
    try {
      const r = await fetch(`/api/workshop/items/${encodeURIComponent(item.id)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.hint || `Couldn’t answer that — ${data.error || r.status}`);
      } else {
        setError(null);
        setFlash(true);
        setTimeout(() => setFlash(false), 220);
      }
    } catch (e) {
      setError(`Couldn’t answer that — ${e.message}`);
    } finally {
      setSending(false);
      sendingRef.current = false;
      refresh();
    }
  }, [view.list, picked, draft, refresh, archive]);

  // Going to look at an agent is an EXCURSION (#661), not a one-hop jump: the host hides the
  // rail, filters the strip to that session's project, and puts a ⌘← trail in the tab strip —
  // so you can walk twenty blocked agents and still be one keystroke from the inbox. It
  // degrades on its own: an older host has no visitSession, and focusSession is what Workshop
  // shipped with.
  const visit = useCallback((item, opts = {}) => {
    if (!item || !item.sessionId || !localIds.has(item.sessionId)) return false;
    const ds = window.deepsteve;
    if (ds?.visitSession) {
      ds.visitSession(item.sessionId, { label: itemSubject(item), reason: item.kind, ...opts });
    } else {
      ds?.focusSession?.(item.sessionId);
    }
    return true;
  }, [localIds]);

  const openTab = useCallback(() => {
    visit(view.list.find((i) => i.id === selectedIdRef.current));
  }, [view.list, visit]);

  const moveCursor = useCallback((to) => {
    const order = orderRef.current;
    if (!order.length) return;
    let index;
    if (to === 'first') index = 0;
    else if (to === 'last') index = order.length - 1;
    else {
      const at = order.indexOf(selectedIdRef.current);
      index = Math.max(0, Math.min(order.length - 1, (at < 0 ? 0 : at) + to));
    }
    setSelectedId(order[index]);
  }, []);

  // ── One cursor, two renderings (#661).
  //
  // Inside the inbox, bare ↑/↓ move the cursor and the reading pane follows. Out on an
  // excursion the host lends ⌘↑/⌘↓ to this same cursor, in the same order, over the same
  // queue — and the TERMINAL follows instead. So twenty blocked agents can be walked without
  // ever coming back to the inbox, and ⌘← still lands you on the row you left off at.
  //
  // Refs, not deps: the host holds one handler for the life of the iframe, and `view` is
  // rebuilt on every 2s poll.
  const cycleRef = useRef({ list: [], visit: () => false });
  useEffect(() => { cycleRef.current = { list: view.list, visit }; }, [view.list, visit]);
  useEffect(() => {
    if (!bridgeReady || !window.deepsteve.onExcursionCycle) return undefined;
    return window.deepsteve.onExcursionCycle(({ delta }) => {
      const order = orderRef.current;
      const { list, visit: go } = cycleRef.current;
      if (!order.length) return;
      let i = order.indexOf(selectedIdRef.current);
      if (i < 0) i = 0;
      // Step PAST anything this window cannot show. getSessions() is window-scoped, so a
      // scheduled run with no tab here is a legitimate inbox row with nothing to visit —
      // stopping on one would end the walk at the first unattended agent.
      for (let steps = 0; steps < order.length; steps++) {
        i += delta;
        if (i < 0 || i >= order.length) return;   // ran off the end: stay put
        const item = list.find((it) => it.id === order[i]);
        // `replace` is the load-bearing half: a queue walk must not deepen the stack, or
        // "back" costs one press per agent you looked at.
        if (item && go(item, { replace: true })) {
          setSelectedId(order[i]);
          return;
        }
      }
    });
  }, [bridgeReady]);

  // ── Keyboard. Inside the iframe: keystrokes in a mod iframe never reach the host's
  // capture-phase listeners, so this needs no shortcuts.js registry entry (the same
  // arrangement mods/action-required uses).
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey) return;

      // ⌘\ — quiet mode (#662). The HOST owns the state, the toggle and the chrome; this is
      // only the key. It has to be bound in here for the reason the comment above gives: the
      // host's listener is on the top document and never sees this keystroke, which is exactly
      // the moment you want the chrome gone. The host registers it too, for when chrome has
      // focus instead.
      //
      // Above the isTypingTarget branch on purpose — unlike every other key here it is not
      // competing with the reply box for a letter, and going quiet while composing an answer
      // is a reasonable thing to want.
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        window.deepsteve?.toggleQuiet?.();
        return;
      }

      if (isTypingTarget(e.target)) {
        // Exactly two keys are ours in here. Everything else — `e`, `o`, digits, bare
        // Enter — belongs to the textarea. This early return IS the "the inbox ate my
        // letter e" fix; do not add cases without a test.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
        return;
      }
      if (e.metaKey || e.ctrlKey) return;   // leave the browser's own shortcuts alone

      const item = view.list.find((i) => i.id === selectedIdRef.current);
      const action = keyAction(e.key, {
        optionCount: (item && item.options && item.options.length) || 0,
        repeat: e.repeat,
      });
      if (!action) return;
      e.preventDefault();

      switch (action.type) {
        case 'move': moveCursor(action.delta); break;
        case 'first': moveCursor('first'); break;
        case 'last': moveCursor('last'); break;
        // A digit STAGES; Enter commits. On the dialog path an answer becomes real
        // keystrokes in someone's live terminal, so a mis-key should cost one
        // keystroke, not a git reset.
        case 'pick': setPicked(action.index); break;
        case 'send': send(); break;
        case 'archive': archive(); break;
        case 'open': openTab(); break;
        case 'focusReply': replyRef.current?.focus(); break;
        case 'help': setHelpOpen((v) => !v); break;
        case 'escape': setHelpOpen(false); break;
        default: break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view.list, send, archive, openTab, moveCursor]);

  useEffect(() => { rootRef.current?.focus(); }, []);

  // ── Render
  const ageOf = (item) => Math.max(0, now - (item.createdAt || now));
  const hasLocalTab = !!(selected && selected.sessionId && localIds.has(selected.sessionId));
  const showReply = !!selected && selected.kind === 'question';
  const canSend = !!(selected && (selected.kind === 'briefing'
    || answerPayload(selected, { picked, draft })));
  const pathHint = selected ? PATH_HINT[selected.pendingPath] : null;

  const rows = [];
  if (view.groups) {
    for (const group of view.groups) {
      rows.push(<GroupHeader key={'g:' + group.project} name={group.name} count={group.items.length} />);
      for (const item of group.items) {
        rows.push(
          <ItemRow
            key={item.id} item={item} selected={item.id === selectedId}
            ageMs={ageOf(item)} compact={settings.compactRows} onSelect={setSelectedId}
          />,
        );
      }
    }
  } else {
    for (const item of view.list) {
      rows.push(
        <ItemRow
          key={item.id} item={item} selected={item.id === selectedId}
          ageMs={ageOf(item)} compact={settings.compactRows} onSelect={setSelectedId}
        />,
      );
    }
  }

  return (
    <div
      ref={rootRef} tabIndex={-1}
      style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        outline: 'none', background: C.bg,
      }}
    >
      {/* Status strip: only when there is something to say. It sits OUTSIDE the grid
          on purpose — as a grid row it made the two panes size to their content
          whenever it was absent, which is most of the time. */}
      {(error || (!settings.seenAutoCycleNote && view.list.length > 0)) && (
        <div style={{
          flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px',
          background: error ? 'rgba(248,81,73,0.10)' : 'rgba(88,166,255,0.08)',
          borderBottom: `1px solid ${C.hairline}`,
          font: `12px ${SANS}`, color: error ? C.red : C.dim,
        }}>
          <span style={{ flex: 1 }}>
            {error || 'Action Required’s auto-cycle will switch tabs out from under this view. '
              + 'Turn it off while you’re here.'}
          </span>
          <button
            type="button"
            onClick={() => (error ? setError(null) : setSetting('seenAutoCycleNote', true))}
            style={{
              border: `1px solid ${C.border}`, borderRadius: 4, background: 'transparent',
              color: C.dim, font: `11px ${SANS}`, padding: '2px 8px', cursor: 'pointer',
            }}
          >{error ? 'Dismiss' : 'Got it'}</button>
        </div>
      )}

      <div style={{
        flex: 1, minHeight: 0, display: 'grid',
        gridTemplateColumns: 'clamp(300px, 27%, 420px) 1fr',
      }}>
      {/* ── Left: the run-sheet ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', minHeight: 0,
        borderRight: `1px solid ${C.hairline}`, background: C.surface,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, height: 40, padding: '0 12px',
          borderBottom: `1px solid ${C.hairline}`, flexShrink: 0,
        }}>
          <span style={{ font: `600 13px ${SANS}`, color: C.bright, flex: 1 }}>
            Inbox <span style={{ color: C.dim, fontVariantNumeric: 'tabular-nums' }}>{view.list.length}</span>
          </span>
          <Toggle
            on={settings.blockingOnly} label="blocking" title="Show only items that are blocking an agent"
            onClick={() => setSetting('blockingOnly', !settings.blockingOnly)}
          />
          <Toggle
            on={settings.groupByProject} label="group" title="Group by project"
            onClick={() => setSetting('groupByProject', !settings.groupByProject)}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {loading && view.list.length === 0
            ? <div style={{ padding: 24, font: `13px ${SANS}`, color: C.faint }}>Loading…</div>
            : rows}
        </div>
      </div>

      {/* ── Right: the bench ── */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!selected ? <EmptyState /> : (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, height: 40, padding: '0 32px',
              borderBottom: `1px solid ${C.hairline}`, flexShrink: 0,
            }}>
              <Stamp item={selected} pulse={false} />
              <span style={{ font: `13px ${MONO}`, color: C.bright }}>
                {selected.sessionName || selected.sessionId}
              </span>
              {selected.projectName && (
                <span style={{ font: `12px ${MONO}`, color: C.dim }}>{selected.projectName}</span>
              )}
              {selected.worktree && selected.worktree !== selected.projectName && (
                <span style={{ font: `12px ${MONO}`, color: C.dimmer }}>{selected.worktree}</span>
              )}
              <span style={{ flex: 1 }} />
              <span style={{
                font: `13px ${MONO}`, color: ageColor(ageOf(selected), selected.urgency),
                fontVariantNumeric: 'tabular-nums',
              }}>{formatAge(ageOf(selected))}</span>
              <button
                type="button" onClick={openTab} disabled={!hasLocalTab}
                title={hasLocalTab
                  ? 'Show this session'
                  : 'This session has no tab in this window — open it from the Sessions menu first'}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  border: `1px solid ${C.border}`, borderRadius: 5, background: 'transparent',
                  color: hasLocalTab ? C.text : C.faint,
                  font: `12px ${SANS}`, padding: '3px 8px',
                  cursor: hasLocalTab ? 'pointer' : 'default',
                }}
              ><Key>o</Key> Open tab</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, position: 'relative' }}>
              <div style={{ maxWidth: 760, padding: '24px 32px 28px' }}>
                <h1 style={{
                  font: `600 22px/1.3 ${SANS}`, letterSpacing: '-0.01em', color: C.bright,
                }}>{selected.headline || selected.question || '(no subject)'}</h1>

                {selected.context && (
                  <div style={{
                    font: `15px/1.6 ${selected.kind === 'blocked' ? MONO : SANS}`,
                    color: C.text, whiteSpace: 'pre-wrap', marginTop: 12,
                  }}>{selected.context}</div>
                )}

                {selected.multi && (
                  <div style={{ font: `12px ${SANS}`, color: C.orange, marginTop: 12 }}>
                    This dialog asks {selected.multi.count || 'several'} questions. Answering one
                    moves it on to the next, which will appear here as a fresh item.
                  </div>
                )}

                {selected.recommendation && (
                  <div style={{ borderLeft: `2px solid ${C.blue}`, padding: '2px 0 2px 12px', marginTop: 18 }}>
                    <div style={{
                      font: `600 11px/1.4 ${MONO}`, letterSpacing: '0.08em',
                      color: C.blue, marginBottom: 4,
                    }}>RECOMMENDS</div>
                    <div style={{ font: `14px/1.55 ${SANS}`, color: C.text }}>{selected.recommendation}</div>
                  </div>
                )}

                {selected.options && selected.options.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 22 }}>
                    {selected.options.map((opt, i) => (
                      <button
                        key={i} type="button"
                        onClick={() => setPicked(i)}
                        onDoubleClick={() => { setPicked(i); send(i); }}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%',
                          textAlign: 'left',
                          background: picked === i ? '#111a26' : C.surface,
                          border: `1px solid ${picked === i ? C.blue : C.border}`,
                          borderRadius: 6, padding: '9px 12px', cursor: 'pointer',
                          transition: 'background 120ms, border-color 120ms',
                        }}
                      >
                        <Key active={picked === i}>{i < 9 ? String(i + 1) : ' '}</Key>
                        <span style={{ minWidth: 0 }}>
                          <span style={{
                            font: `13px/1.5 ${selected.kind === 'blocked' ? MONO : SANS}`,
                            color: picked === i ? C.bright : C.text,
                          }}>{opt.label}</span>
                          {opt.detail && (
                            <div style={{ font: `12px/1.5 ${SANS}`, color: C.dim, marginTop: 3 }}>{opt.detail}</div>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {selected.kind === 'blocked' && !selected.answerable && (
                  <div style={{ font: `13px/1.6 ${SANS}`, color: C.orange, marginTop: 18 }}>
                    This dialog couldn’t be read well enough to answer from here — the screen is
                    below. Press <Key>o</Key> to open the tab and deal with it there.
                  </div>
                )}

                {showReply && (
                  <textarea
                    ref={replyRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Reply &mdash; Enter for a newline, &#8984;&#9166; to send"
                    style={{
                      width: '100%', minHeight: 72, maxHeight: 200, marginTop: 18,
                      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
                      padding: '10px 12px', font: `14px/1.55 ${SANS}`, color: C.text,
                      resize: 'vertical',
                    }}
                  />
                )}

                {selected.kind === 'blocked' && (
                  <ScreenPreview
                    lines={(screen && screen.id === selected.id ? screen.lines : selected.preview) || []}
                    open={screenOpen}
                    onToggle={() => setScreenOpen((v) => !v)}
                  />
                )}
              </div>
            </div>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
              padding: '12px 32px', borderTop: `1px solid ${C.hairline}`, background: C.bg,
              animation: flash ? 'ws-flash 220ms ease-out' : 'none',
            }}>
              <button
                type="button" onClick={() => send()} disabled={!canSend || sending}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  border: 'none', borderRadius: 5, padding: '6px 12px',
                  background: canSend && !sending ? C.green : C.hairline,
                  color: canSend && !sending ? '#fff' : C.faint,
                  font: `600 13px ${SANS}`, cursor: canSend && !sending ? 'pointer' : 'default',
                  transition: 'background 120ms',
                }}
                onMouseEnter={(e) => { if (canSend && !sending) e.currentTarget.style.background = C.greenHi; }}
                onMouseLeave={(e) => { if (canSend && !sending) e.currentTarget.style.background = C.green; }}
              >
                <Key>{'⏎'}</Key> {selected.kind === 'briefing' ? 'Archive' : 'Send'}
              </button>
              {selected.kind !== 'briefing' && (
                <button
                  type="button" onClick={archive} disabled={selected.kind === 'blocked' || sending}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    border: `1px solid ${C.border}`, borderRadius: 5, padding: '6px 12px',
                    background: 'transparent',
                    color: selected.kind === 'blocked' ? C.faint : C.text,
                    font: `13px ${SANS}`,
                    cursor: selected.kind === 'blocked' ? 'default' : 'pointer',
                  }}
                ><Key>e</Key> Archive</button>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ font: `11px ${SANS}`, color: C.dimmer, textAlign: 'right' }}>
                {sending ? 'Sending…' : (pathHint || 'Nothing to answer')}
              </span>
            </div>
          </>
        )}
      </div>
      </div>

      {helpOpen && (
        <div
          onClick={() => setHelpOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(1,4,9,0.72)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10,
          }}
        >
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '18px 22px', minWidth: 300,
          }}>
            <div style={{
              font: `600 11px ${MONO}`, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: C.dim, marginBottom: 12,
            }}>Keys</div>
            {[
              ['↑ ↓ / j k', 'move'],
              ['1–9', 'stage an option'],
              ['⏎', 'send'],
              ['⌘⏎', 'send while typing'],
              ['e', 'archive'],
              ['o', 'open the tab'],
              ['r', 'reply box'],
              ['⌘\\', 'quiet mode'],
              ['?', 'this'],
            ].map(([k, what]) => (
              <div key={k} style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 6 }}>
                <span style={{ font: `12px ${MONO}`, color: C.bright, minWidth: 92 }}>{k}</span>
                <span style={{ font: `13px ${SANS}`, color: C.dim }}>{what}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('workshop-root'));
root.render(<Workshop />);

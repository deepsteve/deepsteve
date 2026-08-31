import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import {
  visibleItems, nextSelection, keyAction, isTypingTarget, typingAction,
  formatAge, ageColor, itemSubject, itemBody, answerPayload,
} from './inbox-view.js';
import { visibleBacklog, formatUpdated, matchNote } from './backlog-view.js';
import { tokenize } from './markdown.js';

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
  purple: '#a371f7',      // results only — distinct from blocked-orange and question-blue
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
  result: { glyph: '▤', color: C.purple, tint: 'rgba(163,113,247,0.14)', label: 'Result' },
};
const kindOf = (item) => KINDS[item && item.kind] || KINDS.question;

const DEFAULTS = {
  pollSeconds: 2,
  showBriefings: true,
  groupByProject: false,
  compactRows: false,
  blockingOnly: false,
  seenAutoCycleNote: false,
  showBacklog: true,
  backlogPollSeconds: 120,
  issueLabel: 'bug',
  backlogCollapsed: false,
  // Not in mod.json on purpose — a pane width is not a settings-modal control. Both are
  // listed in UNRENDERED_SETTINGS in test/unit/workshop-mod-shape.test.js, which is what
  // keeps the DEFAULTS <-> mod.json parity check honest about the difference.
  chatOpen: false,
  chatWidth: 420,
};

/**
 * Why the backlog is empty, in the user's terms.
 *
 * Every one of these is a normal state on some machine, not a bug — which is why the
 * section says its own sentence in grey rather than raising the inbox's red error strip.
 * The backlog is an accessory; it must not be able to make the inbox look broken.
 */
const BACKLOG_ERRORS = {
  'no-project': 'Open a session in a project to see its issues.',
  'no-label': 'Pick a label to list.',
  'gh-unavailable': 'The GitHub CLI (gh) isn’t on this machine’s PATH.',
  'gh-failed': 'gh couldn’t list issues here — no GitHub remote, or not signed in.',
  unreachable: 'Couldn’t reach the server for the issue list.',
};

// What the send bar says is about to happen. The three answer paths behave completely
// differently and the user has to know which one Enter will fire BEFORE pressing it.
const PATH_HINT = {
  held: 'resolves the agent’s pending workshop_ask — nothing is typed',
  prompt: 'delivers as a new prompt when the agent is next idle',
  dialog: 'moves the cursor in its real dialog, re-reads the screen, then commits',
  // A result outlives its session on purpose, so this is a normal end state and the
  // human has to know BEFORE clicking, not from a note afterwards.
  gone: 'that session is gone — this records your decision and tells nobody',
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

/**
 * A backlog row is a SIBLING of ItemRow, not a branch inside it.
 *
 * The two say different things and must not be mistakable for one another: an inbox row
 * is an agent that has stopped and is waiting on you, a backlog row is a piece of work
 * nobody has picked up. So no Stamp, no urgency colour, and a flat hairline on the left
 * instead of a kind-coloured bar — an issue must never read as something blocking.
 */
const BacklogRow = memo(function BacklogRow({ issue, selected, now, compact, onSelect }) {
  const note = matchNote(issue);
  return (
    <div
      onClick={() => onSelect(issue.id)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 9,
        padding: compact ? '7px 12px 7px 0' : '10px 12px 10px 0',
        borderBottom: `1px solid ${C.hairline}`,
        borderLeft: `3px solid ${selected ? C.dim : 'transparent'}`,
        paddingLeft: 12,
        background: selected ? C.raised : 'transparent',
        cursor: 'pointer', transition: 'background 120ms',
      }}
    >
      <span style={{
        font: `12px ${MONO}`, color: note ? C.green : C.faint, flexShrink: 0,
        paddingTop: 2, fontVariantNumeric: 'tabular-nums',
      }}>#{issue.number}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          font: `${selected ? 600 : 400} 13px/1.4 ${SANS}`,
          color: selected ? C.bright : C.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{issue.title}</div>
        {/* Only rendered when something IS on it. "No tab yet" is the state this whole
            view exists to surface, and it is shown by this line's absence — a row that
            spells it out turns the useful default into noise on every row. */}
        {!compact && note && (
          <div style={{
            font: `12px/1.4 ${MONO}`, color: C.dimmer, marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            <span style={{ color: C.green }}>↳ on it: </span>
            {note.text}
            {!note.exact && <span style={{ color: C.faint }}> (by name)</span>}
          </div>
        )}
      </div>
      <span style={{
        font: `13px ${MONO}`, color: C.faint,
        fontVariantNumeric: 'tabular-nums', flexShrink: 0, paddingTop: 1,
      }}>{formatUpdated(issue.updatedAt, now)}</span>
    </div>
  );
});

/**
 * The Backlog's own header: which project, which label, how many, and the collapse.
 *
 * The label picker lives HERE rather than in the gear menu because the mod settings
 * modal renders only checkboxes and number inputs (public/js/mod-manager.js) — a string
 * setting there is an invisible control. Putting it on the panel is the better place
 * anyway: it sits next to the list it filters.
 */
function BacklogHeader({
  projectName, label, labels, count, collapsed, error, onToggle, onLabel, onLabelMenu,
}) {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 1,
      display: 'flex', alignItems: 'center', gap: 8, height: 28, padding: '0 12px',
      background: C.bg, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.hairline}`,
      font: `600 11px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase',
      color: C.dim,
    }}>
      <button
        type="button" onClick={onToggle}
        title={collapsed ? 'Expand the backlog' : 'Collapse the backlog'}
        style={{
          border: 'none', background: 'transparent', color: C.dim, cursor: 'pointer',
          font: `11px ${MONO}`, padding: 0, width: 12, flexShrink: 0,
        }}
      >{collapsed ? '▸' : '▾'}</button>
      <span style={{ flexShrink: 0 }}>Backlog</span>
      {projectName && (
        <span style={{
          color: C.faint, textTransform: 'none', letterSpacing: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>{projectName}</span>
      )}
      <select
        value={label}
        onChange={(e) => onLabel(e.target.value)}
        onMouseDown={onLabelMenu}
        onFocus={onLabelMenu}
        title="Which label to list"
        style={{
          border: `1px solid ${C.border}`, borderRadius: 4, background: C.surface,
          color: C.text, font: `600 11px ${MONO}`, padding: '1px 4px', cursor: 'pointer',
          maxWidth: 130, flexShrink: 0,
        }}
      >
        {/* The current label is always an option, even before the label list lands or
            when the repo no longer defines it — otherwise the select would silently
            jump to whatever happens to be first and change what you are looking at. */}
        {(labels.some((l) => l.name === label) ? labels : [{ name: label }, ...labels])
          .map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
      </select>
      <span style={{ flex: 1 }} />
      <span style={{ color: error ? C.faint : C.dim, fontVariantNumeric: 'tabular-nums' }}>
        {error ? '—' : count}
      </span>
    </div>
  );
}

/**
 * The reading pane for a backlog row.
 *
 * The pop-out is a real `<a target="_blank">`, not a scripted `window.open`, which is
 * the whole reason the mod iframe now carries `allow-popups` and
 * `allow-popups-to-escape-sandbox`. A real link is what makes ⌘-click, middle-click and
 * "copy link address" behave; a button loses all three, and this row's entire job is to
 * hand you the issue.
 */
function IssueBench({ issue, now, hasLocalTab, onShowTab }) {
  const note = matchNote(issue);
  const linkStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    border: `1px solid ${C.border}`, borderRadius: 5, background: 'transparent',
    color: C.text, font: `12px ${SANS}`, padding: '5px 10px',
    cursor: 'pointer', textDecoration: 'none',
  };
  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 40, padding: '0 32px',
        borderBottom: `1px solid ${C.hairline}`, flexShrink: 0,
      }}>
        <span style={{ font: `13px ${MONO}`, color: note ? C.green : C.dim }}>#{issue.number}</span>
        {note && (
          <span style={{ font: `12px ${MONO}`, color: C.dim }}>
            {note.exact ? 'has a tab' : 'named by a tab'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ font: `13px ${MONO}`, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>
          {formatUpdated(issue.updatedAt, now)}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <div style={{ maxWidth: 760, padding: '24px 32px 28px' }}>
          <h1 style={{
            font: `600 22px/1.3 ${SANS}`, letterSpacing: '-0.01em', color: C.bright,
          }}>{issue.title}</h1>

          {issue.labels && issue.labels.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
              {issue.labels.map((name) => (
                <span key={name} style={{
                  border: `1px solid ${C.border}`, borderRadius: 999,
                  padding: '2px 9px', font: `11px ${MONO}`, color: C.dim,
                }}>{name}</span>
              ))}
            </div>
          )}

          {/* The body is deliberately absent. Fetching it means one `gh issue view` per
              row, and the decision this pane supports is "is anyone on this, and do I
              want to read it" — which the title, the labels and the link already
              answer. */}
          <div style={{ font: `13px/1.6 ${SANS}`, color: C.dim, marginTop: 18 }}>
            {note
              ? <>Already being worked on in <strong style={{ color: C.text }}>{note.text}</strong>
                {note.exact
                  ? ' — matched on its worktree, so this is exact.'
                  : ' — matched on the tab’s name only, so check before assuming.'}</>
              : 'Nothing in Deep Steve is working on this yet.'}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 22 }}>
            <a href={issue.url} target="_blank" rel="noopener noreferrer" style={linkStyle}>
              <Key>g</Key> Open on GitHub ↗
            </a>
            <button
              type="button" onClick={onShowTab} disabled={!note || !hasLocalTab}
              title={!note
                ? 'No Deep Steve session is on this issue'
                : hasLocalTab
                  ? 'Show the session working on this'
                  : 'That session has no tab in this window — open it from the Sessions menu first'}
              style={{ ...linkStyle, opacity: (note && hasLocalTab) ? 1 : 0.45 }}
            >
              <Key>o</Key> Show tab
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

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
        also post here directly with <code style={{ font: `12px ${MONO}` }}>workshop_ask</code>,{' '}
        <code style={{ font: `12px ${MONO}` }}>workshop_brief</code> and{' '}
        <code style={{ font: `12px ${MONO}` }}>share_result</code>.
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

/** A small uppercase rule-and-label, the RECOMMENDS block's sibling. */
function Section({ label, color, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        font: `600 11px/1.4 ${MONO}`, letterSpacing: '0.08em',
        color: color || C.dim, marginBottom: 5,
      }}>{label}</div>
      <div style={{
        font: `14px/1.6 ${SANS}`, color: C.text, whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}>{children}</div>
    </div>
  );
}

/**
 * A result's evidence (#669): the before/after pair, the caveats, the images.
 *
 * Before and after sit SIDE BY SIDE because the comparison is the point — stacked, they
 * read as two paragraphs and the reader has to hold the first one in their head. The
 * grid collapses to one column under 640px, where two columns would be two columns of
 * four words.
 *
 * Images are <img src> against /api/workshop/images/<file>, never inlined: the bytes
 * were copied into the Workshop store at share time precisely so the inbox JSON — which
 * the panel re-reads every couple of seconds — never carries them.
 */
function ResultBody({ item, onZoom }) {
  const hasPair = !!(item.before || item.after);
  const imgs = Array.isArray(item.images) ? item.images : [];
  if (!hasPair && !item.caveats && imgs.length === 0) return null;

  return (
    <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {hasPair && (
        <div style={{
          display: 'grid', gap: 20,
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          borderLeft: `2px solid ${C.purple}`, paddingLeft: 14,
        }}>
          <Section label="BEFORE" color={C.dim}>{item.before || '—'}</Section>
          <Section label="AFTER" color={C.purple}>{item.after || '—'}</Section>
        </div>
      )}

      {imgs.length > 0 && (
        <div style={{
          display: 'grid', gap: 10,
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        }}>
          {imgs.map((img) => (
            <button
              key={img.file} type="button" onClick={() => onZoom(img.file)}
              title={`${img.ref} — click to enlarge`}
              style={{
                padding: 0, border: `1px solid ${C.border}`, borderRadius: 6,
                background: C.sunken, cursor: 'zoom-in', overflow: 'hidden', lineHeight: 0,
              }}
            >
              <img
                src={`/api/workshop/images/${encodeURIComponent(img.file)}`}
                alt={img.ref || 'result image'}
                style={{ display: 'block', width: '100%', height: 130, objectFit: 'cover' }}
              />
            </button>
          ))}
        </div>
      )}

      {item.caveats && (
        <div style={{
          borderLeft: `2px solid ${C.orange}`, padding: '2px 0 2px 12px',
          background: 'rgba(240,136,62,0.05)',
        }}>
          <Section label="CAVEATS" color={C.orange}>{item.caveats}</Section>
        </div>
      )}
    </div>
  );
}

/** Full-bleed image view. Any click or Escape closes it — nothing to learn. */
function Lightbox({ file, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // Capture, so it beats the panel's own Escape handler to the event.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(1,4,9,0.88)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32, cursor: 'zoom-out',
      }}
    >
      <img
        src={`/api/workshop/images/${encodeURIComponent(file)}`}
        alt={file}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
    </div>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

// ─── Markdown ────────────────────────────────────────────────────────────────
// The AST comes from markdown.js and is turned into ELEMENTS here — there is no HTML
// string at any point, which is what makes agent-authored text unable to become markup.
// The two React/DOM escape hatches that would undo that are banned from this file outright
// by workshop-mod-shape.test.js, which greps for them by name; if a construct renders
// wrong, the fix is to render it as literal text, never to hand it to the browser as HTML.

function Spans({ spans }) {
  return (
    <>
      {(spans || []).map((s, i) => {
        if (s.type === 'code') {
          return (
            <code key={i} style={{
              font: `0.92em ${MONO}`, background: C.sunken, color: C.bright,
              border: `1px solid ${C.hairline}`, borderRadius: 4, padding: '1px 5px',
            }}>{s.text}</code>
          );
        }
        if (s.type === 'link') {
          return (
            <a
              key={i} href={s.href} target="_blank" rel="noopener noreferrer"
              style={{ color: C.blue, textDecoration: 'none', borderBottom: `1px solid ${C.blue}40` }}
            ><Spans spans={s.children} /></a>
          );
        }
        if (s.type === 'image') {
          return (
            <img
              key={i} src={s.src} alt={s.alt || ''} loading="lazy"
              style={{
                display: 'block', maxWidth: '100%', borderRadius: 6,
                border: `1px solid ${C.hairline}`, margin: '8px 0',
              }}
            />
          );
        }
        if (s.type === 'strong') return <strong key={i} style={{ color: C.bright }}><Spans spans={s.children} /></strong>;
        if (s.type === 'em') return <em key={i}><Spans spans={s.children} /></em>;
        return <React.Fragment key={i}>{s.text}</React.Fragment>;
      })}
    </>
  );
}

/** One message body. Sans for prose, mono for anything that came off a machine. */
const Markdown = memo(function Markdown({ text }) {
  const blocks = useMemo(() => tokenize(text), [text]);
  return (
    <div style={{ font: `14px/1.6 ${SANS}`, color: C.text, overflowWrap: 'anywhere' }}>
      {blocks.map((b, i) => {
        if (b.type === 'code') {
          return (
            <pre key={i} style={{
              background: C.sunken, border: `1px solid ${C.hairline}`, borderRadius: 6,
              padding: '10px 12px', margin: '10px 0', overflowX: 'auto',
              font: `12.5px/1.5 ${MONO}`, color: C.text,
            }}><code>{b.text}</code></pre>
          );
        }
        if (b.type === 'heading') {
          const size = [19, 17, 15.5, 14.5, 14, 13.5][b.level - 1] || 14;
          return (
            <div key={i} style={{
              font: `600 ${size}px/1.35 ${SANS}`, color: C.bright, margin: '14px 0 6px',
            }}><Spans spans={b.spans} /></div>
          );
        }
        if (b.type === 'hr') {
          return <div key={i} style={{ height: 1, background: C.hairline, margin: '14px 0' }} />;
        }
        if (b.type === 'quote') {
          return (
            <div key={i} style={{
              borderLeft: `3px solid ${C.border}`, padding: '2px 0 2px 12px',
              margin: '8px 0', color: C.dim, whiteSpace: 'pre-wrap',
            }}><Spans spans={b.spans} /></div>
          );
        }
        if (b.type === 'list') {
          const List = b.ordered ? 'ol' : 'ul';
          return (
            <List key={i} style={{ margin: '8px 0', paddingLeft: 22 }}>
              {b.items.map((item, j) => (
                <li key={j} style={{ margin: '3px 0' }}><Spans spans={item} /></li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>
            <Spans spans={b.spans} />
          </p>
        );
      })}
    </div>
  );
});

// ─── Chat (#670) ─────────────────────────────────────────────────────────────

const CHAT_MIN = 300;
const CHAT_MAX = 760;
const CHAT_DEFAULT = 420;

const clampChat = (w) => Math.max(CHAT_MIN, Math.min(CHAT_MAX, Math.round(Number(w) || CHAT_DEFAULT)));

// With the pane shut this is byte-identical to the two-column layout Workshop has always
// had, which is what keeps the chat entirely absent rather than merely hidden.
const chatColumns = (w) => (w == null
  ? 'clamp(300px, 27%, 420px) 1fr'
  : `clamp(300px, 27%, 420px) minmax(360px, 1fr) 5px ${w}px`);

/**
 * The divider between the bench and the chat. Pointer capture, not document listeners.
 *
 * The host's three resizers (mod-manager, layout-manager, context-views) all install a
 * document mousemove/mouseup pair and set pointerEvents:'none' on every panel iframe,
 * because they drag ACROSS mod iframes and would otherwise lose the pointer to one. This
 * one is inside a single iframe with no children, so setPointerCapture does the same job
 * with no globals to leak and no teardown to get wrong — it keeps delivering events even
 * when the pointer leaves the window.
 */
function ChatSplitter({ onResize, onReset }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      role="separator" aria-orientation="vertical" aria-label="Resize chat" tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => { if (dragging) onResize(e.clientX); }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        onResize(e.clientX, { commit: true });
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        // Arrows are unbound in keyAction, but stop them anyway: a separator that moved
        // the list cursor as well as itself would be indefensible.
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        onResize(e.key === 'ArrowLeft' ? 16 : -16, { nudge: true, commit: true });
      }}
      title="Drag to resize — double-click to reset"
      style={{
        cursor: 'col-resize', background: dragging ? C.blue : C.hairline,
        transition: dragging ? 'none' : 'background 120ms',
      }}
    />
  );
}

function ChatMessage({ msg }) {
  const mine = msg.role === 'human';
  return (
    <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.hairline}` }}>
      <div style={{
        font: `600 10px ${MONO}`, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: mine ? C.dim : C.blue, marginBottom: 5,
      }}>
        {mine ? 'You' : 'Agent'}
        {msg.pending && <span style={{ color: C.orange, marginLeft: 8 }}>queued</span>}
      </div>
      <Markdown text={msg.text} />
      {msg.truncated && (
        <div style={{ font: `11px ${SANS}`, color: C.dimmer, marginTop: 6 }}>
          … truncated — the whole message is in the tab.
        </div>
      )}
    </div>
  );
}

/**
 * The third column: one session's conversation.
 *
 * Bound to a SESSION, not to the selected item. Two inbox rows from the same agent are one
 * conversation, so moving the cursor between them must not tear this down, reset the
 * scroll, or lose a half-typed question — which is why every piece of state in here is
 * keyed on sessionId and why the effect below does not depend on `selectedId`.
 */
function ChatPane({ sessionId, sessionName, pollMs, composerRef, onStateChange }) {
  const [messages, setMessages] = useState([]);
  const [meta, setMeta] = useState(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const listRef = useRef(null);
  const stickyRef = useRef(true);       // was the reader at the bottom before this update?
  const cursorRef = useRef(null);       // last message id we hold, the `since` cursor
  const threadKeyRef = useRef(null);
  const seqRef = useRef(0);             // monotonic guard: drop a stale in-flight response

  // Everything resets when the SESSION changes — never when the selected item does.
  useEffect(() => {
    setMessages([]); setMeta(null); setPending([]); setError(null); setLoading(true);
    cursorRef.current = null;
    threadKeyRef.current = null;
    stickyRef.current = true;
    // The draft is per-session and survives a cursor move, so it is restored, not cleared.
    setDraft(draftFor(sessionId));
  }, [sessionId]);

  const apply = useCallback((data) => {
    // A fork rotates the transcript onto a new file whose ids we have never seen, so every
    // cursor we hold is stale. Dropping what we have and taking the new thread whole is
    // the entire handling of that: one re-render of visually identical text.
    const rotated = threadKeyRef.current !== null && data.threadKey !== threadKeyRef.current;
    threadKeyRef.current = data.threadKey;
    setMeta(data);
    setMessages((prev) => {
      const base = (rotated || !cursorRef.current) ? [] : prev;
      const next = data.messages.length ? base.concat(data.messages) : base;
      return next;
    });
    if (data.head) cursorRef.current = data.head;
    // Anything the agent has now echoed back is no longer merely queued.
    if (data.messages.length) {
      setPending((p) => p.filter((q) => !data.messages.some((m) => m.text.trim() === q.text.trim())));
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    let timer = null;

    async function tick() {
      if (cancelled) return;
      const seq = ++seqRef.current;
      try {
        const since = cursorRef.current ? `?since=${encodeURIComponent(cursorRef.current)}` : '';
        const r = await fetch(`/api/workshop/chat/${encodeURIComponent(sessionId)}${since}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        // A response that lost the race to a newer one — or to the POST that just ran —
        // would resurrect messages the newer one already reconciled.
        if (cancelled || seq !== seqRef.current) return;
        apply(data);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
      if (!cancelled) setLoading(false);
      if (cancelled) return;
      // Floored at 2s: pollSeconds now drives three loops and this one reads a file.
      timer = setTimeout(tick, document.visibilityState === 'hidden' ? 10000 : Math.max(2000, pollMs));
    }

    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [sessionId, pollMs, apply]);

  // Follow the tail only if the reader was already at it. Yanking the view while someone
  // is reading an older reply is the fastest way to make a live pane unusable.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickyRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  useEffect(() => { if (onStateChange) onStateChange(meta); }, [meta, onStateChange]);

  const closed = meta ? !meta.alive : false;
  const blocked = meta ? !!meta.blocked : false;
  const canSend = !!meta && !closed && !blocked && !sending && draft.trim().length > 0;

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    // Optimistic, and honestly labelled. On the transcript path the message does not appear
    // until Claude ACCEPTS it, which is after whatever turn it is in the middle of — that
    // can be minutes. A pane that showed nothing in the meantime would make a person type
    // it again.
    const optimistic = { id: `pending-${Date.now()}`, role: 'human', text: body, at: Date.now(), pending: true };
    setPending((p) => p.concat(optimistic));
    setDraft('');
    setDraftFor(sessionId, '');
    stickyRef.current = true;
    try {
      const r = await fetch(`/api/workshop/chat/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPending((p) => p.filter((q) => q !== optimistic));
        setDraft(body);
        setError(data.hint || data.error || `HTTP ${r.status}`);
      } else if (data.message) {
        // The store path recorded it durably, so the optimistic copy is redundant.
        setPending((p) => p.filter((q) => q !== optimistic));
        setMessages((m) => m.concat(data.message));
        cursorRef.current = data.message.id;
      }
    } catch (e) {
      setPending((p) => p.filter((q) => q !== optimistic));
      setDraft(body);
      setError(e.message);
    }
    setSending(false);
  }, [draft, sending, sessionId]);

  const shown = messages.concat(pending);
  const placeholder = closed
    ? 'This session has closed.'
    : blocked ? 'Answer the dialog first.' : `Ask ${sessionName || 'this agent'} something…`;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: 0,
      background: C.surface, borderLeft: `1px solid ${C.hairline}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 14px',
        borderBottom: `1px solid ${C.hairline}`, flexShrink: 0,
      }}>
        <span style={{ font: `600 13px ${SANS}`, color: C.bright, flex: 1 }}>Chat</span>
        {meta && meta.source === 'store' && (
          <span
            title="This agent has no transcript to read, so its replies arrive through the workshop_say tool."
            style={{ font: `10px ${MONO}`, letterSpacing: '0.06em', color: C.dimmer, textTransform: 'uppercase' }}
          >via tool</span>
        )}
        {closed && <span style={{ font: `11px ${SANS}`, color: C.orange }}>closed</span>}
      </div>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        {meta && meta.truncated && (
          <div style={{ padding: '8px 16px', font: `11px ${SANS}`, color: C.dimmer, borderBottom: `1px solid ${C.hairline}` }}>
            Showing the most recent messages. Earlier history is in the tab.
          </div>
        )}
        {loading && !shown.length
          ? <div style={{ padding: 20, font: `13px ${SANS}`, color: C.faint }}>Loading…</div>
          : shown.length
            ? shown.map((m) => <ChatMessage key={m.id} msg={m} />)
            : (
              <div style={{ padding: 20, font: `13px/1.6 ${SANS}`, color: C.faint }}>
                {meta && meta.empty === 'no-replies'
                  ? 'Nothing yet. This agent replies through the workshop_say tool — anything it prints in its terminal stays there.'
                  : 'Nothing yet — this session hasn’t been prompted.'}
              </div>
            )}
      </div>

      {error && (
        <div style={{
          flexShrink: 0, padding: '7px 14px', font: `12px ${SANS}`, color: C.red,
          background: 'rgba(248,81,73,0.10)', borderTop: `1px solid ${C.hairline}`,
        }}>{error}</div>
      )}

      <div style={{ flexShrink: 0, padding: 12, borderTop: `1px solid ${C.hairline}`, background: C.bg }}>
        <textarea
          ref={composerRef}
          value={draft}
          disabled={closed || blocked}
          onChange={(e) => { setDraft(e.target.value); setDraftFor(sessionId, e.target.value); }}
          onKeyDown={(e) => {
            // Handled here and stopped here. The document listener maps Cmd-Enter to the
            // ANSWER send, and a message meant for the agent must never fire that.
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              e.stopPropagation();
              send();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.stopPropagation();
              send();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              e.target.blur();
            }
          }}
          placeholder={placeholder}
          rows={3}
          style={{
            width: '100%', resize: 'none', background: C.bg,
            border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px',
            font: `14px/1.5 ${SANS}`, color: closed || blocked ? C.faint : C.text,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button
            type="button" onClick={send} disabled={!canSend}
            style={{
              border: 'none', borderRadius: 5, padding: '5px 11px',
              background: canSend ? C.green : C.hairline, color: canSend ? '#fff' : C.faint,
              font: `600 12px ${SANS}`, cursor: canSend ? 'pointer' : 'default',
            }}
          >{sending ? 'Sending…' : 'Send'}</button>
          <span style={{ flex: 1 }} />
          <span style={{ font: `11px ${SANS}`, color: C.dimmer, textAlign: 'right' }}>
            {closed
              ? 'History stays readable — there is nobody to answer.'
              : blocked
                ? 'Waiting on a dialog — answer that first.'
                : '⏎ to send · queues behind whatever it is doing'}
          </span>
        </div>
      </div>
    </div>
  );
}

// Per-session drafts, in the iframe's own sessionStorage. An app iframe is DESTROYED when
// it is hidden, and the cursor moves between rows of the same session constantly; neither
// should cost a half-typed question.
function draftKey(sessionId) { return `ws-chat-draft:${sessionId}`; }
function draftFor(sessionId) {
  try { return sessionStorage.getItem(draftKey(sessionId)) || ''; } catch { return ''; }
}
function setDraftFor(sessionId, value) {
  try {
    if (value) sessionStorage.setItem(draftKey(sessionId), value);
    else sessionStorage.removeItem(draftKey(sessionId));
  } catch { /* private mode — a lost draft is not worth a crash */ }
}

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
  const [backlog, setBacklog] = useState({ issues: [], projectName: '', error: null });
  const [labels, setLabels] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [zoom, setZoom] = useState(null);   // a result image filename, or null

  // Refs, for the long-lived timers and listeners that must not close over stale state.
  const rootRef = useRef(null);
  const replyRef = useRef(null);
  const chatRef = useRef(null);
  const gridRef = useRef(null);
  const chatWidthRef = useRef(clampChat(DEFAULTS.chatWidth));
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

  // Which project the Backlog is about. NOT getSessions() — this is the host's own
  // notion of the focused tab, which is a single id rather than this window's tab list,
  // so it carries none of that call's window-scoping problem. The server turns the id
  // into a repo root; a worktree tab resolves to its parent repo, so an issue tab asks
  // about the project it is fixing rather than about its own worktree.
  useEffect(() => {
    if (!bridgeReady || !window.deepsteve.onActiveSessionChanged) return undefined;
    return window.deepsteve.onActiveSessionChanged((id) => setActiveSessionId(id || null));
  }, [bridgeReady]);

  const setSetting = useCallback((key, value) => {
    setSettings((s) => ({ ...s, [key]: value }));
    // updateSetting accepts keys that are not in mod.json (tasks.jsx already stores
    // its filters this way), and a fullscreen iframe is DESTROYED on hide — so the
    // host's localStorage is the only place a view toggle can survive.
    window.deepsteve?.updateSetting?.(key, value);
  }, []);

  // ── Chat pane geometry. The live width is a REF and a direct style write; only the
  // released width reaches setSetting, because updateSetting touches localStorage and
  // posts to the host bridge and doing that at pointer-move cadence is 60 writes a second.
  const chatWidth = clampChat(settings.chatWidth);
  useEffect(() => { chatWidthRef.current = chatWidth; }, [chatWidth]);

  const resizeChat = useCallback((x, opts = {}) => {
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    // A nudge is a delta; a drag is an absolute pointer position measured from the RIGHT
    // edge, which is the edge the chat column is pinned to.
    const raw = opts.nudge ? chatWidthRef.current + x : rect.right - x;
    // Never let the bench be squeezed out of existence by the pane that reads it.
    const next = clampChat(Math.min(raw, rect.width - 460));
    chatWidthRef.current = next;
    grid.style.gridTemplateColumns = chatColumns(next);
    if (opts.commit) setSetting('chatWidth', next);
  }, [setSetting]);

  const resetChat = useCallback(() => {
    chatWidthRef.current = CHAT_DEFAULT;
    if (gridRef.current) gridRef.current.style.gridTemplateColumns = chatColumns(CHAT_DEFAULT);
    setSetting('chatWidth', CHAT_DEFAULT);
  }, [setSetting]);

  const toggleChat = useCallback(() => {
    const next = !settings.chatOpen;
    setSetting('chatOpen', next);
    // Opening it is nearly always because you want to type in it.
    if (next) setTimeout(() => chatRef.current?.focus(), 0);
  }, [settings.chatOpen, setSetting]);

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

  // ── Backlog poll (#671). Its own loop, on its own clock: the issue list changes on
  // the order of minutes and every refresh spawns `gh`, so running it at the inbox's 2s
  // would be one subprocess per two seconds per browser window for an answer that is
  // almost always identical. Same shape as the inbox loop above — self-scheduling, backs
  // off while hidden, and keeps the last good list on error.
  const backlogMs = Math.max(30, Math.min(1800, Number(settings.backlogPollSeconds) || 120)) * 1000;
  const issueLabel = String(settings.issueLabel || 'bug');
  useEffect(() => {
    if (!settings.showBacklog) { setBacklog({ issues: [], projectName: '', error: null }); return undefined; }
    let cancelled = false;
    let timer = null;

    async function tick() {
      if (cancelled) return;
      try {
        const q = new URLSearchParams({ label: issueLabel, maxAgeMs: String(backlogMs) });
        if (activeSessionId) q.set('session', activeSessionId);
        const r = await fetch(`/api/workshop/backlog?${q}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        setBacklog({
          issues: Array.isArray(data.issues) ? data.issues : [],
          projectName: data.projectName || '',
          truncated: !!data.truncated,
          error: data.error || null,
        });
      } catch {
        // Deliberately not setError(): that strip is the INBOX's, and a backlog that
        // cannot reach `gh` must not make the inbox look broken. The section's own
        // header shows a dash and the last good list stays.
        if (!cancelled) setBacklog((b) => ({ ...b, error: 'unreachable' }));
      }
      if (cancelled) return;
      timer = setTimeout(tick, document.visibilityState === 'hidden' ? backlogMs * 5 : backlogMs);
    }

    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [settings.showBacklog, issueLabel, backlogMs, activeSessionId]);

  // The label list is fetched once, when you first reach for the picker — not on the
  // poll. A repo's labels change on the order of never, and `gh label list` is a second
  // subprocess nobody asked for on every refresh.
  const loadLabels = useCallback(() => {
    if (labels.length) return;
    const q = new URLSearchParams();
    if (activeSessionId) q.set('session', activeSessionId);
    fetch(`/api/workshop/labels?${q}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && Array.isArray(d.labels)) setLabels(d.labels); })
      .catch(() => {});
  }, [labels.length, activeSessionId]);

  // One root tick drives every row's age. Action Required puts an interval inside each
  // row, which is 40 timers at 40 rows; don't copy that.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Derived view. `order` is render order, and the cursor walks it — never the
  // sorted array, or arrows select a different row from the one highlighted.
  // Sorted by backlog-view.js, which owns that order; visibleItems only appends the ids.
  const backlogView = useMemo(
    () => visibleBacklog(backlog.issues, { collapsed: !!settings.backlogCollapsed }),
    [backlog.issues, settings.backlogCollapsed],
  );

  const view = useMemo(
    () => visibleItems(items, {
      showBriefings: settings.showBriefings,
      blockingOnly: settings.blockingOnly,
      groupByProject: settings.groupByProject,
      // One `order` covers both sections, so ↑/↓ walks out of the inbox and into the
      // backlog. Two sections keeping two orders is the same class of bug the header
      // comment on visibleItems warns about, with one more place to make it.
      backlog: settings.showBacklog ? backlogView.list : [],
      backlogCollapsed: !!settings.backlogCollapsed,
    }),
    [items, settings.showBriefings, settings.blockingOnly, settings.groupByProject,
      settings.showBacklog, settings.backlogCollapsed, backlogView.list],
  );

  useEffect(() => {
    const next = nextSelection(selectedIdRef.current, orderRef.current, view.order);
    orderRef.current = view.order;
    if (next !== selectedIdRef.current) setSelectedId(next);
  }, [view.order]);

  // One cursor walks two sections, so every id lookup has to see both. `rows` is the
  // union in render order, and it is what `selected`, `o` and the excursion walk all
  // index into — three places that would otherwise each need their own branch, and each
  // be a place where a backlog row silently stops responding to a key.
  const rows = useMemo(() => [...view.list, ...view.backlog], [view.list, view.backlog]);

  const selected = useMemo(
    () => rows.find((i) => i.id === selectedId) || null,
    [rows, selectedId],
  );
  const selectedIsIssue = !!selected && selected.kind === 'issue';

  // The chat is bound to the SESSION, not to the item: two rows from the same agent are
  // one conversation, and the pane must not tear down as the cursor moves between them.
  const chatSessionId = (selected && selected.sessionId) || null;
  const chatOpen = !!settings.chatOpen && !!chatSessionId;

  // Reset the staged answer only when the SELECTION changes, never on a poll. Deliberately
  // NOT extended to chat state — that keys on sessionId and lives inside ChatPane.
  useEffect(() => { setPicked(null); setDraft(''); setScreenOpen(false); setZoom(null); }, [selectedId]);

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

  // One key for two things that both mean "I'm done looking at this": a stored item is
  // archived, a live dialog is MUTED — nothing is typed into it and nothing is written,
  // it just stops occupying the inbox until that tab asks something else (#663).
  const archive = useCallback(async () => {
    const item = view.list.find((i) => i.id === selectedIdRef.current);
    if (!item || sendingRef.current) return;
    const verb = item.kind === 'blocked' ? 'dismiss' : 'archive';
    setSending(true);
    sendingRef.current = true;
    try {
      const r = await fetch(`/api/workshop/items/${encodeURIComponent(item.id)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The fingerprint the row was drawn with, echoed back so the server can refuse
        // if this tab has started asking something else since the last poll.
        body: JSON.stringify({ reason: 'archived', expect: item.fingerprint }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.hint || `Couldn’t ${verb} that.`);
      } else {
        setError(null);
      }
    } catch (e) {
      setError(`Couldn’t ${verb} that — ${e.message}`);
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

  // `rows`, not `view.list`: a matched backlog row carries the sessionId of the tab
  // already on that issue, so `o` opens it exactly as it opens a blocked agent's tab.
  const openTab = useCallback(() => {
    visit(rows.find((i) => i.id === selectedIdRef.current));
  }, [rows, visit]);

  // The pop-out, as a keystroke. The row and the bench both render a real <a> — this is
  // only the `g` path, and it needs `allow-popups` on the mod iframe exactly as they do.
  const openGitHub = useCallback(() => {
    const item = rows.find((i) => i.id === selectedIdRef.current);
    if (item && item.kind === 'issue' && item.url) window.open(item.url, '_blank', 'noopener');
  }, [rows]);

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
  useEffect(() => { cycleRef.current = { list: rows, visit }; }, [rows, visit]);
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
      // stopping on one would end the walk at the first unattended agent. An UNMATCHED
      // backlog row is the same case for free: visit() already returns false without a
      // sessionId, so the walk steps over the issues nobody has started and lands on the
      // ones that do have a tab.
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
        //
        // Still two keys with the chat composer in play (#670): what changed is that
        // Cmd-Enter now means something different depending on WHICH box has focus, and
        // that decision lives in typingAction so the truth table is testable. The composer
        // stops its own keys anyway, so this is the belt to its braces.
        const action = typingAction(e.key, {
          meta: e.metaKey || e.ctrlKey,
          chat: e.target === chatRef.current,
        });
        if (action === 'send-answer') { e.preventDefault(); send(); }
        else if (action === 'blur') { e.preventDefault(); e.target.blur(); }
        return;
      }
      if (e.metaKey || e.ctrlKey) return;   // leave the browser's own shortcuts alone

      const item = rows.find((i) => i.id === selectedIdRef.current);
      const action = keyAction(e.key, {
        optionCount: (item && item.options && item.options.length) || 0,
        repeat: e.repeat,
        // A backlog row cannot be answered, archived or option-picked. keyAction returns
        // null for those keys rather than the JSX ignoring the action later, so `e` on an
        // issue never reaches archive() — which looks up in view.list and would silently
        // do nothing, i.e. the same outcome by accident instead of by rule.
        issue: !!item && item.kind === 'issue',
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
        case 'github': openGitHub(); break;
        case 'focusReply': replyRef.current?.focus(); break;
        case 'toggleChat': if (chatSessionId) toggleChat(); break;
        case 'help': setHelpOpen((v) => !v); break;
        case 'escape': setHelpOpen(false); break;
        default: break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows, send, archive, openTab, openGitHub, moveCursor, toggleChat, chatSessionId]);

  useEffect(() => { rootRef.current?.focus(); }, []);

  // ── Render
  const ageOf = (item) => Math.max(0, now - (item.createdAt || now));
  const hasLocalTab = !!(selected && selected.sessionId && localIds.has(selected.sessionId));
  // All of these belong to the answer bench, which an issue never reaches. Gated on
  // selectedIsIssue rather than left to answerPayload's own null: a backlog row is not
  // an unanswerable item, it is not an item at all.
  const showReply = !selectedIsIssue && !!selected
    && (selected.kind === 'question' || selected.kind === 'result');
  const canSend = !selectedIsIssue && !!(selected && (selected.kind === 'briefing'
    || answerPayload(selected, { picked, draft })));
  const pathHint = (selected && !selectedIsIssue) ? PATH_HINT[selected.pendingPath] : null;
  // A result's headline is DERIVED from the first line of its summary, so rendering both
  // the H1 and the raw context says the same sentence twice.
  const body = (selected && !selectedIsIssue) ? itemBody(selected) : '';

  // "Send" says nothing on a result — the two outcomes are opposite, and this label is
  // the last thing read before Enter. Blank until an option is staged, which is also
  // when canSend turns true, so the button never offers a verb it will not perform.
  const sendVerb = (!selected || selectedIsIssue) ? 'Send'
    : selected.kind === 'briefing' ? 'Archive'
      : selected.kind === 'result'
        ? (picked === null ? 'Approve or request changes'
          : (selected.options[picked] || {}).label || 'Send')
        : 'Send';

  const inboxRows = [];
  if (view.groups) {
    for (const group of view.groups) {
      inboxRows.push(<GroupHeader key={'g:' + group.project} name={group.name} count={group.items.length} />);
      for (const item of group.items) {
        inboxRows.push(
          <ItemRow
            key={item.id} item={item} selected={item.id === selectedId}
            ageMs={ageOf(item)} compact={settings.compactRows} onSelect={setSelectedId}
          />,
        );
      }
    }
  } else {
    for (const item of view.list) {
      inboxRows.push(
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

      <div ref={gridRef} style={{
        flex: 1, minHeight: 0, display: 'grid',
        gridTemplateColumns: chatColumns(chatOpen ? chatWidth : null),
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
            : inboxRows}

          {/* ── Backlog: the other half of "what needs me". It scrolls WITH the inbox
              rather than owning a pane, because the point is reading both in one
              glance — an issue nobody has picked up is only interesting next to the
              agents that are already running. */}
          {settings.showBacklog && (
            <>
              <BacklogHeader
                projectName={backlog.projectName}
                label={issueLabel}
                labels={labels}
                count={backlogView.list.length}
                collapsed={!!settings.backlogCollapsed}
                error={backlog.error}
                onToggle={() => setSetting('backlogCollapsed', !settings.backlogCollapsed)}
                onLabel={(v) => setSetting('issueLabel', v)}
                onLabelMenu={loadLabels}
              />
              {!settings.backlogCollapsed && (
                backlog.error
                  ? <div style={{ padding: '10px 12px', font: `12px ${SANS}`, color: C.faint }}>
                    {BACKLOG_ERRORS[backlog.error] || 'The issue list is unavailable.'}
                  </div>
                  : backlogView.list.length === 0
                    ? <div style={{ padding: '10px 12px', font: `12px ${SANS}`, color: C.faint }}>
                      Nothing open with this label.
                    </div>
                    : <>
                      {backlogView.list.map((issue) => (
                        <BacklogRow
                          key={issue.id} issue={issue} selected={issue.id === selectedId}
                          now={now} compact={settings.compactRows} onSelect={setSelectedId}
                        />
                      ))}
                      {/* gh pages at 100. Saying so is the difference between a capped
                          list and a list that looks complete but isn't. */}
                      {backlog.truncated && (
                        <div style={{ padding: '8px 12px', font: `11px ${SANS}`, color: C.faint }}>
                          Showing the first {backlogView.list.length} — there are more on GitHub.
                        </div>
                      )}
                    </>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Right: the bench ── */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* An issue gets its OWN bench, not a branch inside the answer bench. There is
            nothing here to answer, pick or archive, so every control the inbox bench
            carries would be dead — and the send bar below it must not render at all. */}
        {selectedIsIssue ? (
          <IssueBench
            issue={selected} now={now} hasLocalTab={hasLocalTab} onShowTab={openTab}
          />
        ) : !selected ? <EmptyState /> : (
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
              {chatSessionId && (
                <button
                  type="button" onClick={toggleChat}
                  title="Ask this agent about its work, without leaving Workshop"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    border: `1px solid ${settings.chatOpen ? C.blue : C.border}`, borderRadius: 5,
                    background: 'transparent', color: settings.chatOpen ? C.blue : C.text,
                    font: `12px ${SANS}`, padding: '3px 8px', cursor: 'pointer',
                  }}
                ><Key active={settings.chatOpen}>c</Key> Chat</button>
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, position: 'relative' }}>
              <div style={{ maxWidth: 760, padding: '24px 32px 28px' }}>
                <h1 style={{
                  font: `600 22px/1.3 ${SANS}`, letterSpacing: '-0.01em', color: C.bright,
                }}>{selected.headline || selected.question || '(no subject)'}</h1>

                {body && (
                  <div style={{
                    font: `15px/1.6 ${selected.kind === 'blocked' ? MONO : SANS}`,
                    color: C.text, whiteSpace: 'pre-wrap', marginTop: 12,
                  }}>{body}</div>
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

                {selected.kind === 'result' && (
                  <ResultBody item={selected} onZoom={setZoom} />
                )}

                {selected.kind === 'blocked' && !selected.answerable && (
                  <div style={{ font: `13px/1.6 ${SANS}`, color: C.orange, marginTop: 18 }}>
                    This dialog couldn’t be read well enough to answer from here — the screen is
                    below. Press <Key>o</Key> to open the tab and deal with it there, or
                    <Key>e</Key> to drop the row and leave the dialog alone.
                  </div>
                )}

                {showReply && (
                  <textarea
                    ref={replyRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={selected.kind === 'result'
                      ? 'Why it needs changing \u2014 required to request changes, optional to approve'
                      : 'Reply \u2014 Enter for a newline, \u2318\u23ce to send'}
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
                <Key>{'⏎'}</Key> {sendVerb}
              </button>
              {selected.kind !== 'briefing' && (
                <button
                  type="button" onClick={archive} disabled={sending}
                  title={selected.kind === 'blocked'
                    ? 'Drop this row. The dialog is left alone, and comes back if the tab asks something else.'
                    : 'Archive this item without answering it.'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    border: `1px solid ${C.border}`, borderRadius: 5, padding: '6px 12px',
                    background: 'transparent',
                    color: C.text,
                    font: `13px ${SANS}`,
                    cursor: sending ? 'default' : 'pointer',
                  }}
                ><Key>e</Key> {selected.kind === 'blocked' ? 'Dismiss' : 'Archive'}</button>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ font: `11px ${SANS}`, color: C.dimmer, textAlign: 'right' }}>
                {sending ? 'Sending…' : (pathHint || 'Nothing to answer')}
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Right of the bench: the conversation ── */}
      {chatOpen && (
        <>
          <ChatSplitter onResize={resizeChat} onReset={resetChat} />
          <ChatPane
            key={chatSessionId}
            sessionId={chatSessionId}
            sessionName={selected && (selected.sessionName || selected.sessionId)}
            pollMs={pollMs}
            composerRef={chatRef}
          />
        </>
      )}
      </div>

      {zoom && <Lightbox file={zoom} onClose={() => setZoom(null)} />}

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
              ['e', 'archive / dismiss a dialog'],
              ['o', 'open the tab'],
              ['g', 'open the issue on GitHub'],
              ['r', 'reply box'],
              ['c', 'chat with this session'],
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

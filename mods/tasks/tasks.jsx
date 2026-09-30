import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
const { useState, useEffect, useCallback, useRef } = React;

const PRIORITY_COLORS = {
  high: '#f85149',
  medium: '#f0883e',
  low: '#8b949e',
};

const STATUS_OPTIONS = ['all', 'pending', 'in-progress', 'done'];

// A task's session badges, and the picker that adds them, collapse past this many (#719).
const SESSIONS_SHOWN = 10;

// A session closing does not re-broadcast the task list, so the panel re-reads it on this tick,
// which also moves "closed 3 minutes ago" along.
const REFRESH_MS = 60 * 1000;

const GONE_TITLE = 'This closed session was removed by the closed-session retention sweep and can\'t be reopened.';

// A copy of formatTimeAgo in public/js/session-restore-modal.js. Importing that module would load
// tab-manager.js into this iframe.
function formatTimeAgo(ms, now) {
  const seconds = Math.floor((now - ms) / 1000);
  if (seconds < 60) return 'just now';
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (seconds < 3600) return plural(Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return plural(Math.floor(seconds / 3600), 'hour');
  return plural(Math.floor(seconds / 86400), 'day');
}

/** The words after a session's name on its badge. The server decides `state`; see tools.js. */
function sessionStatusText(session, now) {
  if (session.state === 'closed') return session.closedAt ? `closed ${formatTimeAgo(session.closedAt, now)}` : 'closed';
  if (session.state === 'saved') return 'not running';
  if (session.state === 'gone') return 'gone';
  return null;
}

const pillStyle = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.06)',
  color: '#8b949e',
  border: '1px solid #30363d',
};

const chipButtonStyle = {
  ...pillStyle,
  cursor: 'pointer',
  fontFamily: 'inherit',
  lineHeight: 'inherit',
};

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

/** Bring a task's session forward, or reopen it. The server decides which. */
function openTaskSession(taskId, sessionId) {
  const windowId = window.deepsteve?.getWindowId?.() || null;
  return postJSON(`/api/tasks/${taskId}/sessions/${encodeURIComponent(sessionId)}/open`, { windowId });
}

function SessionBadge({ session, now, onOpen }) {
  const status = sessionStatusText(session, now);
  const live = session.state === 'live';
  const gone = session.state === 'gone';
  return (
    <button
      type="button"
      disabled={gone}
      onClick={() => onOpen(session)}
      title={live ? 'Go to this session' : gone ? GONE_TITLE : 'Show this session\'s history'}
      style={{
        ...chipButtonStyle,
        display: 'inline-flex',
        gap: 4,
        maxWidth: '100%',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        cursor: gone ? 'default' : 'pointer',
        opacity: gone ? 0.5 : 1,
        ...(live ? {
          background: 'rgba(88,166,255,0.1)',
          color: '#58a6ff',
          border: '1px solid rgba(88,166,255,0.2)',
        } : {}),
      }}
    >
      {live && <span style={{ color: '#3fb950' }}>&#9679;</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{session.label}</span>
      {status && <span style={{ flexShrink: 0 }}>&middot; {status}</span>}
    </button>
  );
}

const basename = (p) => (p || '').split('/').filter(Boolean).pop() || '';

/** GET /api/shells rows -> picker rows: live sessions first, then the most recently closed. */
function pickerRows(shells) {
  const byId = new Map();
  for (const s of shells) {
    if (!s || !s.id || s.agentType === 'tmux-attach') continue;
    // A live session wins over a saved record for the same id.
    if (!byId.has(s.id) || s.status === 'active') byId.set(s.id, s);
  }
  const rank = (s) => (s.status === 'active' ? 1 : 0);
  const when = (s) => (s.status === 'closed' ? (s.closedAt || s.lastActivity) : s.lastActivity) || 0;
  return [...byId.values()]
    .sort((a, b) => rank(b) - rank(a) || when(b) - when(a))
    .map((s) => ({
      id: s.id,
      label: s.name || basename(s.cwd) || s.id,
      cwd: s.cwd || '',
      state: s.status === 'active' ? 'live' : s.status,
      closedAt: s.closedAt || s.lastActivity || null,
    }));
}

function SessionPicker({ task, now }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/shells')
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setRows(pickerRows(data.shells || [])); })
      .catch(() => { if (!cancelled) setError('Could not load sessions.'); });
    return () => { cancelled = true; };
  }, []);

  const attached = new Set((task.sessions || []).map((s) => s.id));

  const toggle = useCallback(async (row) => {
    setError(null);
    try {
      if (attached.has(row.id)) {
        const res = await fetch(`/api/tasks/${task.id}/sessions/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        await postJSON(`/api/tasks/${task.id}/sessions`, { sessionId: row.id });
      }
    } catch (e) {
      setError(`Could not update the task: ${e.message}`);
    }
  }, [task.id, task.sessions]);

  if (error && !rows) return <div style={{ fontSize: 11, color: '#f85149', marginTop: 6 }}>{error}</div>;
  if (!rows) return <div style={{ fontSize: 11, color: '#8b949e', marginTop: 6 }}>Loading sessions&hellip;</div>;

  const q = query.trim().toLowerCase();
  const matching = q
    ? rows.filter((r) => r.label.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q) || r.id.includes(q))
    : rows;
  const shown = showAll ? matching : matching.slice(0, SESSIONS_SHOWN);

  return (
    <div style={{
      marginTop: 6,
      border: '1px solid #30363d',
      borderRadius: 6,
      padding: 6,
      background: 'rgba(255,255,255,0.02)',
    }}>
      <input
        type="text"
        value={query}
        placeholder="Filter sessions"
        onChange={(e) => setQuery(e.target.value)}
        style={{
          width: '100%',
          padding: '3px 6px',
          fontSize: 11,
          background: '#0d1117',
          border: '1px solid #30363d',
          borderRadius: 4,
          color: '#c9d1d9',
          marginBottom: 4,
        }}
      />
      {error && <div style={{ fontSize: 11, color: '#f85149', margin: '2px 0' }}>{error}</div>}
      {matching.length === 0 && (
        <div style={{ fontSize: 11, color: '#8b949e', padding: '2px 0' }}>No sessions match.</div>
      )}
      {shown.map((row) => (
        <label
          key={row.id}
          title={`${row.cwd} (${row.id})`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '2px 0', cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={attached.has(row.id)}
            onChange={() => toggle(row)}
            style={{ accentColor: '#238636', cursor: 'pointer', flexShrink: 0, margin: 0 }}
          />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#c9d1d9' }}>
            {row.label}
          </span>
          <span style={{ flexShrink: 0, color: row.state === 'live' ? '#3fb950' : '#8b949e' }}>
            {row.state === 'live' ? 'live' : sessionStatusText(row, now)}
          </span>
        </label>
      ))}
      {matching.length > SESSIONS_SHOWN && (
        <button type="button" onClick={() => setShowAll((v) => !v)} style={{ ...chipButtonStyle, marginTop: 4 }}>
          {showAll ? 'Show fewer' : `Show all (${matching.length})`}
        </button>
      )}
    </div>
  );
}

// Which transcript entries are the conversation: what the human typed, and the agent's final
// answers. The same predicates as isPromptEntry / isAnswerEntry in public/js/session-history.js,
// copied because importing that module registers a global shortcut.
const isPromptEntry = (e) => !!e && e.role === 'user' && e.kind === 'text' && !e.meta;
const isAnswerEntry = (e) => !!e && e.role === 'assistant' && e.kind === 'text' && !e.meta && e.stopReason === 'end_turn';

/** A closed session's history, with the offer to reopen it (#719). Covers the panel. */
function HistoryView({ taskId, session, now, onClose }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [openError, setOpenError] = useState(null);
  const [reopening, setReopening] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/shells/${encodeURIComponent(session.id)}/transcript?limit=200`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.status === 404) throw new Error('This session\'s record is gone, so there is no history to show.');
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [session.id]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [data]);

  const reopen = useCallback(async () => {
    setReopening(true);
    setOpenError(null);
    try {
      await openTaskSession(taskId, session.id);
      onClose();
    } catch (e) {
      setOpenError(e.message);
      setReopening(false);
    }
  }, [taskId, session.id, onClose]);

  const messages = data ? (data.entries || []).filter((e) => isPromptEntry(e) || isAnswerEntry(e)) : [];
  let empty = null;
  if (data && data.supported === false) empty = 'This agent keeps no transcript, so there is no history to show.';
  else if (data && !data.exists) empty = 'No conversation on disk for this session. Reopening starts a fresh agent in the same folder.';
  else if (data && messages.length === 0) empty = 'No messages in the latest part of this conversation.';

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'var(--ds-bg-primary, #0d1117)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
    }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#f0f6fc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.label}
            </div>
            <div style={{ fontSize: 11, color: '#8b949e' }}>{sessionStatusText(session, now)}</div>
          </div>
          <button
            type="button"
            onClick={reopen}
            disabled={reopening}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              border: 'none',
              borderRadius: 4,
              cursor: reopening ? 'default' : 'pointer',
              background: '#238636',
              color: '#fff',
              opacity: reopening ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            {reopening ? 'Reopening…' : 'Reopen'}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close history"
            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 14, padding: '0 4px', flexShrink: 0 }}
          >
            &#10005;
          </button>
        </div>
        {openError && <div style={{ fontSize: 11, color: '#f85149', marginTop: 6 }}>{openError}</div>}
      </div>
      <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {!data && !loadError && <div style={{ fontSize: 12, color: '#8b949e' }}>Loading history&hellip;</div>}
        {loadError && <div style={{ fontSize: 12, color: '#f85149' }}>{loadError}</div>}
        {empty && <div style={{ fontSize: 12, color: '#8b949e' }}>{empty}</div>}
        {data && data.cursor && data.cursor.hasMore && messages.length > 0 && (
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 8 }}>
            Showing the latest part of this conversation.
          </div>
        )}
        {messages.map((m) => (
          <div key={`${m.offset}:${m.seq}`} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: m.role === 'user' ? '#58a6ff' : '#3fb950', marginBottom: 2 }}>
              {m.role === 'user' ? 'You' : 'Agent'}
            </div>
            <div style={{ fontSize: 12, color: '#c9d1d9', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {m.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderOlGroup(items) {
  const result = [];
  let i = 0;
  const baseIndent = items[0].indent;
  while (i < items.length) {
    const item = items[i];
    if (item.indent > baseIndent) {
      // Collect all consecutive items with indent > baseIndent as a nested group
      const nested = [];
      while (i < items.length && items[i].indent > baseIndent) {
        nested.push(items[i]);
        i++;
      }
      // Append nested <ol> inside the previous <li>
      if (result.length > 0) {
        const prev = result[result.length - 1];
        result[result.length - 1] = (
          <li key={prev.key} style={{ padding: '1px 0' }}>
            {prev.props.children}
            {renderOlGroup(nested)}
          </li>
        );
      } else {
        // Nested items with no parent — render them as a standalone nested list
        result.push(renderOlGroup(nested));
      }
    } else {
      result.push(
        <li key={item.lineIndex} style={{ padding: '1px 0' }}>{item.text}</li>
      );
      i++;
    }
  }
  return (
    <ol style={{ margin: '2px 0', paddingLeft: 20, listStyleType: 'decimal' }}>
      {result}
    </ol>
  );
}

function renderDescription(description, onCheckToggle) {
  if (!description) return null;
  const lines = description.split('\n');
  const checklistRe = /^- \[([ xX])\] (.*)$/;
  const orderedRe = /^(\s*)(\d+)\.\s+(.*)$/;

  const elements = [];
  let olBuffer = [];

  function flushOl() {
    if (olBuffer.length === 0) return;
    elements.push(
      <React.Fragment key={`ol-${olBuffer[0].lineIndex}`}>
        {renderOlGroup(olBuffer)}
      </React.Fragment>
    );
    olBuffer = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Ordered list item
    const olMatch = line.match(orderedRe);
    if (olMatch) {
      olBuffer.push({ indent: olMatch[1].length, text: olMatch[3], lineIndex: i });
      continue;
    }

    // Flush any pending OL items before rendering a non-OL line
    flushOl();

    // Checkbox line
    const checkMatch = line.match(checklistRe);
    if (checkMatch) {
      const checked = checkMatch[1] !== ' ';
      const text = checkMatch[2];
      elements.push(
        <label key={i} style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 5,
          padding: '1px 0',
          cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onCheckToggle(i)}
            style={{ marginTop: 2, accentColor: '#238636', cursor: 'pointer', flexShrink: 0 }}
          />
          <span style={{
            textDecoration: checked ? 'line-through' : 'none',
            opacity: checked ? 0.6 : 1,
          }}>
            {text}
          </span>
        </label>
      );
      continue;
    }

    // Plain text or empty line
    elements.push(
      line ? <div key={i}>{line}</div> : <div key={i} style={{ height: 4 }} />
    );
  }

  flushOl();

  return (
    <div style={{ fontSize: 12, color: '#8b949e', marginTop: 3, wordBreak: 'break-word' }}>
      {elements}
    </div>
  );
}

function TaskItem({ task, compact, now, onToggle, onDelete, onDescriptionUpdate, onOpenSession }) {
  const isDone = task.status === 'done';
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const sessions = task.sessions || [];
  const shownSessions = showAllSessions ? sessions : sessions.slice(0, SESSIONS_SHOWN);

  const handleCheckToggle = useCallback((lineIndex) => {
    const lines = task.description.split('\n');
    const checklistRe = /^- \[([ xX])\] (.*)$/;
    const m = lines[lineIndex].match(checklistRe);
    if (!m) return;
    const checked = m[1] !== ' ';
    lines[lineIndex] = `- [${checked ? ' ' : 'x'}] ${m[2]}`;
    onDescriptionUpdate(task.id, lines.join('\n'));
  }, [task.id, task.description, onDescriptionUpdate]);

  return (
    <div style={{
      padding: compact ? '5px 12px' : '10px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      opacity: isDone ? 0.5 : 1,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
    }}>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onToggle(task.id, isDone ? 'pending' : 'done')}
        style={{ marginTop: 3, accentColor: '#238636', cursor: 'pointer', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          color: isDone ? '#8b949e' : '#c9d1d9',
          textDecoration: isDone ? 'line-through' : 'none',
          wordBreak: 'break-word',
        }}>
          {task.title}
        </div>
        {!compact && renderDescription(task.description, handleCheckToggle)}
        {!compact && (
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {task.priority && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.06)',
                color: PRIORITY_COLORS[task.priority] || '#8b949e',
                border: `1px solid ${PRIORITY_COLORS[task.priority] || '#30363d'}33`,
              }}>
                {task.priority}
              </span>
            )}
            {task.session_tag && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(88,166,255,0.1)',
                color: '#58a6ff',
                border: '1px solid rgba(88,166,255,0.2)',
              }}>
                {task.session_tag}
              </span>
            )}
            {task.status === 'in-progress' && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(240,136,62,0.1)',
                color: '#f0883e',
                border: '1px solid rgba(240,136,62,0.2)',
              }}>
                in progress
              </span>
            )}
          </div>
        )}
        {!compact && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {shownSessions.map(s => (
              <SessionBadge key={s.id} session={s} now={now} onOpen={(session) => onOpenSession(task, session)} />
            ))}
            {sessions.length > SESSIONS_SHOWN && (
              <button type="button" onClick={() => setShowAllSessions(v => !v)} style={chipButtonStyle}>
                {showAllSessions ? 'fewer' : `+${sessions.length - SESSIONS_SHOWN} more`}
              </button>
            )}
            <button
              type="button"
              onClick={() => setPickerOpen(v => !v)}
              title="Attach or detach sessions"
              style={{ ...chipButtonStyle, borderStyle: 'dashed', color: pickerOpen ? '#58a6ff' : '#8b949e' }}
            >
              {pickerOpen ? 'done' : '+ session'}
            </button>
          </div>
        )}
        {!compact && pickerOpen && <SessionPicker task={task} now={now} />}
      </div>
      <button
        onClick={() => onDelete(task.id)}
        style={{
          background: 'none',
          border: 'none',
          color: '#8b949e',
          cursor: 'pointer',
          fontSize: 14,
          padding: '0 4px',
          opacity: 0.5,
          flexShrink: 0,
        }}
        onMouseEnter={e => e.target.style.opacity = 1}
        onMouseLeave={e => e.target.style.opacity = 0.5}
        title="Delete task"
      >
        &#10005;
      </button>
    </div>
  );
}

function TasksPanel() {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [compactView, setCompactView] = useState(false);
  // "This project": only the tasks of the project selected in the rail. null there means All,
  // which leaves nothing to narrow to, so every task shows.
  const [projectOnly, setProjectOnly] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [projects, setProjects] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [history, setHistory] = useState(null);   // { taskId, session } while a history is up
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let unsubTasks = null;
    let unsubSettings = null;
    let unsubSessions = null;
    let unsubProjects = null;
    let unsubActiveProject = null;
    let refreshTimer = null;
    let sessionsTimer = null;

    // Each task's session states are read by the server as the list goes out, and a session
    // closing does not re-send the list. So re-read it on a tick, and shortly after this window's
    // tabs change — shortly after, because the close reaches the server after the tab is gone.
    const refresh = () => {
      fetch('/api/tasks').then(r => r.json()).then(data => setTasks(data.tasks || [])).catch(() => {});
      setNow(Date.now());
    };

    function setup() {
      unsubTasks = window.deepsteve.onTasksChanged((newTasks) => {
        setTasks(newTasks || []);
      });

      let lastIds = null;
      unsubSessions = window.deepsteve.onSessionsChanged((list) => {
        const ids = (list || []).map(s => s.id).sort().join(',');
        if (lastIds !== null && ids !== lastIds) {
          clearTimeout(sessionsTimer);
          sessionsTimer = setTimeout(refresh, 1000);
        }
        lastIds = ids;
      });
      refreshTimer = setInterval(refresh, REFRESH_MS);

      // The rail's projects, for the toggle's label, and which one is selected.
      if (window.deepsteve.onContextsChanged) {
        unsubProjects = window.deepsteve.onContextsChanged((list) => setProjects(list || []));
      }
      if (window.deepsteve.onActiveContextChanged) {
        unsubActiveProject = window.deepsteve.onActiveContextChanged((id) => setActiveProjectId(id || null));
      }

      // Restore persisted settings
      const settings = window.deepsteve.getSettings();
      if (settings.compactView != null) setCompactView(settings.compactView);
      if (settings.projectOnly != null) setProjectOnly(settings.projectOnly);
      if (settings.statusFilter != null) setFilter(settings.statusFilter);
      if (settings.tagFilter != null) setTagFilter(settings.tagFilter);

      // React to settings changes (e.g. toggled from settings panel)
      unsubSettings = window.deepsteve.onSettingsChanged((settings) => {
        if (settings.compactView != null) setCompactView(settings.compactView);
        if (settings.projectOnly != null) setProjectOnly(settings.projectOnly);
        if (settings.statusFilter != null) setFilter(settings.statusFilter);
        if (settings.tagFilter != null) setTagFilter(settings.tagFilter);
      });
    }

    // Bridge API is injected by the parent after iframe load event,
    // so it may not be available yet when this effect runs. Poll for it.
    if (window.deepsteve) {
      setup();
    } else {
      let attempts = 0;
      const poll = setInterval(() => {
        if (window.deepsteve) {
          clearInterval(poll);
          setup();
        } else if (++attempts > 100) {
          clearInterval(poll);
        }
      }, 100);
    }

    return () => {
      if (unsubTasks) unsubTasks();
      if (unsubSettings) unsubSettings();
      if (unsubSessions) unsubSessions();
      if (unsubProjects) unsubProjects();
      if (unsubActiveProject) unsubActiveProject();
      clearInterval(refreshTimer);
      clearTimeout(sessionsTimer);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // A live session goes to its tab: this window's own tab directly, anything else through the
  // server, which knows which window has it. Any other session shows its history first, and
  // the history offers the reopen.
  const openSession = useCallback(async (task, session) => {
    if (session.state === 'gone') return;
    if (session.state !== 'live') {
      setHistory({ taskId: task.id, session });
      return;
    }
    const ds = window.deepsteve;
    if (ds && (ds.getSessions() || []).some(s => s.id === session.id)) {
      ds.focusSession(session.id);
      return;
    }
    try {
      await openTaskSession(task.id, session.id);
    } catch (e) {
      setNotice(`Could not open "${session.label}": ${e.message}`);
    }
  }, []);

  const closeHistory = useCallback(() => setHistory(null), []);

  const toggleStatus = useCallback(async (id, newStatus) => {
    try {
      await fetch(`/api/tasks/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
    } catch (e) {
      console.error('Failed to update task:', e);
    }
  }, []);

  const deleteTask = useCallback(async (id) => {
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to delete task:', e);
    }
  }, []);

  const updateDescription = useCallback(async (id, description) => {
    try {
      await fetch(`/api/tasks/${id}/description`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
    } catch (e) {
      console.error('Failed to update description:', e);
    }
  }, []);

  const handleFilterChange = useCallback((s) => {
    setFilter(s);
    if (window.deepsteve) window.deepsteve.updateSetting('statusFilter', s);
  }, []);

  const handleTagFilterChange = useCallback((t) => {
    setTagFilter(t);
    if (window.deepsteve) window.deepsteve.updateSetting('tagFilter', t);
  }, []);

  const toggleCompactView = useCallback(() => {
    setCompactView(prev => {
      const next = !prev;
      if (window.deepsteve) window.deepsteve.updateSetting('compactView', next);
      return next;
    });
  }, []);

  const toggleProjectOnly = useCallback(() => {
    setProjectOnly(prev => {
      const next = !prev;
      if (window.deepsteve) window.deepsteve.updateSetting('projectOnly', next);
      return next;
    });
  }, []);

  // Get unique session tags for filter dropdown
  const tags = [...new Set(tasks.map(t => t.session_tag).filter(Boolean))];

  // A task's project is derived by the server from where its sessions ran (tools.js taskProject),
  // so a task with no session in any project belongs to none and is hidden here.
  const scoped = projectOnly && activeProjectId;
  const activeProject = projects.find(p => p.id === activeProjectId) || null;
  const projectName = activeProject ? activeProject.name : 'this project';
  const inScope = scoped ? tasks.filter(t => t.project && t.project.id === activeProjectId) : tasks;

  // Apply filters
  let filtered = inScope;
  if (filter !== 'all') filtered = filtered.filter(t => t.status === filter);
  if (tagFilter !== 'all') filtered = filtered.filter(t => t.session_tag === tagFilter);

  // Sort: pending first, then in-progress, then done
  const statusOrder = { 'pending': 0, 'in-progress': 1, 'done': 2 };
  filtered = [...filtered].sort((a, b) => (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc', marginBottom: 8, display: 'flex', alignItems: 'center' }}>
          <span>
            Tasks
            {inScope.length > 0 && (
              <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400, marginLeft: 6 }}>
                {inScope.filter(t => t.status !== 'done').length} pending
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={toggleProjectOnly}
            title={!projectOnly
              ? (activeProjectId ? `Show only the tasks in ${projectName}` : 'Show only the tasks in the project selected in the rail')
              : scoped
                ? `Showing only the tasks in ${projectName}. Click to show every project's.`
                : 'No project is selected in the rail, so every task shows. Select one to narrow the list.'}
            style={{
              ...chipButtonStyle,
              marginLeft: 'auto',
              maxWidth: 140,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 400,
              ...(projectOnly ? {
                background: scoped ? '#58a6ff' : 'rgba(88,166,255,0.1)',
                color: scoped ? '#fff' : '#58a6ff',
                border: '1px solid rgba(88,166,255,0.4)',
              } : {}),
            }}
          >
            {scoped && activeProject ? activeProject.name : 'This project'}
          </button>
          <button
            onClick={toggleCompactView}
            style={{
              marginLeft: 6,
              background: 'none',
              border: 'none',
              color: compactView ? '#58a6ff' : '#8b949e',
              cursor: 'pointer',
              fontSize: 14,
              padding: '0 2px',
              lineHeight: 1,
            }}
            title={compactView ? 'Expand view' : 'Compact view'}
          >
            &#9776;
          </button>
        </div>

        {/* Status filter */}
        <div style={{ display: 'flex', gap: 2, marginBottom: tags.length > 0 ? 6 : 0 }}>
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              onClick={() => handleFilterChange(s)}
              style={{
                padding: '3px 8px',
                fontSize: 11,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                background: filter === s ? '#58a6ff' : 'rgba(255,255,255,0.06)',
                color: filter === s ? '#fff' : '#8b949e',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Session tag filter */}
        {tags.length > 0 && (
          <select
            value={tagFilter}
            onChange={e => handleTagFilterChange(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: 11,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 4,
              color: '#c9d1d9',
              cursor: 'pointer',
            }}
          >
            <option value="all">All sessions</option>
            {tags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {notice && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: '#f85149', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          {notice}
        </div>
      )}

      {/* Task list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            {tasks.length === 0
              ? 'No tasks yet. Claude sessions can create tasks via MCP tools.'
              : scoped && inScope.length === 0
                ? `No tasks in ${projectName}.`
                : 'No tasks match the current filter.'}
          </div>
        ) : (
          filtered.map(task => (
            <TaskItem
              key={task.id}
              task={task}
              compact={compactView}
              now={now}
              onToggle={toggleStatus}
              onDelete={deleteTask}
              onDescriptionUpdate={updateDescription}
              onOpenSession={openSession}
            />
          ))
        )}
      </div>

      {history && (
        <HistoryView
          key={history.session.id}
          taskId={history.taskId}
          session={history.session}
          now={now}
          onClose={closeHistory}
        />
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('tasks-root'));
root.render(<TasksPanel />);

const { useState, useEffect, useCallback, useRef } = React;

const TYPE_CONFIG = {
  state:     { icon: '\u25CF', color: '#58a6ff', label: 'state' },     // blue dot
  file:      { icon: '\u25C6', color: '#3fb950', label: 'file' },      // green diamond
  git:       { icon: '\u2387', color: '#bc8cff', label: 'git' },       // purple branch-like
  error:     { icon: '\u2717', color: '#f85149', label: 'error' },     // red x
  milestone: { icon: '\u2605', color: '#f0883e', label: 'milestone' }, // orange star
};

const MAX_TICKER_ITEMS = 5;

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTickerHTML(events) {
  const recent = events.slice(-MAX_TICKER_ITEMS).reverse();
  if (recent.length === 0) return '';
  return recent.map((ev, i) => {
    const cfg = TYPE_CONFIG[ev.type] || TYPE_CONFIG.state;
    const sep = i < recent.length - 1 ? '<span class="ticker-sep">\u00b7</span>' : '';
    const raw = ev.message.length > 40 ? ev.message.slice(0, 40) + '\u2026' : ev.message;
    const msg = escapeHTML(raw);
    const name = escapeHTML(ev.sessionName || '');
    return `<span class="ticker-item"><span class="ticker-icon" style="color:${cfg.color}">${cfg.icon}</span><span class="ticker-name">${name}</span><span class="ticker-msg">${msg}</span></span>${sep}`;
  }).join('');
}

const FILTER_OPTIONS = ['all', 'state', 'file', 'git', 'error', 'milestone'];

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 5000) return 'just now';
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function EventItem({ event, onClickSession }) {
  const cfg = TYPE_CONFIG[event.type] || TYPE_CONFIG.state;
  const isMilestone = event.type === 'milestone';

  if (isMilestone) {
    return (
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      }}>
        <span style={{ color: cfg.color, fontSize: 12, flexShrink: 0, marginTop: 2 }}>{cfg.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13 }}>
            <span
              onClick={() => event.sessionId && onClickSession(event.sessionId)}
              style={{
                fontWeight: 700,
                color: '#f0f6fc',
                cursor: event.sessionId ? 'pointer' : 'default',
              }}
              title={event.sessionId ? 'Focus session' : ''}
            >
              {event.sessionName}
            </span>
            <span style={{ color: '#8b949e' }}>: </span>
            <span style={{ color: '#c9d1d9' }}>{event.message}</span>
          </div>
          <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>
            {relativeTime(event.timestamp)}
          </div>
        </div>
      </div>
    );
  }

  // Passive events: compact status line style
  return (
    <div style={{
      padding: '5px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.03)',
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      fontSize: 12,
      color: '#8b949e',
    }}>
      <span style={{ color: cfg.color, fontSize: 10, flexShrink: 0 }}>{cfg.icon}</span>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span
          onClick={() => event.sessionId && onClickSession(event.sessionId)}
          style={{
            color: '#c9d1d9',
            cursor: event.sessionId ? 'pointer' : 'default',
          }}
          title={event.sessionId ? 'Focus session' : ''}
        >
          {event.sessionName}
        </span>
        <span style={{ color: '#30363d' }}> &middot; </span>
        <span style={{ color: event.level === 'error' ? '#f85149' : '#8b949e' }}>
          {event.message}
        </span>
      </div>
      <span style={{ fontSize: 10, color: '#484f58', flexShrink: 0 }}>
        {relativeTime(event.timestamp)}
      </span>
    </div>
  );
}

function ActivityPanel() {
  const [events, setEvents] = useState([]);
  const [typeFilter, setTypeFilter] = useState('all');
  const [sessionFilter, setSessionFilter] = useState('all');
  const [, setTick] = useState(0);
  const listRef = useRef(null);
  const eventsRef = useRef([]);
  const tickerEnabledRef = useRef(false);

  // Keep eventsRef in sync for ticker updates
  useEffect(() => { eventsRef.current = events; }, [events]);

  // Subscribe to settings changes for ticker visibility
  useEffect(() => {
    let unsub = null;

    function setup() {
      unsub = window.deepsteve.onSettingsChanged((settings) => {
        const show = !!settings.showTicker;
        tickerEnabledRef.current = show;
        window.deepsteve.setTickerVisible(show);
        if (show) {
          window.deepsteve.setTickerContent(renderTickerHTML(eventsRef.current));
        }
      });
    }

    if (window.deepsteve) {
      setup();
    } else {
      let attempts = 0;
      const poll = setInterval(() => {
        if (window.deepsteve) { clearInterval(poll); setup(); }
        else if (++attempts > 100) clearInterval(poll);
      }, 100);
    }

    return () => { if (unsub) unsub(); };
  }, []);

  useEffect(() => {
    let unsub = null;

    function setup() {
      unsub = window.deepsteve.onActivityChanged((event) => {
        if (event === null) {
          setEvents([]);
          if (tickerEnabledRef.current) window.deepsteve.setTickerContent('');
        } else {
          setEvents(prev => {
            const next = [...prev, event];
            if (tickerEnabledRef.current) window.deepsteve.setTickerContent(renderTickerHTML(next));
            return next;
          });
        }
      });
    }

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

    return () => { if (unsub) unsub(); };
  }, []);

  // Refresh relative timestamps every 30s
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const handleClear = useCallback(async () => {
    try {
      await fetch('/api/activity/clear', { method: 'POST' });
      setEvents([]);
      if (tickerEnabledRef.current) window.deepsteve.setTickerContent('');
    } catch (e) {
      console.error('Failed to clear activity:', e);
    }
  }, []);

  const handleClickSession = useCallback((sessionId) => {
    if (window.deepsteve) {
      window.deepsteve.focusSession(sessionId);
    }
  }, []);

  // Get unique session names for filter
  const sessionNames = [...new Set(events.map(e => e.sessionName).filter(Boolean))];

  // Apply filters (reverse chronological = newest first)
  let filtered = events;
  if (typeFilter !== 'all') filtered = filtered.filter(e => e.type === typeFilter);
  if (sessionFilter !== 'all') filtered = filtered.filter(e => e.sessionName === sessionFilter);
  filtered = [...filtered].reverse();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>
            Activity
            {events.length > 0 && (
              <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400, marginLeft: 6 }}>
                {events.length}
              </span>
            )}
          </div>
          {events.length > 0 && (
            <button
              onClick={handleClear}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                border: '1px solid #30363d',
                borderRadius: 4,
                cursor: 'pointer',
                background: 'none',
                color: '#8b949e',
              }}
              onMouseEnter={e => e.target.style.color = '#f0f6fc'}
              onMouseLeave={e => e.target.style.color = '#8b949e'}
            >
              Clear
            </button>
          )}
        </div>

        {/* Type filter */}
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginBottom: sessionNames.length > 0 ? 6 : 0 }}>
          {FILTER_OPTIONS.map(f => {
            const cfg = TYPE_CONFIG[f];
            return (
              <button
                key={f}
                onClick={() => setTypeFilter(f)}
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: typeFilter === f ? '#58a6ff' : 'rgba(255,255,255,0.06)',
                  color: typeFilter === f ? '#fff' : (cfg ? cfg.color : '#8b949e'),
                }}
              >
                {cfg ? `${cfg.icon} ${f}` : f}
              </button>
            );
          })}
        </div>

        {/* Session filter */}
        {sessionNames.length > 1 && (
          <select
            value={sessionFilter}
            onChange={e => setSessionFilter(e.target.value)}
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
            {sessionNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
      </div>

      {/* Event list */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            {events.length === 0
              ? 'No activity yet. Events from sessions will appear here.'
              : 'No events match the current filter.'}
          </div>
        ) : (
          filtered.map(event => (
            <EventItem
              key={event.id}
              event={event}
              onClickSession={handleClickSession}
            />
          ))
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('activity-root'));
root.render(<ActivityPanel />);

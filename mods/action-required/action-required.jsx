const { useState, useEffect, useCallback, useRef, useMemo } = React;

// ─── Helpers ─────────────────────────────────────────────────────────

function formatWaitTime(ms) {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// ─── Toggle Switch ──────────────────────────────────────────────────

function ToggleSwitch({ on, onToggle }) {
  return (
    <div
      onClick={onToggle}
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <div style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        background: on ? '#238636' : '#30363d',
        position: 'relative',
        transition: 'background 0.2s',
        flexShrink: 0,
      }}>
        <div style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#f0f6fc',
          position: 'absolute',
          top: 3,
          left: on ? 23 : 3,
          transition: 'left 0.2s',
        }} />
      </div>
      <span style={{
        fontSize: 14,
        fontWeight: 600,
        color: on ? '#3fb950' : '#8b949e',
      }}>
        Auto-cycle {on ? 'ON' : 'OFF'}
      </span>
    </div>
  );
}

// ─── Queue Item ──────────────────────────────────────────────────────

function QueueItem({ session, waitingSince, isActive, onFocus }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = waitingSince ? Date.now() - waitingSince : 0;
  const urgency = elapsed > 60000 ? '#f85149' : elapsed > 30000 ? '#f0883e' : '#8b949e';

  return (
    <div
      onClick={() => onFocus(session.id)}
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        background: isActive ? 'rgba(88,166,255,0.08)' : 'transparent',
        borderLeft: isActive ? '2px solid #58a6ff' : '2px solid transparent',
      }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: '#f0883e',
        flexShrink: 0,
        animation: 'pulse 2s ease-in-out infinite',
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          fontWeight: isActive ? 600 : 400,
          color: isActive ? '#f0f6fc' : '#c9d1d9',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {session.name}
        </div>
      </div>
      <span style={{ fontSize: 12, color: urgency, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {formatWaitTime(elapsed)}
      </span>
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────

function ActionRequiredPanel() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [settings, setSettings] = useState({ autoSwitch: true, switchDelay: 100 });

  // Refs for tracking state across callbacks
  const waitingSinceRef = useRef(new Map());    // sessionId → timestamp
  const prevSessionsRef = useRef([]);           // previous sessions snapshot
  const activeIdRef = useRef(null);
  const settingsRef = useRef(settings);
  const autoSwitchTimerRef = useRef(null);
  const isAutoSwitchingRef = useRef(false);
  const pollIntervalRef = useRef(null);

  // Keep refs in sync
  useEffect(() => { activeIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Derive queue: sessions waiting for input, sorted by wait start time (oldest first)
  const queue = useMemo(() => {
    return sessions
      .filter(s => s.waitingForInput)
      .sort((a, b) => {
        const aTime = waitingSinceRef.current.get(a.id) || Infinity;
        const bTime = waitingSinceRef.current.get(b.id) || Infinity;
        return aTime - bTime;
      });
  }, [sessions]);

  // Helper: find next waiting session (oldest first), excluding a given id
  function findNextWaiting(sessionList, excludeId) {
    return sessionList
      .filter(s => s.waitingForInput && s.id !== excludeId)
      .sort((a, b) => {
        const aTime = waitingSinceRef.current.get(a.id) || Infinity;
        const bTime = waitingSinceRef.current.get(b.id) || Infinity;
        return aTime - bTime;
      })[0] || null;
  }

  // Helper: schedule an auto-switch to a session
  function scheduleAutoSwitch(targetId) {
    if (autoSwitchTimerRef.current) clearTimeout(autoSwitchTimerRef.current);
    const delay = Math.max(100, Math.min(500, settingsRef.current.switchDelay || 100));
    autoSwitchTimerRef.current = setTimeout(() => {
      autoSwitchTimerRef.current = null;
      isAutoSwitchingRef.current = true;
      window.deepsteve.focusSession(targetId);
    }, delay);
  }

  // ── Bridge: settings ──
  useEffect(() => {
    if (!window.deepsteve) return;
    return window.deepsteve.onSettingsChanged((s) => setSettings(s));
  }, []);

  // ── Bridge: active session changes ──
  useEffect(() => {
    if (!window.deepsteve) return;

    if (window.deepsteve.getActiveSessionId) {
      setActiveSessionId(window.deepsteve.getActiveSessionId());
    }

    if (window.deepsteve.onActiveSessionChanged) {
      return window.deepsteve.onActiveSessionChanged((id) => {
        // Auto-switch initiated by us — don't cancel
        if (isAutoSwitchingRef.current) {
          isAutoSwitchingRef.current = false;
          setActiveSessionId(id);
          return;
        }

        // Manual switch — cancel any pending auto-switch and turn off auto-cycle
        if (autoSwitchTimerRef.current) {
          clearTimeout(autoSwitchTimerRef.current);
          autoSwitchTimerRef.current = null;
        }

        if (settingsRef.current.autoSwitch) {
          if (window.deepsteve.updateSetting) {
            window.deepsteve.updateSetting('autoSwitch', false);
          }
        }

        setActiveSessionId(id);
      });
    }
  }, []);

  // ── Bridge: session changes (core auto-switch logic) ──
  useEffect(() => {
    if (!window.deepsteve) return;

    return window.deepsteve.onSessionsChanged((sessionList) => {
      const prev = prevSessionsRef.current;
      const prevMap = new Map(prev.map(s => [s.id, s]));
      const now = Date.now();
      const currentActiveId = activeIdRef.current;
      const currentSettings = settingsRef.current;

      // Track waitingSince timestamps
      for (const s of sessionList) {
        if (s.waitingForInput && !waitingSinceRef.current.has(s.id)) {
          waitingSinceRef.current.set(s.id, now);
        } else if (!s.waitingForInput && waitingSinceRef.current.has(s.id)) {
          waitingSinceRef.current.delete(s.id);
        }
      }

      // Clean up removed sessions
      const currentIds = new Set(sessionList.map(s => s.id));
      for (const id of waitingSinceRef.current.keys()) {
        if (!currentIds.has(id)) waitingSinceRef.current.delete(id);
      }

      if (currentSettings.autoSwitch) {
        const currActive = sessionList.find(s => s.id === currentActiveId);
        const activeIsWaiting = currActive?.waitingForInput;

        if (!activeIsWaiting) {
          // Active tab is NOT waiting — switch to a tab that IS waiting
          const next = findNextWaiting(sessionList, null);
          if (next && !autoSwitchTimerRef.current) {
            scheduleAutoSwitch(next.id);
          }
        }
      }

      prevSessionsRef.current = sessionList;
      setSessions(sessionList);
    });
  }, []);

  // Cancel timers on unmount
  useEffect(() => {
    return () => {
      if (autoSwitchTimerRef.current) clearTimeout(autoSwitchTimerRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Poll for waiting tabs independently of events
  useEffect(() => {
    if (settings.autoSwitch) {
      pollIntervalRef.current = setInterval(() => {
        const sessionList = window.deepsteve?.getSessions() || [];
        const currentActiveId = activeIdRef.current;
        const currActive = sessionList.find(s => s.id === currentActiveId);
        if (!currActive?.waitingForInput) {
          const next = findNextWaiting(sessionList, null);
          if (next && !autoSwitchTimerRef.current) {
            scheduleAutoSwitch(next.id);
          }
        }
      }, 10000);
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [settings.autoSwitch]);

  const handleToggle = useCallback(() => {
    const newValue = !settingsRef.current.autoSwitch;
    if (window.deepsteve?.updateSetting) {
      window.deepsteve.updateSetting('autoSwitch', newValue);
    }

    if (newValue) {
      // Toggling ON: immediately jump to first waiting tab
      const sessions = window.deepsteve?.getSessions() || [];
      const next = sessions
        .filter(s => s.waitingForInput)
        .sort((a, b) => {
          const aTime = waitingSinceRef.current.get(a.id) || Infinity;
          const bTime = waitingSinceRef.current.get(b.id) || Infinity;
          return aTime - bTime;
        })[0];
      if (next) {
        isAutoSwitchingRef.current = true;
        window.deepsteve.focusSession(next.id);
      }
    } else {
      // Toggling OFF: cancel any pending auto-switch
      if (autoSwitchTimerRef.current) {
        clearTimeout(autoSwitchTimerRef.current);
        autoSwitchTimerRef.current = null;
      }
    }
  }, []);

  const handleFocus = useCallback((id) => {
    if (window.deepsteve) {
      window.deepsteve.focusSession(id);
    }
  }, []);

  // Queue depth visual intensity
  const queueDepth = queue.length;
  const borderColor = queueDepth === 0 ? 'transparent'
    : queueDepth <= 2 ? 'rgba(240,136,62,0.2)'
    : queueDepth <= 5 ? 'rgba(240,136,62,0.4)'
    : 'rgba(248,81,73,0.5)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes border-pulse {
          0%, 100% { border-color: ${borderColor}; }
          50% { border-color: transparent; }
        }
      `}</style>

      {/* Toggle */}
      <ToggleSwitch on={settings.autoSwitch} onToggle={handleToggle} />

      {/* Queue header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>
          {queueDepth > 0 ? (
            <span>{queueDepth} tab{queueDepth !== 1 ? 's' : ''} waiting</span>
          ) : (
            'No tabs waiting'
          )}
        </div>
      </div>

      {/* Queue list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        borderLeft: queueDepth > 0 ? `2px solid ${borderColor}` : 'none',
        animation: queueDepth > 2 ? 'border-pulse 3s ease-in-out infinite' : 'none',
      }}>
        {queueDepth === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#484f58', fontSize: 13 }}>
            Tabs needing input will appear here
          </div>
        ) : (
          queue.map(session => (
            <QueueItem
              key={session.id}
              session={session}
              waitingSince={waitingSinceRef.current.get(session.id)}
              isActive={session.id === activeSessionId}
              onFocus={handleFocus}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Mount ───────────────────────────────────────────────────────────

const root = ReactDOM.createRoot(document.getElementById('action-root'));
root.render(<ActionRequiredPanel />);

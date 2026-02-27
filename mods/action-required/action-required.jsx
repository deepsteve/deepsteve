const { useState, useEffect, useCallback, useRef, useMemo } = React;

// ─── Constants ───────────────────────────────────────────────────────

const IDLE_TIMEOUT = 30000;    // streak resets after 30s idle
const COMBO_THRESHOLD = 5000;  // combo for responses under 5s

// ─── Helpers ─────────────────────────────────────────────────────────

function formatWaitTime(ms) {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatAvgTime(times) {
  if (times.length === 0) return '--';
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return formatWaitTime(avg);
}

// ─── Queue Item ──────────────────────────────────────────────────────

function QueueItem({ session, waitingSince, isActive, onFocus }) {
  const [, setTick] = useState(0);

  // Live-update wait time every second
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

// ─── Stats Bar ───────────────────────────────────────────────────────

function StatsBar({ stats }) {
  const { streak, bestStreak, comboMultiplier, responseTimes } = stats;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      fontSize: 12,
      color: '#8b949e',
    }}>
      {/* Streak */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }} title={`Best: ${bestStreak}`}>
        <span style={{ fontSize: 14 }}>{streak > 0 ? '\uD83D\uDD25' : '\u2022'}</span>
        <span style={{ color: streak > 0 ? '#f0883e' : '#484f58', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {streak}
        </span>
      </div>

      {/* Combo */}
      {comboMultiplier > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} title="Fast response combo">
          <span style={{ color: '#d2a8ff', fontWeight: 700, fontSize: 13 }}>{comboMultiplier}x</span>
        </div>
      )}

      {/* Average response time */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 10, color: '#484f58' }}>avg</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatAvgTime(responseTimes)}</span>
      </div>
    </div>
  );
}

// ─── All Clear State ─────────────────────────────────────────────────

function AllClear({ stats }) {
  return (
    <div style={{
      padding: 32,
      textAlign: 'center',
      color: '#8b949e',
    }}>
      <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.6 }}>{'\u2713'}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#3fb950', marginBottom: 16 }}>All clear</div>
      {stats.totalActions > 0 && (
        <div style={{ fontSize: 12, lineHeight: 1.8 }}>
          <div>Actions: <span style={{ color: '#c9d1d9' }}>{stats.totalActions}</span></div>
          <div>Best streak: <span style={{ color: '#c9d1d9' }}>{stats.bestStreak}</span></div>
          <div>Avg response: <span style={{ color: '#c9d1d9' }}>{formatAvgTime(stats.responseTimes)}</span></div>
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────

function ActionRequiredPanel() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [settings, setSettings] = useState({ autoSwitch: true, switchDelay: 200 });
  const [stats, setStats] = useState({
    streak: 0,
    bestStreak: 0,
    totalActions: 0,
    responseTimes: [],
    comboMultiplier: 1,
    lastActionTime: 0,
  });

  // Refs for tracking state across callbacks
  const waitingSinceRef = useRef(new Map());    // sessionId → timestamp
  const prevSessionsRef = useRef([]);           // previous sessions snapshot
  const activeIdRef = useRef(null);             // current activeSessionId
  const settingsRef = useRef(settings);
  const statsRef = useRef(stats);
  const autoSwitchTimerRef = useRef(null);
  const isAutoSwitchingRef = useRef(false);     // flag to distinguish auto-switch from manual

  // Keep refs in sync
  useEffect(() => { activeIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { statsRef.current = stats; }, [stats]);

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

  // ── Bridge: settings ──
  useEffect(() => {
    if (!window.deepsteve) return;
    return window.deepsteve.onSettingsChanged((s) => setSettings(s));
  }, []);

  // ── Bridge: active session changes ──
  useEffect(() => {
    if (!window.deepsteve) return;

    // Get initial active session ID
    if (window.deepsteve.getActiveSessionId) {
      setActiveSessionId(window.deepsteve.getActiveSessionId());
    }

    // Subscribe to active session changes
    if (window.deepsteve.onActiveSessionChanged) {
      return window.deepsteve.onActiveSessionChanged((id) => {
        // If this change came from our auto-switch, don't cancel anything
        if (isAutoSwitchingRef.current) {
          isAutoSwitchingRef.current = false;
          setActiveSessionId(id);
          return;
        }

        // Manual switch — cancel any pending auto-switch
        if (autoSwitchTimerRef.current) {
          clearTimeout(autoSwitchTimerRef.current);
          autoSwitchTimerRef.current = null;
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
      const currentStats = statsRef.current;

      // Capture waitStart for the active session BEFORE updating timestamps
      const activeWaitStart = waitingSinceRef.current.get(currentActiveId);

      // Track waitingSince timestamps
      for (const s of sessionList) {
        if (s.waitingForInput && !waitingSinceRef.current.has(s.id)) {
          // Just started waiting
          waitingSinceRef.current.set(s.id, now);
        } else if (!s.waitingForInput && waitingSinceRef.current.has(s.id)) {
          // Stopped waiting — remove tracking
          waitingSinceRef.current.delete(s.id);
        }
      }

      // Clean up removed sessions
      const currentIds = new Set(sessionList.map(s => s.id));
      for (const id of waitingSinceRef.current.keys()) {
        if (!currentIds.has(id)) waitingSinceRef.current.delete(id);
      }

      // Detect: active session flipped from waiting → not waiting (user submitted input)
      const prevActive = prevMap.get(currentActiveId);
      const currActive = sessionList.find(s => s.id === currentActiveId);
      if (prevActive?.waitingForInput && currActive && !currActive.waitingForInput) {
        // Record action — use the waitStart captured before we deleted it
        const responseTime = activeWaitStart ? now - activeWaitStart : 0;

        const isIdle = currentStats.lastActionTime > 0 && (now - currentStats.lastActionTime) > IDLE_TIMEOUT;
        const isFast = responseTime < COMBO_THRESHOLD;
        const newStreak = isIdle ? 1 : currentStats.streak + 1;
        const newCombo = (isIdle || !isFast) ? 1 : currentStats.comboMultiplier + 1;
        const newTimes = [...currentStats.responseTimes.slice(-49), responseTime]; // keep last 50

        const newStats = {
          streak: newStreak,
          bestStreak: Math.max(currentStats.bestStreak, newStreak),
          totalActions: currentStats.totalActions + 1,
          responseTimes: newTimes,
          comboMultiplier: newCombo,
          lastActionTime: now,
        };
        setStats(newStats);
        statsRef.current = newStats;

        // Auto-switch to next waiting tab
        if (currentSettings.autoSwitch) {
          // Find next in queue (excluding the one we just handled)
          const nextWaiting = sessionList
            .filter(s => s.waitingForInput && s.id !== currentActiveId)
            .sort((a, b) => {
              const aTime = waitingSinceRef.current.get(a.id) || Infinity;
              const bTime = waitingSinceRef.current.get(b.id) || Infinity;
              return aTime - bTime;
            })[0];

          if (nextWaiting && window.deepsteve) {
            // Cancel any existing timer
            if (autoSwitchTimerRef.current) clearTimeout(autoSwitchTimerRef.current);

            const delay = Math.max(100, Math.min(500, currentSettings.switchDelay || 200));
            autoSwitchTimerRef.current = setTimeout(() => {
              autoSwitchTimerRef.current = null;
              isAutoSwitchingRef.current = true;
              window.deepsteve.focusSession(nextWaiting.id);
            }, delay);
          }
        }
      }

      prevSessionsRef.current = sessionList;
      setSessions(sessionList);
    });
  }, []);

  // Cancel auto-switch timer on unmount
  useEffect(() => {
    return () => {
      if (autoSwitchTimerRef.current) clearTimeout(autoSwitchTimerRef.current);
    };
  }, []);

  // Idle detection: reset streak if no action for 30s
  useEffect(() => {
    if (stats.lastActionTime === 0) return;
    const remaining = IDLE_TIMEOUT - (Date.now() - stats.lastActionTime);
    if (remaining <= 0) return;

    const timer = setTimeout(() => {
      setStats(prev => prev.streak > 0 ? { ...prev, streak: 0, comboMultiplier: 1 } : prev);
    }, remaining + 100); // small buffer

    return () => clearTimeout(timer);
  }, [stats.lastActionTime]);

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
      {/* Pulse animation */}
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

      {/* Stats bar */}
      {stats.totalActions > 0 && <StatsBar stats={stats} />}

      {/* Queue header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>
            {queueDepth > 0 ? (
              <>
                <span>{queueDepth} tab{queueDepth !== 1 ? 's' : ''} waiting</span>
                <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400, marginLeft: 6 }}>
                  {settings.autoSwitch ? 'auto' : 'manual'}
                </span>
              </>
            ) : (
              'Action Required'
            )}
          </div>
        </div>
      </div>

      {/* Queue list or all-clear */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        borderLeft: queueDepth > 0 ? `2px solid ${borderColor}` : 'none',
        animation: queueDepth > 2 ? 'border-pulse 3s ease-in-out infinite' : 'none',
      }}>
        {queueDepth === 0 ? (
          <AllClear stats={stats} />
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

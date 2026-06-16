const { useState, useEffect, useCallback, useRef, useMemo } = React;

// ─── Tunables ────────────────────────────────────────────────────────
const TYPING_GRACE_MS = 3000;   // how long after a keystroke we treat you as "actively typing"
const SNOOZE_MS = 20000;        // how long "Stay" defers the jump before re-offering it
const POLL_MS = 2500;           // safety-net re-evaluation cadence
const DEFAULT_TOAST_SECONDS = 5;

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

// ─── Nav button (◀ Prev / Next ▶) ────────────────────────────────────

function NavButton({ label, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: disabled ? '#484f58' : '#c9d1d9',
        background: 'transparent',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 5,
        padding: '3px 8px',
        cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
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
  const [settings, setSettings] = useState({ autoSwitch: true, toastSeconds: DEFAULT_TOAST_SECONDS });

  // Refs for tracking state across long-lived callbacks/timers.
  const waitingSinceRef = useRef(new Map());   // sessionId → timestamp it started waiting
  const sessionsRef = useRef([]);              // latest session list
  const activeIdRef = useRef(null);
  const settingsRef = useRef(settings);
  const dwellTargetRef = useRef(null);         // the tab we're currently parked on
  const lastActivityRef = useRef(0);           // last keystroke time (typing detection)
  const toastTargetRef = useRef(null);         // candidate id the countdown toast is for
  const snoozeUntilRef = useRef(0);            // "Stay" defers the jump until this time
  const reevalTimerRef = useRef(null);         // deferred re-evaluation (typing grace / snooze)
  const pollIntervalRef = useRef(null);
  const isAutoSwitchingRef = useRef(false);    // marks switches we initiate (so they don't disable auto-cycle)

  useEffect(() => { activeIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Stable sort: who has been waiting longest goes first.
  const byWaitingSince = useCallback((a, b) => {
    const aTime = waitingSinceRef.current.get(a.id) || Infinity;
    const bTime = waitingSinceRef.current.get(b.id) || Infinity;
    return aTime - bTime;
  }, []);

  // Derived queue for rendering: waiting tabs, longest-waiting first.
  const queue = useMemo(
    () => sessions.filter(s => s.waitingForInput).sort(byWaitingSince),
    [sessions, byWaitingSince]
  );

  const findNextWaiting = useCallback((sessionList, excludeId) => {
    return sessionList.filter(s => s.waitingForInput && s.id !== excludeId).sort(byWaitingSince)[0] || null;
  }, [byWaitingSince]);

  const hideToast = useCallback(() => {
    if (toastTargetRef.current) {
      toastTargetRef.current = null;
      window.deepsteve?.hideAutoCycleToast?.();
    }
  }, []);

  const scheduleReeval = useCallback((ms) => {
    if (reevalTimerRef.current) clearTimeout(reevalTimerRef.current);
    reevalTimerRef.current = setTimeout(() => {
      reevalTimerRef.current = null;
      evaluate(sessionsRef.current);
    }, Math.max(50, ms));
  }, []);

  // Perform a switch we initiate: dwell on the target until it stops waiting.
  const doSwitch = useCallback((id) => {
    hideToast();
    snoozeUntilRef.current = 0;
    isAutoSwitchingRef.current = true;
    dwellTargetRef.current = id;
    window.deepsteve?.focusSession?.(id);
  }, [hideToast]);

  const showToastFor = useCallback((candidate) => {
    const seconds = Math.max(1, Math.min(60, settingsRef.current.toastSeconds || DEFAULT_TOAST_SECONDS));
    toastTargetRef.current = candidate.id;
    window.deepsteve.showAutoCycleToast({
      name: candidate.name,
      seconds,
      onExpire: () => {
        toastTargetRef.current = null;
        const list = sessionsRef.current;
        const target = list.find(x => x.id === candidate.id);
        if (target && target.waitingForInput) doSwitch(candidate.id);
        else evaluate(list);
      },
      onCancel: () => {
        // "Stay" — defer the jump briefly, then re-offer it.
        toastTargetRef.current = null;
        snoozeUntilRef.current = Date.now() + SNOOZE_MS;
        scheduleReeval(SNOOZE_MS + 50);
      },
    });
  }, [doSwitch, scheduleReeval]);

  // The single decision point for moving between tabs.
  const evaluate = useCallback((sessionList) => {
    if (!sessionList) return;
    const s = settingsRef.current;
    if (!s.autoSwitch) { hideToast(); return; }

    const activeId = activeIdRef.current;
    const dwell = dwellTargetRef.current;

    // DWELL: parked on a tab that's still waiting → stay put, even if others wait too.
    const dwellSession = dwell ? sessionList.find(x => x.id === dwell) : null;
    if (dwellSession && dwellSession.waitingForInput) { hideToast(); return; }
    if (dwell) dwellTargetRef.current = null; // resolved or gone — look for the next

    // If the active tab itself is waiting, treat it as the dwell target and stay.
    const activeSession = sessionList.find(x => x.id === activeId);
    if (activeSession && activeSession.waitingForInput) {
      dwellTargetRef.current = activeId;
      snoozeUntilRef.current = 0;
      hideToast();
      return;
    }

    const candidate = findNextWaiting(sessionList, null);
    if (!candidate) { hideToast(); return; }

    // "Stay" snooze in effect — hold off, then re-evaluate.
    if (snoozeUntilRef.current && Date.now() < snoozeUntilRef.current) {
      hideToast();
      scheduleReeval(snoozeUntilRef.current - Date.now() + 50);
      return;
    }

    // Typing block: actively interacting → no toast, no jump. Resume after the grace window.
    const sinceType = Date.now() - (lastActivityRef.current || 0);
    if (sinceType < TYPING_GRACE_MS) {
      hideToast();
      scheduleReeval(TYPING_GRACE_MS - sinceType + 50);
      return;
    }

    // Already counting down toward this candidate — let the toast keep running.
    if (toastTargetRef.current === candidate.id) return;

    showToastFor(candidate);
  }, [findNextWaiting, hideToast, scheduleReeval, showToastFor]);

  // Manual prev/next through the waiting queue (buttons + arrow keys). Keeps auto-cycle ON.
  const handleNav = useCallback((dir) => {
    const list = sessionsRef.current || [];
    const q = list.filter(x => x.waitingForInput).sort(byWaitingSince);
    if (!q.length) return;
    let idx = q.findIndex(x => x.id === activeIdRef.current);
    if (idx === -1) idx = q.findIndex(x => x.id === dwellTargetRef.current);
    if (idx === -1) idx = dir > 0 ? 0 : q.length - 1;
    else idx = (idx + dir + q.length) % q.length;
    doSwitch(q[idx].id);
  }, [byWaitingSince, doSwitch]);

  const handleFocus = useCallback((id) => {
    // Clicking a queue item is navigation within the menu — dwell there, keep auto-cycle on.
    doSwitch(id);
  }, [doSwitch]);

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
    if (!window.deepsteve.onActiveSessionChanged) return;
    return window.deepsteve.onActiveSessionChanged((id) => {
      if (isAutoSwitchingRef.current) {
        // A switch we initiated (auto-cycle, prev/next, or queue click) — keep auto-cycle on.
        isAutoSwitchingRef.current = false;
        setActiveSessionId(id);
        return;
      }
      // Genuine manual switch (user clicked a terminal tab outside the panel) → stop auto-cycling.
      hideToast();
      if (reevalTimerRef.current) { clearTimeout(reevalTimerRef.current); reevalTimerRef.current = null; }
      dwellTargetRef.current = null;
      snoozeUntilRef.current = 0;
      if (settingsRef.current.autoSwitch && window.deepsteve.updateSetting) {
        window.deepsteve.updateSetting('autoSwitch', false);
      }
      setActiveSessionId(id);
    });
  }, [hideToast]);

  // ── Bridge: user typing (typing blocks auto-cycle; cancels a pending toast) ──
  useEffect(() => {
    if (!window.deepsteve?.onUserActivity) return;
    return window.deepsteve.onUserActivity(() => {
      lastActivityRef.current = Date.now();
      if (toastTargetRef.current) hideToast();
      scheduleReeval(TYPING_GRACE_MS + 50);
    });
  }, [hideToast, scheduleReeval]);

  // ── Bridge: session changes (waiting state + the core evaluation) ──
  useEffect(() => {
    if (!window.deepsteve) return;
    return window.deepsteve.onSessionsChanged((sessionList) => {
      const now = Date.now();
      // Track when each session started waiting.
      for (const s of sessionList) {
        if (s.waitingForInput && !waitingSinceRef.current.has(s.id)) {
          waitingSinceRef.current.set(s.id, now);
        } else if (!s.waitingForInput && waitingSinceRef.current.has(s.id)) {
          waitingSinceRef.current.delete(s.id);
        }
      }
      // Drop removed sessions.
      const currentIds = new Set(sessionList.map(s => s.id));
      for (const id of waitingSinceRef.current.keys()) {
        if (!currentIds.has(id)) waitingSinceRef.current.delete(id);
      }
      sessionsRef.current = sessionList;
      setSessions(sessionList);
      evaluate(sessionList);
    });
  }, [evaluate]);

  // ── Keyboard: arrow keys move prev/next when the panel iframe is focused ──
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); handleNav(1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); handleNav(-1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleNav]);

  // ── Polling safety net + teardown when auto-cycle turns off ──
  useEffect(() => {
    if (settings.autoSwitch) {
      pollIntervalRef.current = setInterval(() => {
        evaluate(window.deepsteve?.getSessions?.() || sessionsRef.current);
      }, POLL_MS);
    } else {
      hideToast();
      if (reevalTimerRef.current) { clearTimeout(reevalTimerRef.current); reevalTimerRef.current = null; }
      dwellTargetRef.current = null;
      snoozeUntilRef.current = 0;
    }
    return () => {
      if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    };
  }, [settings.autoSwitch, evaluate, hideToast]);

  // ── Teardown on unmount ──
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (reevalTimerRef.current) clearTimeout(reevalTimerRef.current);
      hideToast();
    };
  }, [hideToast]);

  const handleToggle = useCallback(() => {
    const newValue = !settingsRef.current.autoSwitch;
    // Apply optimistically so evaluate() sees the new value before the settings round-trip.
    settingsRef.current = { ...settingsRef.current, autoSwitch: newValue };
    window.deepsteve?.updateSetting?.('autoSwitch', newValue);
    if (newValue) {
      snoozeUntilRef.current = 0;
      evaluate(sessionsRef.current);
    } else {
      hideToast();
      if (reevalTimerRef.current) { clearTimeout(reevalTimerRef.current); reevalTimerRef.current = null; }
      dwellTargetRef.current = null;
      snoozeUntilRef.current = 0;
    }
  }, [evaluate, hideToast]);

  // Queue depth visual intensity
  const queueDepth = queue.length;
  const borderColor = queueDepth === 0 ? 'transparent'
    : queueDepth <= 2 ? 'rgba(240,136,62,0.2)'
    : queueDepth <= 5 ? 'rgba(240,136,62,0.4)'
    : 'rgba(248,81,73,0.5)';

  return (
    <div tabIndex={0} style={{ display: 'flex', flexDirection: 'column', height: '100vh', outline: 'none' }}>
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

      {/* Queue header + prev/next controls */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>
          {queueDepth > 0 ? (
            <span>{queueDepth} tab{queueDepth !== 1 ? 's' : ''} waiting</span>
          ) : (
            'No tabs waiting'
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <NavButton label="◀ Prev" onClick={() => handleNav(-1)} disabled={queueDepth < 2} />
          <NavButton label="Next ▶" onClick={() => handleNav(1)} disabled={queueDepth < 2} />
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

const { useState, useEffect, useCallback } = React;

const styles = {
  container: {
    padding: '8px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '16px',
  },
  title: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#c9d1d9',
  },
  configSection: {
    marginBottom: '24px',
  },
  configName: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#8b949e',
    marginBottom: '8px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '8px',
  },
  card: {
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid #30363d',
    background: '#161b22',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    position: 'relative',
  },
  cardRunning: {
    borderColor: '#238636',
    boxShadow: '0 0 8px rgba(35,134,54,0.3)',
  },
  cardWaiting: {
    borderColor: '#d29922',
    animation: 'pulse-yellow 2s infinite',
  },
  cardIdle: {
    opacity: 0.5,
    borderColor: '#30363d',
  },
  cardName: {
    fontSize: '13px',
    fontWeight: 500,
    color: '#c9d1d9',
    marginBottom: '4px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardCwd: {
    fontSize: '11px',
    color: '#8b949e',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    position: 'absolute',
    top: '8px',
    right: '8px',
  },
  emptyMsg: {
    fontSize: '13px',
    color: '#8b949e',
    textAlign: 'center',
    padding: '32px 16px',
    opacity: 0.6,
  },
  unmatched: {
    marginTop: '24px',
  },
};

function shortenPath(p) {
  if (!p) return '';
  const home = '/Users/';
  const idx = p.indexOf(home);
  if (idx === 0) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) return '~' + rest.slice(slash);
    return '~';
  }
  return p;
}

function WindowMap() {
  const [configs, setConfigs] = useState([]);
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    // Fetch configs
    fetch('/api/window-configs')
      .then(r => r.json())
      .then(d => setConfigs(d.configs || []))
      .catch(() => {});

    // Subscribe to live sessions
    let unsub;
    if (window.deepsteve?.onSessionsChanged) {
      unsub = window.deepsteve.onSessionsChanged((list) => {
        setSessions(list);
      });
    }

    // Listen for config updates from parent window
    const onConfigUpdate = (e) => setConfigs(e.detail || []);
    window.parent.addEventListener('deepsteve-window-configs', onConfigUpdate);

    return () => {
      if (unsub) unsub();
      window.parent.removeEventListener('deepsteve-window-configs', onConfigUpdate);
    };
  }, []);

  const handleCardClick = useCallback((session, tab, configId) => {
    if (session) {
      // Focus existing session
      if (window.deepsteve?.focusSession) {
        window.deepsteve.focusSession(session.id);
      }
    } else if (tab && configId) {
      // Launch single tab from config
      fetch(`/api/window-configs/${configId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: window.deepsteve?.getWindowId?.() }),
      }).catch(() => {});
    }
  }, []);

  // Match sessions to config tabs
  const matchedSessionIds = new Set();

  const configSections = configs.map(config => {
    const cards = config.tabs.map((tab, ti) => {
      // Find matching live session by cwd + name
      const match = sessions.find(s =>
        !matchedSessionIds.has(s.id) &&
        s.cwd === tab.cwd &&
        (!tab.name || s.name === tab.name)
      );
      if (match) matchedSessionIds.add(match.id);
      return { tab, session: match, key: `${config.id}-${ti}` };
    });
    return { config, cards };
  });

  const unmatchedSessions = sessions.filter(s => !matchedSessionIds.has(s.id));

  if (configs.length === 0 && sessions.length === 0) {
    return React.createElement('div', { style: styles.emptyMsg },
      'No window configs or active sessions. Create a config in Settings to get started.'
    );
  }

  return React.createElement('div', { style: styles.container },
    // Config sections
    ...configSections.map(({ config, cards }) =>
      React.createElement('div', { key: config.id, style: styles.configSection },
        React.createElement('div', { style: styles.configName }, config.name),
        React.createElement('div', { style: styles.grid },
          ...cards.map(({ tab, session, key }) => {
            const isRunning = !!session;
            const isWaiting = session?.waitingForInput;
            const cardStyle = {
              ...styles.card,
              ...(isWaiting ? styles.cardWaiting : isRunning ? styles.cardRunning : styles.cardIdle),
            };
            const dotColor = isWaiting ? '#d29922' : isRunning ? '#238636' : '#484f58';
            return React.createElement('div', {
              key,
              style: cardStyle,
              onClick: () => handleCardClick(session, tab, config.id),
              title: isRunning ? 'Click to focus' : 'Click to launch all tabs in this config',
            },
              React.createElement('div', { style: { ...styles.statusDot, background: dotColor } }),
              React.createElement('div', { style: styles.cardName }, tab.name || session?.name || 'Unnamed'),
              React.createElement('div', { style: styles.cardCwd }, shortenPath(tab.cwd)),
            );
          })
        )
      )
    ),
    // Unmatched live sessions
    unmatchedSessions.length > 0 && React.createElement('div', { style: styles.unmatched },
      React.createElement('div', { style: styles.configName }, 'Other Sessions'),
      React.createElement('div', { style: styles.grid },
        ...unmatchedSessions.map(session => {
          const isWaiting = session.waitingForInput;
          const cardStyle = {
            ...styles.card,
            ...(isWaiting ? styles.cardWaiting : styles.cardRunning),
          };
          const dotColor = isWaiting ? '#d29922' : '#238636';
          return React.createElement('div', {
            key: session.id,
            style: cardStyle,
            onClick: () => handleCardClick(session),
            title: 'Click to focus',
          },
            React.createElement('div', { style: { ...styles.statusDot, background: dotColor } }),
            React.createElement('div', { style: styles.cardName }, session.name || 'Unnamed'),
            React.createElement('div', { style: styles.cardCwd }, shortenPath(session.cwd)),
          );
        })
      )
    )
  );
}

// Add pulse animation
const styleEl = document.createElement('style');
styleEl.textContent = `
  @keyframes pulse-yellow {
    0%, 100% { box-shadow: 0 0 4px rgba(210,153,34,0.3); }
    50% { box-shadow: 0 0 12px rgba(210,153,34,0.6); }
  }
`;
document.head.appendChild(styleEl);

const root = ReactDOM.createRoot(document.getElementById('map-root'));
root.render(React.createElement(WindowMap));

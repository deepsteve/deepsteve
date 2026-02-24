const { useState, useEffect, useRef, useCallback } = React;

const MAX_ENTRIES = 500;

const LEVEL_COLORS = {
  log: '#c9d1d9',
  info: '#58a6ff',
  warn: '#f0883e',
  error: '#f85149',
  debug: '#8b949e',
};

const LEVEL_BG = {
  warn: 'rgba(240,136,62,0.06)',
  error: 'rgba(248,81,73,0.06)',
};

/**
 * Safely serialize a value for transport. Handles DOM elements,
 * functions, errors, circular references, and large values.
 */
function safeSerialize(value, depth = 0) {
  if (depth > 4) return '[max depth]';
  if (value === null) return null;
  if (value === undefined) return undefined;

  const type = typeof value;
  if (type === 'string') return value.length > 2000 ? value.slice(0, 2000) + '...[truncated]' : value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (type === 'symbol') return value.toString();
  if (type === 'bigint') return value.toString() + 'n';

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  // DOM elements
  if (value instanceof parent.window.HTMLElement) {
    const tag = value.tagName.toLowerCase();
    const id = value.id ? `#${value.id}` : '';
    const cls = value.className && typeof value.className === 'string'
      ? '.' + value.className.trim().split(/\s+/).join('.')
      : '';
    return `[${tag}${id}${cls}]`;
  }

  if (value instanceof parent.window.NodeList || value instanceof parent.window.HTMLCollection) {
    return `[NodeList(${value.length})]`;
  }

  if (Array.isArray(value)) {
    if (value.length > 100) return `[Array(${value.length})]`;
    return value.map(v => safeSerialize(v, depth + 1));
  }

  if (type === 'object') {
    try {
      const keys = Object.keys(value);
      if (keys.length > 50) return `[Object(${keys.length} keys)]`;
      const result = {};
      for (const k of keys) {
        result[k] = safeSerialize(value[k], depth + 1);
      }
      return result;
    } catch {
      return '[Object]';
    }
  }

  return String(value);
}

/**
 * Format console args into a display string.
 */
function formatArgs(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, null, 2); }
    catch { return String(a); }
  }).join(' ');
}

function ConsoleEntry({ entry }) {
  const color = LEVEL_COLORS[entry.level] || '#c9d1d9';
  const bg = LEVEL_BG[entry.level] || 'transparent';
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div style={{
      padding: '4px 10px',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      background: bg,
      fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace',
      fontSize: 12,
      lineHeight: '18px',
      display: 'flex',
      gap: 8,
    }}>
      <span style={{ color: '#484f58', flexShrink: 0, userSelect: 'none' }}>{time}</span>
      <span style={{
        color: LEVEL_COLORS[entry.level],
        flexShrink: 0,
        width: 36,
        textAlign: 'right',
        userSelect: 'none',
        fontWeight: entry.level === 'error' ? 600 : 400,
      }}>
        {entry.level}
      </span>
      <span style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
        {entry.text}
      </span>
    </div>
  );
}

function ConsolePanel() {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('all');
  const entriesRef = useRef([]);
  const listRef = useRef(null);
  const autoScrollRef = useRef(true);

  // Track scroll position for auto-scroll behavior
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries]);

  useEffect(() => {
    if (!window.deepsteve) return;

    const parentWin = parent.window;
    const originals = {};
    const levels = ['log', 'warn', 'error', 'info', 'debug'];

    // Patch parent console methods to capture output
    for (const level of levels) {
      originals[level] = parentWin.console[level];
      parentWin.console[level] = (...args) => {
        // Call original
        originals[level].apply(parentWin.console, args);

        // Capture entry
        const serialized = args.map(a => safeSerialize(a));
        const entry = {
          level,
          args: serialized,
          text: formatArgs(serialized),
          timestamp: Date.now(),
        };

        entriesRef.current.push(entry);
        // Circular buffer
        if (entriesRef.current.length > MAX_ENTRIES) {
          entriesRef.current = entriesRef.current.slice(-MAX_ENTRIES);
        }
        setEntries([...entriesRef.current]);
      };
    }

    // Handle browser_eval requests
    const unsubEval = window.deepsteve.onBrowserEvalRequest(async (req) => {
      let result, error;
      try {
        // Create function in parent scope for full DOM access
        const fn = new parentWin.Function(req.code);
        result = fn();
        // Await if promise
        if (result && typeof result.then === 'function') {
          result = await result;
        }
        result = safeSerialize(result);
        if (result === undefined) result = 'undefined';
      } catch (e) {
        error = e.message || String(e);
      }

      try {
        await fetch('/api/browser-console/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: req.requestId, result, error }),
        });
      } catch (e) {
        originals.error.call(parentWin.console, '[browser-console] Failed to POST eval result:', e);
      }
    });

    // Handle browser_console requests
    const unsubConsole = window.deepsteve.onBrowserConsoleRequest(async (req) => {
      let filtered = entriesRef.current;

      if (req.level && req.level !== 'all') {
        filtered = filtered.filter(e => e.level === req.level);
      }
      if (req.search) {
        const s = req.search.toLowerCase();
        filtered = filtered.filter(e => e.text.toLowerCase().includes(s));
      }

      // Most recent first, limited
      const limit = req.limit || 50;
      const sliced = filtered.slice(-limit).reverse();

      const result = sliced.map(e => {
        const time = new Date(e.timestamp).toISOString();
        return `[${time}] [${e.level}] ${e.text}`;
      }).join('\n') || '(no console entries captured)';

      try {
        await fetch('/api/browser-console/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: req.requestId, result }),
        });
      } catch (e) {
        originals.error.call(parentWin.console, '[browser-console] Failed to POST console result:', e);
      }
    });

    // Cleanup: restore original console methods
    return () => {
      for (const level of levels) {
        parentWin.console[level] = originals[level];
      }
      unsubEval();
      unsubConsole();
    };
  }, []);

  const clearEntries = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  // Apply level filter
  const filtered = filter === 'all' ? entries : entries.filter(e => e.level === filter);

  // Count errors/warnings for header
  const errorCount = entries.filter(e => e.level === 'error').length;
  const warnCount = entries.filter(e => e.level === 'warn').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>Console</span>

        {errorCount > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px', borderRadius: 8,
            background: 'rgba(248,81,73,0.15)', color: '#f85149',
            border: '1px solid rgba(248,81,73,0.3)',
          }}>
            {errorCount} error{errorCount !== 1 ? 's' : ''}
          </span>
        )}
        {warnCount > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px', borderRadius: 8,
            background: 'rgba(240,136,62,0.15)', color: '#f0883e',
            border: '1px solid rgba(240,136,62,0.3)',
          }}>
            {warnCount} warn{warnCount !== 1 ? 's' : ''}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Level filter buttons */}
        <div style={{ display: 'flex', gap: 2 }}>
          {['all', 'error', 'warn', 'log', 'info', 'debug'].map(level => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              style={{
                padding: '2px 6px',
                fontSize: 10,
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
                background: filter === level ? '#58a6ff' : 'rgba(255,255,255,0.06)',
                color: filter === level ? '#fff' : '#8b949e',
              }}
            >
              {level}
            </button>
          ))}
        </div>

        <button
          onClick={clearEntries}
          title="Clear console"
          style={{
            background: 'none', border: 'none', color: '#8b949e',
            cursor: 'pointer', fontSize: 12, padding: '2px 6px',
            borderRadius: 3,
          }}
          onMouseEnter={e => e.target.style.color = '#f0f6fc'}
          onMouseLeave={e => e.target.style.color = '#8b949e'}
        >
          Clear
        </button>
      </div>

      {/* Console entries */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto' }}
      >
        {filtered.length === 0 ? (
          <div style={{
            padding: 24, textAlign: 'center', color: '#8b949e', fontSize: 13,
          }}>
            {entries.length === 0
              ? 'Console output will appear here. Claude sessions can use browser_eval and browser_console MCP tools.'
              : 'No entries match the current filter.'}
          </div>
        ) : (
          filtered.map((entry, i) => <ConsoleEntry key={i} entry={entry} />)
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('console-root'));
root.render(<ConsolePanel />);

const { useState, useEffect, useCallback, useRef } = React;

// Layout preset visual representations (mini grid previews)
const PRESET_ICONS = {
  'single': { rows: 1, cols: 1, cells: [[0,0,1,1]] },
  '2-col':  { rows: 1, cols: 2, cells: [[0,0,1,1],[0,1,1,1]] },
  '2-row':  { rows: 2, cols: 1, cells: [[0,0,1,1],[1,0,1,1]] },
  '3-col':  { rows: 1, cols: 3, cells: [[0,0,1,1],[0,1,1,1],[0,2,1,1]] },
  '2x2':   { rows: 2, cols: 2, cells: [[0,0,1,1],[0,1,1,1],[1,0,1,1],[1,1,1,1]] },
  '1-2':   { rows: 2, cols: 2, cells: [[0,0,2,1],[0,1,1,1],[1,1,1,1]] },
  '2-1':   { rows: 2, cols: 2, cells: [[0,0,1,1],[1,0,1,1],[0,1,2,1]] },
};

function LayoutIcon({ presetId, size = 40, active }) {
  const icon = PRESET_ICONS[presetId];
  if (!icon) return null;
  const gap = 2;
  const pad = 3;
  const inner = size - pad * 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <rect x="0" y="0" width={size} height={size} rx="3"
        fill={active ? 'rgba(88,166,255,0.15)' : 'rgba(255,255,255,0.05)'}
        stroke={active ? '#58a6ff' : 'rgba(255,255,255,0.1)'}
        strokeWidth="1" />
      {icon.cells.map(([row, col, rowSpan, colSpan], i) => {
        const cellW = (inner - (icon.cols - 1) * gap) / icon.cols;
        const cellH = (inner - (icon.rows - 1) * gap) / icon.rows;
        const x = pad + col * (cellW + gap);
        const y = pad + row * (cellH + gap);
        const w = colSpan * cellW + (colSpan - 1) * gap;
        const h = rowSpan * cellH + (rowSpan - 1) * gap;
        return (
          <rect key={i} x={x} y={y} width={w} height={h} rx="2"
            fill={active ? '#58a6ff' : 'rgba(255,255,255,0.15)'} />
        );
      })}
    </svg>
  );
}

function LayoutManager() {
  const [layoutState, setLayoutState] = useState(null);
  const [sessions, setSessions] = useState([]);
  const ds = window.deepsteve;

  useEffect(() => {
    if (!ds) return;

    const unsubLayout = ds.onLayoutChanged?.((state) => {
      setLayoutState(state);
    });
    const unsubSessions = ds.onSessionsChanged?.((list) => {
      setSessions(list);
    });

    return () => {
      if (unsubLayout) unsubLayout();
      if (unsubSessions) unsubSessions();
    };
  }, []);

  const handlePresetClick = useCallback((presetId) => {
    ds?.setLayout(presetId);
  }, []);

  const handlePaneAssign = useCallback((paneIndex, sessionId) => {
    ds?.assignPane(paneIndex, sessionId);
  }, []);

  const handlePaneFocus = useCallback((paneIndex) => {
    ds?.focusPane(paneIndex);
  }, []);

  if (!layoutState) {
    return <div style={styles.container}><div style={styles.loading}>Loading...</div></div>;
  }

  const presets = layoutState.presets || [];
  const panes = layoutState.panes || [];
  const currentLayout = layoutState.layoutId;
  const focused = layoutState.focusedPane;

  // Sessions already assigned to panes
  const assignedIds = new Set(panes.map(p => p.sessionId).filter(Boolean));
  // Unassigned sessions (available for assignment)
  const unassigned = sessions.filter(s => !assignedIds.has(s.id));

  return (
    <div style={styles.container}>
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Layout</div>
        <div style={styles.presetGrid}>
          {presets.map(p => (
            <button
              key={p.id}
              style={{
                ...styles.presetBtn,
                ...(currentLayout === p.id ? styles.presetBtnActive : {}),
              }}
              onClick={() => handlePresetClick(p.id)}
              title={p.name}
            >
              <LayoutIcon presetId={p.id} size={36} active={currentLayout === p.id} />
              <span style={styles.presetLabel}>{p.name}</span>
            </button>
          ))}
        </div>
      </div>

      {currentLayout !== 'single' && panes.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Panes</div>
          <div style={styles.paneList}>
            {panes.map((pane, i) => {
              const session = pane.sessionId
                ? sessions.find(s => s.id === pane.sessionId)
                : null;
              const isFocused = i === focused;

              return (
                <div
                  key={i}
                  style={{
                    ...styles.paneRow,
                    ...(isFocused ? styles.paneRowFocused : {}),
                  }}
                  onClick={() => handlePaneFocus(i)}
                >
                  <div style={styles.paneIndex}>
                    <span style={{
                      ...styles.paneDot,
                      background: isFocused ? '#58a6ff' : 'rgba(255,255,255,0.2)',
                    }} />
                    {i + 1}
                  </div>
                  <select
                    style={styles.paneSelect}
                    value={pane.sessionId || ''}
                    onChange={(e) => {
                      e.stopPropagation();
                      handlePaneAssign(i, e.target.value || null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <option value="">Empty</option>
                    {session && (
                      <option value={session.id}>{session.name || session.id}</option>
                    )}
                    {unassigned.map(s => (
                      <option key={s.id} value={s.id}>{s.name || s.id}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {currentLayout !== 'single' && unassigned.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            Hidden ({unassigned.length})
          </div>
          <div style={styles.hiddenList}>
            {unassigned.map(s => (
              <div key={s.id} style={styles.hiddenItem}>
                <span style={styles.hiddenName}>{s.name || s.id}</span>
                <button
                  style={styles.showBtn}
                  onClick={() => ds?.focusSession(s.id)}
                  title="Show in focused pane"
                >
                  Show
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    padding: '12px',
    fontSize: '13px',
    lineHeight: '1.4',
  },
  loading: {
    color: 'rgba(255,255,255,0.4)',
    textAlign: 'center',
    padding: '20px',
  },
  section: {
    marginBottom: '16px',
  },
  sectionTitle: {
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: 'rgba(255,255,255,0.4)',
    marginBottom: '8px',
  },
  presetGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
    gap: '6px',
  },
  presetBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    padding: '6px 4px',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '6px',
    cursor: 'pointer',
    color: 'rgba(255,255,255,0.6)',
    fontSize: '10px',
    transition: 'all 0.15s',
  },
  presetBtnActive: {
    background: 'rgba(88,166,255,0.1)',
    borderColor: '#58a6ff',
    color: '#58a6ff',
  },
  presetLabel: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '100%',
  },
  paneList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  paneRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    borderRadius: '4px',
    cursor: 'pointer',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid transparent',
    transition: 'all 0.15s',
  },
  paneRowFocused: {
    borderColor: 'rgba(88,166,255,0.3)',
    background: 'rgba(88,166,255,0.05)',
  },
  paneIndex: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    fontWeight: '600',
    color: 'rgba(255,255,255,0.5)',
    minWidth: '28px',
  },
  paneDot: {
    display: 'inline-block',
    width: '6px',
    height: '6px',
    borderRadius: '50%',
  },
  paneSelect: {
    flex: 1,
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '4px',
    color: 'inherit',
    padding: '4px 6px',
    fontSize: '12px',
    cursor: 'pointer',
    outline: 'none',
  },
  hiddenList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  hiddenItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
    borderRadius: '4px',
    background: 'rgba(255,255,255,0.03)',
  },
  hiddenName: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.5)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  showBtn: {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '4px',
    color: 'rgba(255,255,255,0.6)',
    padding: '2px 8px',
    fontSize: '11px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};

const root = ReactDOM.createRoot(document.getElementById('layout-root'));
root.render(<LayoutManager />);

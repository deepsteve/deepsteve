const { useState, useEffect, useRef, useCallback } = React;

const PIXEL = 3;
const PALETTE = {
  sky: ["#1a1a2e", "#16213e", "#0f3460", "#533483"],
  building: {
    wall: "#4a4a5a",
    wallLight: "#5a5a6a",
    wallDark: "#3a3a4a",
    window: "#0a0a1a",
    windowLit: "#ffd700",
    trim: "#6a6a7a",
    floor: "#353545",
    accent: "#7c4dff",
  },
  computer: {
    body: "#2a2a3a",
    screen: "#0d1117",
    screenGlow: "#00e676",
    keyboard: "#1a1a2a",
  },
  person: ["#f4a460", "#8d6e63", "#ffcc80", "#d4a574"],
  chair: "#3a3a5a",
  stars: "#ffffff",
};

const PROJECT_COLORS = [
  { name: "green", screen: "#00e676", glow: "rgba(0,230,118,0.15)" },
  { name: "blue", screen: "#42a5f5", glow: "rgba(66,165,245,0.15)" },
  { name: "amber", screen: "#ffab00", glow: "rgba(255,171,0,0.15)" },
  { name: "pink", screen: "#f06292", glow: "rgba(240,98,146,0.15)" },
  { name: "cyan", screen: "#26c6da", glow: "rgba(38,198,218,0.15)" },
  { name: "purple", screen: "#b388ff", glow: "rgba(179,136,255,0.15)" },
];

const FLOORS_STORAGE_KEY = "tower-mod-floors";

function loadFloors() {
  try {
    const raw = localStorage.getItem(FLOORS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveFloors(floors) {
  localStorage.setItem(FLOORS_STORAGE_KEY, JSON.stringify(floors));
}

function PixelText({ text, x, y, size = 12, color = "#fff", align = "left" }) {
  return (
    <text
      x={x}
      y={y}
      fill={color}
      fontSize={size}
      fontFamily={'"Press Start 2P", monospace'}
      textAnchor={align === "center" ? "middle" : align === "right" ? "end" : "start"}
      dominantBaseline="middle"
      style={{ imageRendering: "pixelated" }}
    >
      {text}
    </text>
  );
}

function Star({ x, y, twinkle }) {
  const [opacity, setOpacity] = useState(Math.random);
  useEffect(() => {
    if (!twinkle) return;
    const interval = setInterval(() => {
      setOpacity(0.3 + Math.random() * 0.7);
    }, 1000 + Math.random() * 2000);
    return () => clearInterval(interval);
  }, [twinkle]);
  return <rect x={x} y={y} width={PIXEL} height={PIXEL} fill={PALETTE.stars} opacity={opacity} />;
}

function Computer({ x, y, screenColor, sessionName, waiting, onClick }) {
  const [cursorOn, setCursorOn] = useState(true);
  const [codeLines] = useState(() => {
    const lines = [];
    for (let i = 0; i < 4; i++) lines.push(Math.floor(3 + Math.random() * 12));
    return lines;
  });

  useEffect(() => {
    const interval = setInterval(() => setCursorOn((p) => !p), 530);
    return () => clearInterval(interval);
  }, []);

  const p = PIXEL;
  const monW = 24 * p;
  const monH = 18 * p;

  return (
    <g onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      {/* Monitor */}
      <rect x={x} y={y} width={monW} height={monH} rx={p} fill={PALETTE.computer.body} />
      <rect x={x + p} y={y + p} width={monW - 2 * p} height={monH - 4 * p} fill={PALETTE.computer.screen} />

      {/* Screen glow */}
      <rect x={x + p} y={y + p} width={monW - 2 * p} height={monH - 4 * p} fill={screenColor} opacity={0.05} />

      {/* Code lines */}
      {codeLines.map((len, i) => (
        <rect
          key={i}
          x={x + 2.5 * p}
          y={y + 2.5 * p + i * 2.5 * p}
          width={Math.min(len * p, monW - 6 * p)}
          height={1.5 * p}
          fill={screenColor}
          opacity={0.6}
          rx={0.5}
        />
      ))}

      {/* Blinking cursor */}
      {cursorOn && (
        <rect
          x={x + 2.5 * p + (codeLines[3] || 5) * p}
          y={y + 2.5 * p + 3 * 2.5 * p}
          width={1.5 * p}
          height={1.5 * p}
          fill={screenColor}
        />
      )}

      {/* Monitor stand */}
      <rect x={x + monW / 2 - 2 * p} y={y + monH} width={4 * p} height={2 * p} fill={PALETTE.computer.body} />
      <rect x={x + monW / 2 - 4 * p} y={y + monH + 2 * p} width={8 * p} height={p} fill={PALETTE.computer.body} />

      {/* Keyboard */}
      <rect x={x - p} y={y + monH + 3.5 * p} width={monW + 2 * p} height={4 * p} rx={p} fill={PALETTE.computer.keyboard} />
      {[0, 1, 2].map((row) =>
        Array.from({ length: 7 - row }, (_, col) => (
          <rect
            key={`${row}-${col}`}
            x={x + p + col * 3 * p + row * p}
            y={y + monH + 4 * p + row * 1.2 * p}
            width={2 * p}
            height={p * 0.8}
            fill="#2a2a3a"
            rx={0.3}
          />
        ))
      )}

      {/* Waiting indicator (pulsing dot) */}
      {waiting && (
        <circle cx={x + monW - 2 * p} cy={y - 1.5 * p} r={3 * p} fill="#ffab00" opacity={0.9}>
          <animate attributeName="opacity" values="0.9;0.3;0.9" dur="1.5s" repeatCount="indefinite" />
        </circle>
      )}

      {/* Session name label */}
      {sessionName && (
        <PixelText
          text={sessionName.length > 10 ? sessionName.slice(0, 9) + "\u2026" : sessionName}
          x={x + monW / 2}
          y={y + monH + 9 * p}
          size={7}
          color="#8a8a9a"
          align="center"
        />
      )}
    </g>
  );
}

function Person({ x, y, colorIdx = 0, facing = "right" }) {
  const p = PIXEL;
  const skinColor = PALETTE.person[colorIdx % PALETTE.person.length];
  const shirtColors = ["#4fc3f7", "#7c4dff", "#66bb6a", "#f06292", "#ffab00", "#26c6da"];
  const shirt = shirtColors[colorIdx % shirtColors.length];
  const cx = facing === "right" ? x : x + 6 * p;

  return (
    <g transform={facing === "left" ? `translate(${2 * cx}, 0) scale(-1, 1)` : undefined}>
      {/* Chair */}
      <rect x={x - 2 * p} y={y + 2 * p} width={10 * p} height={8 * p} rx={p} fill={PALETTE.chair} />
      <rect x={x - 3 * p} y={y + 2 * p} width={2 * p} height={12 * p} fill={PALETTE.chair} rx={0.5} />

      {/* Body */}
      <rect x={x} y={y + 2 * p} width={6 * p} height={6 * p} fill={shirt} rx={p} />

      {/* Arms */}
      <rect x={x + 5 * p} y={y + 3 * p} width={4 * p} height={2 * p} fill={shirt} rx={p} />
      <rect x={x + 8 * p} y={y + 3 * p} width={2 * p} height={2 * p} fill={skinColor} rx={p} />

      {/* Head */}
      <rect x={x + p} y={y - 4 * p} width={5 * p} height={6 * p} rx={p} fill={skinColor} />
      {/* Hair */}
      <rect x={x + 0.5 * p} y={y - 5 * p} width={6 * p} height={3 * p} rx={p} fill="#2a2a3a" />
      {/* Eye */}
      <rect x={x + 4 * p} y={y - 2 * p} width={p} height={p} fill="#1a1a2a" />
    </g>
  );
}

function Floor({ floorData, sessions: floorSessions, y, width, isSelected, onClick, floorNum }) {
  const p = PIXEL;
  const floorH = 42 * p;
  const wallInset = 12 * p;
  const colorScheme = PROJECT_COLORS[floorData.color % PROJECT_COLORS.length];
  const count = Math.min(floorSessions.length, 4);
  const computerSpacing = count > 0 ? (width - 2 * wallInset - 24 * p) / Math.max(count, 1) : 0;

  return (
    <g onClick={onClick} style={{ cursor: "pointer" }}>
      {/* Floor slab */}
      <rect x={wallInset - 2 * p} y={y + floorH - 2 * p} width={width - 2 * wallInset + 4 * p} height={3 * p} fill={PALETTE.building.trim} />

      {/* Walls */}
      <rect x={wallInset} y={y} width={width - 2 * wallInset} height={floorH - 2 * p} fill={PALETTE.building.wall} />

      {/* Wall texture */}
      {[0.25, 0.5, 0.75].map((frac) => (
        <line key={frac} x1={wallInset} y1={y + floorH * frac} x2={width - wallInset} y2={y + floorH * frac}
          stroke={PALETTE.building.wallDark} strokeWidth={0.5} opacity={0.3} />
      ))}

      {/* Selection highlight */}
      {isSelected && (
        <rect x={wallInset} y={y} width={width - 2 * wallInset} height={floorH - 2 * p}
          fill={colorScheme.glow} stroke={colorScheme.screen} strokeWidth={1.5} />
      )}

      {/* Ceiling light */}
      <rect x={wallInset + 10 * p} y={y + 2 * p} width={width - 2 * wallInset - 20 * p} height={p} fill="#8a8a9a" opacity={0.5} />

      {/* Floor label */}
      <rect x={wallInset + 2 * p} y={y + 3 * p} width={Math.max(floorData.name.length * 5.5 + 14, 60)} height={9 * p} rx={p} fill="rgba(0,0,0,0.5)" />
      <PixelText text={`F${floorNum}`} x={wallInset + 4 * p} y={y + 8 * p} size={8} color={colorScheme.screen} />
      <PixelText text={floorData.name} x={wallInset + 16 * p} y={y + 8 * p} size={8} color="#ccc" />

      {/* Computers and people */}
      {floorSessions.slice(0, 4).map((session, i) => {
        const cx = wallInset + 16 * p + i * computerSpacing;
        const cy = y + 14 * p;
        return (
          <g key={session.id}>
            <Computer
              x={cx} y={cy}
              screenColor={colorScheme.screen}
              sessionName={session.name}
              waiting={session.waitingForInput}
              onClick={(e) => {
                e.stopPropagation();
                if (window.deepsteve) window.deepsteve.focusSession(session.id);
              }}
            />
            <Person x={cx - 8 * p} y={cy + 6 * p} colorIdx={i + floorData.color} facing="right" />
          </g>
        );
      })}

      {/* Window decorations */}
      {Array.from({ length: 2 }, (_, i) => (
        <g key={`win-${i}`}>
          <rect x={width - wallInset - 12 * p} y={y + 6 * p + i * 14 * p}
            width={8 * p} height={10 * p} fill={PALETTE.building.window} rx={p} />
          <rect x={width - wallInset - 11 * p} y={y + 7 * p + i * 14 * p}
            width={6 * p} height={8 * p} fill={i === 0 ? "#1a1a3e" : "#0f1a3e"} opacity={0.8} />
          <rect x={width - wallInset - 9 * p} y={y + 9 * p + i * 14 * p}
            width={p * 0.8} height={p * 0.8} fill="#fff" opacity={0.4} />
        </g>
      ))}
    </g>
  );
}

function Roof({ y, width }) {
  const p = PIXEL;
  const wallInset = 12 * p;
  const bw = width - 2 * wallInset;

  return (
    <g>
      <rect x={wallInset - 4 * p} y={y} width={bw + 8 * p} height={4 * p} fill={PALETTE.building.trim} />
      <rect x={wallInset + 10 * p} y={y - 16 * p} width={bw - 20 * p} height={16 * p} fill={PALETTE.building.wallDark} />
      <rect x={wallInset + 8 * p} y={y - 18 * p} width={bw - 16 * p} height={4 * p} fill={PALETTE.building.trim} />

      {/* Antenna */}
      <rect x={width / 2 - p} y={y - 40 * p} width={2 * p} height={22 * p} fill={PALETTE.building.trim} />
      <rect x={width / 2 - 4 * p} y={y - 42 * p} width={8 * p} height={3 * p} fill={PALETTE.building.trim} rx={p} />
      <circle cx={width / 2} cy={y - 44 * p} r={2 * p} fill="#ff1744" opacity={0.9}>
        <animate attributeName="opacity" values="0.9;0.2;0.9" dur="1.5s" repeatCount="indefinite" />
      </circle>

      {/* Sign */}
      <rect x={wallInset + 14 * p} y={y - 14 * p} width={bw - 28 * p} height={10 * p} rx={p} fill="rgba(0,0,0,0.7)" />
      <PixelText text="DEEP STEVE TOWER" x={width / 2} y={y - 8.5 * p} size={10} color="#b388ff" align="center" />
    </g>
  );
}

function Lobby({ y, width, sessions: lobbySessions }) {
  const p = PIXEL;
  const wallInset = 12 * p;
  const count = lobbySessions.length;
  const lobbyH = 36 * p + (count > 0 ? 30 * p : 0);
  const computerSpacing = count > 0 ? (width - 2 * wallInset - 24 * p) / Math.max(count, 1) : 0;

  return (
    <g>
      {/* Lobby walls */}
      <rect x={wallInset} y={y} width={width - 2 * wallInset} height={lobbyH} fill="#3a3a4f" />

      {/* Glass doors */}
      <rect x={width / 2 - 14 * p} y={y + 4 * p} width={28 * p} height={28 * p} fill="#1a2a4a" rx={p} opacity={0.7} />
      <rect x={width / 2 - 12 * p} y={y + 6 * p} width={11 * p} height={24 * p} fill="#0f1f3f" rx={p} />
      <rect x={width / 2 + p} y={y + 6 * p} width={11 * p} height={24 * p} fill="#0f1f3f" rx={p} />
      <rect x={width / 2 - 2 * p} y={y + 14 * p} width={p} height={8 * p} fill="#8a8a9a" rx={0.5} />
      <rect x={width / 2 + p} y={y + 14 * p} width={p} height={8 * p} fill="#8a8a9a" rx={0.5} />

      {/* Lobby label */}
      <PixelText text={"\u25C6 LOBBY \u25C6"} x={width / 2} y={y + lobbyH - 6 * p - (count > 0 ? 30 * p : 0)} size={8} color="#8a8a9a" align="center" />

      {/* Unassigned sessions in lobby */}
      {lobbySessions.slice(0, 4).map((session, i) => {
        const cx = wallInset + 16 * p + i * computerSpacing;
        const cy = y + lobbyH - 28 * p;
        return (
          <g key={session.id}>
            <Computer
              x={cx} y={cy}
              screenColor="#00e676"
              sessionName={session.name}
              waiting={session.waitingForInput}
              onClick={(e) => {
                e.stopPropagation();
                if (window.deepsteve) window.deepsteve.focusSession(session.id);
              }}
            />
            <Person x={cx - 8 * p} y={cy + 6 * p} colorIdx={i} facing="right" />
          </g>
        );
      })}

      {/* Foundation */}
      <rect x={wallInset - 6 * p} y={y + lobbyH} width={width - 2 * wallInset + 12 * p} height={5 * p} fill={PALETTE.building.wallDark} />
    </g>
  );
}

function TowerApp() {
  const [sessions, setSessions] = useState([]);
  const [floors, setFloors] = useState(loadFloors);
  const [selectedFloor, setSelectedFloor] = useState(null);
  const [newName, setNewName] = useState("");
  const [modSettings, setModSettings] = useState({});
  const [editMode, setEditMode] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [nextId, setNextId] = useState(() => {
    const saved = loadFloors();
    return saved.length > 0 ? Math.max(...saved.map(f => f.id)) + 1 : 1;
  });

  // Connect to deepsteve bridge
  useEffect(() => {
    let unsubSessions = null;
    let unsubSettings = null;
    let attempts = 0;
    const poll = setInterval(() => {
      if (window.deepsteve) {
        clearInterval(poll);
        unsubSessions = window.deepsteve.onSessionsChanged((list) => {
          setSessions(list);
        });
        if (window.deepsteve.onSettingsChanged) {
          unsubSettings = window.deepsteve.onSettingsChanged((settings) => {
            setModSettings(settings);
          });
        }
      } else if (++attempts > 100) {
        clearInterval(poll);
      }
    }, 100);
    return () => {
      clearInterval(poll);
      if (unsubSessions) unsubSessions();
      if (unsubSettings) unsubSettings();
    };
  }, []);

  // Persist floors
  useEffect(() => {
    saveFloors(floors);
  }, [floors]);

  // Compute which sessions are assigned to floors and which are in the lobby
  const assignedIds = new Set();
  for (const f of floors) {
    for (const sid of (f.sessionIds || [])) assignedIds.add(sid);
  }
  const lobbySessions = sessions.filter(s => !assignedIds.has(s.id));

  const getFloorSessions = useCallback((floor) => {
    const ids = floor.sessionIds || [];
    return ids.map(id => sessions.find(s => s.id === id)).filter(Boolean);
  }, [sessions]);

  const p = PIXEL;
  const svgWidth = 520;
  const floorH = 42 * p;
  const roofExtra = 50 * p;
  const lobbySessionCount = lobbySessions.length;
  const lobbyH = 41 * p + (lobbySessionCount > 0 ? 30 * p : 0);
  const svgHeight = roofExtra + floors.length * floorH + lobbyH + 20 * p;

  const stars = useRef(
    Array.from({ length: 40 }, () => ({
      x: Math.random() * svgWidth,
      y: Math.random() * 200,
    }))
  );

  const addFloor = () => {
    if (!newName.trim()) return;
    const f = { id: nextId, name: newName.trim(), sessionIds: [], color: (nextId - 1) % PROJECT_COLORS.length };
    setFloors((prev) => [...prev, f]);
    setNextId((n) => n + 1);
    setNewName("");
  };

  const removeFloor = (id) => {
    setFloors((prev) => prev.filter((f) => f.id !== id));
    if (selectedFloor === id) setSelectedFloor(null);
  };

  const assignSession = (floorId, sessionId) => {
    setFloors(prev => prev.map(f => {
      // When multi-floor is off, remove from other floors first
      const ids = modSettings.allowMultiFloor
        ? [...(f.sessionIds || [])]
        : (f.sessionIds || []).filter(id => id !== sessionId);
      if (f.id === floorId && !ids.includes(sessionId)) ids.push(sessionId);
      return { ...f, sessionIds: ids };
    }));
  };

  const unassignSession = (floorId, sessionId) => {
    setFloors(prev => prev.map(f =>
      f.id === floorId ? { ...f, sessionIds: (f.sessionIds || []).filter(id => id !== sessionId) } : f
    ));
  };

  const cycleColor = (id) => {
    setFloors((prev) =>
      prev.map((f) => (f.id === id ? { ...f, color: (f.color + 1) % PROJECT_COLORS.length } : f))
    );
  };

  const moveFloor = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    setFloors(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const handleDragStart = (idx) => (e) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (idx) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  };
  const handleDrop = (idx) => (e) => {
    e.preventDefault();
    if (dragIdx != null) moveFloor(dragIdx, idx);
    setDragIdx(null);
    setDragOverIdx(null);
  };
  const handleDragEnd = () => {
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const selectedData = floors.find((f) => f.id === selectedFloor);

  // Sessions available to assign to the selected floor
  const selectedFloorSessionIds = new Set((selectedData?.sessionIds || []));
  const unassignedForSelected = modSettings.allowMultiFloor
    ? sessions.filter(s => !selectedFloorSessionIds.has(s.id))
    : sessions.filter(s => !selectedFloorSessionIds.has(s.id) && !assignedIds.has(s.id));

  return (
    <div style={{
      height: "100vh",
      fontFamily: '"Press Start 2P", monospace',
      color: "#e0e0e0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "20px 12px",
      overflow: "auto",
    }}>
      <h1 style={{
        fontSize: 20, color: "#b388ff",
        textShadow: "0 0 20px rgba(179,136,255,0.5)",
        letterSpacing: 2, marginBottom: 8, textAlign: "center", flexShrink: 0,
      }}>
        DEEP STEVE TOWER
      </h1>
      <p style={{ fontSize: 11, color: "#6a6a8a", marginBottom: 20, textAlign: "center", flexShrink: 0 }}>
        Each floor is a project. Each computer is a session. Click a computer to open it.
      </p>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center", width: "100%", maxWidth: 960, flex: "1 0 auto", minHeight: 0 }}>
        {/* SVG Building */}
        <div style={{
          flex: "1 1 520px", maxWidth: 540,
          overflow: "auto", border: "2px solid #2a2a4a", borderRadius: 8,
          background: "rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", alignItems: "center",
        }}>
          <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            style={{ imageRendering: "pixelated", display: "block" }}>
            <defs>
              <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0a0a1a" />
                <stop offset="60%" stopColor="#1a1a2e" />
                <stop offset="100%" stopColor="#16213e" />
              </linearGradient>
            </defs>
            <rect width={svgWidth} height={svgHeight} fill="url(#skyGrad)" />

            {stars.current.map((s, i) => (
              <Star key={i} x={s.x} y={s.y} twinkle />
            ))}

            <Roof y={roofExtra} width={svgWidth} />

            {[...floors].reverse().map((floor, idx) => (
              <Floor
                key={floor.id}
                floorData={floor}
                sessions={getFloorSessions(floor)}
                y={roofExtra + 4 * p + idx * floorH}
                width={svgWidth}
                isSelected={selectedFloor === floor.id}
                onClick={() => setSelectedFloor(selectedFloor === floor.id ? null : floor.id)}
                floorNum={floors.length - idx}
              />
            ))}

            <Lobby y={roofExtra + 4 * p + floors.length * floorH} width={svgWidth} sessions={lobbySessions} />
          </svg>
        </div>

        {/* Control Panel */}
        <div style={{ flex: "1 1 300px", maxWidth: 380, display: "flex", flexDirection: "column", gap: 12, overflow: "auto" }}>
          {/* Add Floor */}
          <div style={{ background: "rgba(30,30,50,0.8)", border: "2px solid #2a2a4a", borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: "#b388ff", marginBottom: 10 }}>+ ADD PROJECT FLOOR</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addFloor()}
                placeholder="Project name..." maxLength={16}
                style={{
                  flex: 1, background: "#0a0a1a", border: "1px solid #3a3a5a", borderRadius: 4,
                  color: "#e0e0e0", fontFamily: '"Press Start 2P", monospace', fontSize: 11,
                  padding: "8px 10px", outline: "none",
                }}
              />
              <button onClick={addFloor} style={{
                background: "#7c4dff", border: "none", borderRadius: 4, color: "#fff",
                fontFamily: '"Press Start 2P", monospace', fontSize: 11, padding: "8px 12px", cursor: "pointer",
              }}>
                BUILD
              </button>
            </div>
          </div>

          {/* Floor List */}
          <div style={{ background: "rgba(30,30,50,0.8)", border: "2px solid #2a2a4a", borderRadius: 8, padding: 14, maxHeight: 300, overflow: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: "#8a8a9a" }}>FLOORS ({floors.length})</div>
              {floors.length > 1 && (
                <button onClick={() => { setEditMode(m => !m); setDragIdx(null); setDragOverIdx(null); }} style={{
                  background: editMode ? "rgba(124,77,255,0.3)" : "transparent",
                  border: `1px solid ${editMode ? "#b388ff" : "#3a3a5a"}`,
                  borderRadius: 3, color: editMode ? "#b388ff" : "#6a6a8a",
                  fontFamily: '"Press Start 2P", monospace', fontSize: 9, padding: "4px 8px", cursor: "pointer",
                }}>
                  {editMode ? "DONE" : "EDIT"}
                </button>
              )}
            </div>
            {floors.length === 0 && (
              <div style={{ fontSize: 11, color: "#4a4a6a", textAlign: "center", padding: 20 }}>
                No floors yet. Add a project above!
              </div>
            )}
            {[...floors].reverse().map((f, revIdx) => {
              const realIdx = floors.length - 1 - revIdx;
              const col = PROJECT_COLORS[f.color % PROJECT_COLORS.length];
              const isSelected = selectedFloor === f.id;
              const floorSessionCount = getFloorSessions(f).length;
              const isDragging = dragIdx === realIdx;
              const isDragOver = dragOverIdx === realIdx && dragIdx !== realIdx;
              return (
                <div key={f.id}
                  draggable={editMode}
                  onDragStart={editMode ? handleDragStart(realIdx) : undefined}
                  onDragOver={editMode ? handleDragOver(realIdx) : undefined}
                  onDrop={editMode ? handleDrop(realIdx) : undefined}
                  onDragEnd={editMode ? handleDragEnd : undefined}
                  onClick={editMode ? undefined : () => setSelectedFloor(isSelected ? null : f.id)}
                  style={{
                    background: isDragOver ? "rgba(124,77,255,0.25)" : isSelected && !editMode ? "rgba(124,77,255,0.15)" : "rgba(0,0,0,0.3)",
                    border: `1px solid ${isDragOver ? "#b388ff" : isSelected && !editMode ? col.screen : "#2a2a4a"}`,
                    borderRadius: 6, padding: "8px 10px", marginBottom: 6,
                    cursor: editMode ? "grab" : "pointer",
                    opacity: isDragging ? 0.4 : 1,
                    transition: "background 0.15s, border-color 0.15s, opacity 0.15s",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {editMode && (
                        <span style={{ fontSize: 10, color: "#6a6a8a", cursor: "grab", userSelect: "none" }}>{"\u2630"}</span>
                      )}
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: col.screen, boxShadow: `0 0 6px ${col.screen}` }} />
                      <span style={{ fontSize: 11, color: "#e0e0e0" }}>{f.name}</span>
                    </div>
                    <span style={{ fontSize: 10, color: "#6a6a8a" }}>F{floors.length - revIdx}</span>
                  </div>
                  {!editMode && (
                    <div style={{ fontSize: 10, color: "#6a6a8a", marginTop: 4 }}>
                      {floorSessionCount} session{floorSessionCount !== 1 ? "s" : ""} assigned
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Selected Floor Controls */}
          {selectedData && (
            <div style={{
              background: "rgba(30,30,50,0.8)",
              border: `2px solid ${PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].screen}`,
              borderRadius: 8, padding: 14,
            }}>
              <div style={{ fontSize: 12, color: PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].screen, marginBottom: 10 }}>
                {"\u25B8"} {selectedData.name}
              </div>

              {/* Assigned sessions */}
              <div style={{ fontSize: 10, color: "#8a8a9a", marginBottom: 6 }}>ASSIGNED SESSIONS</div>
              {getFloorSessions(selectedData).length === 0 && (
                <div style={{ fontSize: 10, color: "#4a4a6a", marginBottom: 8, padding: "4px 0" }}>None yet</div>
              )}
              {getFloorSessions(selectedData).map(s => (
                <div key={s.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  background: "rgba(0,0,0,0.3)", borderRadius: 4, padding: "6px 8px", marginBottom: 4, fontSize: 10,
                }}>
                  <span style={{ color: "#e0e0e0" }}>{s.name}</span>
                  <button onClick={() => unassignSession(selectedData.id, s.id)} style={{
                    background: "transparent", border: "none", color: "#f85149", cursor: "pointer",
                    fontFamily: '"Press Start 2P", monospace', fontSize: 10,
                  }}>-</button>
                </div>
              ))}

              {/* Unassigned sessions to add */}
              {unassignedForSelected.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 10, color: "#8a8a9a", marginBottom: 6 }}>ADD SESSION</div>
                  {unassignedForSelected.map(s => (
                    <div key={s.id} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      background: "rgba(0,0,0,0.2)", borderRadius: 4, padding: "6px 8px", marginBottom: 4, fontSize: 10,
                    }}>
                      <span style={{ color: "#8a8a9a" }}>{s.name}</span>
                      <button onClick={() => assignSession(selectedData.id, s.id)} style={{
                        background: "transparent", border: "none", color: "#00e676", cursor: "pointer",
                        fontFamily: '"Press Start 2P", monospace', fontSize: 10,
                      }}>+</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Color cycle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0" }}>
                <span style={{ fontSize: 11, color: "#8a8a9a" }}>Theme</span>
                <button onClick={() => cycleColor(selectedData.id)} style={{
                  background: "transparent", border: `1px solid ${PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].screen}`,
                  borderRadius: 3, color: PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].screen,
                  fontFamily: '"Press Start 2P", monospace', fontSize: 10, padding: "6px 10px", cursor: "pointer",
                }}>
                  {PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].name.toUpperCase()}
                </button>
              </div>

              {/* Delete */}
              <button onClick={() => removeFloor(selectedData.id)} style={{
                width: "100%", background: "rgba(255,23,68,0.15)", border: "1px solid #ff1744",
                borderRadius: 4, color: "#ff1744", fontFamily: '"Press Start 2P", monospace',
                fontSize: 10, padding: "8px", cursor: "pointer",
              }}>
                DEMOLISH FLOOR
              </button>
            </div>
          )}

          {/* Stats */}
          <div style={{ background: "rgba(30,30,50,0.8)", border: "2px solid #2a2a4a", borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: "#8a8a9a", marginBottom: 8 }}>TOWER STATS</div>
            <div style={{ fontSize: 11, color: "#6a6a8a", lineHeight: 2.2 }}>
              <div>Floors: <span style={{ color: "#b388ff" }}>{floors.length}</span></div>
              <div>Total Sessions: <span style={{ color: "#00e676" }}>{sessions.length}</span></div>
              <div>In Lobby: <span style={{ color: "#ffab00" }}>{lobbySessions.length}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("tower-root")).render(<TowerApp />);

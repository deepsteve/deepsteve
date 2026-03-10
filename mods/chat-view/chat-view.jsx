const { useState, useEffect, useCallback, useRef, useMemo } = React;

// ─── Helpers ──────────────────────────────────────────────────────────

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const COLORS = ['#58a6ff', '#f0883e', '#a5d6ff', '#7ee787', '#d2a8ff', '#f85149', '#79c0ff', '#ffa657', '#ff7b72', '#56d364', '#bc8cff', '#e3b341'];

function senderColor(name) {
  return COLORS[hashName(name) % COLORS.length];
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const msgDay = new Date(d); msgDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - msgDay) / 86400000);
  if (diffDays === 0) return time;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function renderMentions(text) {
  const parts = text.split(/(@"[^"]+"|@[\w-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@') && part.length > 1) {
      const quoted = part.startsWith('@"') && part.endsWith('"');
      const name = quoted ? part.slice(2, -1) : part.slice(1);
      const color = senderColor(name);
      return (
        <span key={i} style={{
          color,
          fontWeight: 600,
          background: `${color}18`,
          borderRadius: 4,
          padding: '1px 4px',
        }}>
          @{name}
        </span>
      );
    }
    return part;
  });
}

// ─── Animated SVG Avatar ──────────────────────────────────────────────

function Avatar({ name, size = 40 }) {
  const h = hashName(name);
  const color = senderColor(name);
  const shapeIdx = h % 4; // circle, hex, diamond, rounded-rect
  const patternIdx = (h >> 4) % 4; // none, dots, stripes, grid
  const faceIdx = (h >> 8) % 4;
  const bobDuration = 2.5 + ((h >> 12) & 0xf) / 15 * 1.5; // 2.5–4s
  const pulseDuration = 3 + ((h >> 16) & 0xf) / 15 * 2; // 3–5s
  const animId = `av-${name.replace(/\W/g, '')}`;

  const cx = size / 2, cy = size / 2, r = size * 0.4;

  let shapePath;
  switch (shapeIdx) {
    case 0: // circle
      shapePath = <circle cx={cx} cy={cy} r={r} />;
      break;
    case 1: { // hexagon
      const pts = Array.from({ length: 6 }, (_, i) => {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
      }).join(' ');
      shapePath = <polygon points={pts} />;
      break;
    }
    case 2: { // diamond
      shapePath = <polygon points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`} />;
      break;
    }
    case 3: // rounded rect
      shapePath = <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={r * 0.25} />;
      break;
  }

  let pattern = null;
  const patId = `pat-${animId}`;
  switch (patternIdx) {
    case 1: // dots
      pattern = (
        <pattern id={patId} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="4" r="1.2" fill="rgba(255,255,255,0.15)" />
        </pattern>
      );
      break;
    case 2: // stripes
      pattern = (
        <pattern id={patId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform={`rotate(${45 + (h & 0x3) * 30})`}>
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
        </pattern>
      );
      break;
    case 3: // grid
      pattern = (
        <pattern id={patId} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M 8 0 L 0 0 0 8" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
        </pattern>
      );
      break;
  }

  // Simple face
  const eyeY = cy - r * 0.1;
  const eyeSpread = r * 0.28;
  const eyeR = r * 0.08;
  const mouthY = cy + r * 0.2;
  let face;
  switch (faceIdx) {
    case 0: // smile
      face = (
        <>
          <circle cx={cx - eyeSpread} cy={eyeY} r={eyeR} fill="#fff" />
          <circle cx={cx + eyeSpread} cy={eyeY} r={eyeR} fill="#fff" />
          <path d={`M ${cx - r * 0.18} ${mouthY} Q ${cx} ${mouthY + r * 0.18} ${cx + r * 0.18} ${mouthY}`} fill="none" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
        </>
      );
      break;
    case 1: // dot eyes, line mouth
      face = (
        <>
          <circle cx={cx - eyeSpread} cy={eyeY} r={eyeR * 1.2} fill="#fff" />
          <circle cx={cx + eyeSpread} cy={eyeY} r={eyeR * 1.2} fill="#fff" />
          <line x1={cx - r * 0.12} y1={mouthY} x2={cx + r * 0.12} y2={mouthY} stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
        </>
      );
      break;
    case 2: // happy squint
      face = (
        <>
          <line x1={cx - eyeSpread - eyeR} y1={eyeY} x2={cx - eyeSpread + eyeR * 1.5} y2={eyeY} stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
          <line x1={cx + eyeSpread - eyeR * 1.5} y1={eyeY} x2={cx + eyeSpread + eyeR} y2={eyeY} stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
          <path d={`M ${cx - r * 0.2} ${mouthY} Q ${cx} ${mouthY + r * 0.22} ${cx + r * 0.2} ${mouthY}`} fill="none" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
        </>
      );
      break;
    case 3: // big eyes
      face = (
        <>
          <circle cx={cx - eyeSpread} cy={eyeY} r={eyeR * 1.8} fill="none" stroke="#fff" strokeWidth="1" />
          <circle cx={cx - eyeSpread} cy={eyeY} r={eyeR * 0.7} fill="#fff" />
          <circle cx={cx + eyeSpread} cy={eyeY} r={eyeR * 1.8} fill="none" stroke="#fff" strokeWidth="1" />
          <circle cx={cx + eyeSpread} cy={eyeY} r={eyeR * 0.7} fill="#fff" />
          <path d={`M ${cx - r * 0.1} ${mouthY + r * 0.02} Q ${cx} ${mouthY + r * 0.12} ${cx + r * 0.1} ${mouthY + r * 0.02}`} fill="none" stroke="#fff" strokeWidth="1" strokeLinecap="round" />
        </>
      );
      break;
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <style>{`
        @keyframes bob-${animId} {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
        @keyframes pulse-${animId} {
          0%, 100% { opacity: 0.85; }
          50% { opacity: 1; }
        }
      `}</style>
      <defs>
        {pattern}
      </defs>
      <g style={{ animation: `bob-${animId} ${bobDuration}s ease-in-out infinite, pulse-${animId} ${pulseDuration}s ease-in-out infinite` }}>
        <g fill={color}>
          {shapePath}
        </g>
        {patternIdx > 0 && (
          <g fill={`url(#${patId})`}>
            {shapePath}
          </g>
        )}
        {face}
      </g>
    </svg>
  );
}

// ─── ChatBubble ───────────────────────────────────────────────────────

function ChatBubble({ msg, showAvatar, index }) {
  const color = senderColor(msg.sender);

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: `${showAvatar ? 12 : 2} 20 2 20`,
      alignItems: 'flex-start',
      animation: `fadeSlideIn 0.3s ease-out`,
    }}>
      <div style={{ width: 40, flexShrink: 0 }}>
        {showAvatar && <Avatar name={msg.sender} size={40} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {showAvatar && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color }}>{msg.sender}</span>
            <span style={{ fontSize: 11, color: '#484f58' }}>{formatTime(msg.timestamp)}</span>
          </div>
        )}
        <div style={{
          fontSize: 14,
          color: '#c9d1d9',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.5,
        }}>
          {renderMentions(msg.text)}
        </div>
      </div>
    </div>
  );
}

// ─── ChannelSelector ──────────────────────────────────────────────────

function ChannelSelector({ channels, activeChannel, onSelect, lastReadIds }) {
  const channelNames = Object.keys(channels);
  const displayChannels = channelNames.length > 0 ? channelNames : ['general'];

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {displayChannels.map(name => {
        const isActive = name === activeChannel;
        const msgs = channels[name]?.messages || [];
        const lastRead = lastReadIds[name] || 0;
        const unreadCount = msgs.filter(m => m.id > lastRead).length;

        return (
          <button
            key={name}
            onClick={() => onSelect(name)}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              border: 'none',
              borderRadius: 20,
              cursor: 'pointer',
              background: isActive ? '#58a6ff' : 'rgba(255,255,255,0.06)',
              color: isActive ? '#fff' : '#8b949e',
              fontWeight: isActive ? 600 : 400,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.15s ease',
            }}
          >
            #{name}
            {unreadCount > 0 && !isActive && (
              <span style={{
                fontSize: 10,
                background: '#f85149',
                color: '#fff',
                padding: '1px 6px',
                borderRadius: 10,
                fontWeight: 600,
                minWidth: 18,
                textAlign: 'center',
              }}>
                {unreadCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── ChatView (main) ──────────────────────────────────────────────────

function ChatView() {
  const [channels, setChannels] = useState({});
  const [activeChannel, setActiveChannel] = useState('general');
  const [input, setInput] = useState('');
  const [senderName, setSenderName] = useState(() => {
    try { return localStorage.getItem('deepsteve-chat-sender') || 'Human'; }
    catch { return 'Human'; }
  });

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const prevMessageCountRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const lastReadIdRef = useRef((() => {
    try {
      const saved = localStorage.getItem('deepsteve-chat-view-last-read');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  })());

  // Persist sender name
  useEffect(() => {
    try { localStorage.setItem('deepsteve-chat-sender', senderName); }
    catch {}
  }, [senderName]);

  // Track user scroll position
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    userScrolledUpRef.current = !atBottom;
  }, []);

  function markChannelRead(ch) {
    const msgs = channels[ch]?.messages;
    if (!msgs || msgs.length === 0) return;
    const maxId = msgs[msgs.length - 1].id;
    if (lastReadIdRef.current[ch] === maxId) return;
    lastReadIdRef.current = { ...lastReadIdRef.current, [ch]: maxId };
    try { localStorage.setItem('deepsteve-chat-view-last-read', JSON.stringify(lastReadIdRef.current)); }
    catch {}
  }

  // Subscribe to agent chat data
  useEffect(() => {
    let unsub = null;
    function setup() {
      unsub = window.deepsteve.onAgentChatChanged((newChannels) => {
        setChannels(newChannels || {});
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

  // Auto-scroll on new messages (respect user scroll-up)
  useEffect(() => {
    const msgs = channels[activeChannel]?.messages || [];
    if (msgs.length > prevMessageCountRef.current) {
      const isInitialLoad = prevMessageCountRef.current === 0;
      if (isInitialLoad || !userScrolledUpRef.current) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: isInitialLoad ? 'instant' : 'smooth' });
        });
      }
      if (!document.hidden) {
        setTimeout(() => markChannelRead(activeChannel), 500);
      }
    }
    prevMessageCountRef.current = msgs.length;
  }, [channels, activeChannel]);

  // Mark as read when switching channels
  const selectChannel = useCallback((name) => {
    setActiveChannel(name);
    prevMessageCountRef.current = 0;
    userScrolledUpRef.current = false;
    setTimeout(() => markChannelRead(name), 300);
  }, [channels]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    try {
      await fetch(`/api/agent-chat/${encodeURIComponent(activeChannel)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: senderName, text }),
      });
    } catch (e) {
      console.error('Failed to send:', e);
    }
  }, [input, activeChannel, senderName]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const messages = channels[activeChannel]?.messages || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d1117' }}>
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Header */}
      <div style={{
        padding: '14px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}>
        <ChannelSelector
          channels={channels}
          activeChannel={activeChannel}
          onSelect={selectChannel}
          lastReadIds={lastReadIdRef.current}
        />
        <div style={{ fontSize: 12, color: '#484f58' }}>
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}
      >
        {messages.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#484f58',
            gap: 12,
          }}>
            <Avatar name={activeChannel} size={64} />
            <div style={{ fontSize: 15 }}>No messages in #{activeChannel} yet</div>
            <div style={{ fontSize: 12 }}>Send a message below or use the send_message MCP tool</div>
          </div>
        ) : (
          messages.map((msg, i) => {
            const prevMsg = i > 0 ? messages[i - 1] : null;
            const showAvatar = !prevMsg || prevMsg.sender !== msg.sender ||
              (msg.timestamp - prevMsg.timestamp > 60000);
            return <ChatBubble key={msg.id} msg={msg} showAvatar={showAvatar} index={i} />;
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div style={{
        padding: '12px 20px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        display: 'flex',
        gap: 10,
        alignItems: 'flex-end',
      }}>
        <input
          type="text"
          value={senderName}
          onChange={e => setSenderName(e.target.value)}
          placeholder="Name"
          style={{
            width: 100,
            padding: '8px 10px',
            fontSize: 13,
            background: '#161b22',
            border: '1px solid #30363d',
            borderRadius: 8,
            color: senderColor(senderName),
            fontWeight: 600,
          }}
        />
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message #${activeChannel}`}
          rows={1}
          style={{
            flex: 1,
            padding: '8px 12px',
            fontSize: 14,
            background: '#161b22',
            border: '1px solid #30363d',
            borderRadius: 8,
            color: '#c9d1d9',
            resize: 'none',
            outline: 'none',
            fontFamily: 'system-ui',
            lineHeight: 1.4,
          }}
          onFocus={e => e.target.style.borderColor = '#58a6ff'}
          onBlur={e => e.target.style.borderColor = '#30363d'}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim()}
          style={{
            padding: '8px 20px',
            fontSize: 14,
            background: input.trim() ? '#238636' : 'rgba(255,255,255,0.06)',
            border: 'none',
            borderRadius: 8,
            color: input.trim() ? '#fff' : '#484f58',
            cursor: input.trim() ? 'pointer' : 'default',
            fontWeight: 600,
            transition: 'all 0.15s ease',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('chat-root'));
root.render(<ChatView />);

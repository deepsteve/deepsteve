const { useState, useEffect, useCallback, useRef } = React;

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const msgDay = new Date(d);
  msgDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - msgDay) / 86400000);

  if (diffDays === 0) return time;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) {
    const weekday = d.toLocaleDateString([], { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  const month = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (d.getFullYear() !== now.getFullYear()) {
    return `${month}, ${d.getFullYear()} ${time}`;
  }
  return `${month} ${time}`;
}

// Deterministic color from sender name
function senderColor(name) {
  const colors = ['#58a6ff', '#f0883e', '#a5d6ff', '#7ee787', '#d2a8ff', '#f85149', '#79c0ff', '#ffa657'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

function buildMentionPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@"${escaped}"|@${escaped}\\b`, 'i');
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
          borderRadius: 3,
          padding: '0 3px',
        }}>
          @{name}
        </span>
      );
    }
    return part;
  });
}

function Message({ msg }) {
  const color = senderColor(msg.sender);
  return (
    <div style={{
      padding: '6px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color,
          padding: '1px 6px',
          borderRadius: 8,
          background: `${color}18`,
          border: `1px solid ${color}30`,
          whiteSpace: 'nowrap',
        }}>
          {msg.sender}
        </span>
        <span style={{ fontSize: 10, color: '#484f58' }}>
          {formatTime(msg.timestamp)}
        </span>
      </div>
      <div style={{
        fontSize: 13,
        color: '#c9d1d9',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.4,
      }}>
        {renderMentions(msg.text)}
      </div>
    </div>
  );
}

function notifyMention(msg, myName) {
  if (!myName || msg.sender === myName) return;
  if (!buildMentionPattern(myName).test(msg.text)) return;
  if (Notification.permission === 'granted' && document.hidden) {
    new Notification(`${msg.sender} mentioned you`, {
      body: msg.text.slice(0, 200),
      tag: `chat-mention-${msg.id}`,
    });
  }
}

function ChatPanel() {
  const [channels, setChannels] = useState({});
  const [activeChannel, setActiveChannel] = useState('general');
  const [input, setInput] = useState('');
  const [senderName, setSenderName] = useState(() => {
    try { return localStorage.getItem('deepsteve-chat-sender') || 'Human'; }
    catch { return 'Human'; }
  });
  const messagesEndRef = useRef(null);
  const prevMessageCountRef = useRef(0);
  const senderNameRef = useRef(senderName);
  const seenMessageIdsRef = useRef(new Set());
  const lastReadIdRef = useRef((() => {
    try {
      const saved = localStorage.getItem('deepsteve-chat-last-read');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  })());
  const [unreadMarkers, setUnreadMarkers] = useState({});

  // Keep ref in sync so the callback closure always has the latest name
  useEffect(() => { senderNameRef.current = senderName; }, [senderName]);

  // Persist sender name to localStorage
  useEffect(() => {
    try { localStorage.setItem('deepsteve-chat-sender', senderName); }
    catch {}
  }, [senderName]);

  // Mark current channel as read + clear badge when tab regains focus
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        window.deepsteve?.setPanelBadge(null);
        markChannelRead(activeChannel);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [activeChannel]);

  function markChannelRead(ch) {
    const msgs = channels[ch]?.messages;
    if (!msgs || msgs.length === 0) return;
    const maxId = msgs[msgs.length - 1].id;
    if (lastReadIdRef.current[ch] === maxId) return;
    lastReadIdRef.current[ch] = maxId;
    setUnreadMarkers(prev => ({ ...prev, [ch]: undefined }));
    try { localStorage.setItem('deepsteve-chat-last-read', JSON.stringify(lastReadIdRef.current)); }
    catch {}
  }

  useEffect(() => {
    let unsub = null;

    function setup() {
      unsub = window.deepsteve.onAgentChatChanged((newChannels) => {
        // Check new messages for @mentions — fire browser notifications + panel badge
        let hasMention = false;
        for (const ch of Object.values(newChannels || {})) {
          for (const msg of (ch.messages || [])) {
            if (!seenMessageIdsRef.current.has(msg.id)) {
              seenMessageIdsRef.current.add(msg.id);
              notifyMention(msg, senderNameRef.current);
              if (msg.sender !== senderNameRef.current) {
                if (buildMentionPattern(senderNameRef.current).test(msg.text)) hasMention = true;
              }
            }
          }
        }
        if (hasMention && document.hidden) {
          window.deepsteve?.setPanelBadge('!');
        }
        // Compute unread divider positions per channel
        const newMarkers = {};
        for (const [ch, data] of Object.entries(newChannels || {})) {
          const lastRead = lastReadIdRef.current[ch] || 0;
          const msgs = data.messages || [];
          const firstUnread = msgs.find(m => m.id > lastRead);
          if (firstUnread) newMarkers[ch] = firstUnread.id;
        }
        setUnreadMarkers(newMarkers);
        setChannels(newChannels || {});
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

  // Auto-scroll when new messages arrive; mark channel read if visible
  useEffect(() => {
    const msgs = channels[activeChannel]?.messages || [];
    if (msgs.length > prevMessageCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      if (!document.hidden) {
        // Small delay so the divider flashes briefly before clearing
        setTimeout(() => markChannelRead(activeChannel), 1500);
      }
    }
    prevMessageCountRef.current = msgs.length;
  }, [channels, activeChannel]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    // Request notification permission on first send
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
    try {
      await fetch(`/api/agent-chat/${encodeURIComponent(activeChannel)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: senderName, text }),
      });
    } catch (e) {
      console.error('Failed to send message:', e);
    }
  }, [input, activeChannel, senderName]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const clearChannel = useCallback(async (channelName) => {
    try {
      await fetch(`/api/agent-chat/${encodeURIComponent(channelName)}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to clear channel:', e);
    }
  }, []);

  const channelNames = Object.keys(channels);
  if (channelNames.length === 0 && activeChannel === 'general') {
    // Show general even if empty
  }
  const displayChannels = channelNames.length > 0 ? channelNames : ['general'];
  const messages = channels[activeChannel]?.messages || [];

  const totalUnread = channelNames.reduce((sum, name) => {
    if (name === activeChannel) return sum;
    return sum + (channels[name]?.messages?.length || 0);
  }, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 14,
          fontWeight: 600,
          color: '#f0f6fc',
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>
            Chat
            {messages.length > 0 && (
              <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400, marginLeft: 6 }}>
                {messages.length} message{messages.length !== 1 ? 's' : ''}
              </span>
            )}
          </span>
          {messages.length > 0 && (
            <button
              onClick={() => clearChannel(activeChannel)}
              style={{
                background: 'none',
                border: 'none',
                color: '#8b949e',
                cursor: 'pointer',
                fontSize: 11,
                padding: '2px 6px',
                opacity: 0.6,
              }}
              onMouseEnter={e => e.target.style.opacity = 1}
              onMouseLeave={e => e.target.style.opacity = 0.6}
              title={`Clear #${activeChannel}`}
            >
              Clear
            </button>
          )}
        </div>

        {/* Channel selector */}
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {displayChannels.map(name => {
            const count = channels[name]?.messages?.length || 0;
            const isActive = name === activeChannel;
            return (
              <button
                key={name}
                onClick={() => {
                  if (!document.hidden) markChannelRead(name);
                  setActiveChannel(name);
                }}
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: isActive ? '#58a6ff' : 'rgba(255,255,255,0.06)',
                  color: isActive ? '#fff' : '#8b949e',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                #{name}
                {count > 0 && !isActive && (
                  <span style={{
                    fontSize: 9,
                    background: 'rgba(255,255,255,0.12)',
                    padding: '0 4px',
                    borderRadius: 6,
                  }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Message list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {messages.length === 0 ? (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            No messages in #{activeChannel} yet.
            <br />
            <span style={{ fontSize: 11 }}>Agents can send messages via the send_message MCP tool.</span>
          </div>
        ) : (
          messages.map(msg => (
            <React.Fragment key={msg.id}>
              {unreadMarkers[activeChannel] === msg.id && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 12px',
                }}>
                  <div style={{ flex: 1, height: 1, background: '#f85149' }} />
                  <span style={{ fontSize: 10, color: '#f85149', fontWeight: 600, whiteSpace: 'nowrap' }}>NEW</span>
                  <div style={{ flex: 1, height: 1, background: '#f85149' }} />
                </div>
              )}
              <Message msg={msg} />
            </React.Fragment>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{
        padding: 8,
        borderTop: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input
            type="text"
            value={senderName}
            onChange={e => setSenderName(e.target.value)}
            placeholder="Your name"
            style={{
              width: 80,
              padding: '4px 8px',
              fontSize: 11,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 4,
              color: '#c9d1d9',
            }}
          />
          <span style={{ fontSize: 10, color: '#484f58', lineHeight: '24px' }}>
            in #{activeChannel}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: 12,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 6,
              color: '#c9d1d9',
              resize: 'none',
              outline: 'none',
              fontFamily: 'system-ui',
            }}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              background: input.trim() ? '#238636' : 'rgba(255,255,255,0.06)',
              border: 'none',
              borderRadius: 6,
              color: input.trim() ? '#fff' : '#484f58',
              cursor: input.trim() ? 'pointer' : 'default',
              flexShrink: 0,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('chat-root'));
root.render(<ChatPanel />);

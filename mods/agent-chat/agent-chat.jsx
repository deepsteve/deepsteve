const { useState, useEffect, useCallback, useRef } = React;

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

function renderMentions(text) {
  const parts = text.split(/(@[\w-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@') && part.length > 1) {
      const name = part.slice(1);
      const color = senderColor(name);
      return (
        <span key={i} style={{
          color,
          fontWeight: 600,
          background: `${color}18`,
          borderRadius: 3,
          padding: '0 3px',
        }}>
          {part}
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
  const mentionPattern = new RegExp(`@${myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (!mentionPattern.test(msg.text)) return;
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
  const [senderName, setSenderName] = useState('Human');
  const messagesEndRef = useRef(null);
  const prevMessageCountRef = useRef(0);
  const senderNameRef = useRef(senderName);
  const seenMessageIdsRef = useRef(new Set());

  // Keep ref in sync so the callback closure always has the latest name
  useEffect(() => { senderNameRef.current = senderName; }, [senderName]);

  // Clear badge when tab regains focus
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) window.deepsteve?.setPanelBadge(null);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

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
                const pat = new RegExp(`@${senderNameRef.current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                if (pat.test(msg.text)) hasMention = true;
              }
            }
          }
        }
        if (hasMention && document.hidden) {
          window.deepsteve?.setPanelBadge('!');
        }
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

  // Auto-scroll when new messages arrive
  useEffect(() => {
    const msgs = channels[activeChannel]?.messages || [];
    if (msgs.length > prevMessageCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
                onClick={() => setActiveChannel(name)}
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
          messages.map(msg => <Message key={msg.id} msg={msg} />)
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

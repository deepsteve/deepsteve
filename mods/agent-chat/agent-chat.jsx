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

// ─── TTS engine (module-level, outside React) ────────────────────────

let ttsQueue = [];
let ttsSpeaking = false;
let voiceCache = new Map();
let voicesLoaded = false;

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function senderVoice(name) {
  if (voiceCache.has(name)) return voiceCache.get(name);
  const voices = speechSynthesis.getVoices().filter(v => /en[-_]/i.test(v.lang));
  if (voices.length === 0) return null;
  const h = hashName(name);
  const voice = voices[h % voices.length];
  const pitch = 0.8 + (((h >> 8) & 0xff) / 255) * 0.5;  // 0.8–1.3
  const rate = 0.9 + (((h >> 16) & 0xff) / 255) * 0.2;   // 0.9–1.1
  const result = { voice, pitch, rate };
  voiceCache.set(name, result);
  return result;
}

function processQueue() {
  if (ttsSpeaking || ttsQueue.length === 0) return;
  ttsSpeaking = true;
  const msg = ttsQueue.shift();
  const text = msg.text.length > 500 ? msg.text.slice(0, 500) + '...' : msg.text;
  const utterance = new SpeechSynthesisUtterance(`${msg.sender} says: ${text}`);
  const voiceInfo = senderVoice(msg.sender);
  if (voiceInfo) {
    utterance.voice = voiceInfo.voice;
    utterance.pitch = voiceInfo.pitch;
    utterance.rate = voiceInfo.rate;
  }
  utterance.onend = () => { ttsSpeaking = false; processQueue(); };
  utterance.onerror = () => { ttsSpeaking = false; processQueue(); };
  speechSynthesis.speak(utterance);
}

function speakMessage(msg) {
  ttsQueue.push(msg);
  processQueue();
}

function cancelTts() {
  ttsQueue = [];
  ttsSpeaking = false;
  speechSynthesis.cancel();
}

// Load voices (async in Chrome)
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = () => {
    voicesLoaded = true;
    voiceCache.clear();
  };
  if (speechSynthesis.getVoices().length > 0) voicesLoaded = true;
}

// ─── STT feature detection ───────────────────────────────────────────

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const sttSupported = !!SpeechRecognition;

// ─── SVG icons ───────────────────────────────────────────────────────

function SpeakerIcon({ active }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={active ? '#58a6ff' : '#8b949e'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {active && (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      )}
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="1" width="6" height="12" rx="3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

// ─── ChatPanel ───────────────────────────────────────────────────────

function ChatPanel() {
  const [channels, setChannels] = useState({});
  const [activeChannel, setActiveChannel] = useState('general');
  const [input, setInput] = useState('');
  const [senderName, setSenderName] = useState(() => {
    try { return localStorage.getItem('deepsteve-chat-sender') || 'Human'; }
    catch { return 'Human'; }
  });
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [sttEnabled, setSttEnabled] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const messagesEndRef = useRef(null);
  const prevMessageCountRef = useRef(0);
  const senderNameRef = useRef(senderName);
  const seenMessageIdsRef = useRef(new Set());
  const spokenMessageIdsRef = useRef(new Set());
  const initialLoadDoneRef = useRef(false);
  const ttsEnabledRef = useRef(false);
  const activeChannelRef = useRef(activeChannel);
  const recognitionRef = useRef(null);
  const lastReadIdRef = useRef((() => {
    try {
      const saved = localStorage.getItem('deepsteve-chat-last-read');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  })());
  const [unreadMarkers, setUnreadMarkers] = useState({});

  // Keep refs in sync
  useEffect(() => { senderNameRef.current = senderName; }, [senderName]);
  useEffect(() => { activeChannelRef.current = activeChannel; }, [activeChannel]);
  useEffect(() => { ttsEnabledRef.current = ttsEnabled; }, [ttsEnabled]);

  // Persist sender name to localStorage
  useEffect(() => {
    try { localStorage.setItem('deepsteve-chat-sender', senderName); }
    catch {}
  }, [senderName]);

  // Cancel TTS when toggled off
  useEffect(() => {
    if (!ttsEnabled) cancelTts();
  }, [ttsEnabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelTts();
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
        recognitionRef.current = null;
      }
    };
  }, []);

  // Subscribe to settings changes from deepsteve bridge
  useEffect(() => {
    if (!window.deepsteve) return;
    return window.deepsteve.onSettingsChanged((s) => {
      setTtsEnabled(!!s.ttsEnabled);
      setSttEnabled(!!s.sttEnabled);
    });
  }, []);

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
        for (const [chName, ch] of Object.entries(newChannels || {})) {
          const lastRead = lastReadIdRef.current[chName] || 0;
          for (const msg of (ch.messages || [])) {
            if (!seenMessageIdsRef.current.has(msg.id)) {
              seenMessageIdsRef.current.add(msg.id);
              if (msg.id > lastRead) {
                notifyMention(msg, senderNameRef.current);
                if (msg.sender !== senderNameRef.current) {
                  if (buildMentionPattern(senderNameRef.current).test(msg.text)) hasMention = true;
                }
              }
            }

            // TTS: speak new messages
            if (!spokenMessageIdsRef.current.has(msg.id)) {
              spokenMessageIdsRef.current.add(msg.id);
              if (initialLoadDoneRef.current && ttsEnabledRef.current && chName === activeChannelRef.current) {
                speakMessage(msg);
              }
            }
          }
        }

        // Mark initial load complete after first callback
        if (!initialLoadDoneRef.current) {
          initialLoadDoneRef.current = true;
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

  const toggleTts = useCallback(() => {
    if (window.deepsteve?.updateSetting) {
      window.deepsteve.updateSetting('ttsEnabled', !ttsEnabled);
    }
  }, [ttsEnabled]);

  // ─── STT (speech-to-text) ────────────────────────────────────────

  const startListening = useCallback(() => {
    if (!sttSupported || recognitionRef.current) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(transcript);
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted') {
        console.error('STT error:', event.error);
      }
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
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

  const showMicButton = sttEnabled && sttSupported;

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              onClick={toggleTts}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                display: 'flex',
                alignItems: 'center',
                opacity: ttsEnabled ? 1 : 0.5,
              }}
              onMouseEnter={e => { if (!ttsEnabled) e.currentTarget.style.opacity = 0.8; }}
              onMouseLeave={e => { if (!ttsEnabled) e.currentTarget.style.opacity = 0.5; }}
              title={ttsEnabled ? 'Disable text-to-speech' : 'Enable text-to-speech'}
            >
              <SpeakerIcon active={ttsEnabled} />
            </button>
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
            placeholder={isListening ? 'Listening...' : 'Type a message...'}
            rows={1}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: 12,
              background: '#0d1117',
              border: isListening ? '1px solid #f85149' : '1px solid #30363d',
              borderRadius: 6,
              color: '#c9d1d9',
              resize: 'none',
              outline: 'none',
              fontFamily: 'system-ui',
              ...(isListening ? { animation: 'listening-pulse 1.5s ease-in-out infinite' } : {}),
            }}
          />
          {showMicButton && (
            <button
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onMouseLeave={() => { if (isListening) stopListening(); }}
              onTouchStart={(e) => { e.preventDefault(); startListening(); }}
              onTouchEnd={(e) => { e.preventDefault(); stopListening(); }}
              style={{
                padding: '6px 8px',
                fontSize: 12,
                background: isListening ? 'rgba(248, 81, 73, 0.2)' : 'rgba(255,255,255,0.06)',
                border: isListening ? '1px solid #f85149' : '1px solid #30363d',
                borderRadius: 6,
                color: isListening ? '#f85149' : '#8b949e',
                cursor: 'pointer',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
              }}
              title="Hold to speak"
            >
              <MicIcon />
            </button>
          )}
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

      {/* CSS animation for listening pulse */}
      <style>{`
        @keyframes listening-pulse {
          0%, 100% { border-color: #f85149; }
          50% { border-color: #f8514940; }
        }
      `}</style>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('chat-root'));
root.render(<ChatPanel />);

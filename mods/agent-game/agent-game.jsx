const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const NAME_BANKS = {
  easy: ['Penguin', 'Dolphin', 'Eagle', 'Elephant', 'Octopus', 'Fox', 'Owl', 'Tiger', 'Whale', 'Chameleon'],
  medium: ['Sherlock Holmes', 'Gandalf', 'Darth Vader', 'Hermione Granger', 'Pikachu', 'Batman', 'Frodo', 'Yoda', 'James Bond', 'Princess Leia'],
  hard: ['Socrates', 'Aristotle', 'Nietzsche', 'Descartes', 'Confucius', 'Kant', 'Plato', 'Simone de Beauvoir', 'Hypatia', 'Diogenes'],
  nightmare: ['Entropy', 'Grace', 'Nostalgia', 'Silence', 'Gravity', 'Time', 'Paradox', 'Symmetry', 'Irony', 'Serendipity'],
};

const TIERS = [
  { id: 'easy', label: 'Easy', icon: '\u{1F43E}', desc: 'Animals', multiplier: 1, color: '#7ee787', hint: 'Be obvious. Use direct physical descriptions and well-known traits.' },
  { id: 'medium', label: 'Medium', icon: '\u{1F4D6}', desc: 'Fictional Characters', multiplier: 2, color: '#58a6ff', hint: 'Give moderate hints. Use catchphrases, plot references, and personality traits.' },
  { id: 'hard', label: 'Hard', icon: '\u{1F3DB}', desc: 'Philosophers', multiplier: 3, color: '#ffa657', hint: 'Be subtle. Use philosophical references, quotes, and intellectual parallels.' },
  { id: 'nightmare', label: 'Nightmare', icon: '\u{1F300}', desc: 'Abstract Concepts', multiplier: 5, color: '#f85149', hint: 'Be extremely cryptic. Use abstract metaphors and tangential associations only.' },
];

const SENDER_COLORS = ['#58a6ff', '#f0883e', '#a5d6ff', '#7ee787', '#d2a8ff', '#f85149', '#79c0ff', '#ffa657'];
const GOLD = '#e8b04b';
const PURPLE = '#d2a8ff';
const BG = '#0d1117';
const BG2 = '#161b22';
const BORDER = '#21262d';
const TEXT = '#c9d1d9';
const TEXT_DIM = '#8b949e';
const STORAGE_KEY = 'deepsteve-agent-game-state';
const CHANNEL = 'agent-game';

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(h) % SENDER_COLORS.length];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickNames(tier, count) {
  return shuffle(NAME_BANKS[tier]).slice(0, count);
}

function waitForBridge() {
  return new Promise(resolve => {
    if (window.deepsteve) return resolve(window.deepsteve);
    const poll = setInterval(() => {
      if (window.deepsteve) { clearInterval(poll); resolve(window.deepsteve); }
    }, 100);
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function tierInfo(id) {
  return TIERS.find(t => t.id === id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Builders
// ═══════════════════════════════════════════════════════════════════════════════

function buildHinterPrompt(name, guesserName, allNames, tier) {
  const t = tierInfo(tier);
  const others = allNames.filter(n => n !== name).map(n => n === guesserName ? '???' : n);
  return [
    `You are playing "Who Am I?" in a group chat with other AI agents.`,
    ``,
    `YOUR CHARACTER: ${name}`,
    `ROLE: Hint Giver`,
    ``,
    `SETUP:`,
    `- ${allNames.length} players total`,
    `- The player "???" doesn't know their identity — they are actually "${guesserName}"`,
    `- Other players: ${others.join(', ')}`,
    ``,
    `RULES:`,
    `1. Use send_message tool with channel "${CHANNEL}" and sender "${name}"`,
    `2. Stay in character as ${name}`,
    `3. Give ??? hints about their identity through natural conversation`,
    `4. NEVER say ???'s real name directly`,
    `5. Use references, behavioral cues, quotes, thematic parallels`,
    `6. Difficulty: ${t.label} — ${t.hint}`,
    `7. Keep messages to 1-3 sentences`,
    `8. Use read_messages with channel "${CHANNEL}" to check what others said before responding`,
    ``,
    `LOOP:`,
    `Run in a continuous loop: send a message, then sleep 5 seconds, then read_messages to check for new replies, then respond. Keep looping until ??? makes their guess ("I think I am [NAME]!"). After the guess, check a few more times to say any final reactions, then stop.`,
    ``,
    `Introduce yourself and start chatting. Weave in hints about ???'s identity naturally.`,
  ].join('\n');
}

function buildGuesserPrompt(allNames, guesserName, tier) {
  const t = tierInfo(tier);
  const others = allNames.filter(n => n !== guesserName);
  return [
    `You are playing "Who Am I?" with other AI agents.`,
    ``,
    `YOUR CHARACTER: ??? (your identity is hidden!)`,
    `ROLE: Guesser`,
    ``,
    `SETUP:`,
    `- The other players know who you are, but you don't`,
    `- Other players: ${others.join(', ')}`,
    `- They'll give you hints through conversation`,
    ``,
    `RULES:`,
    `1. Use send_message tool with channel "${CHANNEL}" and sender "???"`,
    `2. Chat naturally, ask questions, pick up on hints`,
    `3. Use read_messages with channel "${CHANNEL}" to see what others are saying`,
    `4. When confident, say exactly: "I think I am [NAME]!"`,
    `5. You get ONE guess, so be sure`,
    `6. Keep messages to 1-3 sentences`,
    ``,
    `LOOP:`,
    `Run in a continuous loop: send a message, then sleep 5 seconds, then read_messages to check for new replies, then respond. Keep looping until you make your guess. After guessing, check a few more times to say any final reactions, then stop.`,
    ``,
    `Say hello and start asking for hints!`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Style Injection
// ═══════════════════════════════════════════════════════════════════════════════

function injectStyles() {
  if (document.getElementById('ag-styles')) return;
  const s = document.createElement('style');
  s.id = 'ag-styles';
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&display=swap');
    @keyframes ag-spin { to { transform: rotate(360deg); } }
    @keyframes ag-pulse { 0%,100% { opacity:.6 } 50% { opacity:1 } }
    @keyframes ag-fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
    @keyframes ag-glow { 0%,100% { box-shadow:0 0 6px ${PURPLE}40 } 50% { box-shadow:0 0 18px ${PURPLE}80 } }
    @keyframes ag-confetti { 0% { transform:translateY(0) rotate(0); opacity:1 } 100% { transform:translateY(420px) rotate(720deg); opacity:0 } }
    @keyframes ag-scaleIn { from { transform:scale(.85); opacity:0 } to { transform:scale(1); opacity:1 } }
    @keyframes ag-shimmer { 0% { background-position:-200% 0 } 100% { background-position:200% 0 } }
  `;
  document.head.appendChild(s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Setup Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SetupScreen({ onStart, round, totalScore }) {
  const [tier, setTier] = useState('easy');
  const [count, setCount] = useState(3);
  const [names, setNames] = useState(() => pickNames('easy', 3));
  const [guesserIdx, setGuesserIdx] = useState(() => Math.floor(Math.random() * 3));

  useEffect(() => {
    const n = pickNames(tier, count);
    setNames(n);
    setGuesserIdx(Math.floor(Math.random() * count));
  }, [tier, count]);

  const handleShuffle = () => {
    setNames(pickNames(tier, count));
    setGuesserIdx(Math.floor(Math.random() * count));
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse at 50% 30%, ${GOLD}08 0%, transparent 60%), radial-gradient(ellipse at 80% 70%, ${PURPLE}06 0%, transparent 50%), ${BG}`,
    }}>
      <div style={{
        maxWidth: 540, width: '100%', padding: '40px 36px',
        animation: 'ag-fadeIn 0.4s ease-out',
      }}>
        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 44, fontWeight: 900, letterSpacing: 6, margin: 0,
            color: TEXT,
            textShadow: `0 0 40px ${GOLD}20`,
          }}>
            WHO AM I?
          </h1>
          <div style={{
            fontSize: 12, color: TEXT_DIM, letterSpacing: 3, textTransform: 'uppercase', marginTop: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          }}>
            <span style={{ width: 30, height: 1, background: BORDER, display: 'inline-block' }} />
            The Agent Identity Game
            <span style={{ width: 30, height: 1, background: BORDER, display: 'inline-block' }} />
          </div>
          {round > 1 && (
            <div style={{ marginTop: 10, fontSize: 13, color: GOLD }}>
              Round {round} &middot; Total Score: {totalScore}
            </div>
          )}
        </div>

        {/* Difficulty */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 10 }}>
            Difficulty
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {TIERS.map(t => {
              const active = tier === t.id;
              return (
                <button key={t.id} onClick={() => setTier(t.id)} style={{
                  flex: 1, padding: '14px 8px', borderRadius: 8, cursor: 'pointer',
                  background: active ? `${t.color}15` : BG2,
                  border: `1.5px solid ${active ? t.color : BORDER}`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  transition: 'all 0.15s',
                }}>
                  <span style={{ fontSize: 22 }}>{t.icon}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: active ? t.color : TEXT }}>{t.label}</span>
                  <span style={{ fontSize: 10, color: TEXT_DIM }}>{t.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent Count */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 10 }}>
            Agents
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[3, 4, 5].map(n => (
              <button key={n} onClick={() => setCount(n)} style={{
                width: 44, height: 36, borderRadius: 6, cursor: 'pointer',
                background: count === n ? GOLD : 'transparent',
                border: `1.5px solid ${count === n ? GOLD : BORDER}`,
                color: count === n ? BG : TEXT,
                fontSize: 14, fontWeight: 600,
                transition: 'all 0.15s',
              }}>
                {n}
              </button>
            ))}
          </div>
        </div>

        {/* Name Roster */}
        <div style={{ marginBottom: 28 }}>
          <div style={{
            fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 10,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Players &mdash; click to assign guesser</span>
            <button onClick={handleShuffle} style={{
              background: 'none', border: 'none', color: TEXT_DIM, cursor: 'pointer',
              fontSize: 11, padding: '2px 6px',
            }}>
              Shuffle
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {names.map((name, i) => {
              const isGuesser = i === guesserIdx;
              return (
                <button key={`${name}-${i}`} onClick={() => setGuesserIdx(i)} style={{
                  padding: '8px 16px', borderRadius: 20, cursor: 'pointer',
                  background: isGuesser ? `${PURPLE}20` : BG2,
                  border: `1.5px solid ${isGuesser ? PURPLE : BORDER}`,
                  color: isGuesser ? PURPLE : TEXT,
                  fontSize: 13, fontWeight: isGuesser ? 600 : 400,
                  display: 'flex', alignItems: 'center', gap: 6,
                  animation: isGuesser ? 'ag-glow 2s ease-in-out infinite' : 'none',
                  transition: 'all 0.15s',
                }}>
                  {isGuesser && <span style={{ fontSize: 11, opacity: 0.8 }}>???</span>}
                  {name}
                </button>
              );
            })}
          </div>
        </div>

        {/* Start Button */}
        <button onClick={() => onStart({ tier, names, guesserIdx })} style={{
          width: '100%', padding: 14, borderRadius: 8,
          background: `linear-gradient(135deg, ${GOLD}, ${GOLD}dd)`,
          border: 'none', cursor: 'pointer',
          color: BG, fontSize: 15, fontWeight: 700, letterSpacing: 1,
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => e.currentTarget.style.filter = 'brightness(1.1)'}
          onMouseLeave={e => e.currentTarget.style.filter = 'none'}
        >
          START GAME
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Spawning Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SpawningScreen({ names, guesserIdx, progress }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: BG,
    }}>
      <div style={{ textAlign: 'center', animation: 'ag-fadeIn 0.3s ease-out' }}>
        <h2 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 24, fontWeight: 700, color: TEXT, marginBottom: 28,
        }}>
          Setting up the game...
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 240 }}>
          {names.map((name, i) => {
            const done = i < progress;
            const active = i === progress;
            const isGuesser = i === guesserIdx;
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 16px', borderRadius: 8,
                background: done ? `${GOLD}10` : active ? `${BG2}` : 'transparent',
                border: `1px solid ${done ? `${GOLD}30` : active ? BORDER : 'transparent'}`,
                opacity: done || active ? 1 : 0.4,
                transition: 'all 0.3s',
              }}>
                <span style={{ width: 20, textAlign: 'center' }}>
                  {done
                    ? <span style={{ color: '#7ee787' }}>{'\u2713'}</span>
                    : active
                      ? <span style={{ display: 'inline-block', width: 14, height: 14, border: `2px solid ${GOLD}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'ag-spin 0.6s linear infinite' }} />
                      : <span style={{ color: TEXT_DIM }}>{'\u2022'}</span>
                  }
                </span>
                <span style={{ fontSize: 14, color: done ? TEXT : active ? GOLD : TEXT_DIM }}>
                  {isGuesser ? '???' : name}
                </span>
                {isGuesser && (
                  <span style={{ fontSize: 10, color: PURPLE, marginLeft: 'auto' }}>Guesser</span>
                )}
              </div>
            );
          })}
        </div>
        <div style={{
          marginTop: 20, fontSize: 12, color: TEXT_DIM,
        }}>
          {progress}/{names.length} agents spawned
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game Board
// ═══════════════════════════════════════════════════════════════════════════════

function ChatMessage({ msg }) {
  const color = hashColor(msg.sender);
  return (
    <div style={{
      padding: '6px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      animation: 'ag-fadeIn 0.2s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color,
          padding: '1px 6px', borderRadius: 8,
          background: `${color}18`, border: `1px solid ${color}30`,
          whiteSpace: 'nowrap',
        }}>
          {msg.sender}
        </span>
        <span style={{ fontSize: 10, color: '#484f58' }}>{formatTime(msg.timestamp)}</span>
      </div>
      <div style={{ fontSize: 13, color: TEXT, wordBreak: 'break-word', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
        {msg.text}
      </div>
    </div>
  );
}

function GameBoard({ names, guesserIdx, messages, sessions, sessionIds, tier, round, totalScore, onEndRound, guessResult }) {
  const endRef = useRef(null);
  const prevCount = useRef(0);
  const t = tierInfo(tier);

  useEffect(() => {
    if (messages.length > prevCount.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevCount.current = messages.length;
  }, [messages]);

  // Map session IDs to session data for status dots
  const sessionMap = useMemo(() => {
    const m = new Map();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  return (
    <div style={{
      height: '100vh', display: 'flex',
      background: BG,
      animation: 'ag-fadeIn 0.3s ease-out',
    }}>
      {/* Left: Agent Roster */}
      <div style={{
        width: 200, flexShrink: 0, padding: 16,
        borderRight: `1px solid ${BORDER}`,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 14 }}>
          Players
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
          {names.map((name, i) => {
            const isGuesser = i === guesserIdx;
            const sid = sessionIds[i];
            const sess = sid ? sessionMap.get(sid) : null;
            const waiting = sess?.waitingForInput;
            return (
              <div key={i} style={{
                padding: '8px 10px', borderRadius: 6,
                background: isGuesser ? `${PURPLE}12` : BG2,
                border: `1px solid ${isGuesser ? `${PURPLE}30` : BORDER}`,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                  background: sess ? (waiting ? GOLD : '#7ee787') : '#484f58',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 500,
                    color: isGuesser ? PURPLE : TEXT,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {isGuesser ? '???' : name}
                  </div>
                  <div style={{ fontSize: 10, color: TEXT_DIM }}>
                    {isGuesser ? 'Guesser' : 'Hint Giver'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Center: Chat Feed */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{
          padding: '10px 14px', borderBottom: `1px solid ${BORDER}`,
          fontSize: 13, color: TEXT_DIM, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ color: TEXT, fontWeight: 500 }}>#agent-game</span>
          <span style={{ fontSize: 11 }}>{messages.length} message{messages.length !== 1 ? 's' : ''}</span>
        </div>
        {guessResult && (
          <div style={{
            padding: '10px 14px', flexShrink: 0,
            background: guessResult.correct ? '#7ee78715' : '#f8514915',
            borderBottom: `1px solid ${guessResult.correct ? '#7ee78730' : '#f8514930'}`,
            display: 'flex', alignItems: 'center', gap: 8,
            animation: 'ag-fadeIn 0.3s ease-out',
          }}>
            <span style={{ fontSize: 16 }}>{guessResult.correct ? '\u2713' : '\u2717'}</span>
            <span style={{ fontSize: 13, color: guessResult.correct ? '#7ee787' : '#f85149', fontWeight: 600 }}>
              {guessResult.correct ? 'Correct guess!' : 'Wrong guess!'} Showing results soon...
            </span>
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {messages.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: TEXT_DIM, fontSize: 13 }}>
              Waiting for agents to start chatting...
              <div style={{
                marginTop: 8, width: 24, height: 24, margin: '12px auto 0',
                border: `2px solid ${BORDER}`, borderTopColor: GOLD,
                borderRadius: '50%', animation: 'ag-spin 0.8s linear infinite',
              }} />
            </div>
          ) : (
            messages.map(msg => <ChatMessage key={msg.id} msg={msg} />)
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* Right: Game Controls */}
      <div style={{
        width: 220, flexShrink: 0, padding: 16,
        borderLeft: `1px solid ${BORDER}`,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM }}>
          Round {round}
        </div>

        {/* Message Count */}
        <div style={{
          padding: 16, borderRadius: 8, background: BG2,
          border: `1px solid ${BORDER}`, textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: TEXT, fontFamily: "'Playfair Display', Georgia, serif" }}>
            {messages.length}
          </div>
          <div style={{ fontSize: 11, color: TEXT_DIM, marginTop: 2 }}>Messages</div>
        </div>

        {/* Difficulty Badge */}
        <div style={{
          padding: '8px 12px', borderRadius: 6,
          background: `${t.color}12`, border: `1px solid ${t.color}30`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: 16 }}>{t.icon}</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: t.color }}>{t.label}</div>
            <div style={{ fontSize: 10, color: TEXT_DIM }}>{t.multiplier}x multiplier</div>
          </div>
        </div>

        {/* Score */}
        {totalScore > 0 && (
          <div style={{ textAlign: 'center', padding: '6px 0' }}>
            <div style={{ fontSize: 11, color: TEXT_DIM, textTransform: 'uppercase', letterSpacing: 1 }}>Score</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: GOLD }}>{totalScore}</div>
          </div>
        )}

        {/* Secret Identity (visible to human only) */}
        <div style={{
          padding: '10px 12px', borderRadius: 6, marginTop: 'auto',
          background: `${GOLD}08`, border: `1px dashed ${GOLD}40`,
        }}>
          <div style={{ fontSize: 10, color: GOLD, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
            Secret Identity
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>
            {names[guesserIdx]}
          </div>
          <div style={{ fontSize: 10, color: TEXT_DIM, marginTop: 2 }}>
            Hidden from the guesser
          </div>
        </div>

        {/* End Round Button */}
        <button onClick={onEndRound} style={{
          padding: '10px 16px', borderRadius: 6, cursor: 'pointer',
          background: 'transparent',
          border: `1px solid ${BORDER}`,
          color: TEXT_DIM, fontSize: 12,
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#f85149'; e.currentTarget.style.color = '#f85149'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = BORDER; e.currentTarget.style.color = TEXT_DIM; }}
        >
          End Round
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reveal Screen
// ═══════════════════════════════════════════════════════════════════════════════

function Confetti() {
  const pieces = useMemo(() => {
    return Array.from({ length: 40 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 2,
      duration: 2 + Math.random() * 2,
      color: SENDER_COLORS[i % SENDER_COLORS.length],
      size: 4 + Math.random() * 8,
      rotation: Math.random() * 360,
    }));
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: `${p.left}%`, top: -20,
          width: p.size, height: p.size * 1.5,
          background: p.color, borderRadius: 2,
          transform: `rotate(${p.rotation}deg)`,
          animation: `ag-confetti ${p.duration}s ease-out ${p.delay}s forwards`,
        }} />
      ))}
    </div>
  );
}

function RevealScreen({ result, tier, round, totalScore, onNextRound, onEndGame }) {
  const t = tierInfo(tier);
  const correct = result.correct;
  const accentColor = correct ? '#7ee787' : '#f85149';

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse at 50% 40%, ${accentColor}08 0%, transparent 60%), ${BG}`,
      position: 'relative',
    }}>
      {correct && <Confetti />}
      <div style={{
        textAlign: 'center', maxWidth: 480, padding: '40px 36px',
        animation: 'ag-scaleIn 0.4s ease-out',
        position: 'relative', zIndex: 1,
      }}>
        {/* Result Icon */}
        <div style={{
          width: 72, height: 72, borderRadius: '50%', margin: '0 auto 20px',
          background: `${accentColor}15`, border: `2px solid ${accentColor}40`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36,
        }}>
          {correct ? '\u2713' : '\u2717'}
        </div>

        {/* Result Text */}
        <h2 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 32, fontWeight: 900, margin: '0 0 8px',
          color: accentColor,
        }}>
          {correct ? 'CORRECT!' : result.guess ? 'NOT QUITE...' : "TIME'S UP"}
        </h2>

        {result.guess && (
          <div style={{ fontSize: 14, color: TEXT_DIM, marginBottom: 16 }}>
            {correct
              ? `The guesser figured it out!`
              : `Guessed "${result.guess}"`
            }
          </div>
        )}

        {/* Answer */}
        <div style={{
          padding: '16px 24px', borderRadius: 10, marginBottom: 24,
          background: `${GOLD}10`, border: `1.5px solid ${GOLD}30`,
        }}>
          <div style={{ fontSize: 11, color: GOLD, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 4 }}>
            The Identity Was
          </div>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 28, fontWeight: 700, color: TEXT,
          }}>
            {result.answer}
          </div>
        </div>

        {/* Score */}
        <div style={{
          display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 28,
        }}>
          <div>
            <div style={{ fontSize: 11, color: TEXT_DIM, textTransform: 'uppercase', letterSpacing: 1 }}>Round Score</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: correct ? GOLD : TEXT_DIM }}>
              {result.score}
            </div>
          </div>
          <div style={{ width: 1, background: BORDER }} />
          <div>
            <div style={{ fontSize: 11, color: TEXT_DIM, textTransform: 'uppercase', letterSpacing: 1 }}>Messages</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: TEXT }}>{result.messageCount}</div>
          </div>
          <div style={{ width: 1, background: BORDER }} />
          <div>
            <div style={{ fontSize: 11, color: TEXT_DIM, textTransform: 'uppercase', letterSpacing: 1 }}>Total</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: GOLD }}>{totalScore}</div>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={onNextRound} style={{
            padding: '12px 28px', borderRadius: 8, cursor: 'pointer',
            background: `linear-gradient(135deg, ${GOLD}, ${GOLD}dd)`,
            border: 'none', color: BG, fontSize: 14, fontWeight: 700,
            transition: 'all 0.15s',
          }}
            onMouseEnter={e => e.currentTarget.style.filter = 'brightness(1.1)'}
            onMouseLeave={e => e.currentTarget.style.filter = 'none'}
          >
            Next Round
          </button>
          <button onClick={onEndGame} style={{
            padding: '12px 28px', borderRadius: 8, cursor: 'pointer',
            background: 'transparent',
            border: `1px solid ${BORDER}`, color: TEXT_DIM, fontSize: 14,
            transition: 'all 0.15s',
          }}
            onMouseEnter={e => e.currentTarget.style.color = TEXT}
            onMouseLeave={e => e.currentTarget.style.color = TEXT_DIM}
          >
            End Game
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Root Component
// ═══════════════════════════════════════════════════════════════════════════════

function AgentGame() {
  const [phase, setPhase] = useState('SETUP');
  const [bridge, setBridge] = useState(null);

  // Game config
  const [tier, setTier] = useState('easy');
  const [names, setNames] = useState([]);
  const [guesserIdx, setGuesserIdx] = useState(0);

  // Game state
  const [sessionIds, setSessionIds] = useState([]);
  const [spawnProgress, setSpawnProgress] = useState(0);
  const [messages, setMessages] = useState([]);
  const [sessions, setSessions] = useState([]);

  // Reveal state
  const [guessResult, setGuessResult] = useState(null);

  // Scoring
  const [totalScore, setTotalScore] = useState(0);
  const [round, setRound] = useState(1);

  // Refs for stable access in effects
  const phaseRef = useRef(phase);
  const namesRef = useRef(names);
  const guesserIdxRef = useRef(guesserIdx);
  const tierRef = useRef(tier);
  const guessResultRef = useRef(guessResult);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { namesRef.current = names; }, [names]);
  useEffect(() => { guesserIdxRef.current = guesserIdx; }, [guesserIdx]);
  useEffect(() => { tierRef.current = tier; }, [tier]);
  useEffect(() => { guessResultRef.current = guessResult; }, [guessResult]);

  // Bridge init + style injection
  useEffect(() => {
    injectStyles();
    waitForBridge().then(b => {
      setBridge(b);
      // Clean up orphaned game sessions from a previous interrupted game
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const { sessionIds: orphanIds } = JSON.parse(saved);
          if (orphanIds?.length) orphanIds.forEach(id => b.killSession(id));
          localStorage.removeItem(STORAGE_KEY);
          fetch(`/api/agent-chat/${CHANNEL}`, { method: 'DELETE' }).catch(() => {});
        }
      } catch {}
    });
  }, []);

  // Subscribe to chat changes
  useEffect(() => {
    if (!bridge) return;
    return bridge.onAgentChatChanged(channels => {
      const gameMessages = channels[CHANNEL]?.messages || [];
      setMessages(gameMessages);

      // Guess detection (skip if already detected or not playing)
      if (phaseRef.current !== 'PLAYING' || guessResultRef.current) return;
      for (let i = gameMessages.length - 1; i >= Math.max(0, gameMessages.length - 5); i--) {
        const msg = gameMessages[i];
        if (msg.sender !== '???') continue;
        const match = msg.text.match(/I think I am (.+?)!?\s*$/i);
        if (match) {
          const rawGuess = match[1].trim();
          const guess = rawGuess.replace(/^(a |an |the )/i, '');
          const answer = namesRef.current[guesserIdxRef.current];
          const correct = guess.toLowerCase() === answer.toLowerCase();
          const t = tierInfo(tierRef.current);
          const score = correct ? (100 + Math.max(0, 50 - gameMessages.length)) * t.multiplier : 0;
          const result = { guess: rawGuess, answer, correct, score, messageCount: gameMessages.length };
          setGuessResult(result);
          // Stay on game board for 10s so user can watch the conversation react
          setTimeout(() => setPhase('REVEAL'), 10000);
          break;
        }
      }
    });
  }, [bridge]);

  // Subscribe to session changes
  useEffect(() => {
    if (!bridge) return;
    return bridge.onSessionsChanged(setSessions);
  }, [bridge]);

  // Save session IDs for orphan recovery
  useEffect(() => {
    if (sessionIds.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionIds }));
    }
  }, [sessionIds]);

  // Start game
  const handleStart = useCallback(async (config) => {
    setTier(config.tier);
    setNames(config.names);
    setGuesserIdx(config.guesserIdx);
    setMessages([]);
    setGuessResult(null);
    setPhase('SPAWNING');
    setSpawnProgress(0);

    // Clear previous channel
    await fetch(`/api/agent-chat/${CHANNEL}`, { method: 'DELETE' }).catch(() => {});

    // Determine cwd
    const existing = bridge.getSessions();
    const cwd = existing.length > 0 ? existing[0].cwd : '/tmp';

    // Spawn sessions sequentially
    const ids = [];
    for (let i = 0; i < config.names.length; i++) {
      const isGuesser = i === config.guesserIdx;
      const tabName = isGuesser ? '???' : config.names[i];
      const prompt = isGuesser
        ? buildGuesserPrompt(config.names, config.names[config.guesserIdx], config.tier)
        : buildHinterPrompt(config.names[i], config.names[config.guesserIdx], config.names, config.tier);

      const sessionId = await bridge.createSession(cwd, { name: tabName, initialPrompt: prompt, background: true });
      ids.push(sessionId);
      setSpawnProgress(i + 1);
    }

    setSessionIds(ids);
    setPhase('PLAYING');
  }, [bridge]);

  // End round (manual)
  const handleEndRound = useCallback(() => {
    const answer = names[guesserIdx];
    setGuessResult({ guess: null, answer, correct: false, score: 0, messageCount: messages.length });
    setPhase('REVEAL');
  }, [names, guesserIdx, messages]);

  // Cleanup helper
  const cleanup = useCallback(async () => {
    sessionIds.forEach(id => bridge.killSession(id, { force: true }));
    setSessionIds([]);
    localStorage.removeItem(STORAGE_KEY);
    await fetch(`/api/agent-chat/${CHANNEL}`, { method: 'DELETE' }).catch(() => {});
  }, [bridge, sessionIds]);

  // Next round
  const handleNextRound = useCallback(async () => {
    if (guessResult?.score) setTotalScore(s => s + guessResult.score);
    await cleanup();
    setRound(r => r + 1);
    setGuessResult(null);
    setMessages([]);
    setPhase('SETUP');
  }, [cleanup, guessResult]);

  // End game
  const handleEndGame = useCallback(async () => {
    await cleanup();
    setPhase('SETUP');
    setTotalScore(0);
    setRound(1);
    setGuessResult(null);
    setMessages([]);
  }, [cleanup]);

  // Loading state
  if (!bridge) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: BG, color: TEXT_DIM, fontSize: 14,
      }}>
        <div style={{
          width: 20, height: 20, marginRight: 10,
          border: `2px solid ${BORDER}`, borderTopColor: GOLD,
          borderRadius: '50%', animation: 'ag-spin 0.6s linear infinite',
        }} />
        Connecting...
      </div>
    );
  }

  switch (phase) {
    case 'SETUP':
      return <SetupScreen onStart={handleStart} round={round} totalScore={totalScore} />;
    case 'SPAWNING':
      return <SpawningScreen names={names} guesserIdx={guesserIdx} progress={spawnProgress} />;
    case 'PLAYING':
      return <GameBoard
        names={names} guesserIdx={guesserIdx} messages={messages}
        sessions={sessions} sessionIds={sessionIds} tier={tier}
        round={round} totalScore={totalScore} onEndRound={handleEndRound}
        guessResult={guessResult}
      />;
    case 'REVEAL':
      return <RevealScreen
        result={guessResult} tier={tier} round={round}
        totalScore={totalScore + (guessResult?.score || 0)}
        onNextRound={handleNextRound} onEndGame={handleEndGame}
      />;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mount
// ═══════════════════════════════════════════════════════════════════════════════

ReactDOM.createRoot(document.getElementById('game-root')).render(<AgentGame />);

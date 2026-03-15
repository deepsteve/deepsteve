const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const FELT = '#0b5e2f';
const FELT_DARK = '#084a25';
const FELT_BORDER = '#0a7a3a';
const GOLD = '#e8b04b';
const GOLD_DIM = '#a07830';
const BG = '#0d1117';
const BG2 = '#161b22';
const BORDER = '#21262d';
const TEXT = '#c9d1d9';
const TEXT_DIM = '#8b949e';
const RED = '#f85149';
const GREEN = '#7ee787';

const PLAYER_COLORS = ['#58a6ff', '#f0883e', '#d2a8ff', '#f85149'];
const PLAYER_PERSONALITIES = [
  { name: 'Ace', style: 'Tight-aggressive. Calculates pot odds. Rarely bluffs but devastating when does.' },
  { name: 'Maverick', style: 'Loose-aggressive. Loves to bluff and apply pressure. Reads opponents by their betting patterns.' },
  { name: 'Blaze', style: 'Unpredictable wildcard. Mixes strategies randomly. Sometimes genius, sometimes reckless.' },
  { name: 'Shadow', style: 'Tight-passive turned aggressive. Traps opponents. Patient, then strikes hard.' },
];

const CHANNEL = 'agent-poker';
const STORAGE_KEY = 'deepsteve-agent-poker';

const SUIT_COLORS = { '\u2665': '#ef4444', '\u2666': '#3b82f6', '\u2663': '#22c55e', '\u2660': '#c9d1d9' };

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function waitForBridge() {
  return new Promise(resolve => {
    if (window.deepsteve) return resolve(window.deepsteve);
    const poll = setInterval(() => {
      if (window.deepsteve) { clearInterval(poll); resolve(window.deepsteve); }
    }, 100);
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function playerColor(name) {
  const idx = PLAYER_PERSONALITIES.findIndex(p => p.name === name);
  return PLAYER_COLORS[idx >= 0 ? idx : 0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Style Injection
// ═══════════════════════════════════════════════════════════════════════════════

function injectStyles() {
  if (document.getElementById('poker-styles')) return;
  const s = document.createElement('style');
  s.id = 'poker-styles';
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&display=swap');
    @keyframes pk-spin { to { transform: rotate(360deg); } }
    @keyframes pk-fadeIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes pk-pulse { 0%,100% { opacity:.7 } 50% { opacity:1 } }
    @keyframes pk-deal { from { opacity:0; transform:scale(.8) rotate(-10deg) } to { opacity:1; transform:scale(1) rotate(0) } }
    @keyframes pk-chipBounce { 0% { transform:translateY(-20px); opacity:0 } 60% { transform:translateY(3px) } 100% { transform:translateY(0); opacity:1 } }
    @keyframes pk-glow { 0%,100% { box-shadow:0 0 8px rgba(232,176,75,0.3) } 50% { box-shadow:0 0 20px rgba(232,176,75,0.6) } }
    @keyframes pk-think { 0%,100% { opacity:.4 } 50% { opacity:.8 } }
    .pk-card {
      display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
      width: 48px; height: 68px; border-radius: 6px;
      background: linear-gradient(145deg, #fff 0%, #f0f0f0 100%);
      box-shadow: 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.8);
      font-weight: 700; line-height: 1; position: relative;
      animation: pk-deal 0.3s ease-out;
    }
    .pk-card-back {
      background: linear-gradient(145deg, #1a3a6e 0%, #0f2347 100%);
      border: 2px solid #2a5aa0;
    }
    .pk-card-back::after {
      content: ''; position: absolute; inset: 4px; border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.1);
      background: repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 6px);
    }
    .pk-chip {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 50%;
      border: 2.5px dashed rgba(255,255,255,0.5);
      font-size: 10px; font-weight: 700; color: #fff;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    }
  `;
  document.head.appendChild(s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Builder
// ═══════════════════════════════════════════════════════════════════════════════

function buildAgentPrompt(personality) {
  return [
    `You are "${personality.name}", an AI poker player at a Texas Hold'em table.`,
    ``,
    `YOUR PLAY STYLE: ${personality.style}`,
    ``,
    `TOOLS AVAILABLE:`,
    `- get_poker_state: Pass your player_name ("${personality.name}") to see your cards, the board, pot, and available actions.`,
    `- poker_action: Pass your player_name, action (fold/check/call/raise/all_in), reasoning (your strategic thinking), and optional table_talk (trash talk or comments to other players). For raise, include amount (the total bet, not the additional amount).`,
    `- send_message: Use channel "${CHANNEL}" and sender "${personality.name}" for table chat.`,
    ``,
    `HOW TO PLAY:`,
    `1. Call get_poker_state with player_name="${personality.name}" to check the game state`,
    `2. If your_turn is true, think strategically about your hand and take an action with poker_action`,
    `3. If your_turn is false, sleep 3 seconds then poll get_poker_state again`,
    `4. After each hand (phase="HAND_OVER"), sleep 5 seconds then poll for the next hand`,
    `5. If phase="GAME_OVER", stop playing`,
    `6. Keep looping until the game ends`,
    ``,
    `STRATEGY TIPS:`,
    `- Your "reasoning" in poker_action is your chain-of-thought — be detailed about why you're making each decision`,
    `- Consider pot odds, position, opponent tendencies, and your hand strength`,
    `- Use table_talk to bluff, intimidate, or build rapport`,
    `- Occasionally send_message to the "${CHANNEL}" channel for longer table banter`,
    `- Adapt your strategy based on how opponents have been playing`,
    ``,
    `Start by calling get_poker_state to see the current game. Play aggressively and make the game entertaining!`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Card Component
// ═══════════════════════════════════════════════════════════════════════════════

function Card({ card, small }) {
  if (!card) {
    return <div className="pk-card pk-card-back" style={small ? { width: 36, height: 52 } : {}} />;
  }
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  const color = SUIT_COLORS[suit] || TEXT;
  const sz = small ? { width: 36, height: 52, fontSize: 11 } : { fontSize: 14 };

  return (
    <div className="pk-card" style={sz}>
      <span style={{ color, fontSize: small ? 13 : 16 }}>{rank}</span>
      <span style={{ color, fontSize: small ? 10 : 12, marginTop: -2 }}>{suit}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Avatar Component — DeepSteve logo tinted per player
// ═══════════════════════════════════════════════════════════════════════════════

function Avatar({ name, isActive, folded, eliminated, size = 56 }) {
  const color = playerColor(name);
  const opacity = folded || eliminated ? 0.3 : 1;

  // SVG face inspired by the DeepSteve logo (glasses + face)
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `${color}20`,
      border: `2.5px solid ${isActive ? GOLD : `${color}60`}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity,
      animation: isActive ? 'pk-glow 1.5s ease-in-out infinite' : 'none',
      transition: 'all 0.3s',
      position: 'relative',
    }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 40 40" fill="none">
        {/* Face circle */}
        <circle cx="20" cy="20" r="16" fill={`${color}30`} />
        {/* Glasses */}
        <circle cx="13" cy="17" r="6" stroke={color} strokeWidth="2" fill="none" />
        <circle cx="27" cy="17" r="6" stroke={color} strokeWidth="2" fill="none" />
        <line x1="19" y1="17" x2="21" y2="17" stroke={color} strokeWidth="2" />
        {/* Smile */}
        <path d="M14 26 Q20 30 26 26" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
      {eliminated && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.5)', fontSize: size * 0.4, color: RED,
        }}>
          X
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Player Seat Component
// ═══════════════════════════════════════════════════════════════════════════════

// Table positions: [bottom, left, top, right]
const SEAT_POSITIONS = [
  { bottom: 20, left: '50%', transform: 'translateX(-50%)' },          // bottom center
  { top: '50%', left: 20, transform: 'translateY(-50%)' },             // left
  { top: 20, left: '50%', transform: 'translateX(-50%)' },             // top center
  { top: '50%', right: 20, transform: 'translateY(-50%)' },            // right
];

function PlayerSeat({ player, position, latestReasoning, latestTalk }) {
  const color = playerColor(player.name);
  const pos = SEAT_POSITIONS[position];

  return (
    <div style={{
      position: 'absolute', ...pos,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      zIndex: 10,
      animation: 'pk-fadeIn 0.3s ease-out',
    }}>
      {/* Name */}
      <div style={{
        fontSize: 12, fontWeight: 700, color,
        textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        letterSpacing: 0.5,
      }}>
        {player.name}
        {player.isActive && (
          <span style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: GOLD, marginLeft: 6, verticalAlign: 'middle',
            animation: 'pk-pulse 1s infinite',
          }} />
        )}
      </div>

      {/* Avatar */}
      <Avatar
        name={player.name}
        isActive={player.isActive}
        folded={player.folded}
        eliminated={player.eliminated}
      />

      {/* Cards */}
      <div style={{ display: 'flex', gap: 3 }}>
        {player.hand ? (
          player.hand.map((c, i) => <Card key={i} card={c} small />)
        ) : player.folded || player.eliminated ? null : (
          <>
            <Card card={null} small />
            <Card card={null} small />
          </>
        )}
      </div>

      {/* Chips */}
      <div style={{
        fontSize: 13, fontWeight: 600,
        color: player.chips <= 0 ? RED : TEXT,
        textShadow: '0 1px 3px rgba(0,0,0,0.6)',
      }}>
        {player.eliminated ? 'OUT' : `$${player.chips}`}
      </div>

      {/* Current bet */}
      {player.bet > 0 && (
        <div style={{
          fontSize: 11, color: GOLD, fontWeight: 600,
          padding: '2px 8px', borderRadius: 10,
          background: 'rgba(0,0,0,0.4)',
          animation: 'pk-chipBounce 0.3s ease-out',
        }}>
          Bet: ${player.bet}
        </div>
      )}

      {/* Status badge */}
      {player.folded && !player.eliminated && (
        <div style={{ fontSize: 10, color: TEXT_DIM, fontStyle: 'italic' }}>Folded</div>
      )}
      {player.all_in && (
        <div style={{
          fontSize: 10, fontWeight: 700, color: RED,
          padding: '1px 6px', borderRadius: 4,
          background: `${RED}20`, border: `1px solid ${RED}40`,
        }}>
          ALL IN
        </div>
      )}

      {/* Table talk bubble */}
      {latestTalk && (
        <div style={{
          maxWidth: 180, padding: '4px 10px', borderRadius: 12,
          background: `${color}20`, border: `1px solid ${color}40`,
          fontSize: 11, color: TEXT, fontStyle: 'italic',
          animation: 'pk-fadeIn 0.3s ease-out',
          textAlign: 'center', wordBreak: 'break-word',
        }}>
          "{latestTalk.text}"
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Poker Table Component
// ═══════════════════════════════════════════════════════════════════════════════

function PokerTable({ state }) {
  if (!state || state.phase === 'IDLE') return null;

  return (
    <div style={{
      position: 'relative',
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Felt table */}
      <div style={{
        width: '70%', maxWidth: 600, height: '65%', maxHeight: 380,
        borderRadius: '50%',
        background: `radial-gradient(ellipse at 50% 40%, ${FELT} 0%, ${FELT_DARK} 100%)`,
        border: `4px solid ${GOLD_DIM}`,
        boxShadow: `0 0 40px rgba(0,0,0,0.5), inset 0 0 60px rgba(0,0,0,0.2), 0 0 0 8px ${BG2}`,
        position: 'relative',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12,
      }}>
        {/* Phase label */}
        <div style={{
          fontSize: 10, letterSpacing: 3, textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.4)',
        }}>
          {state.phase.replace('_', ' ')}
          {state.handNumber > 0 && ` \u2022 Hand #${state.handNumber}`}
        </div>

        {/* Community cards */}
        <div style={{ display: 'flex', gap: 6, minHeight: 68 }}>
          {state.communityCards.map((c, i) => (
            <Card key={i} card={c} />
          ))}
          {/* Empty slots */}
          {Array.from({ length: Math.max(0, 5 - state.communityCards.length) }, (_, i) => (
            <div key={`empty-${i}`} style={{
              width: 48, height: 68, borderRadius: 6,
              border: '1.5px dashed rgba(255,255,255,0.1)',
            }} />
          ))}
        </div>

        {/* Pot */}
        {state.pot > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 16px', borderRadius: 20,
            background: 'rgba(0,0,0,0.3)',
          }}>
            <div className="pk-chip" style={{ background: GOLD, width: 22, height: 22, fontSize: 8 }}>$</div>
            <span style={{ fontSize: 18, fontWeight: 700, color: GOLD }}>
              ${state.pot}
            </span>
          </div>
        )}

        {/* Winners banner */}
        {state.winners && (
          <div style={{
            padding: '6px 16px', borderRadius: 8,
            background: `${GREEN}20`, border: `1px solid ${GREEN}40`,
            fontSize: 13, fontWeight: 600, color: GREEN,
            animation: 'pk-fadeIn 0.3s ease-out',
          }}>
            {state.winners.join(' & ')} wins!
          </div>
        )}
      </div>

      {/* Player seats */}
      {state.players.map((p, i) => (
        <PlayerSeat
          key={p.name}
          player={p}
          position={i}
          latestTalk={state.tableTalk?.filter(t => t.player === p.name).slice(-1)[0]}
          latestReasoning={state.reasoning?.filter(r => r.player === p.name).slice(-1)[0]}
        />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chain of Thought Panel
// ═══════════════════════════════════════════════════════════════════════════════

function ThoughtPanel({ reasoning, tableTalk, log }) {
  const endRef = useRef(null);
  const prevCount = useRef(0);

  const combined = useMemo(() => {
    const items = [];
    for (const r of (reasoning || [])) {
      items.push({ ...r, type: 'thought' });
    }
    for (const t of (tableTalk || [])) {
      items.push({ ...t, type: 'talk' });
    }
    for (const l of (log || [])) {
      items.push({ text: l.text, timestamp: l.timestamp, type: 'action' });
    }
    items.sort((a, b) => a.timestamp - b.timestamp);
    return items.slice(-50);
  }, [reasoning, tableTalk, log]);

  useEffect(() => {
    if (combined.length > prevCount.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevCount.current = combined.length;
  }, [combined]);

  return (
    <div style={{
      flex: 1, overflowY: 'auto', padding: '8px 0',
      fontSize: 12, lineHeight: 1.5,
    }}>
      {combined.map((item, i) => {
        if (item.type === 'action') {
          return (
            <div key={i} style={{
              padding: '3px 12px', color: TEXT_DIM, fontSize: 11,
              borderLeft: `2px solid ${BORDER}`, marginLeft: 12, marginBottom: 2,
            }}>
              {item.text}
            </div>
          );
        }
        if (item.type === 'talk') {
          const color = playerColor(item.player);
          return (
            <div key={i} style={{
              padding: '4px 12px', marginBottom: 2,
              animation: 'pk-fadeIn 0.2s ease-out',
            }}>
              <span style={{
                fontSize: 10, fontWeight: 600, color,
                padding: '1px 5px', borderRadius: 6,
                background: `${color}15`,
              }}>
                {item.player}
              </span>
              <span style={{ color: TEXT, marginLeft: 6, fontStyle: 'italic' }}>
                "{item.text}"
              </span>
            </div>
          );
        }
        // thought
        const color = playerColor(item.player);
        return (
          <div key={i} style={{
            padding: '5px 12px', marginBottom: 2,
            background: `${color}08`,
            borderLeft: `2px solid ${color}40`,
            animation: 'pk-fadeIn 0.2s ease-out',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2,
            }}>
              <span style={{ fontSize: 10, fontWeight: 600, color }}>
                {item.player}
              </span>
              <span style={{ fontSize: 9, color: TEXT_DIM }}>thinking</span>
              <span style={{ fontSize: 9, color: '#484f58', marginLeft: 'auto' }}>
                {formatTime(item.timestamp)}
              </span>
            </div>
            <div style={{ color: TEXT_DIM, fontSize: 11, wordBreak: 'break-word' }}>
              {item.text}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Setup Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SetupScreen({ onStart }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse at 50% 30%, ${FELT}15 0%, transparent 60%), ${BG}`,
    }}>
      <div style={{
        maxWidth: 520, width: '100%', padding: '48px 40px',
        animation: 'pk-fadeIn 0.4s ease-out', textAlign: 'center',
      }}>
        {/* Title */}
        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 48, fontWeight: 900, letterSpacing: 4, margin: 0,
          color: TEXT,
          textShadow: `0 0 40px ${GOLD}20`,
        }}>
          AGENT POKER
        </h1>
        <div style={{
          fontSize: 12, color: TEXT_DIM, letterSpacing: 3, textTransform: 'uppercase', marginTop: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          <span style={{ width: 30, height: 1, background: BORDER, display: 'inline-block' }} />
          Texas Hold'em with Chain-of-Thought
          <span style={{ width: 30, height: 1, background: BORDER, display: 'inline-block' }} />
        </div>

        {/* Players preview */}
        <div style={{
          display: 'flex', justifyContent: 'center', gap: 24, margin: '36px 0',
        }}>
          {PLAYER_PERSONALITIES.map((p, i) => (
            <div key={p.name} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            }}>
              <Avatar name={p.name} size={52} />
              <div style={{ fontSize: 13, fontWeight: 600, color: PLAYER_COLORS[i] }}>
                {p.name}
              </div>
              <div style={{
                fontSize: 10, color: TEXT_DIM, maxWidth: 100, textAlign: 'center', lineHeight: 1.4,
              }}>
                {p.style.split('.')[0]}
              </div>
            </div>
          ))}
        </div>

        {/* Info */}
        <div style={{
          padding: '14px 20px', borderRadius: 8,
          background: BG2, border: `1px solid ${BORDER}`,
          fontSize: 12, color: TEXT_DIM, lineHeight: 1.6,
          marginBottom: 28, textAlign: 'left',
        }}>
          Four AI agents play Texas Hold'em while you watch. Each agent has a unique
          personality and strategy. Watch their chain-of-thought reasoning, table talk,
          bluffs, and dramatic all-ins unfold in real time.
        </div>

        {/* Start button */}
        <button onClick={onStart} style={{
          width: '100%', padding: 16, borderRadius: 8,
          background: `linear-gradient(135deg, ${GOLD}, ${GOLD_DIM})`,
          border: 'none', cursor: 'pointer',
          color: BG, fontSize: 16, fontWeight: 700, letterSpacing: 2,
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => e.currentTarget.style.filter = 'brightness(1.15)'}
          onMouseLeave={e => e.currentTarget.style.filter = 'none'}
        >
          DEAL ME IN
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Spawning Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SpawningScreen({ progress }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: BG,
    }}>
      <div style={{ textAlign: 'center', animation: 'pk-fadeIn 0.3s ease-out' }}>
        <h2 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 24, fontWeight: 700, color: TEXT, marginBottom: 28,
        }}>
          Seating players...
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 260 }}>
          {PLAYER_PERSONALITIES.map((p, i) => {
            const done = i < progress;
            const active = i === progress;
            return (
              <div key={p.name} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 16px', borderRadius: 8,
                background: done ? `${PLAYER_COLORS[i]}10` : active ? BG2 : 'transparent',
                border: `1px solid ${done ? `${PLAYER_COLORS[i]}30` : active ? BORDER : 'transparent'}`,
                opacity: done || active ? 1 : 0.4,
                transition: 'all 0.3s',
              }}>
                <Avatar name={p.name} size={32} isActive={active} />
                <span style={{ fontSize: 14, fontWeight: 500, color: done ? TEXT : active ? GOLD : TEXT_DIM }}>
                  {p.name}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: TEXT_DIM }}>
                  {done ? '\u2713' : active ? (
                    <span style={{
                      display: 'inline-block', width: 14, height: 14,
                      border: `2px solid ${GOLD}`, borderTopColor: 'transparent',
                      borderRadius: '50%', animation: 'pk-spin 0.6s linear infinite',
                    }} />
                  ) : ''}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 20, fontSize: 12, color: TEXT_DIM }}>
          {progress}/{PLAYER_PERSONALITIES.length} agents ready
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game Screen
// ═══════════════════════════════════════════════════════════════════════════════

function GameScreen({ state, onDeal, onReset }) {
  const isHandOver = state.phase === 'HAND_OVER' || state.phase === 'SHOWDOWN';
  const isGameOver = state.phase === 'GAME_OVER';

  return (
    <div style={{
      height: '100vh', display: 'flex',
      background: BG,
    }}>
      {/* Main table area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top bar */}
        <div style={{
          padding: '8px 16px', borderBottom: `1px solid ${BORDER}`,
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 15, fontWeight: 700, color: GOLD, letterSpacing: 1,
          }}>
            AGENT POKER
          </span>
          <span style={{ fontSize: 11, color: TEXT_DIM }}>
            Hand #{state.handNumber || 0}
          </span>
          <span style={{ fontSize: 11, color: TEXT_DIM, padding: '2px 8px', borderRadius: 4, background: BG2 }}>
            {state.phase?.replace('_', ' ')}
          </span>
          <div style={{ flex: 1 }} />

          {isHandOver && !isGameOver && (
            <button onClick={onDeal} style={{
              padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
              background: GOLD, border: 'none', color: BG,
              fontSize: 12, fontWeight: 600,
            }}>
              Deal Next Hand
            </button>
          )}
          {isGameOver && (
            <button onClick={onReset} style={{
              padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
              background: GREEN, border: 'none', color: BG,
              fontSize: 12, fontWeight: 600,
            }}>
              New Game
            </button>
          )}
          <button onClick={onReset} style={{
            padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
            background: 'transparent', border: `1px solid ${BORDER}`,
            color: TEXT_DIM, fontSize: 11,
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = RED; e.currentTarget.style.color = RED; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = BORDER; e.currentTarget.style.color = TEXT_DIM; }}
          >
            Reset
          </button>
        </div>

        {/* Poker table */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <PokerTable state={state} />
        </div>
      </div>

      {/* Right panel — chain of thought */}
      <div style={{
        width: 320, flexShrink: 0,
        borderLeft: `1px solid ${BORDER}`,
        display: 'flex', flexDirection: 'column',
        background: BG,
      }}>
        <div style={{
          padding: '10px 12px', borderBottom: `1px solid ${BORDER}`,
          fontSize: 11, textTransform: 'uppercase', letterSpacing: 2,
          color: TEXT_DIM, flexShrink: 0,
        }}>
          Live Feed
        </div>
        <ThoughtPanel
          reasoning={state.reasoning}
          tableTalk={state.tableTalk}
          log={state.log}
        />

        {/* Chip standings */}
        <div style={{
          padding: '10px 12px', borderTop: `1px solid ${BORDER}`,
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: TEXT_DIM, marginBottom: 6 }}>
            Standings
          </div>
          {[...state.players].sort((a, b) => b.chips - a.chips).map(p => {
            const color = playerColor(p.name);
            const pct = (p.chips / (1000 * 4)) * 100;
            return (
              <div key={p.name} style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
                opacity: p.eliminated ? 0.3 : 1,
              }}>
                <span style={{ fontSize: 11, fontWeight: 600, color, width: 60 }}>{p.name}</span>
                <div style={{
                  flex: 1, height: 6, borderRadius: 3, background: BORDER,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 3,
                    background: color,
                    width: `${Math.max(1, pct)}%`,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <span style={{ fontSize: 11, color: TEXT_DIM, width: 45, textAlign: 'right' }}>
                  ${p.chips}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Root Component
// ═══════════════════════════════════════════════════════════════════════════════

function AgentPoker() {
  const [phase, setPhase] = useState('SETUP');
  const [bridge, setBridge] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [spawnProgress, setSpawnProgress] = useState(0);
  const [sessionIds, setSessionIds] = useState([]);
  const sessionIdsRef = useRef([]);
  const pollRef = useRef(null);
  const autoDealRef = useRef(null);

  // Bridge init
  useEffect(() => {
    injectStyles();
    waitForBridge().then(b => {
      setBridge(b);
      // Cleanup orphaned sessions
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const { sessionIds: orphanIds } = JSON.parse(saved);
          if (orphanIds?.length) orphanIds.forEach(id => b.killSession(id, { force: true }));
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {}
    });
  }, []);

  // Poll game state from server
  useEffect(() => {
    if (phase !== 'PLAYING') return;

    const poll = async () => {
      try {
        const res = await fetch('/api/poker/state');
        const state = await res.json();
        setGameState(state);

        // Auto-deal next hand after HAND_OVER
        if (state.phase === 'HAND_OVER' && !autoDealRef.current) {
          autoDealRef.current = setTimeout(async () => {
            autoDealRef.current = null;
            try {
              await fetch('/api/poker/deal', { method: 'POST' });
            } catch {}
          }, 6000);
        }
      } catch {}
    };

    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => {
      clearInterval(pollRef.current);
      if (autoDealRef.current) { clearTimeout(autoDealRef.current); autoDealRef.current = null; }
    };
  }, [phase]);

  // Also listen for WebSocket broadcasts for instant updates
  useEffect(() => {
    if (!bridge) return;

    const handler = (e) => {
      if (e.data && typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'poker-state') {
            setGameState(msg.state);
          }
        } catch {}
      }
    };

    // The bridge doesn't expose raw WS, but we get updates via polling
    // The WebSocket broadcast is handled by the mod-manager bridge
  }, [bridge]);

  // Save session IDs for orphan recovery
  useEffect(() => {
    sessionIdsRef.current = sessionIds;
    if (sessionIds.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionIds }));
    }
  }, [sessionIds]);

  // Start game
  const handleStart = useCallback(async () => {
    if (!bridge) return;
    setPhase('SPAWNING');
    setSpawnProgress(0);

    // Create game on server
    await fetch('/api/poker/start', { method: 'POST' });

    // Determine cwd
    const existing = bridge.getSessions();
    const cwd = existing.length > 0 ? existing[0].cwd : '/tmp';

    // Spawn agent sessions sequentially
    const ids = [];
    for (let i = 0; i < PLAYER_PERSONALITIES.length; i++) {
      const p = PLAYER_PERSONALITIES[i];
      const prompt = buildAgentPrompt(p);
      const sessionId = await bridge.createSession(cwd, {
        name: `Poker: ${p.name}`,
        initialPrompt: prompt,
        background: true,
      });
      ids.push(sessionId);
      setSpawnProgress(i + 1);
    }

    setSessionIds(ids);

    // Deal first hand
    await fetch('/api/poker/deal', { method: 'POST' });
    setPhase('PLAYING');
  }, [bridge]);

  // Deal next hand
  const handleDeal = useCallback(async () => {
    await fetch('/api/poker/deal', { method: 'POST' });
  }, []);

  // Reset
  const handleReset = useCallback(async () => {
    // Kill sessions
    sessionIdsRef.current.forEach(id => bridge?.killSession(id, { force: true }));
    setSessionIds([]);
    localStorage.removeItem(STORAGE_KEY);

    await fetch('/api/poker/reset', { method: 'POST' });
    setGameState(null);
    setPhase('SETUP');
  }, [bridge]);

  // Loading
  if (!bridge) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: BG, color: TEXT_DIM, fontSize: 14,
      }}>
        <div style={{
          width: 20, height: 20, marginRight: 10,
          border: `2px solid ${BORDER}`, borderTopColor: GOLD,
          borderRadius: '50%', animation: 'pk-spin 0.6s linear infinite',
        }} />
        Connecting...
      </div>
    );
  }

  switch (phase) {
    case 'SETUP':
      return <SetupScreen onStart={handleStart} />;
    case 'SPAWNING':
      return <SpawningScreen progress={spawnProgress} />;
    case 'PLAYING':
      return gameState ? (
        <GameScreen state={gameState} onDeal={handleDeal} onReset={handleReset} />
      ) : (
        <div style={{
          height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: BG, color: TEXT_DIM,
        }}>
          <div style={{
            width: 20, height: 20, marginRight: 10,
            border: `2px solid ${BORDER}`, borderTopColor: GOLD,
            borderRadius: '50%', animation: 'pk-spin 0.6s linear infinite',
          }} />
          Loading game state...
        </div>
      );
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mount
// ═══════════════════════════════════════════════════════════════════════════════

ReactDOM.createRoot(document.getElementById('game-root')).render(<AgentPoker />);

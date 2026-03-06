const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const NAME_BANKS = {
  easy: [
    'Penguin', 'Dolphin', 'Eagle', 'Elephant', 'Octopus', 'Fox', 'Owl', 'Tiger', 'Whale', 'Chameleon',
    'Giraffe', 'Panda', 'Koala', 'Flamingo', 'Hedgehog', 'Otter', 'Parrot', 'Jellyfish', 'Sloth', 'Raccoon',
    'Peacock', 'Seahorse', 'Armadillo', 'Platypus', 'Narwhal', 'Axolotl', 'Capybara', 'Cheetah', 'Gorilla', 'Jaguar',
    'Kangaroo', 'Lemur', 'Lynx', 'Manatee', 'Moose', 'Ostrich', 'Porcupine', 'Quokka', 'Raven', 'Salamander',
    'Tapir', 'Toucan', 'Vulture', 'Walrus', 'Wolverine', 'Yak', 'Zebra', 'Albatross', 'Bison', 'Cobra',
    'Dragonfly', 'Falcon', 'Gazelle', 'Hummingbird', 'Iguana', 'Jackrabbit', 'Kiwi', 'Lobster', 'Mantis', 'Newt',
    'Ocelot', 'Pelican', 'Quail', 'Rhinoceros', 'Stingray', 'Tarantula', 'Urchin', 'Viper', 'Wombat', 'Xerus',
    'Badger', 'Coyote', 'Dugong', 'Ermine', 'Ferret',
  ],
  medium: [
    'Sherlock Holmes', 'Gandalf', 'Darth Vader', 'Hermione Granger', 'Pikachu', 'Batman', 'Frodo', 'Yoda', 'James Bond', 'Princess Leia',
    'Harry Potter', 'Katniss Everdeen', 'Spider-Man', 'Wonder Woman', 'Captain Jack Sparrow', 'Gollum', 'The Joker', 'Elsa', 'Shrek', 'Mario',
    'Indiana Jones', 'Wolverine', 'Daenerys Targaryen', 'Luke Skywalker', 'Iron Man', 'Dumbledore', 'Rapunzel', 'The Doctor', 'Legolas', 'Catwoman',
    'Sonic the Hedgehog', 'Lara Croft', 'Optimus Prime', 'Mulan', 'Captain America', 'Aragorn', 'Simba', 'Loki', 'Merlin', 'Neo',
    'Zelda', 'Buzz Lightyear', 'Dracula', 'Robin Hood', 'Willy Wonka', 'Morpheus', 'Groot', 'Arya Stark', 'Jack Skellington', 'Megamind',
    'Zorro', 'Pocahontas', 'Thanos', 'Aladdin', 'Maleficent', 'Thor', 'Black Panther', 'Tinker Bell', 'Sauron', 'Han Solo',
    'Peter Pan', 'Cruella de Vil', 'Link', 'Deadpool', 'Mary Poppins', 'Bilbo Baggins', 'Cinderella', 'Darth Maul', 'Obi-Wan Kenobi', 'Scooby-Doo',
    'The Grinch', 'Dorothy Gale', 'Pinocchio', 'Tarzan', 'Ratatouille',
  ],
  hard: [
    'Socrates', 'Aristotle', 'Nietzsche', 'Descartes', 'Confucius', 'Kant', 'Plato', 'Simone de Beauvoir', 'Hypatia', 'Diogenes',
    'Hegel', 'Kierkegaard', 'Spinoza', 'Leibniz', 'Hume', 'Locke', 'Hobbes', 'Rousseau', 'Voltaire', 'Wittgenstein',
    'Heidegger', 'Sartre', 'Camus', 'Foucault', 'Derrida', 'Marx', 'Mill', 'Bentham', 'Epicurus', 'Seneca',
    'Marcus Aurelius', 'Zeno of Citium', 'Parmenides', 'Heraclitus', 'Democritus', 'Pythagoras', 'Empedocles', 'Anaxagoras', 'Thales', 'Anaximander',
    'Augustine', 'Aquinas', 'Machiavelli', 'Bacon', 'Montaigne', 'Pascal', 'Berkeley', 'Schopenhauer', 'Emerson', 'Thoreau',
    'William James', 'Dewey', 'Husserl', 'Arendt', 'Popper', 'Kuhn', 'Rawls', 'Nozick', 'Judith Butler', 'Slavoj Zizek',
    'Bertrand Russell', 'Frege', 'Quine', 'Rorty', 'Deleuze', 'Adorno', 'Habermas', 'Levinas', 'Merleau-Ponty', 'Gadamer',
    'Al-Farabi', 'Avicenna', 'Averroes', 'Maimonides', 'Nagarjuna',
  ],
  nightmare: [
    'Entropy', 'Grace', 'Nostalgia', 'Silence', 'Gravity', 'Time', 'Paradox', 'Symmetry', 'Irony', 'Serendipity',
    'Consciousness', 'Infinity', 'Chaos', 'Harmony', 'Melancholy', 'Ambiguity', 'Resonance', 'Ephemeral', 'Sublime', 'Absurdity',
    'Oblivion', 'Emergence', 'Duality', 'Solitude', 'Belonging', 'Transcendence', 'Whimsy', 'Dissonance', 'Luminance', 'Recursion',
    'Inertia', 'Impermanence', 'Liminal', 'Aporia', 'Dialectic', 'Simulacrum', 'Abyss', 'Void', 'Threshold', 'Reverie',
    'Vertigo', 'Metamorphosis', 'Equilibrium', 'Tension', 'Fragility', 'Opacity', 'Dissolution', 'Confluence', 'Caesura', 'Apathy',
    'Euphoria', 'Ennui', 'Zeitgeist', 'Angst', 'Wanderlust', 'Pathos', 'Ethos', 'Hubris', 'Nemesis', 'Catharsis',
    'Sonder', 'Hiraeth', 'Fernweh', 'Kenopsia', 'Jouissance', 'Dasein', 'Qualia', 'Gestalt', 'Umwelt', 'Ataraxia',
    'Saudade', 'Wabi-Sabi', 'Mono no Aware', 'Ubuntu', 'Meraki',
  ],
};

const TIERS = [
  { id: 'easy', label: 'Easy', icon: '\u{1F43E}', desc: 'Animals', multiplier: 1, color: '#7ee787', hint: 'Be obvious. Use direct physical descriptions and well-known traits.' },
  { id: 'medium', label: 'Medium', icon: '\u{1F4D6}', desc: 'Fictional Characters', multiplier: 2, color: '#58a6ff', hint: 'Give moderate hints. Use catchphrases, plot references, and personality traits.' },
  { id: 'hard', label: 'Hard', icon: '\u{1F3DB}', desc: 'Philosophers', multiplier: 3, color: '#ffa657', hint: 'Be subtle. Use philosophical references, quotes, and intellectual parallels.' },
  { id: 'nightmare', label: 'Nightmare', icon: '\u{1F300}', desc: 'Abstract Concepts', multiplier: 5, color: '#f85149', hint: 'Be extremely cryptic. Use abstract metaphors and tangential associations only.' },
  { id: 'custom', label: 'Custom', icon: '\u270F', desc: 'Your own', multiplier: 3, color: '#d2a8ff', hint: 'Custom identities chosen by you.' },
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
const CUSTOM_NAMES_KEY = 'deepsteve-agent-game-custom-names';
const GENERATED_NAMES_KEY_PREFIX = 'deepsteve-agent-game-generated-';
const CHANNEL = 'agent-game';
const GENERATE_CHANNEL = 'agent-game-generate';

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

function getGeneratedNames(tier) {
  try {
    const raw = localStorage.getItem(GENERATED_NAMES_KEY_PREFIX + tier);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveGeneratedNames(tier, names) {
  localStorage.setItem(GENERATED_NAMES_KEY_PREFIX + tier, JSON.stringify(names));
}

function getNamePool(tier) {
  const base = NAME_BANKS[tier] || [];
  const generated = getGeneratedNames(tier);
  // Deduplicate (case-insensitive)
  const seen = new Set(base.map(n => n.toLowerCase()));
  const merged = [...base];
  for (const n of generated) {
    if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      merged.push(n);
    }
  }
  return merged;
}

function pickNames(tier, count) {
  if (tier === 'custom') return []; // custom names handled separately
  return shuffle(getNamePool(tier)).slice(0, count);
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

function buildGeneratorPrompt(tier, existingNames) {
  const t = tierInfo(tier);
  const category = { easy: 'animals', medium: 'fictional characters from books, movies, TV, and games', hard: 'philosophers from any era or tradition', nightmare: 'abstract concepts, emotions, or philosophical terms' }[tier] || t.desc;
  return [
    `Generate exactly 10 unique ${category} for a "Who Am I?" guessing game.`,
    ``,
    `Requirements:`,
    `- Category: ${t.label} (${t.desc})`,
    `- Each name should be well-known enough to give hints about`,
    `- Do NOT repeat any of these existing names: ${existingNames.join(', ')}`,
    `- Be creative and diverse in your selections`,
    ``,
    `Send your response as a JSON array of strings using send_message with channel "${GENERATE_CHANNEL}" and sender "Generator".`,
    `Example: ["Name1", "Name2", "Name3", "Name4", "Name5", "Name6", "Name7", "Name8", "Name9", "Name10"]`,
    ``,
    `Send ONLY the JSON array in your message, nothing else. Then stop.`,
  ].join('\n');
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
// Custom Names Editor
// ═══════════════════════════════════════════════════════════════════════════════

function CustomNamesEditor({ customNames, setCustomNames }) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef(null);

  const addName = () => {
    const name = inputValue.trim();
    if (!name || customNames.length >= 8) return;
    if (customNames.some(n => n.toLowerCase() === name.toLowerCase())) return;
    const updated = [...customNames, name];
    setCustomNames(updated);
    localStorage.setItem(CUSTOM_NAMES_KEY, JSON.stringify(updated));
    setInputValue('');
    inputRef.current?.focus();
  };

  const removeName = (idx) => {
    const updated = customNames.filter((_, i) => i !== idx);
    setCustomNames(updated);
    localStorage.setItem(CUSTOM_NAMES_KEY, JSON.stringify(updated));
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {customNames.map((name, i) => (
          <div key={`${name}-${i}`} style={{
            padding: '6px 10px', borderRadius: 20,
            background: BG2, border: `1.5px solid ${BORDER}`,
            color: TEXT, fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {name}
            <button onClick={() => removeName(i)} style={{
              background: 'none', border: 'none', color: TEXT_DIM, cursor: 'pointer',
              fontSize: 12, padding: '0 2px', lineHeight: 1,
            }}
              onMouseEnter={e => e.currentTarget.style.color = '#f85149'}
              onMouseLeave={e => e.currentTarget.style.color = TEXT_DIM}
            >
              \u00d7
            </button>
          </div>
        ))}
      </div>
      {customNames.length < 8 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addName(); } }}
            placeholder="Type a name and press Enter"
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 6,
              background: BG, border: `1px solid ${BORDER}`,
              color: TEXT, fontSize: 13, outline: 'none',
            }}
          />
          <button onClick={addName} style={{
            padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
            background: PURPLE, border: 'none', color: BG,
            fontSize: 12, fontWeight: 600,
          }}>
            Add
          </button>
        </div>
      )}
      <div style={{ fontSize: 10, color: TEXT_DIM, marginTop: 6 }}>
        {customNames.length}/8 names ({customNames.length < 3 ? `need at least ${3 - customNames.length} more` : 'ready'})
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Setup Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SetupScreen({ onStart, round, totalScore, bridge }) {
  const [tier, setTier] = useState('easy');
  const [count, setCount] = useState(3);
  const [names, setNames] = useState(() => pickNames('easy', 3));
  const [guesserIdx, setGuesserIdx] = useState(() => Math.floor(Math.random() * 3));
  const [customNames, setCustomNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CUSTOM_NAMES_KEY)) || []; } catch { return []; }
  });
  const [generating, setGenerating] = useState(false);
  const generatorSessionRef = useRef(null);
  const generateTimeoutRef = useRef(null);
  const unsubRef = useRef(null);

  const isCustom = tier === 'custom';
  const effectiveNames = isCustom ? customNames : names;
  const canStart = isCustom ? customNames.length >= 3 : true;

  useEffect(() => {
    if (isCustom) return;
    const n = pickNames(tier, count);
    setNames(n);
    setGuesserIdx(Math.floor(Math.random() * count));
  }, [tier, count]);

  // Keep guesserIdx in range for custom names
  useEffect(() => {
    if (isCustom && guesserIdx >= customNames.length) {
      setGuesserIdx(Math.max(0, customNames.length - 1));
    }
  }, [isCustom, customNames.length, guesserIdx]);

  // Cleanup generator on unmount
  useEffect(() => {
    return () => {
      if (generatorSessionRef.current && bridge) {
        bridge.killSession(generatorSessionRef.current, { force: true });
      }
      if (generateTimeoutRef.current) clearTimeout(generateTimeoutRef.current);
      if (unsubRef.current) unsubRef.current();
    };
  }, [bridge]);

  const handleShuffle = () => {
    setNames(pickNames(tier, count));
    setGuesserIdx(Math.floor(Math.random() * count));
  };

  const handleGenerate = async () => {
    if (!bridge || generating || isCustom) return;
    setGenerating(true);

    try {
      // Clear generator channel
      await fetch(`/api/agent-chat/${GENERATE_CHANNEL}`, { method: 'DELETE' }).catch(() => {});

      const existing = getNamePool(tier);
      const prompt = buildGeneratorPrompt(tier, existing);
      const sessions = bridge.getSessions();
      const cwd = sessions.length > 0 ? sessions[0].cwd : '/tmp';

      const sessionId = await bridge.createSession(cwd, {
        name: 'Name Generator',
        initialPrompt: prompt,
        background: true,
      });
      generatorSessionRef.current = sessionId;

      // Monitor for response
      const unsub = bridge.onAgentChatChanged(channels => {
        const msgs = channels[GENERATE_CHANNEL]?.messages || [];
        if (msgs.length === 0) return;

        // Look for a message with a JSON array
        for (const msg of msgs) {
          try {
            // Strip markdown fences if present
            let text = msg.text.trim();
            text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(n => typeof n === 'string')) {
              // Success — merge into pool
              const existingGenerated = getGeneratedNames(tier);
              const allGenerated = [...existingGenerated, ...parsed];
              saveGeneratedNames(tier, allGenerated);

              // Cleanup
              if (unsub) unsub();
              unsubRef.current = null;
              if (generateTimeoutRef.current) { clearTimeout(generateTimeoutRef.current); generateTimeoutRef.current = null; }
              bridge.killSession(sessionId, { force: true });
              generatorSessionRef.current = null;
              fetch(`/api/agent-chat/${GENERATE_CHANNEL}`, { method: 'DELETE' }).catch(() => {});

              // Re-shuffle with new pool
              setNames(pickNames(tier, count));
              setGuesserIdx(Math.floor(Math.random() * count));
              setGenerating(false);
              return;
            }
          } catch {}
        }
      });
      unsubRef.current = unsub;

      // 60-second timeout
      generateTimeoutRef.current = setTimeout(() => {
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
        if (generatorSessionRef.current) {
          bridge.killSession(generatorSessionRef.current, { force: true });
          generatorSessionRef.current = null;
        }
        fetch(`/api/agent-chat/${GENERATE_CHANNEL}`, { method: 'DELETE' }).catch(() => {});
        setGenerating(false);
      }, 60000);

    } catch {
      setGenerating(false);
    }
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse at 50% 30%, ${GOLD}08 0%, transparent 60%), radial-gradient(ellipse at 80% 70%, ${PURPLE}06 0%, transparent 50%), ${BG}`,
    }}>
      <div style={{
        maxWidth: 580, width: '100%', padding: '40px 36px',
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

        {/* Agent Count (hidden for custom tier) */}
        {!isCustom && (
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
        )}

        {/* Name Roster / Custom Editor */}
        <div style={{ marginBottom: 28 }}>
          <div style={{
            fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 10,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{isCustom ? 'Custom Names' : 'Players \u2014 click to assign guesser'}</span>
            {!isCustom && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button onClick={handleGenerate} disabled={generating} style={{
                  background: 'none', border: 'none', color: generating ? GOLD : TEXT_DIM, cursor: generating ? 'default' : 'pointer',
                  fontSize: 11, padding: '2px 6px',
                  display: 'flex', alignItems: 'center', gap: 4,
                }} title="Generate names with AI">
                  {generating ? (
                    <>
                      <span style={{
                        display: 'inline-block', width: 10, height: 10,
                        border: `1.5px solid ${GOLD}`, borderTopColor: 'transparent',
                        borderRadius: '50%', animation: 'ag-spin 0.6s linear infinite',
                      }} />
                      Generating...
                    </>
                  ) : (
                    <>\u2728 Generate</>
                  )}
                </button>
                <button onClick={handleShuffle} style={{
                  background: 'none', border: 'none', color: TEXT_DIM, cursor: 'pointer',
                  fontSize: 11, padding: '2px 6px',
                }}>
                  Shuffle
                </button>
              </div>
            )}
          </div>

          {isCustom ? (
            <CustomNamesEditor customNames={customNames} setCustomNames={setCustomNames} />
          ) : (
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
          )}

          {/* Guesser assignment for custom tier */}
          {isCustom && customNames.length >= 3 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 8 }}>
                Click to assign guesser
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {customNames.map((name, i) => {
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
          )}
        </div>

        {/* Start Button */}
        <button
          onClick={() => onStart({
            tier,
            names: isCustom ? customNames : names,
            guesserIdx: isCustom ? Math.min(guesserIdx, customNames.length - 1) : guesserIdx,
          })}
          disabled={!canStart}
          style={{
            width: '100%', padding: 14, borderRadius: 8,
            background: canStart ? `linear-gradient(135deg, ${GOLD}, ${GOLD}dd)` : `${BORDER}`,
            border: 'none', cursor: canStart ? 'pointer' : 'not-allowed',
            color: canStart ? BG : TEXT_DIM, fontSize: 15, fontWeight: 700, letterSpacing: 1,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (canStart) e.currentTarget.style.filter = 'brightness(1.1)'; }}
          onMouseLeave={e => e.currentTarget.style.filter = 'none'}
        >
          {isCustom && customNames.length < 3 ? `ADD ${3 - customNames.length} MORE NAME${3 - customNames.length > 1 ? 'S' : ''}` : 'START GAME'}
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
      return <SetupScreen onStart={handleStart} round={round} totalScore={totalScore} bridge={bridge} />;
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

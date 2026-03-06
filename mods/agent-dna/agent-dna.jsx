const { useState, useEffect, useCallback } = React;

const APPROACH_PRESETS = ['cautious', 'bold', 'thorough', 'creative', 'methodical', 'move-fast'];
const TRAIT_PRESETS = ['questioning', 'concise', 'verbose', 'experimental', 'defensive', 'pragmatic', 'perfectionist', 'collaborative'];

function Chip({ label, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 10px',
        fontSize: 11,
        border: '1px solid',
        borderColor: selected ? '#58a6ff' : '#30363d',
        borderRadius: 12,
        cursor: 'pointer',
        background: selected ? 'rgba(88,166,255,0.15)' : 'rgba(255,255,255,0.04)',
        color: selected ? '#58a6ff' : '#8b949e',
        transition: 'all 0.15s',
      }}
    >
      {label}
    </button>
  );
}

function AgentDnaPanel() {
  const [sessionId, setSessionId] = useState(null);
  const [sessionName, setSessionName] = useState(null);
  const [approach, setApproach] = useState('');
  const [traits, setTraits] = useState([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const fetchDna = useCallback(async (sid) => {
    if (!sid) return;
    try {
      const res = await fetch(`/api/agent-dna/${sid}`);
      const { dna } = await res.json();
      setApproach(dna.approach || '');
      setTraits(dna.traits || []);
      setDirty(false);
    } catch (e) {
      console.error('Failed to fetch DNA:', e);
    }
  }, []);

  useEffect(() => {
    let unsub = null;

    function setup() {
      unsub = window.deepsteve.onActiveSessionChanged((id) => {
        if (id) {
          setSessionId(id);
          const sessions = window.deepsteve.getSessions();
          const match = sessions.find(s => s.id === id);
          setSessionName(match?.name || id);
          fetchDna(id);
        } else {
          setSessionId(null);
          setSessionName(null);
          setApproach('');
          setTraits([]);
          setDirty(false);
        }
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
  }, [fetchDna]);

  const handleSave = useCallback(async () => {
    if (!sessionId) return;
    setSaving(true);
    try {
      await fetch(`/api/agent-dna/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approach: approach || undefined, traits: traits.length ? traits : undefined }),
      });
      setDirty(false);
    } catch (e) {
      console.error('Failed to save DNA:', e);
    }
    setSaving(false);
  }, [sessionId, approach, traits]);

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch(`/api/agent-dna/${sessionId}`, { method: 'DELETE' });
      setApproach('');
      setTraits([]);
      setDirty(false);
    } catch (e) {
      console.error('Failed to clear DNA:', e);
    }
  }, [sessionId]);

  const toggleTrait = useCallback((trait) => {
    setTraits(prev => {
      const next = prev.includes(trait) ? prev.filter(t => t !== trait) : [...prev, trait];
      setDirty(true);
      return next;
    });
  }, []);

  const selectApproach = useCallback((value) => {
    setApproach(prev => {
      const next = prev === value ? '' : value;
      setDirty(true);
      return next;
    });
  }, []);

  if (!sessionId) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#8b949e', fontSize: 13 }}>
        No session selected. Click a tab to configure its agent DNA.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>
          Agent DNA
        </div>
        <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>
          {sessionName} <span style={{ opacity: 0.5 }}>({sessionId})</span>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* Approach */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6 }}>
            Approach
          </label>
          <input
            type="text"
            value={approach}
            onChange={(e) => { setApproach(e.target.value); setDirty(true); }}
            placeholder="e.g. cautious, move-fast"
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 12,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 6,
              color: '#c9d1d9',
              outline: 'none',
              marginBottom: 6,
            }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {APPROACH_PRESETS.map(a => (
              <Chip
                key={a}
                label={a}
                selected={approach === a}
                onClick={() => selectApproach(a)}
              />
            ))}
          </div>
        </div>

        {/* Traits */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6 }}>
            Traits
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {TRAIT_PRESETS.map(t => (
              <Chip
                key={t}
                label={t}
                selected={traits.includes(t)}
                onClick={() => toggleTrait(t)}
              />
            ))}
          </div>
          {traits.filter(t => !TRAIT_PRESETS.includes(t)).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {traits.filter(t => !TRAIT_PRESETS.includes(t)).map(t => (
                <Chip key={t} label={t} selected={true} onClick={() => toggleTrait(t)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 12px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        gap: 8,
        flexShrink: 0,
      }}>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{
            flex: 1,
            padding: '6px 12px',
            fontSize: 12,
            border: 'none',
            borderRadius: 6,
            cursor: dirty ? 'pointer' : 'default',
            background: dirty ? '#238636' : 'rgba(255,255,255,0.06)',
            color: dirty ? '#fff' : '#8b949e',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleClear}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            border: '1px solid #30363d',
            borderRadius: 6,
            cursor: 'pointer',
            background: 'transparent',
            color: '#8b949e',
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('dna-root'));
root.render(<AgentDnaPanel />);

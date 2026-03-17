# Synth Lab

A real-time Web Audio API synthesizer that runs inside a deepsteve Display Tab. An AI agent (Claude) creates instruments, composes songs, and performs them live in the browser.

## Architecture

```
┌─────────────────────────────────────────────┐
│  deepsteve Display Tab (sandboxed iframe)   │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │Sequencer│→ │Instruments│→ │Web Audio  │  │
│  │(16th    │  │(32 synths)│  │API Context│  │
│  │ notes)  │  │           │  │           │  │
│  └────┬────┘  └──────────┘  └─────┬─────┘  │
│       │                           │         │
│  ┌────┴────┐               ┌──────┴──────┐  │
│  │Playlist │               │  Visualizer │  │
│  │System   │               │  (Canvas)   │  │
│  └─────────┘               └─────────────┘  │
└─────────────────────────────────────────────┘
        ↑ browser_eval injection
        │
┌───────┴───────┐
│ Claude agent   │
│ (composes live)│
└───────────────┘
```

## How It Works

### Phase 1: Create the Display Tab
Create a display tab with the base HTML containing:
- Sequencer engine (step-based, 16th notes)
- Visualizer (canvas waveform + frequency bars)
- Sidebar UI (instruments, queue, log)
- Playlist system with auto-advance and repeat

**Critical**: All top-level state must use `var` (not `const`/`let`) so it's accessible from the parent frame via `browser_eval`.

### Phase 2: Inject Instruments
Use `browser_eval` to call `defineInstrument(id, config)` on the running iframe. Each instrument is a `play(note, duration, time, params)` function that creates Web Audio nodes.

```js
// Access the iframe
var iframe = document.querySelector('#term-<tabId> iframe');
var win = iframe.contentWindow;

// Define an instrument
win.defineInstrument('my_synth', {
  name: 'My Synth', type: 'saw', color: '#ff0000',
  play: function(note, dur, t, p) {
    var o = ctx.createOscillator();
    // ... Web Audio setup ...
  }
});
```

### Phase 3: Compose & Queue Songs
Songs are pattern objects with tracks mapped to instruments:

```js
win.songs['My Song'] = [{
  name: 'My Song',
  bpm: 120,
  steps: 512,    // 16th notes (512 = 32 bars)
  repeat: 2,     // play twice = 64 bars
  tracks: {
    my_synth: [
      { step: 0, note: 'C4', duration: 0.3, params: { vol: 0.1 } },
      { step: 8, note: 'E4', duration: 0.3 },
    ]
  }
}];
```

### Phase 4: Build Playlist
```js
win.playlist = ['Song 1', 'Song 2', 'Song 3'];
win.playlistRepeat = true;
```

## Duration Cheat Sheet

Steps to real time: `duration = steps / (BPM / 60 * 4)`

| Steps | 60 BPM | 80 BPM | 120 BPM | 140 BPM |
|-------|--------|--------|---------|---------|
| 256   | 1:04   | 0:48   | 0:32    | 0:27    |
| 512   | 2:08   | 1:36   | 1:04    | 0:55    |
| 1024  | 4:16   | 3:12   | 2:08    | 1:50    |

For 3+ minute songs at fast tempos, use `repeat` on the pattern.

## Instruments (32)

### Melodic
| ID | Name | Sound | Key Params |
|----|------|-------|------------|
| `chip_lead` | Chip Lead | Square wave | `vibrato: {rate, depth}` |
| `soft_lead` | Soft Lead | Sine, pitch slide-in | `vibRate, vibDepth` |
| `delay_lead` | Delay Lead | Square + echo trail | `echoes, spacing, decay` |
| `chip_piano` | Chip Piano | Square+triangle pluck | `vol` |
| `lead_guitar` | Lead Guitar | Distorted saw | `bend, vibRate, vibDepth, tone` |
| `theremin` | Theremin | Portamento sine | `from (note), slideTime, vibRate, vibDepth` |
| `harpsichord` | Harpsichord | Bright harmonic pluck | `vol` |

### Bass
| ID | Name | Sound | Key Params |
|----|------|-------|------------|
| `pulse_bass` | Pulse Bass | 3 detuned squares | `vol` |
| `sub_bass` | Sub Bass | Pure sine | `vol` |
| `wobble_bass` | Wobble Bass | Saw + LFO filter | `rate, depth, center, q` |
| `acid_bass` | Acid Bass | 303-style resonant saw | `cutoff, res, accent, slide (note)` |

### Pads / Sustained
| ID | Name | Sound | Key Params |
|----|------|-------|------------|
| `tri_pad` | Triangle Pad | Triangle ADSR | `vol` |
| `shimmer` | Shimmer | 5 detuned triangles | `vol` |
| `strings` | Strings | 5 detuned saws + LFO + filter | `attack, bright, vol` |
| `choir` | Choir | Filtered squares at octaves + vibrato | `open (filter Hz), vol` |
| `organ` | Organ | Additive harmonics + Leslie | `drawbars [5 levels], leslie (Hz), vol` |

### Percussion
| ID | Name | Sound | Key Params |
|----|------|-------|------------|
| `noise_kick` | Noise Kick | Sine pitch sweep 150→30Hz | `vol` |
| `noise_snare` | Noise Snare | Bandpass noise + triangle body | `vol` |
| `noise_hat` | Noise Hat | Highpass white noise | `vol, freq, decay` |
| `open_hat` | Open Hat | Bandpass noise, long decay | `vol, decay` |
| `timpani` | Timpani | Sine sweep + noise body | `vol, sustain` |
| `heartbeat` | Heartbeat | Double-pulse lub-dub | `vol, gap` |
| `rock_kick` | Rock Kick | Click transient + sine body | `vol` |
| `rock_snare` | Rock Snare | Highpass noise + triangle crack | `vol` |
| `crash` | Crash | Bandpass noise, long decay | `vol, decay` |
| `metal_perc` | Metal Perc | Ring modulation | `vol, ratio` |

### FX / Other
| ID | Name | Sound | Key Params |
|----|------|-------|------------|
| `fm_bell` | FM Bell | FM synthesis | `ratio, modDepth, vol` |
| `arp_lead` | Arp Lead | Sawtooth arpeggios | `intervals [semitones], speed, vol` |
| `marimba` | Glass Marimba | Sine harmonics 1:2.76:5.4 | `vol` |
| `brass` | Brass | Saw+square fast filter | `bright, vol` |
| `pluck` | Pluck | Saw + filter decay | `cutoff, resonance, vol` |
| `power_chord` | Power Chord | Distorted root+5th+oct | `vol, drive, tone, palm (bool)` |

## Key Learnings

1. **`var` not `const`/`let`** for iframe-accessible state. Functions declared with `function` keyword are also accessible.

2. **Error-resilient sequencer**: The `scheduleStep` → `advancePattern` chain uses `setTimeout`. If either throws, the chain dies and music stops permanently. Always wrap in try/catch with `setTimeout` OUTSIDE the catch.

3. **`update_display_tab` kills audio** because it reloads the iframe. Use `browser_eval` for all live changes.

4. **Iframe sandbox needs** `allow-scripts allow-forms allow-same-origin` and `allow="autoplay"` attribute. Without `allow-same-origin`, parent can't access `contentWindow` properties.

5. **Merging multi-section songs**: Offset each section's step numbers by the cumulative total of prior sections × their repeats. Single merged patterns avoid transition gaps.

6. **Typing sound**: Bandpass-filtered noise bursts (3000-5000Hz, Q 1.5, 12ms duration) with slight random pitch variation per keystroke. Skip spaces.

7. **Intro system**: Overlay with retro terminal (rounded corners, scanline effect), streaming text via `typeText()`, play button in header (not overlay) for re-triggering during recording.

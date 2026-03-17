// Synth Lab - Instrument Definitions
// 22 chiptune/synthesizer instruments for Web Audio API
// Each instrument is a factory function that takes (ctx, masterGain, noteFreq) and returns a play function
// play(note, duration, time, params)

// ==================== NOTE FREQUENCY HELPER ====================
const NOTE_FREQS = {};
const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
for (let oct = 0; oct <= 8; oct++) {
  for (let i = 0; i < 12; i++) {
    NOTE_FREQS[NOTES[i] + oct] = 440 * Math.pow(2, ((oct * 12 + i) - 57) / 12);
  }
}
function noteFreq(n) { return NOTE_FREQS[n] || 440; }

// ==================== INSTRUMENT DEFINITIONS ====================
// Each instrument returns { name, type, color, play(note, dur, time, params) }

const INSTRUMENTS = {

  // 1. CHIP LEAD - Classic chiptune square wave
  // Params: vol (0.12), vibrato: { rate (5), depth (3) }
  chip_lead: (ctx, masterGain) => ({
    name: 'Chip Lead', type: 'square', color: '#00ff88',
    play(note, dur, t, p = {}) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      const v = p.vol || 0.12;
      o.type = 'square';
      o.frequency.setValueAtTime(noteFreq(note), t);
      if (p.vibrato) {
        const l = ctx.createOscillator(), lg = ctx.createGain();
        l.frequency.value = p.vibrato.rate || 5;
        lg.gain.value = p.vibrato.depth || 3;
        l.connect(lg); lg.connect(o.frequency);
        l.start(t); l.stop(t + dur);
      }
      g.gain.setValueAtTime(v, t);
      g.gain.setValueAtTime(v, t + dur * 0.7);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g); g.connect(masterGain);
      o.start(t); o.stop(t + dur + 0.01);
    }
  }),

  // 2. PULSE BASS - 3 detuned square oscillators for thick bass
  // Params: vol (0.15)
  pulse_bass: (ctx, masterGain) => ({
    name: 'Pulse Bass', type: 'pulse', color: '#ff6644',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.15;
      for (let d = -1; d <= 1; d++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(noteFreq(note) + d * 1.5, t);
        g.gain.setValueAtTime(v / 3, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g); g.connect(masterGain);
        o.start(t); o.stop(t + dur + 0.01);
      }
    }
  }),

  // 3. NOISE HAT - Highpass-filtered white noise, short decay
  // Params: vol (0.06), freq (8000), decay (0.05)
  noise_hat: (ctx, masterGain) => ({
    name: 'Noise Hat', type: 'noise', color: '#ffcc00',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.06;
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource(); s.buffer = buf;
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = p.freq || 8000;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (p.decay || 0.05));
      s.connect(f); f.connect(g); g.connect(masterGain);
      s.start(t); s.stop(t + 0.15);
    }
  }),

  // 4. NOISE KICK - Sine oscillator with pitch sweep 150Hz->30Hz
  // Params: vol (0.25)
  noise_kick: (ctx, masterGain) => ({
    name: 'Noise Kick', type: 'synth', color: '#ff3366',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.25;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(30, t + 0.12);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      o.connect(g); g.connect(masterGain);
      o.start(t); o.stop(t + 0.25);
    }
  }),

  // 5. NOISE SNARE - Bandpass noise (3kHz) + triangle body tone (200->80Hz)
  // Params: vol (0.12)
  noise_snare: (ctx, masterGain) => ({
    name: 'Noise Snare', type: 'noise', color: '#ff9900',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.12;
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource(); s.buffer = buf;
      const ng = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 3000;
      ng.gain.setValueAtTime(v, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      s.connect(f); f.connect(ng); ng.connect(masterGain);
      s.start(t); s.stop(t + 0.2);
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(200, t);
      o.frequency.exponentialRampToValueAtTime(80, t + 0.05);
      og.gain.setValueAtTime(v * 0.5, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(og); og.connect(masterGain);
      o.start(t); o.stop(t + 0.15);
    }
  }),

  // 6. TRIANGLE PAD - Soft triangle wave with linear ADSR envelope
  // Params: vol (0.08)
  tri_pad: (ctx, masterGain) => ({
    name: 'Triangle Pad', type: 'triangle', color: '#6688ff',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.08;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(noteFreq(note), t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + dur * 0.3);
      g.gain.linearRampToValueAtTime(v * 0.7, t + dur * 0.7);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g); g.connect(masterGain);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }),

  // 7. ARP LEAD - Sawtooth arpeggios, each note filtered progressively brighter
  // Params: vol (0.06), intervals ([0,4,7,12] semitones), speed (0.06s between notes)
  arp_lead: (ctx, masterGain) => ({
    name: 'Arp Lead', type: 'sawtooth', color: '#cc44ff',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.06;
      const base = noteFreq(note);
      const intervals = p.intervals || [0, 4, 7, 12];
      const speed = p.speed || 0.06;
      for (let i = 0; i < intervals.length; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        const f = ctx.createBiquadFilter();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(base * Math.pow(2, intervals[i] / 12), t + i * speed);
        f.type = 'lowpass'; f.frequency.value = 2000 + i * 500;
        g.gain.setValueAtTime(0, t);
        g.gain.setValueAtTime(v, t + i * speed);
        g.gain.linearRampToValueAtTime(0, t + i * speed + speed * 0.9);
        o.connect(f); f.connect(g); g.connect(masterGain);
        o.start(t + i * speed); o.stop(t + i * speed + speed + 0.01);
      }
    }
  }),

  // 8. CHIP PIANO - Plucky square+triangle at fundamental+octave
  // Params: vol (0.10)
  chip_piano: (ctx, masterGain) => ({
    name: 'Chip Piano', type: 'mixed', color: '#44ddcc',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.10;
      const freq = noteFreq(note);
      const types = ['square', 'triangle'];
      for (let idx = 0; idx < 2; idx++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = types[idx];
        o.frequency.setValueAtTime(freq * (idx + 1), t);
        const vol = v / (idx + 1);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(vol * 0.3, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.8);
        o.connect(g); g.connect(masterGain);
        o.start(t); o.stop(t + dur + 0.01);
      }
    }
  }),

  // 9. FM BELL - Metallic, crystalline FM synthesis
  // Params: vol (0.07), ratio (2.0 carrier:modulator), modDepth (1.5)
  fm_bell: (ctx, masterGain) => ({
    name: 'FM Bell', type: 'fm', color: '#88ffdd',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.07;
      const freq = noteFreq(note);
      const carrier = ctx.createOscillator(), cGain = ctx.createGain();
      const mod = ctx.createOscillator(), modGain = ctx.createGain();
      carrier.type = 'sine';
      carrier.frequency.setValueAtTime(freq, t);
      mod.type = 'sine';
      mod.frequency.setValueAtTime(freq * (p.ratio || 2.0), t);
      modGain.gain.setValueAtTime(freq * (p.modDepth || 1.5), t);
      modGain.gain.exponentialRampToValueAtTime(1, t + dur * 0.8);
      mod.connect(modGain); modGain.connect(carrier.frequency);
      cGain.gain.setValueAtTime(v, t);
      cGain.gain.exponentialRampToValueAtTime(v * 0.3, t + 0.06);
      cGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      carrier.connect(cGain); cGain.connect(masterGain);
      carrier.start(t); carrier.stop(t + dur + 0.01);
      mod.start(t); mod.stop(t + dur + 0.01);
    }
  }),

  // 10. SUB BASS - Pure deep sine wave
  // Params: vol (0.2)
  sub_bass: (ctx, masterGain) => ({
    name: 'Sub Bass', type: 'sine', color: '#ff44aa',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.2;
      const freq = noteFreq(note);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(v, t);
      g.gain.setValueAtTime(v * 0.8, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(masterGain);
      o.start(t); o.stop(t + dur + 0.01);
    }
  }),

  // 11. SHIMMER - 5 detuned triangle oscillators, slow chorus pad
  // Params: vol (0.04)
  shimmer: (ctx, masterGain) => ({
    name: 'Shimmer', type: 'chorus', color: '#aaccff',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.04;
      const freq = noteFreq(note);
      const detunes = [-7, -3, 0, 3, 7];
      for (let i = 0; i < detunes.length; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(freq, t);
        o.detune.setValueAtTime(detunes[i], t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(v / detunes.length, t + dur * 0.4);
        g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(g); g.connect(masterGain);
        o.start(t); o.stop(t + dur + 0.05);
      }
    }
  }),

  // 12. OPEN HAT - Longer noise decay, bandpass filtered
  // Params: vol (0.05), decay (0.2)
  open_hat: (ctx, masterGain) => ({
    name: 'Open Hat', type: 'noise', color: '#dddd44',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.05;
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource(); s.buffer = buf;
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 10000; f.Q.value = 1;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (p.decay || 0.2));
      s.connect(f); f.connect(g); g.connect(masterGain);
      s.start(t); s.stop(t + 0.35);
    }
  }),

  // 13. WOBBLE BASS - Sawtooth with LFO-modulated lowpass filter
  // Params: vol (0.14), rate (4 Hz), depth (600), center (800 Hz), q (8)
  wobble_bass: (ctx, masterGain) => ({
    name: 'Wobble Bass', type: 'wobble', color: '#ff66cc',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.14;
      const freq = noteFreq(note);
      const o = ctx.createOscillator(), g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(freq, t);
      f.type = 'lowpass'; f.frequency.value = p.center || 800; f.Q.value = p.q || 8;
      lfo.type = 'sine'; lfo.frequency.value = p.rate || 4;
      lfoG.gain.value = p.depth || 600;
      lfo.connect(lfoG); lfoG.connect(f.frequency);
      g.gain.setValueAtTime(v, t);
      g.gain.setValueAtTime(v * 0.8, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(f); f.connect(g); g.connect(masterGain);
      lfo.start(t); lfo.stop(t + dur + 0.01);
      o.start(t); o.stop(t + dur + 0.01);
    }
  }),

  // 14. STRINGS - 5 detuned sawtooths with LFO, filtered envelope
  // Params: vol (0.06), attack (0.25 ratio of dur), bright (2500 Hz peak filter)
  strings: (ctx, masterGain) => ({
    name: 'Strings', type: 'ensemble', color: '#ff8866',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.06;
      const freq = noteFreq(note);
      const detunes = [-12, -5, 0, 5, 12];
      for (let i = 0; i < detunes.length; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        const f = ctx.createBiquadFilter();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(freq, t);
        o.detune.setValueAtTime(detunes[i], t);
        const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
        lfo.frequency.value = 0.3 + Math.random() * 0.4;
        lfoG.gain.value = 2 + Math.random() * 2;
        lfo.connect(lfoG); lfoG.connect(o.detune);
        lfo.start(t); lfo.stop(t + dur + 0.1);
        f.type = 'lowpass';
        f.frequency.setValueAtTime(300, t);
        f.frequency.linearRampToValueAtTime(p.bright || 2500, t + dur * 0.4);
        f.frequency.linearRampToValueAtTime(1200, t + dur * 0.8);
        f.frequency.linearRampToValueAtTime(200, t + dur);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(v / detunes.length, t + dur * (p.attack || 0.25));
        g.gain.setValueAtTime(v / detunes.length, t + dur * 0.7);
        g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(f); f.connect(g); g.connect(masterGain);
        o.start(t); o.stop(t + dur + 0.05);
      }
    }
  }),

  // 15. CHOIR - Filtered square waves at sub/fundamental/octave with vibrato
  // Params: vol (0.05), open (1500 Hz filter peak)
  choir: (ctx, masterGain) => ({
    name: 'Choir', type: 'voice', color: '#ddaaff',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.05;
      const freq = noteFreq(note);
      const partials = [0.5, 1, 2];
      for (let i = 0; i < partials.length; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        const f = ctx.createBiquadFilter();
        o.type = 'square';
        o.frequency.setValueAtTime(freq * partials[i], t);
        const vib = ctx.createOscillator(), vibG = ctx.createGain();
        vib.frequency.value = 5.5;
        vibG.gain.value = freq * partials[i] * 0.008;
        vib.connect(vibG); vibG.connect(o.frequency);
        vib.start(t + 0.3); vib.stop(t + dur + 0.1);
        f.type = 'lowpass';
        f.frequency.setValueAtTime(200, t);
        f.frequency.linearRampToValueAtTime(p.open || 1500, t + dur * 0.3);
        f.frequency.setValueAtTime(p.open || 1500, t + dur * 0.6);
        f.frequency.linearRampToValueAtTime(300, t + dur);
        const partVol = v / partials.length / (i === 2 ? 2 : 1);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(partVol, t + dur * 0.2);
        g.gain.setValueAtTime(partVol * 0.9, t + dur * 0.7);
        g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(f); f.connect(g); g.connect(masterGain);
        o.start(t); o.stop(t + dur + 0.05);
      }
    }
  }),

  // 16. BRASS - Bright saw+square stab with fast filter attack
  // Params: vol (0.10), bright (4000 Hz)
  brass: (ctx, masterGain) => ({
    name: 'Brass', type: 'brass', color: '#ffdd33',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.10;
      const freq = noteFreq(note);
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      o1.type = 'sawtooth'; o2.type = 'square';
      o1.frequency.setValueAtTime(freq, t);
      o2.frequency.setValueAtTime(freq * 1.003, t);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(500, t);
      f.frequency.linearRampToValueAtTime(p.bright || 4000, t + 0.06);
      f.frequency.exponentialRampToValueAtTime(800, t + dur * 0.7);
      f.frequency.linearRampToValueAtTime(300, t + dur);
      f.Q.value = 2;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 0.03);
      g.gain.setValueAtTime(v * 0.7, t + dur * 0.5);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o1.connect(f); o2.connect(f); f.connect(g); g.connect(masterGain);
      o1.start(t); o1.stop(t + dur + 0.01);
      o2.start(t); o2.stop(t + dur + 0.01);
    }
  }),

  // 17. SOFT LEAD - Sine wave with pitch slide-in and delayed vibrato
  // Params: vol (0.10), vibRate (5), vibDepth (4)
  soft_lead: (ctx, masterGain) => ({
    name: 'Soft Lead', type: 'sine', color: '#77ffaa',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.10;
      const freq = noteFreq(note);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * 0.97, t);
      o.frequency.linearRampToValueAtTime(freq, t + 0.08);
      const vib = ctx.createOscillator(), vibG = ctx.createGain();
      vib.frequency.value = p.vibRate || 5;
      vibG.gain.setValueAtTime(0, t);
      vibG.gain.linearRampToValueAtTime(p.vibDepth || 4, t + dur * 0.3);
      vib.connect(vibG); vibG.connect(o.frequency);
      vib.start(t); vib.stop(t + dur + 0.1);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 0.06);
      g.gain.setValueAtTime(v * 0.85, t + dur * 0.6);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g); g.connect(masterGain);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }),

  // 18. TIMPANI - Pitched drum with sine sweep and noise body
  // Params: vol (0.22), sustain (0.5s)
  timpani: (ctx, masterGain) => ({
    name: 'Timpani', type: 'perc', color: '#cc8844',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.22;
      const freq = noteFreq(note || 'C2');
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * 1.5, t);
      o.frequency.exponentialRampToValueAtTime(freq, t + 0.04);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(v * 0.3, t + 0.1);
      g.gain.exponentialRampToValueAtTime(0.001, t + (p.sustain || 0.5));
      o.connect(g); g.connect(masterGain);
      o.start(t); o.stop(t + 0.6);
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource(); s.buffer = buf;
      const ng = ctx.createGain(), nf = ctx.createBiquadFilter();
      nf.type = 'lowpass'; nf.frequency.value = freq * 3;
      ng.gain.setValueAtTime(v * 0.15, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      s.connect(nf); nf.connect(ng); ng.connect(masterGain);
      s.start(t); s.stop(t + 0.1);
    }
  }),

  // 19. PLUCK - Sawtooth with fast filter decay, guitar-like
  // Params: vol (0.09), cutoff (4000), resonance (2)
  pluck: (ctx, masterGain) => ({
    name: 'Pluck', type: 'filtered-saw', color: '#ffaa44',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.09;
      const freq = noteFreq(note);
      const o = ctx.createOscillator(), g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(freq, t);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(p.cutoff || 4000, t);
      f.frequency.exponentialRampToValueAtTime(400, t + dur * 0.7);
      f.Q.value = p.resonance || 2;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(f); f.connect(g); g.connect(masterGain);
      o.start(t); o.stop(t + dur + 0.01);
    }
  }),

  // 20. GLASS MARIMBA - Sine with marimba-like harmonic ratios
  // Params: vol (0.09)
  marimba: (ctx, masterGain) => ({
    name: 'Glass Marimba', type: 'perc-tuned', color: '#77eebb',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.09;
      const freq = noteFreq(note);
      const harmonics = [1, 2.76, 5.4];
      const volumes = [1, 0.3, 0.1];
      for (let i = 0; i < harmonics.length; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq * harmonics[i], t);
        const hv = v * volumes[i];
        g.gain.setValueAtTime(hv, t);
        g.gain.exponentialRampToValueAtTime(hv * 0.5, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur * (1 - i * 0.2));
        o.connect(g); g.connect(masterGain);
        o.start(t); o.stop(t + dur + 0.01);
      }
    }
  }),

  // 21. DELAY LEAD - Square wave that plays its own echo trail
  // Params: vol (0.10), echoes (3), spacing (0.15s), decay (0.6 multiplier)
  delay_lead: (ctx, masterGain) => ({
    name: 'Delay Lead', type: 'echo', color: '#55bbff',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.10;
      const freq = noteFreq(note);
      const echoes = p.echoes || 3;
      const spacing = p.spacing || 0.15;
      const decay = p.decay || 0.6;
      for (let i = 0; i <= echoes; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        const f = ctx.createBiquadFilter();
        o.type = 'square';
        o.frequency.setValueAtTime(freq + i * 0.5, t + i * spacing);
        f.type = 'lowpass';
        f.frequency.value = 3000 - i * 600;
        const ev = v * Math.pow(decay, i);
        g.gain.setValueAtTime(0, t);
        g.gain.setValueAtTime(ev, t + i * spacing);
        g.gain.linearRampToValueAtTime(ev * 0.7, t + i * spacing + dur * 0.6);
        g.gain.linearRampToValueAtTime(0, t + i * spacing + dur);
        o.connect(f); f.connect(g); g.connect(masterGain);
        o.start(t + i * spacing); o.stop(t + i * spacing + dur + 0.01);
      }
    }
  }),

  // 22. HEARTBEAT - Organic double-pulse (lub-dub)
  // Params: vol (0.18), gap (0.22s between lub and dub)
  heartbeat: (ctx, masterGain) => ({
    name: 'Heartbeat', type: 'organic', color: '#ff5555',
    play(note, dur, t, p = {}) {
      const v = p.vol || 0.18;
      const o1 = ctx.createOscillator(), g1 = ctx.createGain();
      o1.type = 'sine';
      o1.frequency.setValueAtTime(60, t);
      o1.frequency.exponentialRampToValueAtTime(30, t + 0.1);
      g1.gain.setValueAtTime(v, t);
      g1.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o1.connect(g1); g1.connect(masterGain);
      o1.start(t); o1.stop(t + 0.2);
      const delay = p.gap || 0.22;
      const o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o2.type = 'sine';
      o2.frequency.setValueAtTime(50, t + delay);
      o2.frequency.exponentialRampToValueAtTime(25, t + delay + 0.08);
      g2.gain.setValueAtTime(v * 0.7, t + delay);
      g2.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.12);
      o2.connect(g2); g2.connect(masterGain);
      o2.start(t + delay); o2.stop(t + delay + 0.15);
    }
  }),
};

// Export for use
if (typeof module !== 'undefined') module.exports = { INSTRUMENTS, NOTE_FREQS, noteFreq };

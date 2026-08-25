// Every sound in the Village is synthesized here. Nothing is loaded.
//
// Same reason as the textures: release.sh ships a mod's files through a text
// heredoc, so an audio file could not reach a curl install. It suits the material
// anyway — rain is filtered noise, and a soft ambient pad is three detuned
// oscillators, so nothing here is a compromise.
//
// The context is created on the first real user gesture (browsers refuse one
// otherwise), which in practice is the click that takes pointer lock.

const MASTER = 0.5;

let ctx = null;
let master = null;
let started = false;

const bed = { rain: null, pad: null, gain: null };

/** Create the context. Safe to call repeatedly; only the first call does anything. */
export function startAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;

  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = MASTER;
  master.connect(ctx.destination);
  return ctx;
}

/** A looping noise buffer. Long enough that the loop point is not audible. */
function noiseBuffer(seconds = 4) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  // Cross-fade the tail into the head so the seam disappears.
  const fade = Math.floor(ctx.sampleRate * 0.25);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[len - fade + i] = data[len - fade + i] * (1 - t) + data[i] * t;
  }
  return buf;
}

/**
 * The ambient bed: rain and a slow pad, both running for as long as the mod is up.
 *
 * The rain is band-limited noise with a slow LFO on the filter, which is what makes
 * it breathe instead of hiss. The pad is two oscillators a fifth apart, detuned and
 * very quiet — you should not be able to name it while it is playing.
 */
export function startAmbient() {
  if (!ctx || started) return;
  started = true;

  bed.gain = ctx.createGain();
  bed.gain.gain.value = 0;
  bed.gain.connect(master);

  // --- rain
  const rainSrc = ctx.createBufferSource();
  rainSrc.buffer = noiseBuffer(5);
  rainSrc.loop = true;

  const rainHp = ctx.createBiquadFilter();
  rainHp.type = 'highpass';
  rainHp.frequency.value = 420;

  const rainLp = ctx.createBiquadFilter();
  rainLp.type = 'lowpass';
  rainLp.frequency.value = 2400;
  rainLp.Q.value = 0.4;

  const rainGain = ctx.createGain();
  rainGain.gain.value = 0.16;

  // A slow sweep on the low-pass so the downpour swells and eases.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.055;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 900;
  lfo.connect(lfoAmt).connect(rainLp.frequency);
  lfo.start();

  rainSrc.connect(rainHp).connect(rainLp).connect(rainGain).connect(bed.gain);
  rainSrc.start();
  bed.rain = { src: rainSrc, gain: rainGain, lfo };

  // --- pad
  const padGain = ctx.createGain();
  padGain.gain.value = 0.035;
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = 700;
  padFilter.connect(padGain).connect(bed.gain);

  const voices = [];
  for (const [freq, detune] of [[110, -6], [164.81, 5], [220, 9]]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const g = ctx.createGain();
    g.gain.value = 0.34;
    osc.connect(g).connect(padFilter);
    osc.start();
    voices.push({ osc, g });

    // Each voice drifts on its own slow LFO, so the chord never sits still.
    const vib = ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = 0.03 + Math.random() * 0.04;
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = 4;
    vib.connect(vibAmt).connect(osc.detune);
    vib.start();
  }
  bed.pad = { voices, filter: padFilter, gain: padGain };

  // Fade in, rather than arriving.
  bed.gain.gain.setValueAtTime(0, ctx.currentTime);
  bed.gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 3.0);
}

/** Turn the bed on or off without tearing it down — the setting is a live toggle. */
export function setAmbientEnabled(on) {
  if (!ctx || !bed.gain) return;
  const now = ctx.currentTime;
  bed.gain.gain.cancelScheduledValues(now);
  bed.gain.gain.setValueAtTime(bed.gain.gain.value, now);
  bed.gain.gain.linearRampToValueAtTime(on ? 1 : 0, now + 0.6);
}

/** Rain audio follows the rain setting, so turning the weather off silences it. */
export function setRainAudio(on) {
  if (!ctx || !bed.rain) return;
  const now = ctx.currentTime;
  bed.rain.gain.gain.cancelScheduledValues(now);
  bed.rain.gain.gain.setValueAtTime(bed.rain.gain.gain.value, now);
  bed.rain.gain.gain.linearRampToValueAtTime(on ? 0.16 : 0, now + 0.8);
}

/**
 * A footstep on wet cobblestone: a short filtered noise burst with a click of body
 * under it. Alternates slightly in pitch so a walk does not sound like a metronome.
 */
let stepParity = 0;
export function playFootstep(onCobbles = true) {
  if (!ctx) return;
  const now = ctx.currentTime;
  stepParity ^= 1;

  const src = ctx.createBufferSource();
  const len = Math.floor(ctx.sampleRate * 0.09);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    // A sharp attack decaying fast — the shape of a foot meeting stone.
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  src.buffer = buf;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  // Cobbles ring higher and tighter than grass does.
  filter.frequency.value = (onCobbles ? 1500 : 700) * (stepParity ? 1.12 : 0.9);
  filter.Q.value = onCobbles ? 1.6 : 0.9;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(onCobbles ? 0.11 : 0.075, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);

  src.connect(filter).connect(gain).connect(master);
  src.start(now);
  src.stop(now + 0.12);

  // A wet splat on top when walking through the rain-soaked stone.
  if (onCobbles && Math.random() > 0.72) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.03, now);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    osc.connect(og).connect(master);
    osc.start(now);
    osc.stop(now + 0.08);
  }
}

/** A soft wooden knock when a door's card opens. */
export function playDoorChime() {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [freq, delay, vol] of [[523.25, 0, 0.05], [659.25, 0.07, 0.04]]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now + delay);
    g.gain.linearRampToValueAtTime(vol, now + delay + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.45);
    osc.connect(g).connect(master);
    osc.start(now + delay);
    osc.stop(now + delay + 0.5);
  }
}

/** A brighter two-note figure when you actually enter a house. */
export function playEnter() {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [freq, delay] of [[587.33, 0], [880, 0.1]]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now + delay);
    g.gain.linearRampToValueAtTime(0.07, now + delay + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.5);
    osc.connect(g).connect(master);
    osc.start(now + delay);
    osc.stop(now + delay + 0.55);
  }
}

/** Tear the whole graph down when the mod's iframe goes away. */
export function disposeAudio() {
  if (!ctx) return;
  try {
    bed.rain?.src.stop();
    bed.rain?.lfo.stop();
    bed.pad?.voices.forEach((v) => v.osc.stop());
  } catch { /* already stopped */ }
  try { ctx.close(); } catch { /* nothing to close */ }
  ctx = null;
  master = null;
  started = false;
  bed.rain = null;
  bed.pad = null;
  bed.gain = null;
}

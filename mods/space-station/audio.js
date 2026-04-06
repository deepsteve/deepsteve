// ── Procedural audio ────────────────────────────────────────────────────────

let audioCtx = null;
let ambientStarted = false;

export function startAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

export function playBootClank() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 60;
  gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.1);
}

export function playJetpackIgnite() {
  if (!audioCtx) return;
  const bufSize = audioCtx.sampleRate * 0.2;
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'bandpass'; filter.frequency.value = 2000; filter.Q.value = 1.5;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
  src.connect(filter).connect(gain).connect(audioCtx.destination);
  src.start(); src.stop(audioCtx.currentTime + 0.2);
}

export function playDoorOpen() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  // Servo whine
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(200, t);
  osc.frequency.linearRampToValueAtTime(600, t + 0.3);
  gain.gain.setValueAtTime(0.04, t);
  gain.gain.linearRampToValueAtTime(0.02, t + 0.2);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(); osc.stop(t + 0.35);
  // Hiss
  const bufSize = audioCtx.sampleRate * 0.3;
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufSize) * 0.3;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 3000;
  const g2 = audioCtx.createGain(); g2.gain.value = 0.06;
  src.connect(hp).connect(g2).connect(audioCtx.destination);
  src.start(); src.stop(t + 0.3);
}

export function playAirlockCycle() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  // Mechanical grind
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = 50;
  gain.gain.setValueAtTime(0.06, t);
  gain.gain.linearRampToValueAtTime(0.03, t + 0.8);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(); osc.stop(t + 1.0);
  // Long hiss
  const bufSize = audioCtx.sampleRate * 1.5;
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 2000;
  const g2 = audioCtx.createGain(); g2.gain.value = 0.04;
  src.connect(hp).connect(g2).connect(audioCtx.destination);
  src.start(); src.stop(t + 1.5);
}

export function startAmbient() {
  if (ambientStarted || !audioCtx) return;
  ambientStarted = true;

  // Engine hum
  const hum = audioCtx.createOscillator();
  hum.type = 'sine'; hum.frequency.value = 80;
  const humGain = audioCtx.createGain(); humGain.gain.value = 0.02;
  hum.connect(humGain).connect(audioCtx.destination);
  hum.start();

  // Ventilation hiss
  const noise = audioCtx.createBufferSource();
  const noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 4, audioCtx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  noise.buffer = noiseBuf; noise.loop = true;
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 4000;
  const ng = audioCtx.createGain(); ng.gain.value = 0.008;
  noise.connect(hp).connect(ng).connect(audioCtx.destination);
  noise.start();

  // System chirps
  setInterval(() => {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 800 + Math.random() * 1200;
    g.gain.setValueAtTime(0.015, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.08);
  }, 4000 + Math.random() * 4000);
}

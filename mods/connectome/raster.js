// A spike raster over a population-rate plot, drawn on a canvas. Rows are grouped by role and
// ordered by first spike, so activity reads top-down.
//
//   drawRaster(canvas, { network, spikes, duration, stimulus, title, subtitle })
//     network   the network that produced the spikes: its circuit and synapse signs
//     spikes    { t, i } arrays, e.g. from record(network)
//     duration  ms along the x axis
//     stimulus  optional { from, to } in ms, shaded
//
// The page sizes the canvas with CSS; this only sets its pixel buffer to match.

const ROLES = ['upstream', 'both', 'seed', 'downstream', 'other'];
const ROLE_COLOR = { upstream: '#58a6ff', both: '#bc8cff', seed: '#ffd166', downstream: '#3fb950', other: '#8a96a6' };
const SIGN_COLOR = { 1: '#39c5b4', '-1': '#ff7a5c' };
const BG = '#0e1116';
const FONT = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';

export function drawRaster(canvas, { network, spikes, duration, stimulus = null, title = '', subtitle = '' }) {
  const { circuit, compiled } = network;
  const neurons = circuit.neurons;
  const N = neurons.length;
  const roleOf = n => (ROLES.includes(n.role) ? n.role : 'other');
  const count = Object.fromEntries(ROLES.map(r => [r, 0]));
  for (const n of neurons) count[roleOf(n)]++;
  const label = { upstream: 'upstream', both: 'up + down', seed: circuit.seedType ?? 'seed', downstream: 'downstream', other: 'neurons' };

  const box = canvas.getBoundingClientRect();
  const W = Math.max(480, box.width);
  const H = Math.max(360, box.height);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  if (!N) return;

  const L = 100, R = 18, T = 68, GAP = 40, PSTH = 120, B = 34;
  const rasterH = H - T - GAP - PSTH - B;
  const psthTop = T + rasterH + GAP;
  const x = t => L + (t / duration) * (W - L - R);

  // Rows: grouped by role, then by first spike so the cascade reads top-down; silent last.
  const first = new Float64Array(N).fill(Infinity);
  for (let k = spikes.t.length - 1; k >= 0; k--) if (spikes.i[k] < N) first[spikes.i[k]] = spikes.t[k];
  const order = neurons.map((_, i) => i).sort((a, b) =>
    ROLES.indexOf(roleOf(neurons[a])) - ROLES.indexOf(roleOf(neurons[b])) ||
    first[a] - first[b] || (neurons[a].bodyId ?? a) - (neurons[b].bodyId ?? b));

  // Seed neurons are a couple of rows among hundreds; give each up to 8px so they stay visible.
  const seeds = count.seed;
  let rowH = rasterH / N;
  let seedH = rowH;
  if (seeds && N > seeds && rowH < 8) {
    seedH = Math.min(8, (rasterH * 0.25) / seeds);
    rowH = (rasterH - seeds * seedH) / (N - seeds);
  }
  const top = new Float64Array(N);
  const height = new Float64Array(N);
  let y = T;
  for (const i of order) {
    top[i] = y;
    height[i] = roleOf(neurons[i]) === 'seed' ? seedH : rowH;
    y += height[i];
  }

  if (stimulus) {
    ctx.fillStyle = 'rgba(255, 209, 102, 0.07)';
    ctx.fillRect(x(stimulus.from), T, x(stimulus.to) - x(stimulus.from), rasterH);
    ctx.fillRect(x(stimulus.from), psthTop, x(stimulus.to) - x(stimulus.from), PSTH);
  }

  // Title, subtitle and legend.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e8edf3';
  ctx.font = `600 13px ${FONT}`;
  ctx.fillText(title, L, 18);
  ctx.fillStyle = '#8a96a6';
  ctx.font = `11px ${FONT}`;
  ctx.fillText(subtitle, L, 35);
  const seedNt = compiled.ntField ? neurons.find(n => n.role === 'seed')?.nt?.[compiled.ntField] : null;
  let lx = L;
  for (const [text, color] of [
    ['excitatory', SIGN_COLOR[1]],
    ['inhibitory', SIGN_COLOR['-1']],
    ...(seeds ? [[`${label.seed}${seedNt ? ` (${seedNt})` : ''}`, ROLE_COLOR.seed]] : []),
  ]) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, 45, 8, 8);
    ctx.fillStyle = '#c9d1d9';
    ctx.fillText(text, lx + 13, 53);
    lx += 13 + ctx.measureText(text).width + 18;
  }

  // Role bands: color bar, divider and label.
  ctx.textBaseline = 'middle';
  let k0 = 0;
  for (const role of ROLES) {
    const m = count[role];
    if (!m) continue;
    const y0 = top[order[k0]];
    const y1 = top[order[k0 + m - 1]] + height[order[k0 + m - 1]];
    if (k0) {
      ctx.strokeStyle = '#2b3442';
      ctx.beginPath();
      ctx.moveTo(L - 8, y0 + 0.5);
      ctx.lineTo(W - R, y0 + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = ROLE_COLOR[role];
    ctx.fillRect(L - 8, y0, 3, Math.max(1, y1 - y0));
    ctx.textAlign = 'right';
    ctx.fillStyle = '#c9d1d9';
    const mid = (y0 + y1) / 2;
    const roomy = y1 - y0 > 30;
    ctx.fillText(label[role], L - 14, roomy ? mid - 7 : mid);
    if (roomy) {
      ctx.fillStyle = '#7d8896';
      ctx.fillText(String(m), L - 14, mid + 7);
    }
    k0 += m;
  }

  // Spikes, one path per color.
  const markW = Math.max(1.3, ((W - L - R) / duration) * 0.5);
  const paths = { seed: new Path2D(), 1: new Path2D(), '-1': new Path2D() };
  for (let k = 0; k < spikes.t.length; k++) {
    const i = spikes.i[k];
    if (i >= N || spikes.t[k] > duration) continue;
    const path = roleOf(neurons[i]) === 'seed' ? paths.seed : paths[compiled.sign[i]];
    path.rect(x(spikes.t[k]) - markW / 2, top[i] + height[i] * 0.1, markW, Math.max(1, height[i] * 0.8));
  }
  for (const [key, color] of [[1, SIGN_COLOR[1]], ['-1', SIGN_COLOR['-1']], ['seed', ROLE_COLOR.seed]]) {
    ctx.fillStyle = color;
    ctx.fill(paths[key]);
  }

  // Population rate per role, 5 ms bins.
  const bin = 5;
  const bins = Math.ceil(duration / bin);
  const rates = Object.fromEntries(ROLES.map(r => [r, new Float64Array(bins)]));
  for (let k = 0; k < spikes.t.length; k++) {
    const b = Math.floor(spikes.t[k] / bin);
    if (spikes.i[k] < N && b < bins) rates[roleOf(neurons[spikes.i[k]])][b]++;
  }
  let peak = 1;
  for (const role of ROLES) {
    for (let b = 0; b < bins; b++) {
      rates[role][b] = count[role] ? rates[role][b] / count[role] / (bin / 1000) : 0;
      peak = Math.max(peak, rates[role][b]);
    }
  }
  const py = v => psthTop + PSTH - (v / peak) * PSTH;
  ctx.strokeStyle = '#2b3442';
  ctx.strokeRect(L + 0.5, psthTop + 0.5, W - L - R - 1, PSTH - 1);
  ctx.lineWidth = 1.5;
  for (const role of ROLES) {
    if (!count[role]) continue;
    ctx.strokeStyle = ROLE_COLOR[role];
    ctx.beginPath();
    for (let b = 0; b < bins; b++) {
      ctx.lineTo(x(b * bin), py(rates[role][b]));
      ctx.lineTo(x(Math.min(duration, (b + 1) * bin)), py(rates[role][b]));
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.fillStyle = '#7d8896';
  ctx.fillText(`${Math.round(peak)} Hz`, L - 14, psthTop + 6);
  ctx.fillText('0', L - 14, psthTop + PSTH - 4);
  ctx.fillStyle = '#c9d1d9';
  ctx.fillText('rate / neuron', L - 14, psthTop + PSTH / 2);

  // Time axis.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.strokeStyle = '#3a4554';
  const tick = duration > 1000 ? 250 : 50;
  for (let t = 0; t <= duration; t += tick) {
    ctx.beginPath();
    ctx.moveTo(x(t) + 0.5, T + rasterH);
    ctx.lineTo(x(t) + 0.5, T + rasterH + 4);
    ctx.moveTo(x(t) + 0.5, psthTop + PSTH);
    ctx.lineTo(x(t) + 0.5, psthTop + PSTH + 4);
    ctx.stroke();
    ctx.fillStyle = '#8a96a6';
    ctx.fillText(String(t), x(t), psthTop + PSTH + 7);
  }
  ctx.fillText('time (ms)', (L + W - R) / 2, H - 13);
}

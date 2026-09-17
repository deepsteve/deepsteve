// The fly's brain for the TikTok page: DNp01's circuit from the connectome as a spiking network,
// fed with how much each patch of the phone screen moves, deciding when to move on to the next
// video. No DOM, so tests drive it in Node (test/brain.test.mjs).
//
//   const brain = createBrain(circuitData, { gain: 30 });
//   const decision = brain.step(performance.now(), grid, { stillCounts: true, boredCounts: true });
//   if (decision) swipe(); // decision.reason: 'escape' (DNp01 fired), 'paused' (screen still) or
//                          // 'bored' (a video that kept moving without ever startling it)
//
// grid: motion per cell of a GRID_COLUMNS × GRID_ROWS grid over the screen, row by row from the
// top left, as the bridge sends it; null when there's no fresh frame, which counts as no motion.

import { selectCircuit, fitThreshold, group, createNetwork } from '../connectome/index.js';

export const GRID_COLUMNS = 6;
export const GRID_ROWS = 12;

export const DEFAULTS = Object.freeze({
  // mV of input per unit of motion. 30, measured on TikTok: the most-changed patch reaches the
  // visual neurons' firing threshold (about 8 mV) every few seconds, on cuts and fast motion.
  gain: 30,
  bias: 0,             // mV held on every visual neuron
  adapt: 2,            // s for a patch to get used to its own motion; 0 turns adaptation off
  need: 1,             // DNp01 spikes within escapeWindowMs that make an escape
  escapeWindowMs: 100,
  transitionMs: 1500,  // after moving on, the screen moves by itself; the fly doesn't look
  stillMotion: 0.002,  // no patch moving more than this: the screen is still
  stillMs: 4000,       // still this long: a paused video, so move on, once per stillness
  // On one video this long without an escape: move on anyway. Without it, a video that moves
  // steadily and gently (a talking head, a slow pan) is neither still nor startling, and holds the
  // fly forever; on 2026-09-16 one held it for over 80 s.
  boredMs: 20000,
});

// The neurons that see the screen: the looming-sensitive visual projection neurons that are
// DNp01's largest inputs.
const INPUT_TYPES = ['LPLC2', 'LC4'];

// Bands, for drawing: the neurons that see the screen, the other inputs, DNp01, its targets.
export const EYES = 0;
export const INPUTS = 1;
export const SEED = 2;
export const OUTPUTS = 3;

export function createBrain(data, settings = {}) {
  const circuit = selectCircuit(data, fitThreshold(data));
  const { neurons } = circuit;
  const N = neurons.length;
  const net = createNetwork(circuit);
  const inputs = group(circuit, n => n.role !== 'seed' && n.role !== 'downstream' && INPUT_TYPES.includes(n.type));
  const seeds = group(circuit, 'seed');
  const s = { ...DEFAULTS, ...settings };
  const cells = GRID_COLUMNS * GRID_ROWS;
  const cellOf = assignCells(neurons, inputs);

  const band = new Uint8Array(N);
  for (let i = 0; i < N; i++) band[i] = neurons[i].role === 'seed' ? SEED : neurons[i].role === 'downstream' ? OUTPUTS : INPUTS;
  for (const i of inputs) band[i] = EYES;
  const cellOfNeuron = new Int32Array(N).fill(-1);
  inputs.forEach((i, k) => { cellOfNeuron[i] = cellOf[k]; });
  const order = [...Array(N).keys()].sort((a, b) =>
    band[a] - band[b] || cellOfNeuron[a] - cellOfNeuron[b] ||
    (neurons[a].type ?? '').localeCompare(neurons[b].type ?? '') || neurons[a].bodyId - neurons[b].bodyId);

  const baseline = new Float64Array(cells); // each patch's recent motion
  const felt = new Float64Array(cells);     // motion the neurons respond to
  const still = new Float64Array(cells);
  const drives = new Float64Array(inputs.length);
  const seedTimes = [];
  let now = 0;
  let last = null;
  let wasLooking = false;   // the first step sets the level, like a new video
  let stillSince = null;
  let pausedSwipes = 0;     // moves on for a still screen since anything on it last moved
  let escaped = false;

  const brain = {
    circuit, net, neurons, inputs, seeds, cellOf, band, order, felt, settings: s,
    videos: 0,
    drive: 0,                   // mean input on the visual neurons, mV
    videoStart: 0,              // when the current video started, in step() time
    transitionUntil: -Infinity,
    swipesAt: [],               // network time of each move on, ms
    step,
  };

  net.onSpike((i, t) => {
    if (band[i] !== SEED) return;
    seedTimes.push(t);
    while (seedTimes[0] < t - s.escapeWindowMs) seedTimes.shift();
    if (seedTimes.length >= s.need && now >= brain.transitionUntil) {
      seedTimes.length = 0;
      escaped = true;
    }
  });

  // Advance to `time` (ms, any clock that only goes forward) seeing `grid`. Returns a decision to
  // move on, or null.
  function step(time, grid, { stillCounts = false, boredCounts = false } = {}) {
    if (last === null) brain.videoStart = time;
    const dt = last === null ? 0 : Math.min(50, Math.max(0, time - last));
    last = time;
    now = time;
    const g = grid ?? still;
    const looking = time >= brain.transitionUntil;

    // Adaptation: a patch responds to motion above its own recent level, so steady motion (a
    // spinning icon, a talking head) fades and changes stand out. Paused while the screen moves
    // by itself; when the next video appears, its first frame becomes the level.
    const alpha = s.adapt > 0 ? 1 - Math.exp(-dt / (s.adapt * 1000)) : 0;
    if (looking && !wasLooking) baseline.set(g);
    wasLooking = looking;
    let moving = false;
    for (let c = 0; c < cells; c++) {
      felt[c] = s.adapt > 0 ? Math.max(0, g[c] - baseline[c]) : g[c];
      if (looking) baseline[c] += alpha * (g[c] - baseline[c]);
      if (g[c] > s.stillMotion) moving = true;
    }

    let drive = 0;
    for (let k = 0; k < inputs.length; k++) {
      drives[k] = s.bias + (looking ? s.gain * felt[cellOf[k]] : 0);
      drive += drives[k] / inputs.length;
    }
    brain.drive = drive;
    net.setInput(inputs, drives);
    escaped = false;
    net.step(dt);
    if (escaped) return moveOn('escape');

    // A paused video: nothing on the screen has moved for a while. Once per stillness: if the
    // screen stays still after moving on, it isn't a paused video, and moving on won't help.
    if (moving) pausedSwipes = 0;
    if (!looking || moving || !stillCounts || pausedSwipes > 0) stillSince = null;
    else if (stillSince === null) stillSince = time;
    else if (time - stillSince > s.stillMs) {
      pausedSwipes++;
      return moveOn('paused');
    }

    // Bored: a video it has watched long enough. Not the circuit's decision, any more than a paused
    // video is. Not on a screen that stayed still after moving on, for the same reason as above.
    if (boredCounts && looking && pausedSwipes === 0 && time - brain.videoStart > s.boredMs) return moveOn('bored');
    return null;
  }

  function moveOn(reason) {
    brain.videos++;
    brain.swipesAt.push(net.t);
    brain.transitionUntil = now + s.transitionMs;
    brain.videoStart = now + s.transitionMs;
    stillSince = null;
    return { reason, t: now };
  }

  return brain;
}

// Each visual neuron watches one patch of the screen. LC4 and LPLC2 tile the fly's visual field,
// and a neuron in the left optic lobe (instance "…_L") looks at the left half. Which patch within
// a half is this module's choice, not the connectome's: neurons are dealt out in bodyId order.
function assignCells(neurons, inputs) {
  const half = GRID_COLUMNS / 2;
  const cellOf = new Int32Array(inputs.length);
  const bySide = [[], [], []]; // left, right, unknown
  inputs.forEach((i, k) => {
    const instance = neurons[i].instance ?? '';
    bySide[/_L$/.test(instance) ? 0 : /_R$/.test(instance) ? 1 : 2].push(k);
  });
  bySide.forEach((ks, side) => {
    const columns = side === 2 ? GRID_COLUMNS : half;
    const offset = side === 1 ? half : 0;
    ks.sort((a, b) => neurons[inputs[a]].bodyId - neurons[inputs[b]].bodyId).forEach((k, r) => {
      const cell = r % (columns * GRID_ROWS);
      cellOf[k] = Math.floor(cell / columns) * GRID_COLUMNS + offset + (cell % columns);
    });
  });
  return cellOf;
}

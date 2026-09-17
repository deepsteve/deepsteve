// A leaky integrate-and-fire network you keep stepping: the Brian2 fly model of Shiu et al.
// (2024), in plain JavaScript for browsers and Node.
//
//   dv/dt = (v0 − v + g + I) / tauM    (unless refractory)
//   dg/dt = −g / tauSyn                (unless refractory)
//   v > vTh → spike: v = vReset, g = 0, refractory for tRef.
//   A spike adds sign × synapses × wSyn to the g of each target, `delay` later.
//
// I is input held on a neuron, given as the voltage it holds the membrane at (R·I, in mV).

import { group } from './circuit.js';

// Shiu et al., default_params in model.py, in mV and ms. dt is Brian2's default time step.
export const PARAMS = Object.freeze({
  v0: -52, vReset: -52, vTh: -45, tauM: 20, tauSyn: 5, tRef: 2.2, delay: 1.8, wSyn: 0.275, dt: 0.1,
});

// Transmitters whose synapses are negative. Shiu et al.: "GABAergic and glutamatergic neurons
// are inhibitory"; dopamine, octopamine and serotonin count as excitatory. Everything else
// (acetylcholine, "unclear", a missing value) is excitatory too.
export const INHIBITORY = new Set(['gaba', 'glutamate']);

// The parts of a network that never change while it runs, so several networks (one per game
// agent, say) can share them. ntField picks the transmitter prediction that signs synapses:
// by default the circuit's first, null for all-excitatory.
export function compile(circuit, { ntField, params } = {}) {
  const P = Object.freeze({ ...PARAMS, ...params });
  if (P.tauSyn === P.tauM) throw new RangeError('tauSyn must differ from tauM');
  const field = ntField === undefined ? (circuit.ntFields?.[0] ?? null) : ntField;
  const { neurons, pre, post, weight } = circuit;
  const N = neurons.length;
  const sign = Int8Array.from(neurons, n => (field && INHIBITORY.has(n.nt?.[field]) ? -1 : 1));

  // Outgoing synapses grouped by presynaptic neuron, so a spike walks only its own.
  const start = new Int32Array(N + 1);
  for (const i of pre) start[i + 1]++;
  for (let i = 0; i < N; i++) start[i + 1] += start[i];
  const fill = start.slice(0, N);
  const target = new Int32Array(pre.length);
  const w = new Float64Array(pre.length);
  for (let k = 0; k < pre.length; k++) {
    const s = fill[pre[k]]++;
    target[s] = post[k];
    w[s] = sign[pre[k]] * weight[k] * P.wSyn;
  }

  const delaySteps = Math.round(P.delay / P.dt);
  if (delaySteps < 1) throw new RangeError('delay must be at least one time step');
  return Object.freeze({
    compiled: true, circuit, params: P, ntField: field, N, sign, start, target, weight: w,
    delaySteps, refSteps: Math.round(P.tRef / P.dt),
  });
}

// A network with its own state, from a circuit (compiled with `options`) or from compile().
// rateWindow is how far back rate() and rates() can look, in ms.
export function createNetwork(source, { rateWindow = 1000, ...options } = {}) {
  return new Network(source.compiled ? source : compile(source, options), rateWindow);
}

// Collect every spike from now on, e.g. for drawRaster(). stop() detaches.
export function record(net) {
  const t = [];
  const i = [];
  const stop = net.onSpike((index, time) => { i.push(index); t.push(time); });
  return { t, i, stop };
}

class Network {
  constructor(compiled, rateWindow) {
    const { N, params: P, delaySteps } = compiled;
    this.compiled = compiled;
    this.circuit = compiled.circuit;
    this.v = new Float64Array(N).fill(P.v0); // membrane potential, mV: read, don't write
    this.g = new Float64Array(N);            // synaptic conductance, mV
    this.input = new Float64Array(N);        // held input R·I, mV: write through setInput()
    this._refractoryUntil = new Float64Array(N);   // first step each neuron integrates again
    this._ring = new Float64Array(delaySteps * N); // slot s % delaySteps: conductance landing at step s
    this._spiking = new Int32Array(N);
    this._step = 0;
    this._carry = 0; // ms asked for that didn't fill a whole step yet
    this._rateWindow = rateWindow;
    this._log = new SpikeLog();
    this._listeners = new Set();
    // Both equations are linear, so Brian2 integrates them exactly. Over one step dt:
    //   g' = g·B    v' = vInf + (v − vInf)·A + g·C·(B − A)
    this._A = Math.exp(-P.dt / P.tauM);
    this._B = Math.exp(-P.dt / P.tauSyn);
    this._C = P.tauSyn / (P.tauSyn - P.tauM);
  }

  // Simulated time, ms.
  get t() {
    return this._step * this.compiled.params.dt;
  }

  // Hold input on neurons until changed: one value for all of them, or one per neuron.
  setInput(selector, mV) {
    const indices = indicesOf(this.circuit, selector);
    const each = typeof mV !== 'number';
    if (each && mV.length !== indices.length) {
      throw new RangeError(`setInput: ${mV.length} values for ${indices.length} neurons`);
    }
    for (let k = 0; k < indices.length; k++) this.input[indices[k]] = each ? mV[k] : mV;
    return this;
  }

  clearInputs() {
    this.input.fill(0);
    return this;
  }

  // Advance by ms. A fraction of a time step carries over, so 60 fps frames add up exactly.
  // Returns the number of spikes emitted.
  step(ms) {
    if (!(ms >= 0)) throw new RangeError(`step(${ms}): ms must be >= 0`);
    const { dt } = this.compiled.params;
    this._carry += ms;
    const steps = Math.floor(this._carry / dt + 1e-9);
    this._carry = Math.max(0, this._carry - steps * dt);
    let spikes = 0;
    for (let k = 0; k < steps; k++) spikes += this._advance();
    this._log.prune(this.t - this._rateWindow);
    return spikes;
  }

  // Mean firing rate, Hz per neuron, of a group over the trailing window.
  rate(selector, windowMs = 50) {
    const rates = this.rates(selector, windowMs);
    let sum = 0;
    for (const r of rates) sum += r;
    return rates.length ? sum / rates.length : 0;
  }

  // Firing rate of each neuron of a group over the trailing window, Hz, in selector order.
  rates(selector, windowMs = 50) {
    if (windowMs > this._rateWindow) {
      throw new RangeError(`window ${windowMs} ms is longer than this network's rateWindow (${this._rateWindow} ms)`);
    }
    const indices = indicesOf(this.circuit, selector);
    const out = new Float64Array(indices.length);
    const span = Math.min(windowMs, this.t);
    if (span <= 0 || indices.length === 0) return out;
    const slot = new Int32Array(this.compiled.N).fill(-1);
    for (let k = 0; k < indices.length; k++) slot[indices[k]] = k;
    this._log.forEachSince(this.t - windowMs, i => { if (slot[i] >= 0) out[slot[i]]++; });
    for (let k = 0; k < out.length; k++) out[k] *= 1000 / span;
    return out;
  }

  // Call fn(neuronIndex, tMs) for each spike, during step(). Returns an unsubscribe function.
  // Don't call step() from inside fn.
  onSpike(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // Back to t = 0: at rest, no conductance, no inputs, no spike history. Listeners stay.
  reset() {
    const { v0 } = this.compiled.params;
    this.v.fill(v0);
    this.g.fill(0);
    this.input.fill(0);
    this._refractoryUntil.fill(0);
    this._ring.fill(0);
    this._step = 0;
    this._carry = 0;
    this._log.clear();
    return this;
  }

  // One time step, in Brian2's order: state update, threshold, synaptic delivery, reset.
  _advance() {
    const c = this.compiled;
    const P = c.params;
    const N = c.N;
    const { v, g, input } = this;
    const refractoryUntil = this._refractoryUntil;
    const A = this._A, B = this._B, C = this._C;
    const s = this._step;

    for (let i = 0; i < N; i++) {
      if (s < refractoryUntil[i]) continue;
      const vInf = P.v0 + input[i];
      v[i] = vInf + (v[i] - vInf) * A + g[i] * C * (B - A);
      g[i] *= B;
    }

    const spiking = this._spiking;
    let count = 0;
    for (let i = 0; i < N; i++) if (s >= refractoryUntil[i] && v[i] > P.vTh) spiking[count++] = i;

    // Apply what lands now, then queue this step's spikes `delaySteps` ahead, which is the
    // same ring slot, just emptied.
    const ring = this._ring;
    const base = (s % c.delaySteps) * N;
    for (let i = 0; i < N; i++) {
      if (ring[base + i] !== 0) {
        g[i] += ring[base + i];
        ring[base + i] = 0;
      }
    }
    const t = s * P.dt;
    for (let k = 0; k < count; k++) {
      const i = spiking[k];
      for (let e = c.start[i]; e < c.start[i + 1]; e++) ring[base + c.target[e]] += c.weight[e];
      this._log.push(t, i);
      if (this._listeners.size) for (const fn of this._listeners) fn(i, t);
    }

    for (let k = 0; k < count; k++) {
      const i = spiking[k];
      v[i] = P.vReset;
      g[i] = 0;
      refractoryUntil[i] = s + c.refSteps;
    }
    this._step = s + 1;
    return count;
  }
}

function indicesOf(circuit, selector) {
  if (ArrayBuffer.isView(selector)) return selector;
  if (typeof selector === 'number') return [selector];
  if (Array.isArray(selector) && selector.every(x => typeof x === 'number')) return selector;
  return group(circuit, selector);
}

// Recent spikes as a growable ring buffer, oldest first.
class SpikeLog {
  constructor(capacity = 4096) {
    this.t = new Float64Array(capacity);
    this.i = new Int32Array(capacity);
    this.head = 0;
    this.size = 0;
  }

  push(t, i) {
    if (this.size === this.t.length) this._grow();
    const k = (this.head + this.size) % this.t.length;
    this.t[k] = t;
    this.i[k] = i;
    this.size++;
  }

  prune(before) {
    while (this.size && this.t[this.head] < before) {
      this.head = (this.head + 1) % this.t.length;
      this.size--;
    }
  }

  // Newest first, stopping at the first spike older than `since`.
  forEachSince(since, fn) {
    for (let k = this.size - 1; k >= 0; k--) {
      const j = (this.head + k) % this.t.length;
      if (this.t[j] < since) break;
      fn(this.i[j], this.t[j]);
    }
  }

  clear() {
    this.head = 0;
    this.size = 0;
  }

  _grow() {
    const capacity = this.t.length * 2;
    const t = new Float64Array(capacity);
    const i = new Int32Array(capacity);
    for (let k = 0; k < this.size; k++) {
      const j = (this.head + k) % this.t.length;
      t[k] = this.t[j];
      i[k] = this.i[j];
    }
    this.t = t;
    this.i = i;
    this.head = 0;
  }
}

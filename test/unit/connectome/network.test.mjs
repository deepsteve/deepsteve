import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PARAMS, compile, createNetwork, record } from '../../../mods/connectome/network.js';
import { fitThreshold, group, selectCircuit } from '../../../mods/connectome/circuit.js';

const P = PARAMS;
const data = JSON.parse(readFileSync(new URL('../../../mods/connectome/circuits/dnge104.json', import.meta.url), 'utf8'));
const fitted = () => selectCircuit(data, fitThreshold(data));

// A hand-built circuit; connections are [pre, post, synapses].
const tiny = (neurons, connections = []) => ({
  ntFields: ['predictedNt'],
  neurons,
  pre: connections.map(c => c[0]),
  post: connections.map(c => c[1]),
  weight: connections.map(c => c[2]),
});

// Time from rest to threshold under held input I: tauM·ln(I / (I − (vTh − v0))).
const climb = I => P.tauM * Math.log(I / (I - (P.vTh - P.v0)));

test('a driven neuron fires on the analytic schedule, quantized to the time step', () => {
  const net = createNetwork(tiny([{ role: 'upstream', nt: {} }]));
  const spikes = record(net);
  net.step(50);
  net.setInput([0], 10).step(200);
  net.setInput([0], 0).step(150);

  // A spike is stamped on the step whose update crosses threshold, and refractoriness holds
  // for tRef, so: first spike C − 1 steps after the input starts, then every R + C − 1.
  const C = Math.ceil(climb(10) / P.dt);
  const R = Math.round(P.tRef / P.dt);
  const expected = [];
  for (let s = Math.round(50 / P.dt) + C - 1; s < Math.round(250 / P.dt); s += R + C - 1) expected.push(s * P.dt);
  assert.equal(spikes.t.length, expected.length);
  spikes.t.forEach((t, k) => assert.ok(Math.abs(t - expected[k]) < 1e-6, `spike ${k}: ${t} vs ${expected[k]}`));
  assert.ok(Math.abs(spikes.t[1] - spikes.t[0] - (climb(10) + P.tRef)) < 2 * P.dt, 'far from the continuous-time interval');
});

test('one presynaptic spike fires its target only past the analytic threshold, after the delay, and never through an inhibitory synapse', () => {
  // Peak of the PSP from conductance g0 is g0·(e^(−t*/tauM) − e^(−t*/tauSyn))·tauSyn/(tauM − tauSyn).
  const tStar = Math.log(P.tauM / P.tauSyn) * P.tauM * P.tauSyn / (P.tauM - P.tauSyn);
  const peakPerMv = (Math.exp(-tStar / P.tauM) - Math.exp(-tStar / P.tauSyn)) * P.tauSyn / (P.tauM - P.tauSyn);
  const threshold = (P.vTh - P.v0) / peakPerMv / P.wSyn;
  assert.ok(Math.abs(threshold - 161.6) < 0.1, `threshold ${threshold}`);

  const run = (synapses, nt) => {
    const net = createNetwork(tiny(
      [{ role: 'upstream', nt: { predictedNt: nt } }, { role: 'downstream', nt: {} }],
      [[0, 1, synapses]],
    ));
    const spikes = record(net);
    net.setInput([0], 10).step(climb(10) + 0.5); // long enough for exactly one spike
    net.setInput([0], 0).step(100);
    return spikes;
  };
  const firesOfB = spikes => spikes.i.filter(i => i === 1).length;

  assert.equal(firesOfB(run(Math.floor(threshold * 0.97), 'acetylcholine')), 0);
  const above = run(Math.ceil(threshold * 1.03), 'acetylcholine');
  assert.equal(firesOfB(above), 1);
  assert.deepEqual(above.i, [0, 1]);
  assert.ok(above.t[1] - above.t[0] > P.delay, 'target fired before the synaptic delay');
  assert.equal(firesOfB(run(10 * Math.ceil(threshold), 'gaba')), 0);
});

test('the spike train does not depend on how step() is sliced', () => {
  const circuit = fitted();
  const compiled = compile(circuit);
  const inputs = group(circuit, ['upstream', 'both']);
  const trains = [
    net => net.step(400),
    net => { for (let k = 0; k < 400; k++) net.step(1); },
    net => { for (let k = 0; k < 24; k++) net.step(1000 / 60); },
  ].map(slice => {
    const net = createNetwork(compiled).setInput(inputs, 10);
    const spikes = record(net);
    slice(net);
    assert.ok(Math.abs(net.t - 400) < 1e-9, `t = ${net.t}`);
    return spikes;
  });
  assert.ok(trains[0].t.length > 1000, `only ${trains[0].t.length} spikes`);
  for (const other of trains.slice(1)) {
    assert.deepEqual(other.i, trains[0].i);
    assert.deepEqual(other.t, trains[0].t);
  }
});

test('networks sharing one compiled circuit keep separate state', () => {
  const circuit = fitted();
  const compiled = compile(circuit);
  const inputs = group(circuit, ['upstream', 'both']);

  const solo = createNetwork(compiled).setInput(inputs, 10);
  const soloSpikes = record(solo);
  solo.step(100);

  const a = createNetwork(compiled).setInput(inputs, 10);
  const b = createNetwork(compiled);
  const aSpikes = record(a);
  const bSpikes = record(b);
  for (let k = 0; k < 100; k++) {
    a.step(1);
    b.step(1);
  }
  assert.equal(bSpikes.t.length, 0);
  assert.deepEqual(aSpikes.t, soloSpikes.t);
  assert.deepEqual(aSpikes.i, soloSpikes.i);
});

test('reset() returns to t = 0 and replays the same run', () => {
  const circuit = fitted();
  const inputs = group(circuit, ['upstream', 'both']);
  const net = createNetwork(circuit);
  const first = record(net);
  net.setInput(inputs, 10).step(100);
  first.stop();

  net.reset();
  assert.equal(net.t, 0);
  assert.equal(net.rate(inputs, 50), 0);
  const second = record(net);
  net.setInput(inputs, 10).step(100);
  assert.deepEqual(second.t, first.t);
  assert.deepEqual(second.i, first.i);
});

test('rate() counts spikes in the trailing window and refuses windows past rateWindow', () => {
  const net = createNetwork(tiny([{ role: 'upstream', nt: {} }]), { rateWindow: 300 });
  net.setInput([0], 10).step(200);
  assert.ok(Math.abs(net.rate([0], 200) - 7 / 0.2) < 1e-9, `rate ${net.rate([0], 200)}`);
  assert.ok(Math.abs(net.rates([0], 200)[0] - 35) < 1e-9);
  net.setInput([0], 0).step(100);
  assert.equal(net.rate([0], 50), 0);
  assert.throws(() => net.rate([0], 301), RangeError);
});

test('setInput takes one value or one per neuron, and onSpike unsubscribes', () => {
  const net = createNetwork(tiny([{ role: 'upstream', nt: {} }, { role: 'upstream', nt: {} }]));
  net.setInput([0, 1], [10, 0]);
  assert.deepEqual([...net.input], [10, 0]);
  assert.throws(() => net.setInput([0, 1], [10]), RangeError);

  let calls = 0;
  const off = net.onSpike(() => calls++);
  net.step(100);
  const seen = calls;
  assert.ok(seen > 0);
  off();
  net.step(100);
  assert.equal(calls, seen);
});

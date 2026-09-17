import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrain } from '../../../mods/fly-tiktok/brain.js';
import { layoutCns, fromThorax, BRAIN, CORD, CM_PER_UM } from '../../../mods/fly-tiktok/cns.js';

const data = JSON.parse(readFileSync(new URL('../../../mods/connectome/circuits/dnp01.json', import.meta.url), 'utf8'));
const fly = JSON.parse(readFileSync(new URL('../../../mods/fly-tiktok/fly.json', import.meta.url), 'utf8'));
const brain = createBrain(data);
const cns = layoutCns(brain.circuit, fly);
const { neurons } = brain.circuit;
const N = neurons.length;
const at = (array, i) => [array[i * 3], array[i * 3 + 1], array[i * 3 + 2]];
const indexOf = instance => neurons.findIndex(n => n.instance === instance);

test("the dataset's axes are the ones the layout assumes, judged by anatomy: x to the fly's left, y ventral, z posterior", () => {
  const right = neurons[indexOf('DNp01(GF)_R')].soma;
  const left = neurons[indexOf('DNp01(GF)_L')].soma;
  assert.ok(right[0] < left[0], 'DNp01(GF)_R should have the lower x');

  // All the file's neurons, not just the circuit's, for enough of each kind.
  const meanOf = (types, k) => {
    const members = data.neurons.filter(n => n.soma && types.test(n.type ?? ''));
    assert.ok(members.length >= 5, `too few ${types} to judge by`);
    return members.reduce((s, n) => s + n.soma[k], 0) / members.length;
  };
  assert.ok(meanOf(/^(SMP|SLP|SIP)/, 1) < meanOf(/^(GNG|SAD|PRW)/, 1), 'superior neuropils should be dorsal of gnathal ones: lower y');
  assert.ok(meanOf(/^AVLP/, 2) < meanOf(/^PVLP/, 2), 'AVLP should be anterior of PVLP: lower z');
  assert.ok(meanOf(/^AVLP/, 2) < meanOf(/^(LC|LPLC)\d/, 2), 'AVLP should be anterior of the lobula projection neurons');
});

test('every neuron has a position, and those with a soma are exactly at it', () => {
  assert.equal(cns.positions.length, N * 3);
  assert.ok(cns.positions.every(Number.isFinite));
  const nm = data.source.voxelSize[0];
  let withSoma = 0;
  neurons.forEach((n, i) => {
    if (!n.soma) {
      assert.equal(cns.placed[i], 1);
      return;
    }
    withSoma++;
    assert.equal(cns.placed[i], 0);
    assert.deepEqual(at(cns.um, i), n.soma.map(v => (v * nm) / 1000));
  });
  assert.ok(withSoma / N > 0.95, `${withSoma} of ${N} have a soma`);
  // Real somas keep their distances, in cm.
  const [a, b] = [indexOf('DNp01(GF)_R'), indexOf('DNp01(GF)_L')];
  const umApart = Math.hypot(...at(cns.um, a).map((v, k) => v - at(cns.um, b)[k]));
  const cmApart = Math.hypot(...at(cns.positions, a).map((v, k) => v - at(cns.positions, b)[k]));
  assert.ok(Math.abs(cmApart - umApart * CM_PER_UM) < 1e-7);
});

test("in the fly, the giant fibres are on their own sides and the brain fits inside the head's cuticle", () => {
  assert.ok(cns.positions[indexOf('DNp01(GF)_R') * 3 + 1] < 0, "the fly's right is -y");
  assert.ok(cns.positions[indexOf('DNp01(GF)_L') * 3 + 1] > 0);

  const head = fly.bodies.findIndex(b => b.name === 'head');
  const bounds = (body, material) => {
    const parts = fly.parts.filter(p => p.body === body && p.material === material);
    return [0, 1, 2].map(k => [Math.min(...parts.map(p => p.min[k])), Math.max(...parts.map(p => p.max[k]))]);
  };
  const within = (point, box) => point.every((v, k) => v >= box[k][0] && v <= box[k][1]);
  const cuticle = bounds(head, 'body');
  const thorax = bounds(0, 'body');
  for (let i = 0; i < N; i++) {
    if (cns.region[i] === BRAIN) assert.ok(within(fromThorax(fly, head, at(cns.positions, i)), cuticle), `${neurons[i].instance} is outside the head`);
    else assert.ok(within(at(cns.positions, i), thorax), `${neurons[i].instance} is outside the thorax`);
  }
  assert.ok(neurons.some((n, i) => cns.region[i] === CORD && n.role === 'downstream'), "DNp01's outputs are in the nerve cord");
});

test('the shell is closed, faces outward, and holds every neuron', () => {
  const { positions, normals, indices } = cns.shell;
  assert.ok(indices.length > 3000);
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    for (const [a, b] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]) {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  assert.ok([...edges.values()].every(c => c === 2), 'every edge should join exactly two faces');

  let volume = 0;
  let outward = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(v => at(positions, v));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const u = b.map((v, k) => v - a[k]);
    const w = c.map((v, k) => v - a[k]);
    const face = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const normal = [indices[t], indices[t + 1], indices[t + 2]].map(v => at(normals, v)).reduce((s, n) => s.map((x, k) => x + n[k]));
    if (face[0] * normal[0] + face[1] * normal[1] + face[2] * normal[2] > 0) outward++;
  }
  assert.ok(volume > 0);
  assert.equal(outward, indices.length / 3);

  for (let i = 0; i < N; i++) {
    assert.ok(cns.fieldAt(...at(cns.um, i)) < 0, `${neurons[i].instance} is outside the shell`);
  }
});

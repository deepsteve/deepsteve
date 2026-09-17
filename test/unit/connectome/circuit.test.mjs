import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_NEURONS, fitThreshold, group, selectCircuit } from '../../../mods/connectome/circuit.js';

const data = JSON.parse(readFileSync(new URL('../../../mods/connectome/circuits/dnge104.json', import.meta.url), 'utf8'));

test('the circuit file is consistent with its own header', () => {
  assert.equal(data.format, 1);
  assert.equal(data.seedType, 'DNge104');
  assert.equal(data.neurons.filter(n => n.type === data.seedType).length, 2);
  assert.equal(data.edges.length % 3, 0);
  assert.equal(data.source.neurons, data.neurons.length);
  assert.equal(data.source.connections, data.edges.length / 3);
  let synapses = 0;
  for (let k = 2; k < data.edges.length; k += 3) {
    assert.ok(data.edges[k] >= data.minWeight);
    synapses += data.edges[k];
  }
  assert.equal(data.source.synapses, synapses);
});

test('selectCircuit shrinks as the threshold rises and keeps its roles consistent', () => {
  let previous = Infinity;
  for (const w of [5, 8, 12, 16, 25, 40]) {
    const c = selectCircuit(data, w);
    assert.ok(c.neurons.length <= previous, `grew at ${w}`);
    previous = c.neurons.length;
    assert.equal(Object.values(c.roles).reduce((a, b) => a + b, 0), c.neurons.length);
    assert.equal(c.roles.seed, 2);
    assert.ok(c.weight.every(x => x >= w));
    assert.equal(c.synapses, c.weight.reduce((a, b) => a + b, 0));
    assert.ok(c.pre.every(i => i < c.neurons.length) && c.post.every(i => i < c.neurons.length));
  }
  assert.throws(() => selectCircuit(data, data.minWeight - 1), RangeError);
});

test('fitThreshold returns the smallest threshold within the budget', () => {
  const w = fitThreshold(data, MAX_NEURONS);
  assert.ok(selectCircuit(data, w).neurons.length <= MAX_NEURONS);
  if (w > data.minWeight) assert.ok(selectCircuit(data, w - 1).neurons.length > MAX_NEURONS);
});

test('group selects by role, by field or by predicate', () => {
  const c = selectCircuit(data, fitThreshold(data));
  assert.equal(group(c, 'seed').length, 2);
  assert.deepEqual([...group(c, { type: 'DNge104' })], [...group(c, 'seed')]);
  assert.equal(group(c, ['upstream', 'both']).length, c.roles.upstream + c.roles.both);
  assert.equal(group(c, n => n.role === 'downstream').length, c.roles.downstream);
  assert.throws(() => group(c, 'upstreem'), /unknown role/);
});

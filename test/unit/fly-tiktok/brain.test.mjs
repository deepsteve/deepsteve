import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrain, GRID_COLUMNS, GRID_ROWS, EYES, SEED } from '../../../mods/fly-tiktok/brain.js';

const data = JSON.parse(readFileSync(new URL('../../../mods/connectome/circuits/dnp01.json', import.meta.url), 'utf8'));
const CELLS = GRID_COLUMNS * GRID_ROWS;

// Step a brain at 60 frames a second from `from` for `ms` with one grid; the decisions it made.
function run(brain, from, ms, grid, options) {
  const decisions = [];
  for (let t = from; t < from + ms; t += 1000 / 60) {
    const decision = brain.step(t, grid, options);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

const zeros = () => new Float64Array(CELLS);
function burst() {
  const grid = zeros();
  for (const cell of [30, 31, 36, 37]) grid[cell] = 0.5; // four patches in the left half
  return grid;
}

test('the visual neurons are LC4 and LPLC2, each watching a patch in its own half of the screen', () => {
  const brain = createBrain(data);
  assert.ok(brain.inputs.length > 200);
  brain.inputs.forEach((i, k) => {
    const n = brain.neurons[i];
    assert.ok(['LC4', 'LPLC2'].includes(n.type));
    assert.equal(brain.band[i], EYES);
    const column = brain.cellOf[k] % GRID_COLUMNS;
    if (n.instance.endsWith('_L')) assert.ok(column < GRID_COLUMNS / 2, `${n.instance} looks right`);
    if (n.instance.endsWith('_R')) assert.ok(column >= GRID_COLUMNS / 2, `${n.instance} looks left`);
  });
  assert.equal(brain.seeds.length, 2);
  for (const i of brain.seeds) assert.equal(brain.band[i], SEED);
});

test('sudden motion in a few patches makes DNp01 fire and the fly escape within a fraction of a second', () => {
  const brain = createBrain(data);
  assert.deepEqual(run(brain, 0, 1000, zeros()), []);
  const decisions = run(brain, 1000, 1000, burst());
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].reason, 'escape');
  assert.ok(decisions[0].t < 1300, `escaped at ${decisions[0].t} ms`);
  assert.equal(brain.videos, 1);
});

test('nothing moves it on while the screen moves by itself after a swipe, and the next video starts fresh', () => {
  const brain = createBrain(data);
  run(brain, 0, 1000, zeros());
  const [escape] = run(brain, 1000, 300, burst());
  assert.equal(escape.reason, 'escape');
  // The same burst carries on through the transition and after it: after it, it is the new
  // video's level, not a change.
  assert.deepEqual(run(brain, 1300, 3000, burst()), []);
});

test('steady motion fades: a screen moving the same way everywhere never makes it escape', () => {
  const brain = createBrain(data);
  const steady = new Float64Array(CELLS).fill(0.05);
  assert.deepEqual(run(brain, 0, 10000, steady, { stillCounts: true }), []);
});

test('a video that keeps moving but never startles it is left after 20 s, only when told boredom counts', () => {
  const steady = new Float64Array(CELLS).fill(0.05); // moving, so never still; steady, so it adapts away
  assert.deepEqual(run(createBrain(data), 0, 30000, steady, { stillCounts: true }), []);

  const brain = createBrain(data);
  const first = run(brain, 0, 25000, steady, { stillCounts: true, boredCounts: true });
  assert.deepEqual(first.map(d => d.reason), ['bored']);
  assert.ok(first[0].t > 20000 && first[0].t < 20100, `bored at ${first[0].t} ms`);
  // The next video gets its own 20 s, from when it appears after the swipe.
  const second = run(brain, 25000, 20000, steady, { stillCounts: true, boredCounts: true });
  assert.deepEqual(second.map(d => d.reason), ['bored']);
  const due = first[0].t + brain.settings.transitionMs + 20000;
  assert.ok(second[0].t > due && second[0].t < due + 100, `bored again at ${second[0].t} ms, due ${due}`);
});

test('a screen that stays still after moving on is not swiped again out of boredom', () => {
  const brain = createBrain(data);
  const decisions = run(brain, 0, 60000, null, { stillCounts: true, boredCounts: true });
  assert.deepEqual(decisions.map(d => d.reason), ['paused']);
});

test('a still screen moves on once, only when told stillness counts, and not again until something moves', () => {
  const quiet = createBrain(data);
  assert.deepEqual(run(quiet, 0, 12000, null), []);

  const brain = createBrain(data);
  const decisions = run(brain, 0, 12000, null, { stillCounts: true });
  assert.deepEqual(decisions.map(d => d.reason), ['paused']);
  assert.ok(decisions[0].t > 4000 && decisions[0].t < 4200, `moved on at ${decisions[0].t} ms`);
  // Motion, then stillness again: one more.
  run(brain, 12000, 500, new Float64Array(CELLS).fill(0.01), { stillCounts: true });
  assert.deepEqual(run(brain, 12500, 6000, null, { stillCounts: true }).map(d => d.reason), ['paused']);
});

// Unit tests for power-assertion.js (#563): the caffeinate child lifecycle,
// driven with a fake spawn — no real processes.
//
// Run: node --test test/unit/power-assertion.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createPowerAssertion } = require('../../power-assertion.js');

function makeAssertion({ platform = 'darwin', wanted = () => true } = {}) {
  const spawns = [];
  const fakeSpawn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.pid = 4000 + spawns.length;
    c.killed = [];
    c.kill = (sig) => c.killed.push(sig);
    spawns.push({ cmd, args, opts, child: c });
    return c;
  };
  const logs = [];
  const pa = createPowerAssertion({
    spawn: fakeSpawn,
    platform,
    pid: 1234,
    isWanted: wanted,
    log: (m) => logs.push(m),
  });
  return { pa, spawns, logs };
}

test('spawns caffeinate -i -w <pid> when wanted', () => {
  const { pa, spawns } = makeAssertion();
  pa.sync();
  assert.strictEqual(spawns.length, 1);
  assert.strictEqual(spawns[0].cmd, 'caffeinate');
  assert.deepStrictEqual(spawns[0].args, ['-i', '-w', '1234']);
  assert.deepStrictEqual(spawns[0].opts, { stdio: 'ignore' });
  assert.strictEqual(pa.isHolding(), true);
});

test('sync is idempotent while holding', () => {
  const { pa, spawns } = makeAssertion();
  pa.sync();
  pa.sync();
  pa.sync();
  assert.strictEqual(spawns.length, 1);
});

test('no-op on non-darwin platforms', () => {
  const { pa, spawns } = makeAssertion({ platform: 'linux' });
  pa.sync();
  assert.strictEqual(spawns.length, 0);
  assert.strictEqual(pa.isHolding(), false);
});

test('releases with SIGTERM when no longer wanted', () => {
  let wanted = true;
  const { pa, spawns } = makeAssertion({ wanted: () => wanted });
  pa.sync();
  wanted = false;
  pa.sync();
  assert.deepStrictEqual(spawns[0].child.killed, ['SIGTERM']);
  assert.strictEqual(pa.isHolding(), false);
});

test('deliberate release does not log an unexpected-exit line', () => {
  let wanted = true;
  const { pa, spawns, logs } = makeAssertion({ wanted: () => wanted });
  pa.sync();
  wanted = false;
  pa.sync();
  spawns[0].child.emit('exit', null, 'SIGTERM'); // the kill we sent lands
  assert.ok(!logs.some((l) => l.includes('caffeinate exited')));
});

test('respawns after an unexpected child exit', () => {
  const { pa, spawns, logs } = makeAssertion();
  pa.sync();
  spawns[0].child.emit('exit', 1, null);
  assert.strictEqual(pa.isHolding(), false);
  assert.ok(logs.some((l) => l.includes('caffeinate exited')));
  pa.sync();
  assert.strictEqual(spawns.length, 2);
  assert.strictEqual(pa.isHolding(), true);
});

test('spawn error latches — no retry spam while continuously wanted', () => {
  const { pa, spawns, logs } = makeAssertion();
  pa.sync();
  spawns[0].child.emit('error', new Error('spawn caffeinate ENOENT'));
  assert.strictEqual(pa.isHolding(), false);
  pa.sync();
  pa.sync();
  assert.strictEqual(spawns.length, 1); // latched
  assert.strictEqual(logs.filter((l) => l.includes('ENOENT')).length, 1);
});

test('latch re-arms on the next false→true want transition', () => {
  let wanted = true;
  const { pa, spawns } = makeAssertion({ wanted: () => wanted });
  pa.sync();
  spawns[0].child.emit('error', new Error('ENOENT'));
  pa.sync();
  assert.strictEqual(spawns.length, 1);
  wanted = false;
  pa.sync();
  wanted = true;
  pa.sync();
  assert.strictEqual(spawns.length, 2); // one retry per want-cycle
});

test('dispose kills the child and blocks future syncs', () => {
  const { pa, spawns } = makeAssertion();
  pa.sync();
  pa.dispose();
  assert.deepStrictEqual(spawns[0].child.killed, ['SIGTERM']);
  pa.sync();
  assert.strictEqual(spawns.length, 1);
  assert.strictEqual(pa.isHolding(), false);
});

test('synchronous spawn throw is caught and latched', () => {
  const logs = [];
  const pa = createPowerAssertion({
    spawn: () => { throw new Error('EAGAIN'); },
    platform: 'darwin',
    pid: 1,
    isWanted: () => true,
    log: (m) => logs.push(m),
  });
  assert.doesNotThrow(() => pa.sync());
  pa.sync();
  assert.strictEqual(logs.filter((l) => l.includes('EAGAIN')).length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskClock, formatDuration, whyNotCounting } from '../../../mods/fly-tiktok/phone/task-clock.mjs';

const working = { armed: true, device: { name: 'phone' }, wda: true, locked: false, pages: 1, visiblePages: 1 };

test('it counts only while switched on, on the cable, unlocked, driven, and with the page open and visible', () => {
  assert.equal(whyNotCounting(working), null);
  assert.equal(whyNotCounting({ ...working, armed: false }), 'switched off');
  assert.equal(whyNotCounting({ ...working, device: null }), 'no phone on the cable');
  assert.equal(whyNotCounting({ ...working, wda: false }), 'WebDriverAgent not running');
  assert.equal(whyNotCounting({ ...working, locked: true }), 'phone locked');
  assert.equal(whyNotCounting({ ...working, locked: null }), 'phone lock unknown');
  assert.equal(whyNotCounting({ ...working, pages: 0 }), 'page not open');
  assert.equal(whyNotCounting({ ...working, visiblePages: 0 }), 'page hidden');
});

test('time adds up over the stretches the fly was working, and carries on from a saved total', () => {
  let t = 0;
  const clock = createTaskClock({ seconds: 100, now: () => t });
  clock.tick(working);
  t = 1000; clock.tick(working);
  t = 2000; clock.tick({ ...working, locked: true }); // the second before this was working
  t = 3000; clock.tick(working); // this one wasn't
  t = 4000;
  const { seconds, counting, reason } = clock.tick(working);
  assert.equal(seconds, 103);
  assert.equal(counting, true);
  assert.equal(reason, null);
});

test('a long gap between ticks, the Mac asleep, counts for no more than a few seconds', () => {
  let t = 0;
  const clock = createTaskClock({ now: () => t });
  clock.tick(working);
  t = 3_600_000;
  assert.equal(clock.tick(working).seconds, 5);
});

test('reset starts over, and durations read as hh:mm:ss past a day', () => {
  let t = 0;
  const clock = createTaskClock({ seconds: 42, now: () => t });
  assert.equal(clock.reset().seconds, 0);
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(3723.9), '01:02:03');
  assert.equal(formatDuration(100 * 3600 + 5), '100:00:05');
});

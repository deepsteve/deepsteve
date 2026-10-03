// Unit tests for the timecard's pure half (#666).
//
// Everything that decides what the card SAYS lives here, so this suite is the whole
// correctness surface: what one sample concludes, how samples become hours, and the
// arithmetic behind the three stats. Four of these guard failures that would look
// entirely plausible on screen:
//
//   * a laptop shut overnight crediting the whole gap as work;
//   * an unattended 3am agent run counting as a human being present;
//   * an average over seven days when only five had hours, which quietly understates
//     every week that contains a day off;
//   * a bucket holding more hours than it is long, which makes "Longest block" report
//     4.5 for a two-hour block.
//
// Pure fs + require, no server boot and no shell, so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/timecard-store.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createTimecardStore,
  resolveAnchor,
  decideSample,
  buildViews,
  seedViews,
  normalizeInterval,
  STAT_LABELS,
  SEED_VALUES,
  DEFAULT_INTERVAL_MIN,
} = require('../../timecard-store.js');

const MIN = 60 * 1000;

function tmpFile(name = 'timecard.jsonl') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-timecard-')), name);
}

/** `count` active samples of `intervalMin` minutes each, ending at `endTs`. */
function activeRun(endTs, count, intervalMin = 5) {
  const out = [];
  for (let i = count; i >= 1; i--) {
    out.push({ t: endTs - (i - 1) * intervalMin * MIN, a: 1, m: intervalMin, s: 1 });
  }
  return out;
}

// ------------------------------------------------------------------ the interval

test('the sample interval is coerced to one the sampler supports', () => {
  assert.strictEqual(normalizeInterval(1), 1);
  assert.strictEqual(normalizeInterval(5), 5);
  assert.strictEqual(normalizeInterval(15), 15);
  assert.strictEqual(normalizeInterval('5'), 5, 'a select posts a string');
  for (const bad of [0, 3, 60, -5, NaN, null, undefined, 'nope']) {
    assert.strictEqual(normalizeInterval(bad), DEFAULT_INTERVAL_MIN, `${bad} should fall back`);
  }
});

// ------------------------------------------------------------------ decideSample

test('nothing fires until a full interval has passed', () => {
  const now = Date.now();
  assert.strictEqual(
    decideSample({ now, lastSampleAt: now - 4 * MIN, intervalMin: 5 }).fire, false,
  );
  assert.strictEqual(
    decideSample({ now, lastSampleAt: now - 5 * MIN, intervalMin: 5 }).fire, true,
  );
});

test('typing anywhere in Deep Steve makes the sample active', () => {
  const now = Date.now();
  const lastSampleAt = now - 5 * MIN;
  const d = decideSample({
    now, lastSampleAt, intervalMin: 5,
    windows: [{ focused: false, lastSeenAt: now - 1000, lastInteractionAt: now - 2 * MIN }],
    sessions: [],
  });
  assert.strictEqual(d.active, true);
  assert.strictEqual(d.minutes, 5);
});

test('watching a run counts, but only from a focused window', () => {
  const now = Date.now();
  const lastSampleAt = now - 5 * MIN;
  const sessions = [{ lastActivity: now - 30 * 1000 }];

  const watching = decideSample({
    now, lastSampleAt, intervalMin: 5,
    windows: [{ focused: true, lastSeenAt: now - 10 * 1000, lastInteractionAt: 0 }],
    sessions,
  });
  assert.strictEqual(watching.active, true, 'focused window + a session producing output');

  const blurred = decideSample({
    now, lastSampleAt, intervalMin: 5,
    windows: [{ focused: false, lastSeenAt: now - 10 * 1000, lastInteractionAt: 0 }],
    sessions,
  });
  assert.strictEqual(blurred.active, false, 'an unfocused window is not someone watching');
});

test('a tab left open overnight scores nothing', () => {
  const now = Date.now();
  const lastSampleAt = now - 5 * MIN;
  // The window is still "focused" as far as its last report goes, but that report is
  // stale — the browser stopped beaconing hours ago — and no session moved.
  const d = decideSample({
    now, lastSampleAt, intervalMin: 5,
    windows: [{ focused: true, lastSeenAt: now - 6 * 60 * MIN, lastInteractionAt: now - 8 * 60 * MIN }],
    sessions: [{ lastActivity: now - 7 * 60 * MIN }],
  });
  assert.strictEqual(d.active, false);
});

test('an unattended overnight agent run is not a human being present', () => {
  const now = Date.now();
  const lastSampleAt = now - 5 * MIN;
  const d = decideSample({
    now, lastSampleAt, intervalMin: 5,
    windows: [],                                  // nobody has a browser open
    sessions: [{ lastActivity: now - 1000 }],     // but an agent is grinding away
  });
  assert.strictEqual(d.active, false);
});

test('a gap the daemon slept through credits one interval at most, and counts as idle', () => {
  const now = Date.now();
  const lastSampleAt = now - 8 * 60 * MIN; // laptop shut for eight hours
  const d = decideSample({
    now, lastSampleAt, intervalMin: 5,
    windows: [{ focused: true, lastSeenAt: now - 1000, lastInteractionAt: now - 1000 }],
    sessions: [{ lastActivity: now - 1000 }],
  });
  assert.strictEqual(d.fire, true);
  assert.ok(d.minutes <= 5, `credited ${d.minutes}m for an 8h freeze`);
  assert.strictEqual(d.active, false, 'we have no evidence about time we were not running');
});

test('a slightly late tick is still normal running, not a sleep', () => {
  const now = Date.now();
  const d = decideSample({
    now, lastSampleAt: now - 6 * MIN, intervalMin: 5,
    windows: [{ focused: true, lastSeenAt: now - 1000, lastInteractionAt: now - 1000 }],
    sessions: [],
  });
  assert.strictEqual(d.active, true);
  assert.strictEqual(d.minutes, 5, 'capped at the interval, never the real 6 minutes');
});

// ------------------------------------------------------------------ the store

// Real timestamps throughout: the store prunes by age on load AND on append, so toy
// values like t:1 are correctly thrown away as four decades stale.
const T0 = Date.UTC(2026, 7, 26, 9, 0, 0);

test('samples survive being written and re-read — the restart criterion', () => {
  const file = tmpFile();
  const a = createTimecardStore({ file });
  assert.strictEqual(a.lastSampleAt(), null, 'a fresh store has no anchor');
  a.append({ t: T0, a: 1, m: 5, s: 2 });
  a.append({ t: T0 + 5 * MIN, a: 0, m: 5, s: 0 });

  const b = createTimecardStore({ file });
  assert.strictEqual(b.size, 2);
  assert.strictEqual(b.lastSampleAt(), T0 + 5 * MIN, 'the last row IS the sampler anchor');
  assert.deepStrictEqual(b.all()[0], { t: T0, a: 1, m: 5, s: 2 });
});

test('the resume anchor is never in the future', () => {
  const now = Date.UTC(2026, 7, 31, 12, 0, 0);
  assert.strictEqual(resolveAnchor(now - 5 * MIN, now), now - 5 * MIN, 'a normal last row is the anchor');
  assert.strictEqual(resolveAnchor(null, now), now, 'a fresh store starts the clock now');
  assert.strictEqual(
    resolveAnchor(now + 6 * 60 * MIN, now), now,
    'a row stamped in the future — a clock that jumped, or a restored file — would park '
    + 'the anchor ahead of now and stall the sampler silently until real time caught up',
  );
});

test('a malformed line is skipped rather than losing the file', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `{"t":${T0},"a":1,"m":5}\nnot json at all\n{"no":"timestamp"}\n{"t":${T0 + MIN},"a":0,"m":5}\n`,
  );
  const store = createTimecardStore({ file });
  assert.strictEqual(store.size, 2);
  assert.deepStrictEqual(store.all().map((s) => s.t), [T0, T0 + MIN]);
});

test('the log stays bounded, keeping the newest samples', () => {
  const file = tmpFile();
  const store = createTimecardStore({ file, maxSamples: 10 });
  for (let i = 1; i <= 25; i++) store.append({ t: T0 + i * MIN, a: 1, m: 5, s: 0 });
  assert.strictEqual(store.size, 10);
  assert.deepStrictEqual(
    store.all().map((s) => s.t),
    [16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map((i) => T0 + i * MIN),
  );
  // The trim has to reach the FILE, not just memory, or the next boot reads them back.
  assert.strictEqual(createTimecardStore({ file, maxSamples: 10 }).size, 10);
});

test('samples older than the retention window are dropped on load', () => {
  const file = tmpFile();
  const now = Date.UTC(2026, 7, 31);
  const old = now - 500 * 24 * 60 * MIN;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `{"t":${old},"a":1,"m":5}\n{"t":${now - MIN},"a":1,"m":5}\n`);
  const store = createTimecardStore({ file, retentionDays: 400, now: () => now });
  assert.strictEqual(store.size, 1);
});

// ------------------------------------------------------------------ aggregation

test('hours come from the credited minutes of ACTIVE samples only', () => {
  const now = new Date(2026, 7, 26, 15, 0, 0).getTime();
  const samples = [
    ...activeRun(new Date(2026, 7, 26, 11, 0, 0).getTime(), 24), // 09:00–11:00, 2h
    { t: new Date(2026, 7, 26, 11, 5, 0).getTime(), a: 0, m: 5, s: 0 }, // idle, ignored
  ];
  const { day } = buildViews(samples, now);
  assert.strictEqual(day.total, 2);
});

test('a sample is credited to the bucket its minutes STARTED in', () => {
  const now = new Date(2026, 7, 26, 15, 0, 0).getTime();
  // One 5-minute sample stamped exactly at 10:00 — it covers 09:55–10:00, which is the
  // 8a block, not the 10a one.
  const samples = [{ t: new Date(2026, 7, 26, 10, 0, 0).getTime(), a: 1, m: 5, s: 1 }];
  const { day } = buildViews(samples, now);
  assert.deepStrictEqual(day.labels, ['8a', '10a', '12p', '2p', '4p', '6p']);
  assert.ok(day.values[0] > 0, '8a block holds it');
  assert.strictEqual(day.values[1], 0, '10a block does not');
});

test('the Day view is six two-hour blocks and its headline is the sum of its bars', () => {
  const now = new Date(2026, 7, 26, 20, 0, 0).getTime();
  const day0 = new Date(2026, 7, 26, 0, 0, 0).getTime();
  const samples = [];
  for (let h = 9; h < 15; h++) for (let k = 1; k <= 12; k++) samples.push({ t: day0 + h * 3600000 + k * 5 * MIN, a: 1, m: 5, s: 1 });
  const { day } = buildViews(samples, now);
  assert.strictEqual(day.values.length, 6);
  assert.deepStrictEqual(day.values, [1, 2, 2, 1, 0, 0]);
  assert.strictEqual(day.total, 6);
  assert.strictEqual(day.range, 'Wednesday 26 Aug');
});

test('a two-hour block can never report more than two hours', () => {
  const now = new Date(2026, 7, 26, 20, 0, 0).getTime();
  // A pathological run of overlapping samples all landing in one block.
  const at = new Date(2026, 7, 26, 9, 0, 0).getTime();
  const samples = [];
  for (let i = 0; i < 200; i++) samples.push({ t: at + i * 1000, a: 1, m: 15, s: 1 });
  const { day } = buildViews(samples, now);
  assert.ok(day.values.every((v) => v <= 2), `a block reported ${Math.max(...day.values)}h`);
  const longest = day.stats.find((s) => s.label === 'Longest block');
  assert.ok(longest.value <= 2, 'and the stat agrees with the bar');
});

test('the Week view runs Sun–Sat and keeps zero days as zeros, not gaps', () => {
  const now = new Date(2026, 7, 26, 12, 0, 0).getTime(); // a Wednesday
  const samples = activeRun(new Date(2026, 7, 26, 11, 0, 0).getTime(), 12);
  const { week } = buildViews(samples, now);
  assert.deepStrictEqual(week.labels, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.strictEqual(week.values.length, 7, 'every day has a bar, including the empty ones');
  assert.strictEqual(week.values[3], 1, 'Wednesday');
  assert.strictEqual(week.range, 'Sun 23 – Sat 29 Aug');
});

test('a week straddling two months names both, or it reads as running backwards', () => {
  const { week } = buildViews([], new Date(2026, 7, 1, 12, 0, 0).getTime()); // Sat 1 Aug
  assert.strictEqual(week.range, 'Sun 26 Jul – Sat 1 Aug');
});

test('the Month view is Sunday-anchored weeks clipped to the month', () => {
  const now = new Date(2026, 7, 15, 12, 0, 0).getTime();
  // Aug 2026 starts on a Saturday, so W1 is the single day Aug 1.
  const samples = activeRun(new Date(2026, 7, 1, 11, 0, 0).getTime(), 12);
  const { month } = buildViews(samples, now);
  assert.strictEqual(month.range, 'August 2026');
  assert.ok(month.labels.every((l, i) => l === `W${i + 1}`), 'labels are W1…Wn');
  assert.strictEqual(month.values[0], 1, 'the 1 Aug hour lands in W1');
  // Hours from the July half of that straddling week must not leak into August.
  const withJuly = buildViews(
    [...samples, ...activeRun(new Date(2026, 6, 30, 11, 0, 0).getTime(), 12)],
    now,
  ).month;
  assert.strictEqual(withJuly.values[0], 1, 'July hours stay out of the August total');
});

// ------------------------------------------------------------------ the stat row

test('averages divide by periods with hours logged, not by period count', () => {
  const now = new Date(2026, 7, 26, 12, 0, 0).getTime();
  const monday = new Date(2026, 7, 24, 0, 0, 0).getTime();
  const samples = [
    ...activeRun(monday + 4 * 3600000, 24),                    // Mon: 2h
    ...activeRun(monday + 24 * 3600000 + 6 * 3600000, 48),     // Tue: 4h
  ];
  const { week } = buildViews(samples, now);
  const avg = week.stats.find((s) => s.label === 'Daily average');
  assert.strictEqual(avg.value, 3, '(2 + 4) / 2 days with hours, not / 7');
  const off = week.stats.find((s) => s.label === 'Days off');
  assert.strictEqual(off.value, 1, 'Wednesday has begun with nothing logged; Sunday predates the log, Thu–Sat have not happened');
  assert.strictEqual(off.kind, 'count', 'counts render as integers, hours to one decimal');
});

test('an empty period averages to zero rather than dividing by nothing', () => {
  const { week } = buildViews([], new Date(2026, 7, 26, 12, 0, 0).getTime());
  const [avg, longest, off] = week.stats;
  assert.strictEqual(avg.value, 0);
  assert.strictEqual(longest.value, 0);
  assert.strictEqual(off.value, 4, 'Sun, Mon, Tue and the Wednesday in progress — not the three days ahead');
  assert.strictEqual(week.total, 0);
});

test('a day that has not happened yet is not a day off', () => {
  const now = new Date(2026, 7, 23, 15, 0, 0).getTime(); // a Sunday afternoon
  const worked = activeRun(new Date(2026, 7, 23, 11, 0, 0).getTime(), 24);
  const off = (samples) => buildViews(samples, now).week.stats.find((s) => s.label === 'Days off').value;
  assert.strictEqual(off(worked), 0, 'Mon–Sat are still ahead');
  assert.strictEqual(off([]), 1, 'but a Sunday that has begun with nothing in it counts');
});

test('a week that has not started yet is not a quiet week', () => {
  // Thu 10 Sep 2026. September starts on a Tuesday: W1 1–5, W2 6–12, then W3–W5 ahead.
  const now = new Date(2026, 8, 10, 12, 0, 0).getTime();
  const quiet = (samples) => buildViews(samples, now).month.stats.find((s) => s.label === 'Quiet weeks').value;
  // An idle sample on the 1st says the sampler was running through W1 — without it, W1
  // predates the log and is not quiet either (see below).
  const running = { t: new Date(2026, 8, 1, 9, 0, 0).getTime(), a: 0, m: 5, s: 0 };
  const w2 = [running, ...activeRun(new Date(2026, 8, 8, 11, 0, 0).getTime(), 12)];
  assert.strictEqual(buildViews(w2, now).month.labels.length, 5);
  assert.strictEqual(quiet(w2), 1, 'W1 was quiet; W3, W4 and W5 have not happened');
  assert.strictEqual(quiet([...w2, ...activeRun(new Date(2026, 8, 2, 11, 0, 0).getTime(), 12)]), 0);
});

test('a period that ended before the log began is not a day off or a quiet week', () => {
  // The timecard was installed on Thu 10 Sep 2026. Nobody knows what Sun–Wed held.
  const now = new Date(2026, 8, 11, 12, 0, 0).getTime(); // Fri
  const samples = activeRun(new Date(2026, 8, 10, 11, 0, 0).getTime(), 12);
  const { week, month } = buildViews(samples, now);
  assert.strictEqual(week.stats.find((s) => s.label === 'Days off').value, 1,
    'Friday counts; Sun–Wed predate the log, Thursday has hours, Saturday is ahead');
  assert.strictEqual(month.stats.find((s) => s.label === 'Quiet weeks').value, 0,
    'W1 (1–5 Sep) ended before the first sample');
});

test('a block that has not started yet is not an idle block', () => {
  const now = new Date(2026, 7, 26, 13, 0, 0).getTime(); // inside the 12p block
  const samples = activeRun(new Date(2026, 7, 26, 9, 0, 0).getTime(), 12); // 8a block only
  const idle = buildViews(samples, now).day.stats.find((s) => s.label === 'Idle blocks').value;
  assert.strictEqual(idle, 2, '10a and the 12p in progress; 2p, 4p and 6p are still ahead');
});

test('the stat LABELS change with the view, not just the values', () => {
  const views = buildViews([], Date.now());
  for (const name of ['day', 'week', 'month']) {
    assert.deepStrictEqual(
      views[name].stats.map((s) => s.label), STAT_LABELS[name],
      `${name} must carry its own labels — "Longest day" over a per-block number is the bug`,
    );
  }
  // And the three sets really are distinct, so a swap would be visible.
  const all = new Set([...STAT_LABELS.day, ...STAT_LABELS.week, ...STAT_LABELS.month]);
  assert.strictEqual(all.size, 9);
});

// ------------------------------------------------------------------ past months

test('every earlier month with samples is offered, oldest first', () => {
  const now = new Date(2026, 9, 2, 12, 0, 0).getTime(); // 2 Oct 2026
  const samples = [
    ...activeRun(new Date(2026, 5, 10, 11, 0, 0).getTime(), 12), // June: 1h
    { t: new Date(2026, 6, 20, 11, 0, 0).getTime(), a: 0, m: 5, s: 0 }, // July: idle only
    // August: nothing — the daemon never ran
    ...activeRun(new Date(2026, 8, 15, 12, 0, 0).getTime(), 36), // September: 3h
    ...activeRun(new Date(2026, 9, 1, 11, 0, 0).getTime(), 12), // October: the current month
  ];
  const { month, pastMonths } = buildViews(samples, now);
  assert.deepStrictEqual(pastMonths.map((m) => m.range), ['June 2026', 'July 2026', 'September 2026'],
    'an idle month is still history; a month the sampler never ran in is not');
  assert.deepStrictEqual(pastMonths.map((m) => m.key), ['2026-06', '2026-07', '2026-09']);
  assert.deepStrictEqual(pastMonths.map((m) => m.total), [1, 0, 3]);
  assert.strictEqual(month.range, 'October 2026', 'the current month stays where it was');
  assert.strictEqual(month.key, '2026-10');
  assert.strictEqual(month.total, 1, 'and keeps only its own hours');
});

test('a sample is filed under the month its minutes started in', () => {
  // Stamped 00:03 on 1 Oct, covering 23:58–00:03: it belongs to September.
  const now = new Date(2026, 9, 2, 12, 0, 0).getTime();
  const samples = [{ t: new Date(2026, 9, 1, 0, 3, 0).getTime(), a: 1, m: 5, s: 1 }];
  const { month, pastMonths } = buildViews(samples, now);
  assert.deepStrictEqual(pastMonths.map((m) => m.key), ['2026-09']);
  assert.strictEqual(month.total, 0);
});

test('a past month is judged as a whole month, not as of the day it was picked by', () => {
  // September 2026 viewed from October, with hours in W2 only and the log running from
  // the 1st: every one of its five weeks has begun, so four are quiet.
  const now = new Date(2026, 9, 2, 12, 0, 0).getTime();
  const samples = [
    { t: new Date(2026, 8, 1, 9, 0, 0).getTime(), a: 0, m: 5, s: 0 },
    ...activeRun(new Date(2026, 8, 8, 11, 0, 0).getTime(), 12),
  ];
  const [sep] = buildViews(samples, now).pastMonths;
  assert.deepStrictEqual(sep.labels, ['W1', 'W2', 'W3', 'W4', 'W5']);
  assert.strictEqual(sep.stats.find((s) => s.label === 'Quiet weeks').value, 4);
  assert.deepStrictEqual(sep.stats.map((s) => s.label), STAT_LABELS.month);
});

test('example data has no history to step back through', () => {
  assert.deepStrictEqual(seedViews(new Date(2026, 9, 2, 12, 0, 0).getTime()).pastMonths, []);
  assert.deepStrictEqual(buildViews([], Date.now()).pastMonths, []);
});

// ------------------------------------------------------------------ bar scaling

test('bars scale to a per-view max, raised only when the data would clip', () => {
  const now = new Date(2026, 7, 26, 12, 0, 0).getTime();
  assert.strictEqual(buildViews([], now).week.max, 12, 'a quiet week still uses the view max');

  const monday = new Date(2026, 7, 24, 0, 0, 0).getTime();
  const heroic = activeRun(monday + 20 * 3600000, 12 * 14); // 14h on the Monday
  const { week } = buildViews(heroic, now);
  assert.ok(week.max >= Math.max(...week.values), 'a 14h day is never clipped');
});

// ------------------------------------------------------------------ the seed

test('the seed is plausible founder data with at least one zero and no rigid pattern', () => {
  for (const name of ['day', 'week', 'month']) {
    assert.ok(SEED_VALUES[name].length > 0, `${name} seed exists`);
  }
  assert.ok(SEED_VALUES.week.includes(0), 'at least one zero');
  assert.ok(SEED_VALUES.day.includes(0), 'and one in the day too');
  assert.ok(
    new Set(SEED_VALUES.week).size >= 6,
    'no rigid eight-hour pattern — the values must actually vary',
  );
  assert.ok(!SEED_VALUES.week.every((v) => v === 8));
});

test('the seed borrows the real range strings, so it reads as this week', () => {
  const now = new Date(2026, 7, 26, 12, 0, 0).getTime();
  const seed = seedViews(now);
  const real = buildViews([], now);
  for (const name of ['day', 'week', 'month']) {
    assert.strictEqual(seed[name].range, real[name].range);
    assert.deepStrictEqual(seed[name].stats.map((s) => s.label), STAT_LABELS[name]);
  }
  assert.strictEqual(seed.week.total, 50.2, 'the headline is the sum of the seeded bars');
  assert.strictEqual(seed.week.stats[2].value, 1, 'example data is a whole week, so its Sunday zero is a day off');
});

// ------------------------------------------------------------------ the framing

test('no employer framing leaks out of the aggregator', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'timecard-store.js'), 'utf8');
  // Split the label strings out of the prose: the header comment names these words in
  // order to forbid them, so only the emitted labels are searched.
  const labels = Object.values(STAT_LABELS).flat().join(' ');
  assert.doesNotMatch(
    labels, /overtime|attainment|target|compliance|clock.?in|quota|productivity|shortfall/i,
    'observation, not enforcement (#666)',
  );
  assert.ok(!/\bgoal\b|\bexpected hours\b/i.test(labels));
  assert.ok(src.includes('observing their own hours'), 'the framing note stays with the code');
});

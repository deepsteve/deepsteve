// Unit tests for the scheduled-tasks cron parser (#697).
//
// cron.js shipped with no tests, which is how `0 */2 * * *` came to be labelled
// "Every hour at :00" for two releases. The label table below is the regression
// guard: every shape describe() claims to know, plus the shapes it must decline
// to summarise. The matches() block pins the dom/dow rule, including the one case
// that reads like a bug and is not.
//
// Pure — no daemon, no filesystem, no HOME.
const { test } = require('node:test');
const assert = require('node:assert');

const { parseCron, matches, nextRun, describe } = require('../../mods/scheduled-tasks/cron.js');

// Local time, so a Date built here means the same instant the daemon would match.
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);

test('describe: labels a stepped field with its step, never as unstepped', () => {
  // The #697 report. Each of these rendered as "Every hour at :MM".
  assert.equal(describe('0 */2 * * *'), 'Every 2 hours at :00');
  assert.equal(describe('0 */6 * * *'), 'Every 6 hours at :00');
  assert.equal(describe('30 */3 * * *'), 'Every 3 hours at :30');
  // Same root, found while fixing it: a stepped dom/dow read as "Every day".
  assert.equal(describe('0 9 */2 * *'), '0 9 */2 * *');
  assert.equal(describe('0 9 * * */2'), 'Every Sunday, Tuesday, Thursday, Saturday at 09:00');
  // A stepped minute used to fall through to the raw expression.
  assert.equal(describe('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(describe('*/5 * * * *'), 'Every 5 minutes');
  assert.equal(describe('*/30 * * * *'), 'Every 30 minutes');
  // Written as a range, but the same schedule as `*/2`, so the same label.
  assert.equal(describe('0 0-22/2 * * *'), 'Every 2 hours at :00');
});

test('describe: the unstepped shapes are unchanged', () => {
  assert.equal(describe('* * * * *'), 'Every minute');
  assert.equal(describe('0 * * * *'), 'Every hour at :00');
  assert.equal(describe('0 9 * * *'), 'Every day at 09:00');
  assert.equal(describe('0 9 * * 1'), 'Every Monday at 09:00');
  assert.equal(describe('0 0 * * 1-5'), 'Every Monday, Tuesday, Wednesday, Thursday, Friday at 00:00');
  assert.equal(describe('0 9 1 * *'), 'Monthly on day 1 at 09:00');
});

test('describe: a range covering the whole field is as unrestricted as `*`', () => {
  assert.equal(describe('0 0-23 * * *'), 'Every hour at :00');
  assert.equal(describe('0 9 1-31 * *'), 'Every day at 09:00');
  assert.equal(describe('0 9 * 1-12 *'), 'Every day at 09:00');
  assert.equal(describe('5 */1 * * *'), 'Every hour at :05'); // step 1 covers everything
});

test('describe: declines to summarise what it has no honest label for', () => {
  assert.equal(describe('0 9,17 * * *'), '0 9,17 * * *'); // two fire times, not a step
  assert.equal(describe('0 9-17/2 * * *'), '0 9-17/2 * * *'); // stepped, but not from 0
  assert.equal(describe('0 0-12/2 * * *'), '0 0-12/2 * * *'); // stops halfway through the day
  // A step that doesn't tile its range evenly leaves a short gap at the wrap, so
  // "Every N" would misstate the interval — the same failure this issue is about.
  assert.equal(describe('0 */5 * * *'), '0 */5 * * *'); // 00,05,10,15,20 → a 4h gap to midnight
  assert.equal(describe('0 */7 * * *'), '0 */7 * * *');
  assert.equal(describe('*/40 * * * *'), '*/40 * * * *'); // :00 and :40 → gaps of 40 and 20
  assert.equal(describe('*/7 * * * *'), '*/7 * * * *');
  assert.equal(describe('0 9 15 * 1'), '0 9 15 * 1'); // dom AND dow both restricted
  assert.equal(describe('0 9 * 6 *'), '0 9 * 6 *'); // one month only
  assert.equal(describe('30 4 1,15 * 5'), '30 4 1,15 * 5'); // the crontab(5) OR example
});

test('describe: an unparseable expression comes back verbatim', () => {
  // The form preview describes half-typed input, so this path is load-bearing.
  assert.equal(describe('0 9 * *'), '0 9 * *');
  assert.equal(describe('nonsense'), 'nonsense');
  assert.equal(describe(''), '');
});

test('parseCron: rejects malformed expressions', () => {
  assert.throws(() => parseCron('0 9 * *'), /5 fields/);
  assert.throws(() => parseCron('0 9 * * * *'), /5 fields/);
  assert.throws(() => parseCron('0 */0 * * *'), /Invalid cron step/);
  assert.throws(() => parseCron('0 17-9 * * *'), /Descending cron range/);
  assert.throws(() => parseCron('0 24 * * *'), /out of range/);
  assert.throws(() => parseCron('0 9 * * ,1'), /Empty cron field component/);
  assert.throws(() => parseCron(42), /must be a string/);
});

test('parseCron: 7 is Sunday in the day-of-week field', () => {
  assert.deepEqual([...parseCron('0 9 * * 7').dow.set], [0]);
  assert.equal(matches('0 9 * * 7', at(2026, 9, 13, 9, 0)), true); // a Sunday
});

test('parseField: `star` and `full` mean different things for a stepped field', () => {
  const c = parseCron('0 */2 * * *');
  assert.equal(c.hour.star, true, 'the token did begin with `*`');
  assert.equal(c.hour.full, false, 'but it does not cover every hour');
  const plain = parseCron('0 * * * *');
  assert.equal(plain.hour.star, true);
  assert.equal(plain.hour.full, true);
  const range = parseCron('0 0-23 * * *');
  assert.equal(range.hour.star, false, 'no leading `*`');
  assert.equal(range.hour.full, true, 'yet it restricts nothing');
});

test('matches: dom/dow OR when both are restricted, AND otherwise', () => {
  // crontab(5)'s own example: 4:30am on the 1st and 15th, plus every Friday.
  assert.equal(matches('30 4 1,15 * 5', at(2026, 9, 15, 4, 30)), true); // the 15th, a Tuesday
  assert.equal(matches('30 4 1,15 * 5', at(2026, 9, 11, 4, 30)), true); // a Friday, the 11th
  assert.equal(matches('30 4 1,15 * 5', at(2026, 9, 10, 4, 30)), false); // neither
  // Only one restricted → it simply applies.
  assert.equal(matches('0 9 * * 1', at(2026, 9, 14, 9, 0)), true);
  assert.equal(matches('0 9 * * 1', at(2026, 9, 15, 9, 0)), false);
  assert.equal(matches('0 9 15 * *', at(2026, 9, 15, 9, 0)), true);
});

test('matches: a stepped dom keeps the AND branch, as the system cron does', () => {
  // Deliberate, not a bug (#697). Vixie sets DOM_STAR from the field's literal
  // first character before parsing the list, so `*/2` sets it and the AND branch
  // applies — `dom` here is the odd days, and the 14th is not one of them, so
  // real cron does not fire either. npm's cron-parser decides by set fullness and
  // would return true; we follow the cron actually installed on the machine.
  // Changing this would move when every already-saved task fires.
  assert.equal(matches('0 9 */2 * 1', at(2026, 9, 14, 9, 0)), false); // Monday, even day
  assert.equal(matches('0 9 */2 * 1', at(2026, 9, 15, 9, 0)), false); // odd day, not Monday
  assert.equal(matches('0 9 */2 * 1', at(2026, 9, 7, 9, 0)), true); // Monday AND odd day
});

test('matches: the minute, hour and month fields all gate a fire', () => {
  assert.equal(matches('0 */2 * * *', at(2026, 9, 6, 10, 0)), true);
  assert.equal(matches('0 */2 * * *', at(2026, 9, 6, 11, 0)), false); // odd hour
  assert.equal(matches('0 */2 * * *', at(2026, 9, 6, 10, 1)), false); // wrong minute
  assert.equal(matches('0 9 * 6 *', at(2026, 6, 6, 9, 0)), true);
  assert.equal(matches('0 9 * 6 *', at(2026, 9, 6, 9, 0)), false); // wrong month
});

test('nextRun: steps to the next matching minute, strictly after `from`', () => {
  const from = at(2026, 9, 6, 9, 30);
  assert.equal(nextRun('0 */2 * * *', from), at(2026, 9, 6, 10, 0).getTime());
  assert.equal(nextRun('*/15 * * * *', from), at(2026, 9, 6, 9, 45).getTime());
  // Exactly on a fire time → the NEXT one, never the same minute twice.
  assert.equal(nextRun('0 */2 * * *', at(2026, 9, 6, 10, 0)), at(2026, 9, 6, 12, 0).getTime());
  // Rolls over midnight: the last stepped hour is 22:00.
  assert.equal(nextRun('0 */2 * * *', at(2026, 9, 6, 23, 0)), at(2026, 9, 7, 0, 0).getTime());
});

test('nextRun: an unsatisfiable expression returns null instead of looping', () => {
  // Feb 30th never comes; the ~400-day cap is what ends the walk.
  assert.equal(nextRun('0 9 30 2 *', at(2026, 9, 6, 9, 30)), null);
});

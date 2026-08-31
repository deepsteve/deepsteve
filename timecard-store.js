// Timecard sampling + aggregation (#666) — the pure half.
//
// The daemon samples, every N minutes, whether a human is actually working in Deep
// Steve, and appends one row per sample to ~/.deepsteve/timecard.jsonl. This module
// holds the parts with no daemon in them: the bounded append-only store, what a single
// sample says, and the read-time aggregation into Day / Week / Month datasets. The
// wiring — the tick, the presence map, the routes — lives in mods/timecard/tools.js,
// the same split terminal-run.js and mods/deepsteve-core use.
//
// It sits at the repo ROOT deliberately: restart.sh's `cp *.js` and release.sh's
// root-js loop ship root modules automatically, while engines/ and mods/ have
// hand-maintained lists. Same reason as terminal-run.js and tmux-path.js. It is also
// dependency-free, so it loads on the bare CI `unit` job, which runs --ignore-scripts.
//
// Framing (#666): this is a founder observing their own hours, not an employer
// measuring an employee. Nothing here computes a target, an attainment ratio or a
// shortfall, and nothing should.

const fs = require('fs');
const path = require('path');

// 120k rows is ~5 MB and ~416 days at the default 5-minute interval — long enough that
// the Month view always has history behind it, small enough to parse at boot.
const DEFAULT_MAX_SAMPLES = 120000;
const DEFAULT_RETENTION_DAYS = 400;

const SAMPLE_INTERVALS = [1, 5, 15];
const DEFAULT_INTERVAL_MIN = 5;

// How long a presence report stays meaningful. The browser beacons every 30s, so a
// report older than this means that window stopped talking to us — asleep, closed, or
// on a machine that went away.
const PRESENCE_TTL_MS = 90 * 1000;

// The Day view's window, from the issue. Hours worked outside it are counted in the
// Week and Month views but have no bar of their own — see docs/timecard.md.
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const DAY_BLOCK_HOURS = 2;

// Bars scale to a per-view max, not to the data max, so a slow week does not look
// exactly like a busy one. Raised only when the data would otherwise clip.
const VIEW_MAX = { day: DAY_BLOCK_HOURS, week: 12, month: 60 };

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The stat row's labels change with the view — that is the whole point of the row, and
// swapping the values while leaving "Daily average" over a per-block number is the bug
// this table exists to make impossible.
const STAT_LABELS = {
  day: ['Per block', 'Longest block', 'Idle blocks'],
  week: ['Daily average', 'Longest day', 'Days off'],
  month: ['Weekly average', 'Biggest week', 'Quiet weeks'],
};

/** The configured interval, coerced to one this module actually supports. */
function normalizeInterval(raw) {
  const n = Math.round(Number(raw));
  return SAMPLE_INTERVALS.includes(n) ? n : DEFAULT_INTERVAL_MIN;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * The bounded append-only sample log. Load once into an in-memory mirror, append one
 * line per sample, rewrite the whole file only when trimming — the same shape as
 * terminal-run.js's createRunLog and mods/session-lifecycle/tools.js.
 *
 * Every fs call is best-effort: losing a sample is a gap in a chart, and must never be
 * able to throw into the daemon's timer.
 */
function createTimecardStore({
  file,
  maxSamples = DEFAULT_MAX_SAMPLES,
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = Date.now,
} = {}) {
  let samples = [];

  function prune(list) {
    const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
    let out = list.filter((s) => s.t >= cutoff);
    if (out.length > maxSamples) out = out.slice(-maxSamples);
    return out;
  }

  function rewrite() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, samples.map((s) => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : ''));
  }

  try {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const s = JSON.parse(line);
          if (s && Number.isFinite(s.t)) samples.push(s);
        } catch { /* skip a malformed line rather than lose the file */ }
      }
      const kept = prune(samples);
      if (kept.length !== samples.length) {
        samples = kept;
        try { rewrite(); } catch { /* best-effort */ }
      }
    }
  } catch { samples = []; }

  return {
    get file() { return file; },
    get size() { return samples.length; },
    /** Every sample, oldest first. Handed out uncopied — callers only read. */
    all() { return samples; },
    /** When the last sample was taken, or null. This is what survives a restart. */
    lastSampleAt() { return samples.length ? samples[samples.length - 1].t : null; },
    /** Append one sample. Returns it. */
    append(sample) {
      samples.push(sample);
      const kept = prune(samples);
      const trimmed = kept.length !== samples.length;
      samples = kept;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (trimmed) rewrite();
        else fs.appendFileSync(file, JSON.stringify(sample) + '\n');
      } catch { /* best-effort — never throw into the sampler */ }
      return sample;
    },
  };
}

/**
 * Where the sampler resumes from, given the last stored sample's timestamp.
 *
 * The last row IS the anchor — that is the whole of "samples survive a restart", with no
 * second state file to keep in sync. But it must never be trusted past the present: a
 * clock that jumped forward and back, or a restored backup, leaves a row stamped in the
 * future, and an anchor ahead of `now` makes every elapsed check negative and stalls the
 * sampler silently until real time catches up.
 */
function resolveAnchor(lastStoredT, now = Date.now()) {
  return Number.isFinite(lastStoredT) ? Math.min(lastStoredT, now) : now;
}

/**
 * What one tick of the sampler concludes.
 *
 *   windows  — [{ focused, lastSeenAt, lastInteractionAt }], one per browser window
 *              that has reported presence recently
 *   sessions — [{ lastActivity }], the live sessions this daemon owns, scheduled runs
 *              already excluded by the caller
 *
 * Returns { fire: false } alone when not enough time has passed yet.
 */
function decideSample({
  now,
  lastSampleAt,
  intervalMin,
  windows = [],
  sessions = [],
  presenceTtlMs = PRESENCE_TTL_MS,
}) {
  const interval = normalizeInterval(intervalMin);
  const intervalMs = interval * 60 * 1000;
  const elapsedMs = now - lastSampleAt;
  if (elapsedMs < intervalMs) return { fire: false };

  // The daemon is frozen across a macOS sleep (sleep-watch.js exists for exactly this),
  // so `elapsed` can be hours. Credit at most one interval, or a laptop shut overnight
  // manufactures a night's work.
  const minutes = Math.min(elapsedMs / 60000, interval);

  // A gap longer than two intervals means we were not running. We have no evidence
  // about that time, and "no evidence" is not "working".
  const slept = elapsedMs > intervalMs * 2;

  // Typing, clicking or scrolling anywhere in Deep Steve since the last sample.
  const interacted = !slept && windows.some((w) => Number(w.lastInteractionAt) > lastSampleAt);

  // A window that is focused AND still talking to us. This is the half a server-only
  // sampler cannot see, and the only thing separating "I am in it" from "a tab left
  // open overnight".
  const present = !slept && windows.some(
    (w) => w.focused && Number(w.lastSeenAt) >= now - presenceTtlMs,
  );
  // Watching a run counts: supervising an agent for twenty minutes without touching the
  // keyboard is work. It needs a focused window, so an unattended overnight run scores
  // nothing.
  const watching = present && sessions.some((s) => Number(s.lastActivity) > lastSampleAt);

  return {
    fire: true,
    active: interacted || watching,
    minutes: Math.round(minutes * 100) / 100,
    sessionCount: sessions.length,
  };
}

// --- Date helpers. Local time throughout; the week starts Monday. ---

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; }
function startOfWeek(t) {
  const d = startOfDay(t);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function startOfMonth(t) { const d = startOfDay(t); d.setDate(1); return d; }

function hourLabel(h) {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? 'a' : 'p'}`;
}

function dayRange(d) {
  return `${WEEKDAY_LONG[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
}
function weekRange(start, end) {
  // A week straddling two months has to name both, or "Mon 28 – Sun 3 Aug" reads as a
  // week that runs backwards.
  const from = start.getMonth() === end.getMonth()
    ? `${WEEKDAY_SHORT[start.getDay()]} ${start.getDate()}`
    : `${WEEKDAY_SHORT[start.getDay()]} ${start.getDate()} ${MONTH_SHORT[start.getMonth()]}`;
  return `${from} – ${WEEKDAY_SHORT[end.getDay()]} ${end.getDate()} ${MONTH_SHORT[end.getMonth()]}`;
}
function monthRange(d) { return `${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`; }

/**
 * Hours logged in [from, to).
 *
 * A sample stamped `t` covers the `m` minutes BEFORE it, so it is attributed to the
 * bucket containing the start of that span. Stamping it at `t` would push the last few
 * minutes of every bucket into the next one.
 */
function hoursIn(samples, from, to) {
  let minutes = 0;
  for (const s of samples) {
    if (!s.a) continue;
    const m = Number(s.m) || 0;
    const at = s.t - m * 60000;
    if (at < from || at >= to) continue;
    minutes += m;
  }
  return minutes / 60;
}

/** A bucket can never hold more hours than it is long. */
const clampHours = (h, span) => Math.min(h, span);

function statsFor(name, values) {
  const [avgLabel, maxLabel, zeroLabel] = STAT_LABELS[name];
  // Divide by periods with hours logged, not by period count (#666): a week with two
  // days off is not a week of five-sevenths days.
  const logged = values.filter((v) => v > 0);
  const avg = logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;
  return [
    { label: avgLabel, value: round1(avg), kind: 'hours' },
    { label: maxLabel, value: values.length ? round1(Math.max(...values)) : 0, kind: 'hours' },
    { label: zeroLabel, value: values.length - logged.length, kind: 'count' },
  ];
}

function buildView(name, range, labels, rawValues) {
  const values = rawValues.map(round1);
  // The headline is the sum of the bars actually on screen, so the number and the chart
  // can never disagree.
  const total = round1(values.reduce((a, b) => a + b, 0));
  const dataMax = values.length ? Math.max(...values) : 0;
  return {
    range,
    labels,
    values,
    max: Math.max(VIEW_MAX[name], Math.ceil(dataMax)),
    total,
    stats: statsFor(name, values),
  };
}

function buildDay(samples, now) {
  const start = startOfDay(now);
  const labels = [];
  const values = [];
  for (let h = DAY_START_HOUR; h < DAY_END_HOUR; h += DAY_BLOCK_HOURS) {
    const from = new Date(start); from.setHours(h);
    const to = new Date(start); to.setHours(h + DAY_BLOCK_HOURS);
    labels.push(hourLabel(h));
    values.push(clampHours(hoursIn(samples, from.getTime(), to.getTime()), DAY_BLOCK_HOURS));
  }
  return buildView('day', dayRange(start), labels, values);
}

function buildWeek(samples, now) {
  const start = startOfWeek(now);
  const labels = [];
  const values = [];
  for (let i = 0; i < 7; i++) {
    const from = new Date(start); from.setDate(from.getDate() + i);
    const to = new Date(start); to.setDate(to.getDate() + i + 1);
    labels.push(WEEK_LABELS[i]);
    values.push(clampHours(hoursIn(samples, from.getTime(), to.getTime()), 24));
  }
  const end = new Date(start); end.setDate(end.getDate() + 6);
  return buildView('week', weekRange(start, end), labels, values);
}

function buildMonth(samples, now) {
  const first = startOfMonth(now);
  const next = new Date(first); next.setMonth(next.getMonth() + 1);
  const labels = [];
  const values = [];
  let cursor = startOfWeek(first);
  let n = 0;
  while (cursor.getTime() < next.getTime()) {
    const weekEnd = new Date(cursor); weekEnd.setDate(weekEnd.getDate() + 7);
    // Weeks are clipped to the month, so W1 of a month starting on a Saturday is two
    // days long and the month's bars sum to the month's hours.
    const from = Math.max(cursor.getTime(), first.getTime());
    const to = Math.min(weekEnd.getTime(), next.getTime());
    labels.push(`W${++n}`);
    values.push(clampHours(hoursIn(samples, from, to), 24 * 7));
    cursor = weekEnd;
  }
  return buildView('month', monthRange(first), labels, values);
}

/** All three datasets at once, so the card can switch views with no round trip. */
function buildViews(samples, now = Date.now()) {
  return {
    day: buildDay(samples, now),
    week: buildWeek(samples, now),
    month: buildMonth(samples, now),
  };
}

// Plausible founder hours for a store with nothing in it yet: long weekdays, a couple of
// zeros, no rigid eight-hour pattern. The ranges are computed from the clock so the seed
// reads as this week rather than as some other year, and the card says "example data"
// for as long as it is showing them.
const SEED_VALUES = {
  day: [1.8, 2.0, 0, 1.9, 2.0, 1.4],
  week: [9.5, 8.2, 11.4, 7.6, 10.1, 3.4, 0],
  month: [44.6, 51.2, 38.9, 50.2, 12.3],
};

function seedViews(now = Date.now()) {
  const dayLabels = [];
  for (let h = DAY_START_HOUR; h < DAY_END_HOUR; h += DAY_BLOCK_HOURS) dayLabels.push(hourLabel(h));
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  return {
    day: buildView('day', dayRange(startOfDay(now)), dayLabels, SEED_VALUES.day),
    week: buildView('week', weekRange(weekStart, weekEnd), WEEK_LABELS.slice(), SEED_VALUES.week),
    month: buildView('month', monthRange(startOfMonth(now)), ['W1', 'W2', 'W3', 'W4', 'W5'], SEED_VALUES.month),
  };
}

module.exports = {
  DEFAULT_MAX_SAMPLES,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_INTERVAL_MIN,
  SAMPLE_INTERVALS,
  PRESENCE_TTL_MS,
  DAY_START_HOUR,
  DAY_END_HOUR,
  DAY_BLOCK_HOURS,
  STAT_LABELS,
  VIEW_MAX,
  SEED_VALUES,
  normalizeInterval,
  createTimecardStore,
  resolveAnchor,
  decideSample,
  buildViews,
  seedViews,
};

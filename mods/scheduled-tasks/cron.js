// Tiny, dependency-free 5-field cron for the scheduled-tasks mod.
//
// Fields (standard Vixie cron), all evaluated in the daemon's LOCAL time:
//   ┌─────── minute        (0-59)
//   │ ┌───── hour          (0-23)
//   │ │ ┌─── day-of-month  (1-31)
//   │ │ │ ┌─ month         (1-12)
//   │ │ │ │ ┌ day-of-week  (0-6, 0=Sunday; 7 also accepted as Sunday)
//   * * * * *
//
// Per-field syntax: `*`, `n`, `a,b,c`, `a-b`, `*/n`, `a-b/n`.
//
// Day-of-month / day-of-week follow the classic cron rule: when BOTH are
// restricted (neither is `*`), a match on EITHER field fires the job; if one is
// `*` the other simply applies (AND).

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Parse one field into a Set of allowed integers, with two flags that look alike
// and are not (#697):
//
//   star — the token literally began with `*`, step or no step. This is Vixie's
//          DOM_STAR/DOW_STAR, which it sets from the field's first character
//          before parsing the list, so `*/2` sets it. ONLY the dom/dow OR-rule in
//          `matches()` reads it, which is what keeps us firing when the system
//          cron fires.
//   full — the set actually covers every value in the range, i.e. the field
//          restricts nothing. `*` and `0-23` are full; `*/2` is not. Only
//          `describe()` reads it: a label may not call `*/2` "every hour".
function parseField(raw, { min, max }) {
  const set = new Set();
  let star = false;
  for (const part of String(raw).split(',')) {
    const token = part.trim();
    if (token === '') throw new Error(`Empty cron field component in "${raw}"`);

    // Split off an optional step: `<range>/<n>`
    let stepStr = null;
    let rangeStr = token;
    const slash = token.indexOf('/');
    if (slash !== -1) {
      rangeStr = token.slice(0, slash);
      stepStr = token.slice(slash + 1);
    }

    const step = stepStr === null ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${stepStr}" in "${raw}"`);

    let lo, hi;
    if (rangeStr === '*') {
      star = true;
      lo = min;
      hi = max;
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = hi = Number(rangeStr);
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`Invalid cron value "${rangeStr}" in "${raw}"`);
    // Accept 7 as Sunday for the day-of-week field before the range check.
    if (max === 6) {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo > hi) throw new Error(`Descending cron range "${rangeStr}" in "${raw}"`);
    if (lo < min || hi > max) throw new Error(`Cron value out of range (${min}-${max}) in "${raw}"`);

    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, star, full: set.size === max - min + 1, min, max };
}

// Parse a 5-field cron string. Throws on anything malformed.
function parseCron(str) {
  if (typeof str !== 'string') throw new Error('Cron expression must be a string');
  const fields = str.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have 5 fields, got ${fields.length}: "${str}"`);
  const parsed = { raw: str.trim() };
  for (let i = 0; i < 5; i++) {
    parsed[FIELD_RANGES[i].name] = parseField(fields[i], FIELD_RANGES[i]);
  }
  return parsed;
}

// Does a local-time Date satisfy a parsed (or string) cron expression?
function matches(cron, date) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  if (!c.minute.set.has(date.getMinutes())) return false;
  if (!c.hour.set.has(date.getHours())) return false;
  if (!c.month.set.has(date.getMonth() + 1)) return false;

  const domOk = c.dom.set.has(date.getDate());
  const dowOk = c.dow.set.has(date.getDay());
  // Classic rule: both restricted → OR; otherwise the restricted one applies.
  // `star`, never `full`: Vixie decides this on the field's literal first
  // character, so `*/2` takes the AND branch there too and `0 9 */2 * 1` does not
  // fire on an even-numbered Monday. Swapping in `full` would look like a fix and
  // would silently move when every already-saved task fires.
  if (!c.dom.star && !c.dow.star) return domOk || dowOk;
  return domOk && dowOk;
}

// Next fire time strictly after `from`, as epoch ms. Steps minute-by-minute
// (cron granularity is a minute) with a ~400-day cap so an unsatisfiable
// expression returns null instead of looping forever. Only called on
// save/run/load — never in the hot tick path.
function nextRun(cron, from = new Date()) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`
  const capMs = d.getTime() + 400 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= capMs) {
    if (matches(c, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// The step of a field that fires at a genuinely even interval — i.e. an
// evenly-spaced run from the bottom of the range to the top whose step also
// divides the range, so the gap that wraps past the end is the same as all the
// others. Returns null for anything else, which sends the caller back to the raw
// expression: `9-17/2` and `9,17` don't start at the bottom, `0-12/2` stops
// halfway, and `*/5` on hours would be "Every 5 hours" with a 4-hour gap over
// midnight (20:00 → 00:00). Declining to summarise is what describe() already
// does for everything it cannot state truthfully.
function stepOf(f) {
  const vals = [...f.set].sort((a, b) => a - b);
  if (vals.length < 2 || vals[0] !== f.min) return null;
  const step = vals[1] - vals[0];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] - vals[i - 1] !== step) return null;
  }
  // Must tile the range exactly: the right count AND no short last gap. This is
  // what rejects `0-12/2` (stops halfway) and `*/5` (25 ≠ 24).
  if (vals.length * step !== f.max - f.min + 1) return null;
  return step;
}

// Human-readable summary for common shapes; falls back to the raw expression.
// Reads `full`, never `star` — see parseField. A stepped field restricts, so it
// only ever earns a label that names its step.
function describe(cron) {
  let c;
  try {
    c = typeof cron === 'string' ? parseCron(cron) : cron;
  } catch {
    return String(cron && cron.raw ? cron.raw : cron);
  }
  const raw = c.raw;
  const pad = (n) => String(n).padStart(2, '0');
  const single = (f) => (f.set.size === 1 ? [...f.set][0] : null);
  const min = single(c.minute);
  const hr = single(c.hour);
  const dom = single(c.dom);
  const dow = single(c.dow);
  const hasTime = min !== null && hr !== null;
  const time = hasTime ? `${pad(hr)}:${pad(min)}` : null;

  if (raw === '* * * * *') return 'Every minute';
  // Every day the calendar offers — the guard shared by the sub-daily shapes.
  const everyDay = c.dom.full && c.month.full && c.dow.full;
  if (everyDay) {
    // Every N minutes
    if (min === null && c.hour.full) {
      const step = stepOf(c.minute);
      if (step) return `Every ${step} minutes`;
    }
    if (min !== null) {
      // Every hour at :MM
      if (c.hour.full) return `Every hour at :${pad(min)}`;
      // Every N hours at :MM
      const step = stepOf(c.hour);
      if (step) return `Every ${step} hours at :${pad(min)}`;
    }
  }
  if (hasTime && c.month.full) {
    // Weekly (dow restricted, dom not)
    if (!c.dow.full && c.dom.full) {
      const days = [...c.dow.set].sort((a, b) => a - b).map((d) => DAY_NAMES[d]);
      const label = days.length === 1 ? days[0] : days.join(', ');
      return `Every ${label} at ${time}`;
    }
    // Monthly (dom restricted, dow not)
    if (!c.dom.full && c.dow.full && dom !== null) {
      return `Monthly on day ${dom} at ${time}`;
    }
    // Daily
    if (c.dom.full && c.dow.full) {
      return `Every day at ${time}`;
    }
  }
  return raw;
}

module.exports = { parseCron, matches, nextRun, describe };

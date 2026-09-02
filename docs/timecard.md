# Timecard

Your own hours in Deep Steve: a sampler that records whether you were working, and a
card that charts it by day, week and month.

The framing is a founder observing their own hours, not an employer measuring an
employee. There are no targets, no attainment percentages and no overtime — a design
constraint, not a stylistic one, and `test/unit/timecard-mod-shape.test.js` fails the
build if that vocabulary reappears in the UI copy.

## The pieces

| Where | What |
|---|---|
| `timecard-store.js` (repo root) | The bounded sample log, `decideSample`, and the read-time aggregation. Pure and dependency-free, so it is unit-testable with no daemon and loads on the bare CI `unit` job. |
| `mods/timecard/tools.js` | The 1-minute tick, the presence map, `GET /api/timecard`, `POST /api/timecard/presence`. |
| `mods/timecard/{index.html,timecard.js}` | The card. An App (`"app": true`) — a rail row and a palette entry, no toolbar button. |
| `public/js/timecard-presence.js` | The browser's presence beacon, in the top document. |

## What counts as working

Each sample asks one question: since the last sample, was a human working here? Two
things answer yes.

- **Interaction** — a keydown, pointerdown or wheel anywhere in Deep Steve. Captured at
  the top document, so terminal keystrokes count without reaching into the session
  plumbing.
- **Watching a run** — a browser window that is focused *and* still beaconing, while a
  non-scheduled session produced output. Supervising an agent for twenty minutes without
  touching the keyboard is work.

Everything else is idle. In particular a scheduled run at 3am scores nothing: it needs a
focused window, and `isScheduledRun` excludes cron sessions from the "is anything
happening" half regardless.

**Presence is reported by the browser, not inferred by the daemon.** Nothing else in the
codebase reports window focus, and without it a tab left open overnight and a night of
work are the same state — which is the exact distinction the feature exists to draw. The
beacon lives in the top document rather than in the mod because a fullscreen mod view's
iframe is destroyed the moment it is hidden (`_hideMod` in `mod-manager.js`), so a beacon
inside the card would only report while you were looking at the card.

It POSTs every 30 seconds while focused, plus once on focus and once on blur, and sends
nothing at all while unfocused — an idle machine generates no traffic. It waits 15s after
boot before its first POST, because mod routes register after core's and `client-log.js`
beacons every ≥400 response into the daemon log. Three consecutive failures stop it until
settings re-arm it.

## Sleep

The daemon is frozen across a macOS sleep, so the wall-clock gap between two ticks can be
hours. Two rules keep that from inventing work:

- a sample credits **at most one interval**, never the real elapsed time;
- a gap longer than **two intervals** is recorded as *inactive* — we were not running,
  and "no evidence" is not "working".

## Storage

`~/.deepsteve/timecard.jsonl`, via `stateDir()`. Outside any repo, so it needs no
`.gitignore` entry — and specifically not the `.deepsteve/` entry that is forbidden
inside a repo, where project mods live.

One line per sample:

```json
{"t":1756600000000,"a":1,"m":5,"s":3}
```

`t` sample time · `a` active · `m` credited minutes · `s` live non-scheduled sessions.

Bounded at 120,000 rows and 400 days — about 5 MB, or 416 days at the default interval.
Loaded once into an in-memory mirror at boot; appended a line at a time; rewritten only
when trimming. The same shape as `terminal-run.js`'s `createRunLog`.

**The last row is the sampler's anchor.** There is no second state file recording when
the last sample was taken, which is the whole of "samples survive a restart". It is
clamped to the present on the way in (`resolveAnchor`): a row stamped in the future — a
clock that jumped forward and back, or a restored file — would otherwise park the anchor
ahead of `now`, making every elapsed check negative and stalling the sampler silently
until real time caught up.

## Aggregation

Happens on read. `GET /api/timecard` returns all three datasets in one response, so the
card switches views with no round trip.

| View | Buckets | Range | Stats |
|---|---|---|---|
| Day | 2-hour blocks, 8a–8p | `Monday 31 Aug` | Per block · Longest block · Idle blocks |
| Week | Mon–Sun | `Mon 24 – Sun 30 Aug` | Daily average · Longest day · Days off |
| Month | Monday-anchored weeks, clipped to the month | `August 2026` | Weekly average · Biggest week · Quiet weeks |

Details that are deliberate rather than incidental:

- **Averages divide by periods with hours logged**, not by period count. A week with two
  days off is not a week of five-sevenths days.
- **A sample is credited to the bucket its minutes started in**, not the one its
  timestamp lands in — otherwise the last few minutes of every bucket spill into the
  next.
- **A bucket is clamped to its own duration**, so "Longest block" can never report 4.5
  hours for a two-hour block.
- **Bars scale to a per-view max** (Day 2h, Week 12h, Month 60h), raised only when the
  data would clip. A slow week must not look like a busy one.
- **The Day view only shows 8a–8p.** Hours outside that window are counted in the Week
  and Month views but have no bar of their own, and the Day headline is the sum of the
  bars on screen — the number and the chart never disagree.
- Local time throughout; the week starts Monday.

## The card

Rendered in the mod's iframe, in vanilla JS. Mod iframes receive no theme variables, so
`timecard.js` mirrors the host's computed `--ds-*` tokens onto its own `:root` and
re-mirrors on a `MutationObserver` when the theme changes. Every `var()` also carries a
fallback, so a failed mirror degrades to legible dark rather than
transparent-on-transparent. Both halves are pinned by the shape test — including that the
mirror's token list covers every token the CSS paints with, which is otherwise a
half-themed card nobody notices.

Hovering a bar floats a readout — `Thu · 7.6h` — over the chart, anchored just above
that bar's top edge and dropping just inside it when a tall bar leaves no room. It is
positioned rather than laid out, so the fixed 120px chart never grows and the axis below
it never shifts. The hit area is the whole column (a `::before` bleeding half a gap to
each side), because a zero day is a 2px hairline and a quiet one is a sliver — neither is
something a pointer can land on. The native `title` tooltip is deliberately not used: it
appears below and to the right of the cursor after a delay, which is neither over the bar
nor immediate.

While the store is empty the card shows seeded example data and says so in the range
line; the note disappears the moment a real sample lands. A paused sampler says
`sampling off` there for the same reason — a frozen chart should not read as a quiet week.

## Settings

Both in `SETTINGS_SCHEMA`, because a mod's own enable/disable is per-browser localStorage
and never reaches the server.

- `timecardEnabled` (boolean, **default true**) — read live each tick, so toggling it
  stops and starts sampling with no restart. It also arms the browser beacon, so turning
  it off means no traffic at all.
- `timecardSampleMinutes` (1 / 5 / 15, **default 5**) — `custom` rather than `enum`,
  because `coerceSetting`'s enum branch would store the string `"5"`. An out-of-set value
  is rejected into the POST response's `warnings` rather than silently defaulting. The
  tick runs at a fixed 1-minute cadence and reads this live, so there is no timer to
  restart.

## Tests

```bash
node --test test/unit/timecard-store.test.js      # sampling decisions + aggregation
node --test test/unit/timecard-mod-shape.test.js  # manifest, geometry, theming, framing
node --test test/unit/timecard-presence.test.js   # beacon gating and backoff
```

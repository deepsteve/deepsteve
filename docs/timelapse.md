# Timelapse

A recording circle above the panel tabs. Click it and deepsteve writes a screenshot plus a
JSON snapshot of the tab layout every five minutes, into one folder per run. Running it for
a day answers two questions the app cannot otherwise answer about itself: **how many tabs
get opened**, and **how much of the day is actually spent here**.

The JSON is what the counting is done from. The PNGs are for looking at.

## Storage

```
~/.deepsteve/timelapse/<runId>/
  run.json      manifest: startedAt, windowId, intervalMs, frames, lastFrameAt
  0001.png      the window
  0001.json     the sidecar
  0002.png
  0002.json
  …
```

`runId` is `<YYYYMMDD-HHMMSS>-<windowId>`, so runs sort chronologically and a folder says
which browser window made it. A day at five minutes is ~288 frames.

**Nothing prunes this.** Screenshots age out after 7 days; a timelapse run does not, because
a run is a record somebody chose to make and one silently ageing out would destroy the thing
it exists to be. `DELETE /api/timelapse/runs/:runId` is the disposal path, and
`GET /api/timelapse/runs` reports `bytes` per run so the cost is visible. Frames are captured
at **half scale** (`FRAME_SCALE` in `public/js/timelapse.js`), which puts a day at tens of MB
rather than hundreds while leaving terminal text legible enough to see what a tab was doing.

## Endpoints

| Route | Does |
|---|---|
| `POST /api/timelapse/frame` | Write one PNG + sidecar. Server allocates the `NNNN`. |
| `GET /api/timelapse/runs` | List runs with frame count and bytes. |
| `GET /api/timelapse/runs/:runId/summary` | `summarizeRun()` over the sidecars. |
| `DELETE /api/timelapse/runs/:runId` | Remove a run. |

`runId` becomes a path segment, so it is validated twice on every route — a charset that
cannot express `/` or `..` (`/^[A-Za-z0-9._-]{1,120}$/`), then `pathInside()` containment.

All but `DELETE` are gated on `settings.timelapseEnabled`, read live so the toggle needs no
restart. `DELETE` deliberately is not: turning the feature off must never strand a run's disk
usage behind a setting you just flipped.

`POST /api/timelapse/frame` carries a base64 PNG, so `/api/timelapse` is on the
global-body-parser skip list in `server.js` next to `/api/screenshots`, and the route declares
its own `express.json({ limit: '50mb' })`. Without the skip, the default 100 KB parser rejects
every frame before the route sees it.

## Settings

- `timelapseEnabled` (default `true`) — the feature is present but completely inert until
  the circle is clicked. Off hides the circle and refuses new frames.
- `timelapseIntervalMinutes` (default `5`, clamped 1–60).

Both are broadcast: the browser owns the timer and the circle, so a change in one window has
to reach the others. A mod's own enable/disable is per-browser localStorage and never reaches
the daemon, which is why these are `SETTINGS_SCHEMA` entries and why timelapse is not a mod.

## Why the recorder is in the browser, and what that costs

Capture renders the live DOM, so it needs an attached browser — the same constraint
`screenshot_capture` has. Recording is therefore a browser-side timer, and **a closed browser
simply leaves a hole**. That hole is not a defect to be patched: it *is* the answer to "how
much time did I spend", so nothing backfills it and `summarizeRun()` reports it as a gap.

Three consequences worth knowing before changing anything here.

**The deadline is wall-clock, never a tick count.** Browsers clamp `setInterval` in a hidden
tab — Chrome to roughly once a minute after five minutes hidden — which is most of a working
day for a background deepsteve. So the timer fires every 15s and does nothing but compare
`Date.now()` against a stored deadline; `visibilitychange` and `focus` also poke it, so
returning to the tab takes an overdue frame immediately rather than waiting out the clamp.

**A late capture re-anchors to now, not to the deadline it missed.** Anchoring to the missed
deadline makes a tab that was hidden for an hour fire twelve captures back to back, all of the
same screen — twelve identical frames that hide the very gap the run is there to show. Every
sidecar records `capturedAt` next to the `expectedAt` it was aiming for, so lateness is
visible rather than smoothed away.

**Run state lives in `sessionStorage`**, under `nsKey('deepsteve-timelapse')`. That is exactly
the right lifetime: it survives a page reload and a `./restart.sh --refresh`, so a run
continues into the *same* folder, and it dies with the browser tab, so a genuinely new window
starts a genuinely new run. Each window records its own stream — two windows have two tab
strips, and merging them would make "how many tabs did I open" unanswerable.

## The picture is chrome-accurate and iframe-blank

Frames capture `#app-container` with `divertToIframe: false`.

`modern-screenshot` cannot see inside an iframe, and `contentIframeOf()` normally redirects a
capture into any child iframe covering ≥50% of the target — which is right for
`screenshot_capture` on a display tab, and wrong here: with a fullscreen App on screen, or a
display-tab / project-mod tab active, diverting would return that app and throw away all the
chrome the frame exists to record. So timelapse does not divert, and **iframe regions render
blank**. The sidecar names the active tab and its type, so a blank frame is still
interpretable.

## The join, and where it lives

A frame is assembled from both sides, because neither can answer the question alone:

- **The browser** knows the tab *strip* — order (derived from `#tabs-list` DOM order, the same
  derivation `app.js`'s `getAllTabIds` uses), titles, which tab is active, which are hidden by
  the context filter, and the window's own state: viewport, `visibilityState`,
  `document.hasFocus()`, and a window-level last-input stamp.
- **The daemon** knows the *sessions* — `agentType`, `worktree`, `cwd`/`repoRoot`, `engineType`,
  and the `busy | idle | unknown` tri-state from `sessionInputState()`.

`agentType` is the clearest case: the server sends it on the session message and the browser
drops it, so a client-side join could never produce it. The tri-state is the subtler one — the
browser holds only the collapsed `waitingForInput` boolean, and "at a prompt" and "never
classified" are different answers to "was I working".

The join is `enrichTabs()` in `timelapse-snapshot.js`, a root-level pure module (like
`screen-classifier.js`) so `test/unit` can exercise it without booting a daemon. Rows
deliberately use the `list_sessions` field names, so a script that reads one reads the other.

**The window-level input stamp is new.** The daemon tracks `lastInputTime` per *session*;
nothing tracked it per *window*, and per window is what separates "deepsteve was open" from
"deepsteve was being used". `timelapse.js` stamps `keydown`/`pointerdown`/`wheel` in the
capture phase (so a handler that stops propagation cannot hide it) and passive (so it costs
the input path nothing).

## The indicator

A `<button class="timelapse-dot">` mounted as the **first child of `#panel-tabs`** via
`ModManager.mountRailIndicator()`.

There is no bespoke "Action Required rail" — `#panel-tabs` is the generic vertical panel-tab
strip, and "Action Required" is just the label of its first tab. Mounting at the top of that
flex column means overlap with the rail chrome is impossible by construction, and the dot stays
top-right in **both** layouts (under `vertical-layout`, `#content-row` starts at `y=0`) and
survives quiet mode. Anything in `#tabs` would have moved to the *left* rail in vertical layout
and vanished entirely under ⌘\.

The strip used to hide itself whenever `panelTabs.size === 0`; `_updatePanelTabsVisibility()`
now ORs in the indicator, because the dot *is* the stop button and a hidden strip would be a
run with no way to end it. It counts the indicator's **visibility**, not merely its existence
— timelapse turned off with no panel mods enabled would otherwise leave a bare 26px bordered
column standing next to nothing. mod-manager owns the strip and timelapse owns the dot, so the
dot announces its own show/hide through `ModManager.setRailIndicatorVisible()` rather than
mod-manager reading a style off an element it does not own.

Idle is a hollow ring, armed is solid plus the shared `@keyframes pulse`. The shape carries
the state as well as the colour, because `win-95.css` and `ascii-art.css` restyle this corner
with `!important` and a hue-only distinction would not survive them. The colour is its own
token, `--ds-recording`: `--ds-accent-red` is reserved for destructive actions and is already
the `.panel-tab-badge` colour, so a bare red dot on that strip would say two things at once.

## Tests

```bash
node --test test/unit/timelapse-snapshot.test.js   # the join + the summary arithmetic
node --test test/unit/timelapse-recorder.test.js   # deadlines, reload survival, the off switch
node --test test/unit/dom-capture-shared.test.js   # one capture path, not two
```

The recorder suite drives `tick()` by hand against a frozen `Date.now()`, so "what happens
after an hour hidden" is one assertion rather than a real wait.

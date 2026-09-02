# Frontend

The browser side: the shortcut registry every global key binding must go through, the command
palette, what the terminal does with a wheel and a selection, and the storage layers that make
tabs survive a refresh, a second window, and being nested inside deepsteve's own Baby Browser.

The frontend is vanilla ES modules with no build step — see `AGENTS.md` for the style rules.

## Command Palette

Cmd+K opens a command palette for keyboard-driven access to tabs, settings, and custom user scripts.

- **Settings**: `commandPaletteEnabled` (default `true`) and `commandPaletteShortcut` (default `Meta+k`) follow the 3-place settings pattern (defaults, POST handler, broadcastSettings).
- **Built-in commands**: Hard-coded in `BUILTIN_COMMANDS` array (new-tab, close-tab, settings, mods, next/prev-tab). Client dispatches these via callbacks.
- **Custom commands**: Executable files in `~/.deepsteve/commands/`. Optional `.json` sidecar for name/description metadata. Executed server-side under `resolveLoginShell()`'s shell with its login flag (for PATH; literally `zsh -l -c` before #621). Not the same as Skills (which are Claude slash commands in `skills/*.md`).
- **API**: `GET /api/commands` returns built-in + custom commands. `POST /api/commands/execute` runs a custom command by ID.
- **Client**: `command-palette.js` is a self-contained ES module (like `cmd-tab-switch.js`) with `init()`, `setEnabled()`, `setShortcut()` exports.

## Hash Commands (`public/js/hash-commands.js`)

`#` typed at the start of an empty input line opens a client-side palette (`#terminal`, `#tab`,
`#close`, `#settings`, `#mods`) that runs in the browser with no PTY round-trip. Setting:
`hashCommandsEnabled` (default `true`). It hooks `term.onData` through `beforeSend`, so the
keystroke is consumed rather than forwarded — which is why getting the "is the line empty?"
question right matters: a wrong yes makes a literal `#` untypeable.

**Activation ANDs two signals, and neither can be dropped (#634).**

- `public/js/composer-caret.js` reads the **live xterm buffer** and returns `empty` / `busy` /
  `unknown`. In an agent tab it reads the composer box's contents (`readComposerDraft`, a port of
  root `composer-state.js` — pinned to the original by an agreement test in
  `test/unit/composer-caret.test.js` that runs every fixture through both copies). It deliberately
  does **not** anchor on the caret there: Claude draws its own inverse-video cursor, so the
  hardware cursor is parked wherever Ink's last frame write ended, and an empty box implies the
  caret is at its front anyway. In a **shell** tab there is no box, but readline does park the real
  cursor at the input position, so the caret row decides — and that path may only ever answer
  `busy` or `unknown`, never `empty`, because a shell prompt is arbitrary text (`echo foo > ` ends
  in a sigil and would otherwise read as an empty prompt).
- A **per-terminal keystroke mirror** covers the window between a keystroke and its echo, during
  which the screen still shows an empty composer. It was module-global before #634, so text typed
  in one tab blocked `#` in every other.

`unknown` — a full-screen TUI, a startup banner, a permission dialog, an idle shell prompt — falls
back to the mirror alone, i.e. the pre-#634 behavior. That fallback is why the mirror cannot be
deleted, and it means the screen read can only ever *veto* an activation, never cause one.

A stale mirror (something cleared the composer that we never saw — `/clear`, a server-injected
prompt) is resynced from the screen at `#`-press time, but only once a repaint has landed **and**
a short grace has elapsed; a repaint alone is not proof, because a working turn repaints on every
spinner frame. `setWaitingForInput()` no longer wipes it: that blind wipe *was* #634, since the
screen classifier reports a composed-but-unsent message as "waiting" by design and `app.js` also
calls it unconditionally on tab switch and on reconnect.

## Terminal wheel, keys, selection and clipboard

Four facts about the terminal that are expensive to re-derive, and two of them were bugs for a release.

**xterm 6 turns a wheel into arrow keys when it has no scrollback and no mouse protocol.** Its wheel listener runs only when no wheel-carrying mouse protocol is bound; then, if `buffer.hasScrollback` is false, it emits `ESC[A` / `ESC[B` and sends them as input. Under tmux the client owns the outer alternate screen, so `hasScrollback` is permanently false — which is why scrolling any tab walked the agent's prompt history until #650 turned tmux's `mouse` on. The fix is server-side (see [terminal-engines.md](terminal-engines.md)); what matters here is the shape of the dependency: **the browser stops producing arrow keys because tmux enables mouse reporting, not because of anything in `public/js/`.** If scrolling ever regresses to history-walking, check `term.modes.mouseTrackingMode` first — `'none'` means the mode-set never arrived and the bug is on the tmux side.

**The ctrl-wheel guard must never `preventDefault` (#583).** macOS pinch-zoom arrives as a wheel with `ctrlKey: true`, and xterm cancels every wheel it sees — its mouse-report path unconditionally, its scrollable-element path whenever the wheel moved anything. `handleTerminalWheelCapture` in `terminal.js` is a **capture-phase, passive** listener on `#terminals` that `stopPropagation()`s ctrl-wheels so they never reach xterm's own listeners; passive is what leaves the browser's zoom default to proceed. Capture on an ancestor is the only reliable interception, because xterm's handlers stop propagation themselves and `attachCustomWheelEventHandler` covers only one of the two paths.

**Selection and copy changed shape with mouse reporting on.** A drag over the terminal is now reported to tmux or to the pane's program, so it is *their* selection, not the browser's. Browser-native selection is still available as the force-selection gesture — **⌥+drag on macOS, ⇧+drag elsewhere** — and on macOS xterm gates that on `macOptionClickForcesSelection`, which defaults to false, so `createTerminal()` sets it. Copies made on the other side come back as **OSC 52**, which xterm 6.0.0 has no handler for (it registers 0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112). `public/js/osc-clipboard.js` supplies one. Three things about it are not optional:

- **A `?` payload is a clipboard *read* request and is never answered.** Replying would let anything in any pane exfiltrate the user's clipboard over the PTY.
- **The handler must stay synchronous.** xterm pauses its parser on a thenable OSC result, so awaiting the clipboard would stall the terminal behind a permission prompt. It always returns `true`, so a `?` or an undecodable payload cannot fall through.
- **It stays inert until the tab has seen a gesture.** The daemon replays a session's whole scrollback on every WebSocket connect, so every OSC 52 the pane ever emitted is re-delivered on a page refresh; writing the clipboard from a page load nobody asked for would eat whatever the user had copied elsewhere. A real copy is always downstream of a pointerdown or a keydown in the tab. (Residual, accepted: a mid-page reconnect can re-fire the session's most recent OSC 52 once. If that ever bites, strip OSC 52 from the replay server-side rather than adding client heuristics.)

**xterm 6 dropped xterm 5's macOS Alt+Arrow remap, and ⌥←/⌥→ went dead (#652).** `@xterm/xterm@5.5.0`'s `case 37` rewrote `ESC[1;3D` into `ESC b` on macOS (and `ESC[1;3C` into `ESC f`); 6.0.0 emits the bare CSI form. That form is *not* the problem it looks like: the Claude Code composer parses modifier param 3 as `meta` and jumps a word on it, and **tmux forwards it to the pane byte-for-byte** — it is in tmux's key tree unconditionally, `IMPLIED_META` and all, so no `extended-keys` or `terminal-features` option is involved. What broke is the shell: zsh and readline bind `ESC b`/`ESC f` to word motion and nothing to `ESC[1;3D`. So `terminal.js` restores the xterm 5 translation, macOS only, in the same `attachCustomKeyEventHandler` as Shift+Enter — and unlike Shift+Enter it needs no `suppressNextEnter` twin (an arrow produces no `input` event on the hidden textarea) but *does* need an explicit `preventDefault()`, because returning `false` makes xterm bail before its own `cancel()`. **⌥ now means two different things on macOS**: word motion from the keyboard, force-browser-selection from a drag. Different xterm code paths, so they don't collide. Tests: `test/unit/terminal-word-motion.test.js`, and `test/integration-standalone/tmux-word-motion.test.js` for the byte actually surviving tmux.

Base64 is decoded through `TextDecoder`, not straight off `atob` — `atob` yields bytes, and handing those to the clipboard mojibakes every accent and box-drawing glyph. `navigator.clipboard` is absent outside a secure context (the canonical `deepsteve.localhost` origin is one; a plain-HTTP LAN address is not), so there is a hidden-textarea `execCommand('copy')` fallback that restores focus afterwards. Tests: `test/unit/terminal-wheel-guard.test.js`, `test/unit/osc-clipboard.test.js`.

## History pane (`public/js/session-history.js`, #672)

An agent tab has no scrollback to scroll — Claude Code repaints inside its own alternate screen, so tmux history and xterm scrollback are both 0 rows ([terminal-engines.md](terminal-engines.md)). The pane reads the agent's `~/.claude/projects/<project>/<uuid>.jsonl` instead, through `GET /api/shells/:id/transcript`.

**It belongs to a tab, not to the window.** It mounts inside that session's `.terminal-container` — the ⌘F search-bar precedent, not the full-bleed Scheduled History one — so switching tabs hides it with its container. Two consequences that are easy to undo by accident: `switchTo()` must **not** close it the way it closes the search bar, and it must call `SessionHistory.focusIfOpen(id)` **before** `term.focus()`, or the terminal behind a visible pane takes the keyboard and every arrow key goes to the agent.

**The affordance is one glyph on the tab.** `.tab-history` sits in `TAB_INNER_HTML` beside `.close`, carries an `aria-label` and deliberately no `title` (a child title shadows the tab's own), and is revealed by `.has-history` — set from the `agentType` the server has always sent on the session socket. It is in the collapsed icon-rail's hide-list; a glyph surviving into a 48px rail is the rendering fault `619571f` removed. There is **no global key binding**, so the `shortcuts.js` registry and its drift guard are untouched: the tab glyph, the tab's right-click menu and a ⌘K palette entry are the three routes, and ⌘Y/⌘⇧H are browser-owned anyway.

**The loaded range extends at both ends.** `?before=` walks backwards, `?after=` forwards and doubles as the live tail (idle, it is one `stat` and zero reads); "Beginning" and "Latest" reload at an end rather than walking there, because the largest transcript measured is 139 MB. Two rules the client cannot drop: terminate paging on `cursor.hasMore`, **never** on `entries.length` (a window can be entirely bookkeeping and yield zero entries with history still behind it), and discard everything when the echoed `claudeSessionId` changes, because a fork or a plan-mode exit starts a new file and a byte cursor into the old one is meaningless.

**Reading position** is `sessionStorage` under `nsKey('deepsteve-history-pos')`, anchored on a message `uuid` rather than a pixel offset — the transcript grows and the window resizes, and both move a pixel. Reopening walks back a bounded number of pages looking for that anchor before giving up and staying at the tail.

Tests: `test/unit/session-history-client.test.js` (the folding, grouping and formatting helpers), plus `transcript-view` / `transcript-window` for the server halves.

## Keyboard Shortcuts (`public/js/shortcuts.js`)

**Every global key binding is declared in the `shortcuts.js` registry, and the ⌘? overlay (`shortcuts-help.js`) renders `getAll()`. The list is never hand-maintained** — that's the whole point of #549, and before it there were four independent capture-phase listeners with `parseShortcut`/`matchesShortcut` copy-pasted verbatim into two of them.

The registry is **load-bearing, not documentation**: `register()` returns the matcher the module must use in its `onKeyDown`, so there is no way to change a binding without editing its entry. Call it at **module scope**, not in `init()`, so the entry and the matcher are a single statement that can't be separated.

```js
const matchesShortcut = register({
  id: 'command-palette', group: 'General',
  description: 'Open the command palette',
  getShortcut: () => shortcut,   // live setting value; or `shortcut: 'Meta+f'` if hard-coded
  isEnabled: () => enabled,      // overlay hides the row when this is false
});
```

- **`shortcut` xor `getShortcut`** — either may be a string **or a list of alternates**. Both throw if you pass both or neither.
- **`match: 'key' | 'code'`** (default `'key'`) — `e.key` is the *layout character*, `e.code` the *physical key*. Letters that should survive Dvorak/AZERTY use `'code'` (context-views' ⌘P); punctuation **must** use `'key'` (⌘⇧? is `code:'Slash'` on US but `'Minus'` on German). `match:'code'` throws at import time if paired with `getShortcut` (the settings recorder only emits `e.key` tokens, so it could never fire) or with a key that has no code (`ArrowUp`).
- **Strict modifier equality** is what keeps Ctrl+F reaching the PTY for vim's `<C-f>` while ⌘F opens search. Pinned by a test — don't loosen it.
- **`registerInfo()`** is for bindings the matcher can't express (hold-⌘ tab switching, the ⌘P→A chord, and the two keys xterm consumes for itself — Shift+Enter and macOS ⌥←/⌥→). These are *not* enforced, so put them **next to their real handler** and edit them together. `combine: 'then'` renders a sequence, `'or'` (default) renders alternates.
- **One key, two meanings needs two entries.** ⌘↑/⌘↓ cycles projects at home and walks an App's queue while you are out on an excursion (#661), so both `context-cycle` and `app-queue-cycle` are declared with mutually exclusive `isEnabled` closures. The overlay then shows exactly the live one — which is the whole reason an overload has to be paid for in the registry rather than hidden in a handler. ⌘← (`app-back`) also overlaps the ⌘-hold tab switcher, which claims ← only after a full second of holding ⌘; `context-views.js` skips its branch while `#tabs` carries `.tab-switch-mode`, because capture-phase `stopPropagation()` does **not** stop other listeners on the same node.
- **A binding the top document cannot hear needs a second home.** Global listeners are capture-phase on the **top** document, and keystrokes inside a mod iframe never cross that boundary — so a host-registered key is dead exactly while an App has focus. Quiet mode's ⌘\ (`app-quiet`, #662) is registered here *and* bound inside `mods/workshop/workshop.jsx`, which calls `deepsteve.toggleQuiet()`. The registry entry is still required: it is what the ⌘? overlay renders, and it is what fires when chrome has the focus instead — during an excursion, say. Punctuation forces `match: 'key'` for the same reason an arrow does.
- **Arrow keys**: `formatShortcut` maps `ArrowLeft/Right/Up/Down` to `←→↑↓`, so a real `register()` entry displays properly. They must use `match: 'key'` — `keyToCode()` maps only letters and digits, so `match: 'code'` throws at import time for an arrow.
- **`shortcutsHelpShortcut` defaults to a two-item list** (`['Meta+Shift+?', 'Meta+/']`). macOS auto-assigns ⌘⇧/ to the Help menu Search field of any app with a Help menu — Firefox and Chrome both have one — and a menu key equivalent is consumed before the page sees the keydown. ⌘/ is the fallback so the overlay can't ship unreachable. It's a `custom` schema type (not `string`) because the value is a list; `sanitize` also accepts a bare string, which is what the Settings rebind button posts.
- **Tests**: `npm run test:unit`. `test/unit/shortcuts-registry.test.js` asserts the **exact set of registered ids** — if you add or rename a binding, update that list. That is the drift guard.

## Projects panel motion (`public/js/context-views.js`, #691)

The rail (`#context-rail`, ⌘P) slides open and closed instead of flipping `display`. Four things
about how, because each was a bug before it was a rule:

- **It animates `width`, not a transform.** The rail is a flex *sibling* of `#app-main`, so a
  width animation is what carries the terminal's left edge along with the panel's. An overlay
  slide would have drawn the panel over live terminal output and snapped the terminal at t=0.
  The terminal's refit is a 100ms-debounced ResizeObserver (`terminal.js`), and the timer resets
  on every callback, so the whole slide costs exactly **one** `fit.fit()` after it settles.
- **`display: none` stays the resting closed state**, so the open sets it first and the close
  clears it on `transitionend`. The rail's drag handle and its `border-width` ride the same
  classes — left to pop in at full size they put a visible step on the terminal at one end of
  every toggle (6px, or 14px under a bezelled theme).
- **Contents are pinned to the target width** (`--ds-rail-anim-w`, set inline from
  `rail.clientWidth`) and clipped by the rail's `overflow-x: hidden`, so they are *revealed* by
  the moving edge rather than squeezed — labels never ellipsise and un-ellipsise mid-slide. The
  6px content parallax is scoped to a `.rail-opening` class that lives only for one open, because
  `renderRail()` also runs on tab open, project switch and row drag.
- **Reduced motion is gated in JS (`railCanAnimate()`), not only in CSS.** The close defers
  `display: none` to `transitionend`, and a transition suppressed by a media query never fires
  one — the rail would stay on screen forever. A `setTimeout` sized from the computed duration
  is the same insurance for a theme that sets `0s` or a tab backgrounded mid-slide.

`window.matchMedia` is also what the gate keys on, which is why `context-views.test.js`,
`excursion-keys.test.js`, `apps-rail.test.js` and `quiet-mode.test.js` still see the original
synchronous flip: their fake DOMs have no media queries. `test/unit/rail-animation.test.js` is the
only suite that stubs it, and so the only one that exercises the animated path. Timing lives in
four `--ds-context-*` tokens ([docs/themes.md](themes.md)); `0s` opts a theme out.

## Client-side storage

- **Two-tier session storage**: `TabSessions` (sessionStorage) is the authoritative per-tab source that survives page refresh. `SessionStore` (localStorage) is for cross-tab/window coordination (orphan detection, restore modal). **Every mutation of both goes through the single write facade `public/js/session-stores.js` (#385) — `SessionStores.add/remove/rename/reorder` write both stores in one call, so they can't drift; app.js never mutates either store's session list by hand.** `TabSessions` now lives inside that module (unexported), so it can only be written via the facade; reads use `getTabSessions()` / `SessionStore.getWindowSessions()`. The facade owns *dual* writes and *all* `TabSessions` writes (incl. the TabSessions-only `updateId`/`setClaudeSessionId`/`clearTabSessions`/`addTabOnly`); `SessionStore`'s standalone window/pref writes (`addRecentDir`, `touchWindow`, `claimSessions`, dir-picker prefs) have no `TabSessions` twin and stay direct.
- **Orphan detection**: Uses BroadcastChannel for cross-tab heartbeats. When a new tab opens and finds localStorage windows with no heartbeat response within 1.5s, those sessions are offered for restore.
- **Per-window view state** goes in `sessionStorage` through `nsKey`, like the excursion stack (`deepsteve-excursion`, #661): it survives a reload, dies with the window, and cannot leak into a second one. The counterpart is `localStorage` for things that are a *preference* rather than a place — which app is open (`deepsteve-active-mod-view`) and which apps you sit in with the chrome gone (`deepsteve-app-quiet`, #662) are browser-wide; where you wandered from one is not.
- **The projects rail's five keys straddle that line, and which side each falls on is the whole point.** *Place* is per-window: the active project (`deepsteve-context-active`) and its last tab (`deepsteve-context-last-tab`). *Appearance* is a browser-wide preference in `localStorage`: whether the rail is open (`deepsteve-context-sidebar`), how wide it was dragged (`deepsteve-context-width`), and whether Archived is expanded (`deepsteve-context-archived`) — all three through `loadPref`/`savePref` in `context-views.js`, alongside the compact-rail flag that was already there. Appearance has to outlive the window because the daemon opens a **brand-new browser tab at login**, which has no `sessionStorage` at all: a rail stored per-window came back closed after every machine restart, however you had left it. `loadPref` still reads the old `sessionStorage` home as a fallback so a tab open across the upgrade keeps its rail, and `savePref` clears that key only once the `localStorage` write has landed — in a private window it throws, and per-window persistence beats none.
- **Recursive windows (Baby Browser)**: Opening DeepSteve inside its own Baby Browser proxy shares the same origin, so sessionStorage/localStorage/BroadcastChannel would collide. `storage-namespace.js` detects iframe nesting depth and prefixes all keys with `ds{depth}-` (e.g., `ds1-deepsteve`). Depth 0 (top-level) uses no prefix for backward compatibility. Each recursion level gets fully isolated sessions, tabs, and layout state.

## Opening a WebSocket

**Every socket in the client is constructed by `openGatedSocket()` in `public/js/ws-open.js`, and nowhere else.** `test/unit/ws-single-construct.test.js` asserts that `new WebSocket(` appears exactly once under `public/`.

The reason is a browser-wide penalty, not a local one. Firefox implements RFC 6455 §7.2.3 by keying a FailDelay entry on `{address, path, port, originSuffix}`, where `path` comes from `GetFilePath()` and **excludes the query string**. Every DeepSteve socket is `ws://host/?params` → path `/`, so there is **one entry for the whole browser**, shared across tabs, windows and nested Baby Browser instances. Each failed handshake ramps it ×1.5 to a 60s cap; a later connect to a delayed host is parked in `CONNECTING_DELAYED` behind a timer with no traffic and **no error event** — it just sits in `readyState CONNECTING`. The entry only expires 60s + the current delay after the *last* failure, so a client that keeps retrying keeps it alive forever. **No backoff schedule can dig us out. The only winning move is to never create the entry.**

The gate has two halves and both are load-bearing:

1. **`waitForServer()`** (`server-probe.js`) — is the server there? HTTP runs through a different subsystem with no shared failure accounting, so probing is free where a handshake is not.
2. **`maybeHealAuth()`** (`auth-heal.js`) — will it accept *us*? A missing or stale `ds_auth` cookie makes `verifyWsClient` reject the upgrade with 401, and the browser reports that as close code 1006 — indistinguishable from "server down". Since #674 the probe resolves to a verdict (`ok` / `unauthed` / `down` / `unknown`) and the gate **refuses to emit a handshake it has been told will be rejected**, including when auth-heal's 60s one-reload guard has suppressed the reload that would fix it. It carries an `AbortSignal.timeout` for the same reason `serverUp()` does: callers await it, so a fetch that never settles would park every reconnect loop in the window on one dead promise.

Both callers — `ws-client.js` (terminal sessions) and `live-reload.js` (the reload/beacon socket) — run the same loop shape: park while `window.__deepsteveReloadPending` is set, ask the gate, and on a refusal pace the retry (`backoffDelay()`, 1s→30s jittered) rather than spin. `openGatedSocket` returns `{ socket, reason }`; a `null` socket is *not* a failed attempt and must not be counted as one.

Two failures this replaced, both of which looked correct when written:

- `live-reload.js`'s `connect()` at the end of `initLiveReload()` fired unconditionally at every page load — the one ungated handshake in the tree, and on a machine reboot a guaranteed failure, because the browser restores the tab before the daemon is listening.
- Its reconnect path (`onclose` → `pollAndReconnect()` → `connect()`) had no backoff and no failure accounting at all, so a server that was up but rejecting the cookie produced a fresh doomed handshake every fetch round trip. That loop poisons the browser and then falls silent, because once the entry is ramped its own handshakes stop reaching the server too — which is why the daemon log shows very few rejected upgrades for a very large outage.

Mods are not scanned by the guard (they are user- and agent-authored), but the rule applies to them: a mod runs in a nested realm that shares the same entry. A mod that needs a socket should import `openGatedSocket`.

Three beacons from `ws-trace.js` report what the daemon cannot see, over the `client-log.js` channel: `ws-failed` (closed before ever opening — the arming event), `ws-slow-open` (opened after ≥3s with no error — a parked handshake), and `ws-abandoned` (still `CONNECTING` at `pagehide`).

## Saying so: connection and auth status (#556, #676, #677)

Everything above is about recovering quietly. This section is about the cases where quiet
recovery is the wrong answer, because the user is sitting in front of a tab that looks
normal and is not.

That was #677: a clobbered cookie meant every fetch 401'd and no fresh handshake could be
accepted, for two minutes, with **no banner, no badge, no toast**. The sockets that were
already open had authenticated at handshake time and stayed up, so nothing repainted.
Typing went nowhere. The only way to find out was to read the daemon log.

### The page-level banners

Four of them, all at `top: 12px` centred, deliberately sharing one spot so two cannot both
claim to be the headline. They are ordered by how much they outrank each other as an
*explanation*:

| Banner | Class / z-index | Shown when |
|---|---|---|
| Pending create | `.pending-session-banner` / 2600 | a brand-new session's first connect is slow (#563) |
| Connection lost | `.reconnect-banner` / 2600 | ≥1 socket reconnecting for longer than `graceMs` (#556) |
| Refused session | `.session-error-banner` / 2601 | the server declined to spawn — persistent, dismissible (#632) |
| Auth broken | `.auth-banner` / 2602 | the daemon is answering and refusing our credentials (#676) |

The reconnect banner is **suppressed** while either of the other two states holds.
`syncBannerSuppression()` in `app.js` is the single choke point — it reads both
`pendingCreates.size` and `isAuthLost()`, so the two suppressors cannot clear each other.
During an auth outage "Connection lost — reconnecting…" is not merely redundant, it is
**wrong**: the server is answering and no amount of waiting will help.

### The auth state lives in `auth-heal.js`

`authLostStatus` is `0` when credentials are known good, else the status that condemned
them. `onAuthLost(cb)` subscribes to the **transition** — a 401 storm is hundreds of
responses and must not be hundreds of banner renders — and fires immediately for a late
subscriber so a mod panel or modal doesn't miss the edge. `isAuthLost()` reads it.

| State | What the user sees |
|---|---|
| `401` / `429` | the reload-fixable wording plus a **Reload** button |
| `403` | the Origin/Host explanation and **no** button — a valid cookie against a disallowed origin, which reloading cannot fix |
| `AUTH_RELOADING` | "Re-authenticating — refreshing the page…", no button — `forcePageReload()` announces itself before navigating (#677), instead of the page just vanishing unexplained. Reverts if the meta-refresh watchdog trips |
| `0` | banner cleared, suppression released |

Two feeds, and both are needed. `api.js`'s fetch watch reports every same-origin `/api`
status to `noteAuthStatus()`. And `maybeHealAuth()` records its own probe verdict directly
(#677) — `ws-open.js`'s gate calls it without going through any fetch watch, so a tab whose
*sockets* were being refused used to set nothing page-level and stay silent until some
unrelated `/api` call happened to fail too. A tab that has gone quiet is exactly the one
that stops making requests.

A server that isn't answering (`down`, `unknown`) deliberately produces **nothing** here.
A daemon restart is not an auth failure, and a banner that cried "signed out" on every
bounce would be ignored by the time it mattered.

### Per-tab indicators

Both live on the tab's `.badge` slot, which works for background and placeholder tabs (the
terminal container is `display:none`, and pre-session there is no container at all):

- `TabManager.updateReconnecting` → `.tab.reconnecting`, orange — a socket that dropped.
- `TabManager.updateAuthBlocked` → `.tab.auth-blocked`, red — a socket the gate *refused to
  emit* (#677). Must stay **after** the orange rule in `styles.css`: equal specificity, and
  a blocked connection is also marked reconnecting.

The two need different responses from the user: orange resolves itself by waiting, red
never will. The same split applies to the container overlay —
`.terminal-container.auth-blocked::after` overrides "Reconnecting..." with "Signed out —
reload to reconnect", for the same reason the reconnect banner is suppressed.

`connection-status.js` drives both from one handle, so a connection cannot be in an
inconsistent pair of states. `noteBlocked()` is the #677 addition; blocked handles are
excluded from the reconnect banner's count, since they are not reconnecting in any sense
that banner's wording would survive.

### Two silences closed with it

A socket parked in the `/healthz` gate never reaches `attemptConnect()`, so
`onreconnecting` — which fires off a socket's *close* — structurally could not describe the
tab a user is most likely staring at. `ws-client.js` arms a `GATE_STALL_MS` (1.5s, matched
to `graceMs`) timer around the gate and reports a stall as a reconnect.

And `wrapper.send()` / `sendJSON()` return whether the write went out. Being inert while
the socket is down is correct — replaying keystrokes into a live PTY minutes later would be
worse — but it was *silently* inert, which is how the tabs swallowed input.
`setupTerminalIO`'s `onInputDropped` turns the first dropped keystroke into a throttled
toast and a `clientLog` entry.

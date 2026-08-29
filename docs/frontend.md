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

Five facts about the terminal that are expensive to re-derive, and two of them were bugs for a release.

**xterm 6 turns a wheel into arrow keys when it has no scrollback and no mouse protocol.** Its wheel listener runs only when no wheel-carrying mouse protocol is bound; then, if `buffer.hasScrollback` is false, it emits `ESC[A` / `ESC[B` and sends them as input. Under tmux the client owns the outer alternate screen, so `hasScrollback` is permanently false — which is why scrolling any tab walked the agent's prompt history until #650 turned tmux's `mouse` on. The fix is server-side (see [terminal-engines.md](terminal-engines.md)); what matters here is the shape of the dependency: **the browser stops producing arrow keys because tmux enables mouse reporting, not because of anything in `public/js/`.** If scrolling ever regresses to history-walking, check `term.modes.mouseTrackingMode` first — `'none'` means the mode-set never arrived and the bug is on the tmux side.

**The scrollbar is server-side too, for the same reason.** `hasScrollback` is what xterm gates its scrollbar on, so under tmux there was no scrollbar to draw — the `.scrollbar` div exists but carries class `invisible` and its slider fills the whole track. Nothing in `public/js/` can change that: the fix is a tmux option that stops the attach client claiming the alternate buffer (`browserScrollback`, see [terminal-engines.md](terminal-engines.md)). When diagnosing a missing scrollbar, `term.buffer.active.type` is the one-line check — `'alternate'` means the setting is off or the option never reached that session's client, and no amount of CSS will help. Note the wheel and the scrollbar move different things whenever the pane has asked for the mouse: the wheel goes to the agent, the scrollbar walks xterm's own history.

**The ctrl-wheel guard must never `preventDefault` (#583).** macOS pinch-zoom arrives as a wheel with `ctrlKey: true`, and xterm cancels every wheel it sees — its mouse-report path unconditionally, its scrollable-element path whenever the wheel moved anything. `handleTerminalWheelCapture` in `terminal.js` is a **capture-phase, passive** listener on `#terminals` that `stopPropagation()`s ctrl-wheels so they never reach xterm's own listeners; passive is what leaves the browser's zoom default to proceed. Capture on an ancestor is the only reliable interception, because xterm's handlers stop propagation themselves and `attachCustomWheelEventHandler` covers only one of the two paths.

**Selection and copy changed shape with mouse reporting on.** A drag over the terminal is now reported to tmux or to the pane's program, so it is *their* selection, not the browser's. Browser-native selection is still available as the force-selection gesture — **⌥+drag on macOS, ⇧+drag elsewhere** — and on macOS xterm gates that on `macOptionClickForcesSelection`, which defaults to false, so `createTerminal()` sets it. Copies made on the other side come back as **OSC 52**, which xterm 6.0.0 has no handler for (it registers 0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112). `public/js/osc-clipboard.js` supplies one. Three things about it are not optional:

- **A `?` payload is a clipboard *read* request and is never answered.** Replying would let anything in any pane exfiltrate the user's clipboard over the PTY.
- **The handler must stay synchronous.** xterm pauses its parser on a thenable OSC result, so awaiting the clipboard would stall the terminal behind a permission prompt. It always returns `true`, so a `?` or an undecodable payload cannot fall through.
- **It stays inert until the tab has seen a gesture.** The daemon replays a session's whole scrollback on every WebSocket connect, so every OSC 52 the pane ever emitted is re-delivered on a page refresh; writing the clipboard from a page load nobody asked for would eat whatever the user had copied elsewhere. A real copy is always downstream of a pointerdown or a keydown in the tab. (Residual, accepted: a mid-page reconnect can re-fire the session's most recent OSC 52 once. If that ever bites, strip OSC 52 from the replay server-side rather than adding client heuristics.)

**xterm 6 dropped xterm 5's macOS Alt+Arrow remap, and ⌥←/⌥→ went dead (#652).** `@xterm/xterm@5.5.0`'s `case 37` rewrote `ESC[1;3D` into `ESC b` on macOS (and `ESC[1;3C` into `ESC f`); 6.0.0 emits the bare CSI form. That form is *not* the problem it looks like: the Claude Code composer parses modifier param 3 as `meta` and jumps a word on it, and **tmux forwards it to the pane byte-for-byte** — it is in tmux's key tree unconditionally, `IMPLIED_META` and all, so no `extended-keys` or `terminal-features` option is involved. What broke is the shell: zsh and readline bind `ESC b`/`ESC f` to word motion and nothing to `ESC[1;3D`. So `terminal.js` restores the xterm 5 translation, macOS only, in the same `attachCustomKeyEventHandler` as Shift+Enter — and unlike Shift+Enter it needs no `suppressNextEnter` twin (an arrow produces no `input` event on the hidden textarea) but *does* need an explicit `preventDefault()`, because returning `false` makes xterm bail before its own `cancel()`. **⌥ now means two different things on macOS**: word motion from the keyboard, force-browser-selection from a drag. Different xterm code paths, so they don't collide. Tests: `test/unit/terminal-word-motion.test.js`, and `test/integration-standalone/tmux-word-motion.test.js` for the byte actually surviving tmux.

Base64 is decoded through `TextDecoder`, not straight off `atob` — `atob` yields bytes, and handing those to the clipboard mojibakes every accent and box-drawing glyph. `navigator.clipboard` is absent outside a secure context (the canonical `deepsteve.localhost` origin is one; a plain-HTTP LAN address is not), so there is a hidden-textarea `execCommand('copy')` fallback that restores focus afterwards. Tests: `test/unit/terminal-wheel-guard.test.js`, `test/unit/osc-clipboard.test.js`.

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
- **`shortcutsHelpShortcut` defaults to a two-item list** (`['Meta+Shift+?', 'Meta+/']`). macOS auto-assigns ⌘⇧/ to the Help menu Search field of any app with a Help menu — Firefox and Chrome both have one — and a menu key equivalent is consumed before the page sees the keydown. ⌘/ is the fallback so the overlay can't ship unreachable. It's a `custom` schema type (not `string`) because the value is a list; `sanitize` also accepts a bare string, which is what the Settings rebind button posts.
- **Tests**: `npm run test:unit`. `test/unit/shortcuts-registry.test.js` asserts the **exact set of registered ids** — if you add or rename a binding, update that list. That is the drift guard.

## Client-side storage

- **Two-tier session storage**: `TabSessions` (sessionStorage) is the authoritative per-tab source that survives page refresh. `SessionStore` (localStorage) is for cross-tab/window coordination (orphan detection, restore modal). **Every mutation of both goes through the single write facade `public/js/session-stores.js` (#385) — `SessionStores.add/remove/rename/reorder` write both stores in one call, so they can't drift; app.js never mutates either store's session list by hand.** `TabSessions` now lives inside that module (unexported), so it can only be written via the facade; reads use `getTabSessions()` / `SessionStore.getWindowSessions()`. The facade owns *dual* writes and *all* `TabSessions` writes (incl. the TabSessions-only `updateId`/`setClaudeSessionId`/`clearTabSessions`/`addTabOnly`); `SessionStore`'s standalone window/pref writes (`addRecentDir`, `touchWindow`, `claimSessions`, dir-picker prefs) have no `TabSessions` twin and stay direct.
- **Orphan detection**: Uses BroadcastChannel for cross-tab heartbeats. When a new tab opens and finds localStorage windows with no heartbeat response within 1.5s, those sessions are offered for restore.
- **Recursive windows (Baby Browser)**: Opening DeepSteve inside its own Baby Browser proxy shares the same origin, so sessionStorage/localStorage/BroadcastChannel would collide. `storage-namespace.js` detects iframe nesting depth and prefixes all keys with `ds{depth}-` (e.g., `ds1-deepsteve`). Depth 0 (top-level) uses no prefix for backward compatibility. Each recursion level gets fully isolated sessions, tabs, and layout state.

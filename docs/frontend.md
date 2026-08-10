# Frontend

The browser side: the shortcut registry every global key binding must go through, the command
palette, and the storage layers that make tabs survive a refresh, a second window, and being
nested inside deepsteve's own Baby Browser.

The frontend is vanilla ES modules with no build step — see `AGENTS.md` for the style rules.

## Command Palette

Cmd+K opens a command palette for keyboard-driven access to tabs, settings, and custom user scripts.

- **Settings**: `commandPaletteEnabled` (default `true`) and `commandPaletteShortcut` (default `Meta+k`) follow the 3-place settings pattern (defaults, POST handler, broadcastSettings).
- **Built-in commands**: Hard-coded in `BUILTIN_COMMANDS` array (new-tab, close-tab, settings, mods, next/prev-tab). Client dispatches these via callbacks.
- **Custom commands**: Executable files in `~/.deepsteve/commands/`. Optional `.json` sidecar for name/description metadata. Executed server-side under `resolveLoginShell()`'s shell with its login flag (for PATH; literally `zsh -l -c` before #621). Not the same as Skills (which are Claude slash commands in `skills/*.md`).
- **API**: `GET /api/commands` returns built-in + custom commands. `POST /api/commands/execute` runs a custom command by ID.
- **Client**: `command-palette.js` is a self-contained ES module (like `cmd-tab-switch.js`) with `init()`, `setEnabled()`, `setShortcut()` exports.

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
- **`registerInfo()`** is for bindings the matcher can't express (hold-⌘ tab switching, the ⌘P→A chord, xterm's Shift+Enter). These are *not* enforced, so put them **next to their real handler** and edit them together. `combine: 'then'` renders a sequence, `'or'` (default) renders alternates.
- **`shortcutsHelpShortcut` defaults to a two-item list** (`['Meta+Shift+?', 'Meta+/']`). macOS auto-assigns ⌘⇧/ to the Help menu Search field of any app with a Help menu — Firefox and Chrome both have one — and a menu key equivalent is consumed before the page sees the keydown. ⌘/ is the fallback so the overlay can't ship unreachable. It's a `custom` schema type (not `string`) because the value is a list; `sanitize` also accepts a bare string, which is what the Settings rebind button posts.
- **Tests**: `npm run test:unit`. `test/unit/shortcuts-registry.test.js` asserts the **exact set of registered ids** — if you add or rename a binding, update that list. That is the drift guard.

## Client-side storage

- **Two-tier session storage**: `TabSessions` (sessionStorage) is the authoritative per-tab source that survives page refresh. `SessionStore` (localStorage) is for cross-tab/window coordination (orphan detection, restore modal). **Every mutation of both goes through the single write facade `public/js/session-stores.js` (#385) — `SessionStores.add/remove/rename/reorder` write both stores in one call, so they can't drift; app.js never mutates either store's session list by hand.** `TabSessions` now lives inside that module (unexported), so it can only be written via the facade; reads use `getTabSessions()` / `SessionStore.getWindowSessions()`. The facade owns *dual* writes and *all* `TabSessions` writes (incl. the TabSessions-only `updateId`/`setClaudeSessionId`/`clearTabSessions`/`addTabOnly`); `SessionStore`'s standalone window/pref writes (`addRecentDir`, `touchWindow`, `claimSessions`, dir-picker prefs) have no `TabSessions` twin and stay direct.
- **Orphan detection**: Uses BroadcastChannel for cross-tab heartbeats. When a new tab opens and finds localStorage windows with no heartbeat response within 1.5s, those sessions are offered for restore.
- **Recursive windows (Baby Browser)**: Opening DeepSteve inside its own Baby Browser proxy shares the same origin, so sessionStorage/localStorage/BroadcastChannel would collide. `storage-namespace.js` detects iframe nesting depth and prefixes all keys with `ds{depth}-` (e.g., `ds1-deepsteve`). Depth 0 (top-level) uses no prefix for backward compatibility. Each recursion level gets fully isolated sessions, tabs, and layout state.

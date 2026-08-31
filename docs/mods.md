# Mods Guide

There are two kinds of mod, and they are not the same thing:

- **DeepSteve Mods** — mods on the UI of the DeepSteve platform itself. They live in `mods/`, are **global to the install** (every session loads every mod's `tools.js`), are enabled per browser, and can be published to the marketplace. This guide is about these.
- **Project Mods** — custom behaviour, like a dashboard, that an agent implements **for one project**. A directory of files, registered to one git repo root and **stored in that repo** at `.deepsteve/mods/<name>/`, visible only when you are looking at that project. It is committed, so it travels with the checkout. See [Project Mods](#project-mods) at the end.

A rule of thumb: if the thing belongs to *deepsteve*, it's a DeepSteve Mod. If it belongs to *what you're building*, it's a Project Mod.

## Using Mods

### Enable/Disable

Open the **Mods** modal — the toolbar button, `⌘K → Mods`, or `#mods` — to see everything
available. Toggle the switch on a row to enable or disable it. Mods with
`enabledByDefault: true` are auto-enabled on first visit.

### Browsing (#673)

The modal is one scrolling list, grouped into sections with sticky headings:
**Automations**, then **Apps · Panels · Fullscreen · Games · Tabs · Background**, then
**Skills**, and **Available** when a catalog mod is not installed. Which section a mod lands
in is [derived from its manifest](#how-a-mod-is-grouped-673), not chosen by hand.

Three controls, and they are three different things on purpose:

- The **chips** above the list are *jump-to navigation* with a count each — they scroll to a
  section, they do not hide the others. They replaced a row of exclusive filter pills that
  mixed what a thing *is* with how a mod *draws* and whether it is *on*, so telling the kinds
  apart meant hiding everything else.
- **Enabled only** is the one state control, and it is separate because state is its own axis.
  It is not remembered between openings — a filter should never silently hide a mod you are
  looking for. Automations are unaffected: an automation is not on or off, it is runnable.
- **Search** spans every section at once, over names, descriptions, tags, slash commands and
  the names of the MCP tools a mod registers. Sections that come out empty drop their heading
  rather than standing over nothing.

A row is one line: name, the badges that change a decision (`Experimental`, `Update`,
`Incompatible`, `Not installed`), a one-line description, and its controls. **Click the row**
to expand it in place for the full description, the version and source, its dependencies, the
MCP tools it registers, and — depending on what it is — a skill's `Usage:` line and **View**
button, or a catalog mod's Install / Uninstall / Update buttons. The detail is built on first
expand and never before; putting all of it on all 32 entries is what made four fit on screen.

### Per-Mod Settings

Mods can define settings (boolean or number). Click the gear icon on the mod's row to
configure it. Settings are saved immediately to localStorage.

### Display Modes

Mods have four display modes:

- **Fullscreen** — activated via a toolbar button, replaces the terminal view. Clicking a session in the mod switches back to the terminal with a back button to return. Only one fullscreen mod iframe exists at a time; it's created on show and destroyed on hide. An [App](#apps-661) has neither of those buttons — the Apps rail section and the command palette both launch it and return you to it.
- **Panel** — docked to the right side of the terminal area, with tabs if multiple panel mods are enabled. A drag handle allows resizing. Panel iframes stay alive even when hidden, so MCP tools keep working.
- **Tab** (`display: "tab"`) — opens as its own tab in the tab strip, offered in the new-tab menu under `tabOption.label`. `baby-browser` and `steveonardo` are the two. It gets no toolbar button.
- **Tools-only** — no UI, no iframe, no toolbar button. Only provides MCP tools to sessions. Omit both `display` and `entry` from `mod.json`.

### Apps (#661)

An **App** is a fullscreen mod that is a *place you work from* rather than a tool you visit —
an inbox you sit in all day, not a view you glance at. Declare it with `"app": true` alongside
an `entry`. The flag is purely additive: a mod without it behaves exactly as it always has.

Declaring it buys four things:

- a row in an **Apps** section at the top of the projects rail, above `Projects`,
- a command-palette entry (`Open: <name>`). This is **not optional for an app** — the rail is
  ⌘P-toggled, so the palette is the entry that works while the rail is closed,
- **quiet mode** below,
- the **excursion** API below.

and costs one: `"app": true` **implies no button of its own in the tab strip** (#662) — not the
toolbar launcher, and not the `← <name>` back button either. The Apps section is how you get to
a place, so it is also how you get back to one, and the `←` is only that launcher pointing the
other way. The rail row stays lit the whole time you are away, ⌘← pops an excursion, and the
palette entry is the route while the ⌘P rail is closed. There is no second manifest field for
this — one flag means one thing, so every future app inherits the decision. `toolbar.label` is
still read: it names the rail row and the palette entry. Non-app fullscreen mods keep both
buttons; they have no rail row to carry the job.

**Quiet mode** takes the host's chrome away and leaves the app alone on screen — the tab strip
(which is also the toolbar) and the projects rail. The panels need no rule: they live in
`#content-row`, which the fullscreen slot already hides.

It belongs to the host, not to the app: an iframe cannot hide the tab strip that contains it,
and a control built in one would be stuck on hardcoded fallback colours (mod iframes receive no
theme variables). So it is built once against the view slot and every app gets it. The toggle
sits at the top-left **of the slot**, not in the strip beside the `←` button, because the strip
is exactly what it takes away — it has to survive that, or quiet mode is a state with no exit.

⌘\ toggles it. That binding exists twice on purpose: the host registers it for when chrome has
focus, and an app binds it inside its own page and calls `deepsteve.toggleQuiet()`, because a
host listener sits on the top document and never sees a keystroke made inside a mod iframe —
which is exactly the moment you want the chrome gone. ⌘P wins over quiet mode and leaves it, on
the standing rule that no affordance asking for the rail may become a dead key.

The state is per app id in `localStorage` (`deepsteve-app-quiet`), so it holds across reloads
and windows; it never reaches the server, so there is no `SETTINGS_SCHEMA` entry. It is
*derived* from the slot rather than bookkept, which is what makes an excursion free: while you
are out the slot is down and so is quiet mode — so the rail carrying your way home is back on
screen — and coming home re-derives it with nothing saved or restored in between.

**Excursions** are a navigation stack owned by the host. An app calls `visitSession()` instead
of `focusSession()`; the host hides the projects rail and filters the tab strip to the visited
session's project. ⌘← pops one frame, as does the app's rail row, which stays lit for the whole
errand; an emptied stack restores the app, which was only *backgrounded* — its iframe stayed
loaded, so you come back to the state you left. (A non-app fullscreen mod may start an excursion
too, and there the `← <name>` button becomes a trail: `← Tower · deepsteve / issue-661`.)

While you are out, ⌘↑/⌘↓ move the app's own cursor and the *terminal* follows, so a queue of
twenty blocked agents can be walked without returning to the inbox. That walk **replaces** the
top frame rather than pushing, or "back" would cost one press per agent; drilling from a
visited session into another one *does* push. The app owns the queue and the host asks it to
move (`onExcursionCycle`), because only the app knows what resolved while you were away.

The stack lives in `sessionStorage`, so it survives a reload of the same window and does not
leak into a second one. That is a deliberate split from which app is *open*, which is a
browser-wide `localStorage` preference.

### How a mod is grouped (#673)

The Mods modal has one section per **kind**. Kind is derived once, server-side, by
`modKind()` in `mod-kind.js`, and served as a `kind` field on every `GET /api/mods` entry;
the client groups by that field and never re-derives it (a guard test enforces both halves).
The ladder, in order — the order is the substance:

| Test | Kind | Section |
|---|---|---|
| `type: "skill"` | `skill` | Skills — stamped by the server, never derived, so a skill can't file itself under Apps |
| no `entry` | `background` | Background — nothing to render, so nowhere else to put it |
| `app: true` | `app` | Apps |
| `tags` includes `"games"` | `game` | Games |
| `display: "panel"` | `panel` | Panels |
| `display: "tab"` | `tab` | Tabs |
| otherwise | `fullscreen` | Fullscreen |

`!entry` is checked before `app`/`display` only because it *can* be: `validate-mods.js`
already rejects `app: true`, `display: "panel"` and `display: "tab"` without an `entry`. It
is what gives the right answer for the one real ambiguity — a tools-only mod tagged `games`
is not a game you can play. `app` outranks `display` because it is a stronger statement about
what the thing is (#661), and `games` outranks `display` because Games is a kind, so a
panel-shaped game belongs there rather than swelling Panels.

`kind` sits **after** the manifest spread in the `/api/mods` push, for the same later-key-wins
reason `tools` does: a third-party mod arrives as a tarball whose `mod.json` we do not write,
and it must not be able to declare which section it appears in. A manifest that sets `kind` is
ignored.

**`kind` is a presentation grouping, not a behaviour predicate.** `getApps()`,
`getNewTabItems()` and every `display === 'panel'` branch keep reading the manifest fields
directly: they ask *how does this mount*, which is a different question from *which heading
does it live under*, and the two answers deliberately disagree for apps and for games.

A catalog mod that is not installed gets `kind: 'available'` from the **client**, not the
server: a `/api/mods/catalog` row is a remote `catalog.json` entry with no
`entry`/`display`/`tags` to read, so running the ladder over it would file every downloadable
mod under Background.

### Built-in Mods

| Mod | Display | Default | Description |
|---|---|---|---|
| **Action Required** | panel | on | Auto-cycle through tabs needing input |
| **Agent Chat** | panel | off | Shared message bus for agent-to-agent communication |
| **Console** | panel | off | Browser console passthrough for Agents |
| **Go Karts** | fullscreen | off | 3D go-kart racing with your Claude sessions |
| **Screenshots** | panel | off | Capture terminal screenshots as PNG |
| **Session Info** | tools-only | on | Sessions discover their own identity and tab name |
| **Tasks** | panel | on | Task list populated by Agent sessions |
| **Tower** | fullscreen | off | Pixel art skyscraper view of sessions |
| **Village** | fullscreen | off | Walk a rainy town where every house is a project |
| **Workshop** | app | off | One inbox for every agent that needs you — see [Workshop](#workshop) |

This is a highlights list, not an inventory — it names neither every mod nor the tools each one
registers. Those are declared in the mod's `tools.js` and reported by `GET /api/mods`, which derives
the list at runtime (#644); the Mods modal is the live version of this table.

## Creating a Mod

### Directory Structure

```
mods/<name>/
  mod.json       # Manifest (required)
  index.html     # Entry point (required unless tools-only)
  tools.js       # MCP tools (optional)
```

### mod.json Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Display name |
| `version` | string | yes | Semver version (e.g. `"0.3.0"`) |
| `minDeepsteveVersion` | string | no | Minimum compatible deepsteve version. Incompatible mods are shown but disabled. |
| `description` | string | no | Short description shown on the mod's row in the Mods modal |
| `enabledByDefault` | boolean | no | If `true`, mod is enabled on first visit without user action |
| `entry` | string | no | HTML entry point, defaults to `"index.html"`. Omit for tools-only mods. |
| `display` | string | no | `"panel"` for a docked panel, `"tab"` for a mod that opens as its own tab (`baby-browser`, `steveonardo`). Omit for fullscreen (default) or tools-only mods. |
| `app` | boolean | no | `true` marks a fullscreen mod as an **App** — a place you work from. Adds an Apps rail row and a palette entry, unlocks the excursion API and quiet mode, and **suppresses both tab-strip buttons** (the toolbar launcher and the `←` back button). Requires `entry`. See [Apps](#apps-661). |
| `panel.position` | string | no | `"right"` (only value currently supported) |
| `panel.defaultWidth` | number | no | Initial panel width in pixels |
| `panel.minWidth` | number | no | Minimum panel width when resizing |
| `toolbar.label` | string | no | Display label: the toolbar button (fullscreen mods), the panel tab (panel mods), or the Apps rail row and palette entry (apps, which have no tab-strip button) |
| `tags` | array | no | `["games"]` files the mod under the **Games** section of the Mods modal (see [How a mod is grouped](#how-a-mod-is-grouped-673)). Tags are searched too. |
| `experimental` | boolean | no | Shows an **Experimental** badge on the mod's row |
| `settings` | array | no | Per-mod settings (see below) |

There is no `tools` field. A mod's MCP tools are declared only in `tools.js` — see
[MCP Tools](#mcp-tools-toolsjs). `validate-mods.js` fails a manifest that declares one. There
is no `kind` field either: it is derived (see
[How a mod is grouped](#how-a-mod-is-grouped-673)) and a manifest that sets one is ignored.

**Settings entries:**

```json
{
  "key": "allowMultiFloor",
  "type": "boolean",
  "label": "Allow multi-floor sessions",
  "description": "Allow one session to be assigned to multiple floors at once",
  "default": false
}
```

Supported types: `"boolean"` (rendered as a checkbox) and `"number"` (rendered as a number input).

### Example: Fullscreen Mod (Tower)

```json
{
  "name": "Tower",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.3.0",
  "description": "Pixel art skyscraper view of your Agent sessions",
  "entry": "index.html",
  "toolbar": {
    "label": "Tower"
  },
  "settings": [
    {
      "key": "allowMultiFloor",
      "type": "boolean",
      "label": "Allow multi-floor sessions",
      "description": "Allow one session to be assigned to multiple floors at once",
      "default": false
    }
  ]
}
```

### Example: Panel Mod (Tasks)

```json
{
  "name": "Tasks",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.3.0",
  "description": "Task list for human actions, populated by Agent sessions",
  "enabledByDefault": true,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 360, "minWidth": 200 },
  "toolbar": { "label": "Tasks" },
  "settings": [
    { "key": "panelPosition", "type": "boolean", "label": "Panel on left", "description": "Show panel on left side instead of right", "default": false }
  ]
}
```

### Example: Tools-Only Mod (Session Info)

```json
{
  "name": "Session Info",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.3.0",
  "enabledByDefault": true,
  "description": "MCP tool for sessions to discover their own identity and tab name"
}
```

A tools-only mod is one with no `display` and no `entry`. The manifest says nothing about the tools
themselves — they live in `tools.js`.

## Bridge API (`deepsteve.*`)

Every mod iframe gets a `deepsteve` object injected on its `window` after load. This is the only interface between mods and the host application.

### `getDeepsteveVersion()`
Returns the deepsteve version string (e.g. `"0.3.0"`).

### `getSessions()`
Returns an array of session objects with the current state of all sessions.

### `focusSession(id)`
Switches from the mod view to the terminal view and focuses the given session. The mod is only *backgrounded* — for a fullscreen mod a `←` back button returns to it, and for an [App](#apps-661) the Apps rail row does (it has no strip button).

### `onSessionsChanged(cb)`
Registers a callback that fires whenever sessions change. Fires immediately with current sessions. Returns an unsubscribe function.

```js
const unsub = deepsteve.onSessionsChanged(sessions => {
  console.log('Sessions:', sessions);
});
// Later: unsub();
```

### `createSession(cwd)`
Creates a new Claude Code session in the given working directory.

### `killSession(id)`
Kills the session with the given ID.

### `getSettings()`
Returns the mod's current settings object — stored values merged with defaults from `mod.json`.

### `onSettingsChanged(cb)`
Registers a callback that fires when the mod's settings change. Fires immediately with current settings. Returns an unsubscribe function.

### `onTasksChanged(cb)`
Registers a callback that fires when tasks change (via the Tasks mod's MCP tools or REST API). Fires immediately after fetching current tasks from `/api/tasks`. Returns an unsubscribe function.

### `onBrowserEvalRequest(cb)`
Registers a callback that fires when a `browser_eval` MCP tool call is received. The callback receives `{ requestId, code }`. Used by the Console mod to execute JS in the browser and POST results back. Returns an unsubscribe function.

### `onBrowserConsoleRequest(cb)`
Registers a callback for `browser_console` MCP tool calls. Receives `{ requestId, level, limit, search }`. Returns an unsubscribe function.

### `onScreenshotCaptureRequest(cb)`
Registers a callback for `screenshot_capture` MCP tool calls. Receives `{ requestId, selector }`. Returns an unsubscribe function.

### `openScheduledHistory()`
Opens the cross-project scheduled-run history page (#633). Like `showAutoCycleToast`, this is a host hook a single mod uses rather than a general capability — the Scheduled Tasks panel calls it from its header button. The page deliberately renders in the **top document**, not in the calling iframe, because mod iframes receive no theme variables; see [scheduled-tasks.md](scheduled-tasks.md).

### Excursions — for [Apps](#apps-661) only

These four are available to any mod, but only the page currently occupying the fullscreen view slot can start an excursion — a panel mod calling `visitSession()` would begin a trail back to a view that is not on screen, so the call is ignored. `focusSession()` above keeps its one-hop semantics untouched; excursions are strictly opt-in and no existing mod changes.

### `visitSession(id, opts?)`
Like `focusSession(id)`, but the host remembers where you came from. `opts` takes `label` and `reason` (shown in the excursion bar and returned in the stack), `replace: true` to overwrite the top frame instead of pushing — which is what a queue walk must use, or "back" costs one press per item — and `chrome`, currently `{ rail: 'hide' | 'keep' }`.

### `getExcursion()`
Returns `{ appId, depth, stack, chrome }`. `depth` is `0` and `stack` empty when there is no excursion.

### `onExcursionChanged(cb)`
Registers a callback that fires whenever the stack or the view changes, including when you come home. Fires immediately with the current state. Returns an unsubscribe function.

### `onExcursionCycle(cb)`
Registers the handler for ⌘↑/⌘↓ while out. The callback receives `{ delta: 1 | -1 }` and should move the app's own cursor and then call `visitSession(next, { replace: true })`. The app owns the queue because it is the only thing that knows what resolved while you were away. There is one view slot and therefore one handler; registering again replaces it. If no app registers one, ⌘↑/⌘↓ keep cycling projects rather than going dead.

### `endExcursion()`
Pops everything and returns to the app.

### Quiet mode — for [Apps](#apps-661) only

Both are ignored unless the caller is the page currently in the fullscreen slot. The host owns the state, renders the toggle and applies the chrome; these exist only so an app can bind ⌘\ *inside its own page*, because a host-registered shortcut listens on the top document and never sees a keystroke made in a mod iframe — which is exactly when you want the chrome gone. `mods/workshop/workshop.jsx` does this in the same keydown handler it already uses for its cursor keys.

### `toggleQuiet()`
Flips quiet mode for this app and persists it. Do **not** build a toggle in the iframe as well — the host's is always on screen, and one built in here would be stuck on hardcoded fallback colours.

### `isQuiet()`
Whether the chrome is currently down for this app. `false` for any mod that is not in the slot.

## MCP Tools (`tools.js`)

Mods can expose tools to Claude Code sessions via the MCP protocol. Tools are defined in a `tools.js` file using CommonJS exports.

**`tools.js` is the only place a mod's MCP tools are declared.** `mod.json` used to carry a parallel
array of `{ name, description }` objects, and it rotted the way a second copy always does: 48 names
declared across 15 manifests against 55 actually registered, with three of Agent Chat's tools,
Display Tabs' edit tool and three of Screenshots' four missing outright — plus short human-written
descriptions that no longer resembled the long model-facing ones. `GET /api/mods` now derives each
mod's `tools` array from the object that mod's `init()` returns, so the inventory is generated and
cannot go stale. The response also carries `mcpReady`, which is `false` for the brief window after
boot while the ESM-only MCP SDK is still being imported and the index is empty — that is what
separates "this mod registers no tools" from "nothing has been scanned yet". `validate-mods.js`
fails a manifest that declares `tools` (#644).

### `exports.init(context)`

Called once at server startup. Returns an object mapping tool names to definitions:

```js
function init(context) {
  const { broadcast } = context;

  return {
    my_tool: {
      description: 'What this tool does',
      schema: {
        param1: z.string().describe('Description of param1'),
        param2: z.number().optional().describe('Optional param'),
      },
      handler: async ({ param1, param2 }) => {
        // Do work...
        return {
          content: [{ type: 'text', text: 'Result message' }],
        };
      },
    },
  };
}
```

Each tool has:
- **`description`** — shown to Claude in the MCP tool listing, and the exact text `GET /api/mods` reports for this tool. Write it for the model, not as a UI caption.
- **`schema`** — Zod shape object defining input parameters
- **`handler`** — async function that receives validated params and returns an MCP content response

### `exports.registerRoutes(app, context)` (optional)

Register Express routes for browser-side communication (REST endpoints for the mod's iframe to call):

```js
function registerRoutes(app, context) {
  app.get('/api/my-mod/data', (req, res) => {
    res.json({ items: [] });
  });
}
```

### Context Object

Both `init` and `registerRoutes` receive a context object:

| Field | Description |
|---|---|
| `broadcast` | `broadcast(msg)` — send a WebSocket message to all connected clients |
| `log` | `log(...args)` — write to the deepsteve log file |
| `app` | Express app instance |
| `shells` | Map of active shell instances |
| `wss` | WebSocket server instance |
| `MODS_DIR` | Absolute path to the `mods/` directory |

### Browser-Bridge Pattern

Some tools need to execute code in the browser (e.g. evaluating JS, capturing screenshots). Since the server can't access the DOM directly, these tools use a broadcast-and-respond pattern:

1. MCP tool handler creates a `requestId` and a pending Promise
2. Handler broadcasts a request message to all WebSocket clients
3. The mod's iframe (registered via `onBrowserEvalRequest` etc.) receives the broadcast and executes the work
4. The iframe POSTs the result back to a REST endpoint (e.g. `/api/browser-console/result`)
5. The REST handler resolves the pending Promise, returning the result to Claude

```js
// In tools.js — handler broadcasts request, waits for browser response
handler: async ({ code }) => {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ content: [{ type: 'text', text: 'Error: Timed out.' }] });
    }, TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, timer });
    broadcast({ type: 'browser-eval-request', requestId, code });
  });
},

// In tools.js — registerRoutes receives browser response
function registerRoutes(app, context) {
  app.post('/api/browser-console/result', (req, res) => {
    const { requestId, result, error } = req.body;
    const pending = pendingRequests.get(requestId);
    if (!pending) return res.json({ accepted: false });

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({
      content: [{ type: 'text', text: error ? `Error: ${error}` : result }],
    });
    res.json({ accepted: true });
  });
}
```

## Mod Lifecycle

### Iframe Sandboxing

All mod iframes use `sandbox="allow-scripts allow-same-origin"`. This allows JavaScript execution and same-origin access (needed for the bridge API injection) while blocking other capabilities like popups and form submission.

### Panel Mods

Panel mod iframes are created when the mod is enabled and stay alive for the duration of the session. When you switch between panel tabs, iframes are shown/hidden via `display: none` — they are not destroyed. This is important because MCP tools registered by panel mods (e.g. `browser_eval`) need the iframe to be alive to handle requests.

### Fullscreen Mods

Fullscreen mod iframes are created when shown and destroyed when hidden. If you switch to a different fullscreen mod, the previous one's iframe is destroyed first. Session and settings callbacks registered by a fullscreen mod are cleaned up on hide.

### Hot Reload

The server watches mod directories with `fs.watch()`. When files change, it broadcasts a `mod-changed` message. Active iframes reload with a cache-busting query parameter. Stale bridge API callbacks are cleaned up before the iframe reloads.

### Version Compatibility

If a mod declares `minDeepsteveVersion`, the server compares it against its own version using semver. Incompatible mods appear in the Mods modal but are disabled (checkbox grayed out) with a "Requires deepsteve vX.Y.Z+" warning.

## State & Storage

Mod state is stored in localStorage with the following keys:

| Key | Description |
|---|---|
| `deepsteve-enabled-mods` | JSON set of enabled mod IDs |
| `deepsteve-active-mod-view` | ID of the currently shown fullscreen mod |
| `deepsteve-panel-visible` | Whether the panel is visible (`"true"` / `"false"`) |
| `deepsteve-active-panel` | ID of the active panel tab |
| `deepsteve-panel-width` | Panel width in pixels (persisted across resizes) |
| `deepsteve-mod-settings-<modId>` | Per-mod settings object (one key per mod) |
| `deepsteve-app-quiet` | JSON array of the app IDs you sit in with the chrome gone (#662) |

Panel mods are auto-enabled on first visit (when no mod preferences have been saved yet).

## Workshop

One fullscreen inbox merging **blocked sessions** — anything sitting on a Claude Code permission
or AskUserQuestion dialog, with the question and options parsed and rendered inline — and the
**questions and briefings agents post deliberately** through `workshop_ask`, `workshop_brief` and
`workshop_check`. You answer from the inbox instead of switching to the tab.

Everything lives in `mods/workshop/`. There is no `server.js` edit and no new bridge hook:
`registerRoutes(app, context)` already hands every mod the full `initMCP` context, and the panel
polls its own `GET /api/workshop/inbox`.

**Workshop is the first [App](#apps-661).** Going to look at an agent is a `visitSession()`, not
a `focusSession()`, so ⌘← brings you back; and its `onExcursionCycle` handler moves the *same*
cursor the bare ↑/↓ keys move, so ⌘↑/⌘↓ walk the queue from inside a terminal. That walk steps
past any item with no tab in this window — `getSessions()` is window-scoped, so a scheduled run
is a legitimate inbox row with nothing to visit, and stopping on one would end the walk at the
first unattended agent.

**Blocked items are derived, never stored.** They are computed per request from `ctx.shells`, so
they exist exactly as long as the dialog does — nothing to reconcile, no tombstone, and no stale
row when a dialog resolves itself in its own terminal. Questions and briefings are stored at
`stateDir()/workshop.json`.

**Membership is `detectDialog()`, not `waitingForInput`.** `sessionInputState()` maps `'waiting'`
to `'idle'`, and `'idle'` covers a session sitting at an empty composer just as much as one
showing a modal. `waitingForInput` is only a cheap pre-filter; the positive dialog signal in
`mods/workshop/dialog-parse.js` is what stops every agent that merely finished its turn becoming
an inbox row. The listing reads `entry.terminalScreen.linesSync(n)` and never
`readTerminalScreen`, which would replay the whole scrollback into a fresh emulator and `await`
a parse queue one chatty session can defer indefinitely.

### How an item leaves the inbox

Every row is an obligation, so nothing is dropped silently — but a row nobody will ever act on is
its own failure, and before #663 the inbox had no way to shed one.

| Kind | Leaves when |
|---|---|
| Question (`workshop_ask`) | answered, archived with `e`, or its session has been absent from `ctx.shells` for `EXPIRY_GRACE_MS` (5 min) |
| Briefing (`workshop_brief`) | archived with `e` — `⏎` archives it too, since there is nothing to answer |
| Blocked (derived) | the dialog resolves, the session goes, or **`e` mutes it** |

The dead-session sweep is two-phase and never eager: the first pass only stamps `missingSince`,
and a session that comes back inside the grace clears it. `ctx.shells` is briefly *empty* during
the daemon's own boot, before sessions are restored, so an eager sweep would dismiss the whole
inbox on every restart. `BOOT_GRACE_MS` in `tools.js` skips the sweep entirely until either a
session shows up or a minute has passed.

**`e` on a blocked row is a mute, not a dismissal.** Nothing is written, no tombstone is minted,
and the dialog is left exactly as it stands — Escape *is* a decision and Workshop still never makes
it for you. The mute is keyed on `dialogParse.dialogFingerprint()`, the dialog itself rather than
the session: the row stays gone while that question is on screen and returns unprompted the moment
the tab asks a different one. That is the whole moved-on rule — a tab that moves on either paints a
different dialog or none, and both stop the mute applying. It lives in memory and dies with the
daemon, for the reason the `wait_seconds` holds do: losing one costs a row you already read coming
back once, and persisting one costs a second store to reconcile against sessions that are gone.

The fingerprint is the whole dialog block, not the parsed question, because `parseDialog()` returns
`null` on any dialog whose option run it cannot walk — a real AskUserQuestion draws a rule between
the last option and "Chat about this", which stops the walk dead. Those all shared one empty
fingerprint, so hashing the question alone would let a single dismissal silence every unreadable
dialog on the machine, and give each of them one inherited age. The cursor glyph is stripped, so
arrowing between options is navigation rather than a new question.

A blocked row carries the `fingerprint` it was drawn with, and the panel echoes it back as
`expect` — the same confirmed-not-assumed check `sendChoice` makes before pressing a button. A
dialog can be replaced between the poll and the click, and muting whatever is on screen *now*
would silence a question nobody has seen; a mismatch is a `409 dialog-changed` and the row
redraws.

Only `POST /api/workshop/items/blocked:<id>/dismiss` writes a mute, and no MCP tool calls it. **An
agent must never be able to silence a human's inbox** — same line as the meta-controls reasoning
below.

### The three answer paths, and why they differ

| Situation | What happens | PTY write |
|---|---|---|
| The agent is holding inside `workshop_ask` (`wait_seconds`) | resolve its pending promise | **none** |
| The agent's turn ended and it is idle at its composer | `deliverPromptWhenReady(…, { source: 'workshop' })` | via the prompt FIFO |
| The agent is showing a live dialog | raw key writes, 250 ms apart | arrows + `\r` |

The third is **not** `submitToShell`: its `confirmEcho` waits for the composer to echo the text,
and a modal has no composer, so every answer would burn the full cap waiting for an echo that can
never arrive. Instead Workshop moves the cursor **relative to where it already is**, re-reads the
screen to confirm `❯` landed on the intended option, and only then sends Enter — #607's
"confirmed, not assumed" applied to a menu. **A failed verification sends no Enter**, and does not
send Escape either: Escape cancels the dialog, which is a decision the human did not make.

Each control byte is its own `engine.write` separated by 250 ms, because Ink recognizes a control
byte only when it arrives as its own stdin read. `test/integration-standalone/workshop-dialog-answer.test.js`
proves this through a real PTY using the `menu` policy in `test/helpers/stubs/fake-claude-tui.js`.

A blocked item is answered **by option only**. Free text is refused with a 400 and a hint to open
the tab: a permission prompt has no text field, and Escape-then-type would cancel the tool call
the agent was asking about.

### It deliberately skips the meta-controls consent gate

That gate prices one risk: an *agent* typing into another agent's session (#519). Every PTY write
in Workshop originates from a human pressing a key in the host UI, behind the same auth cookie
that already authorizes closing the session. Routing it through the modal would ask the user to
approve their own click, and a decline there starts a 60 s cooldown that would block the next
unrelated `meta_type`. The three MCP tools write nothing to any PTY. **If an agent ever gains a
way to answer another agent's item, revisit this** — at that point Workshop becomes exactly what
#519 guards. The reasoning is repeated in the header of `mods/workshop/tools.js`.

`logRcWrite` only logs text matching `/(^|\s)\/rc(\s|$)/` — deliberately not a keylogger — and
arrow keys plus `\r` can never match it, so the explicit `[workshop] answer …` log line is the
only record that a human moved a cursor in someone else's session.

### Coexisting with Action Required

Both surfaces are untouched by each other, and Action Required's auto-cycle **will switch tabs out
from under Workshop**. Workshop cannot detect that — `getSettings()` is scoped to the calling mod
— so it shows a one-time dismissible note instead. Turn auto-cycle off while sitting in the inbox.

Two known gaps, both needing the platform work in #661: a fullscreen mod has no way to show an
unread count while it is off screen (`setPanelBadge` returns early when there is no panel tab), and
`o` (open the tab) only works for sessions that have a tab in *this* browser window — the bridge's
`focusSession` cannot attach one that does not.

## Tutorials

- [Three.js VR Skeleton](../mod-tutorials/threejs-vr-skeleton/) — Minimal three.js + WebXR starter template for building VR mods

---

## Project Mods

A **Project Mod** is a page an agent writes for **one project** and nowhere else. Where a display tab is a one-shot snapshot that disappears with the session, a project mod is durable: it stays registered to the project and is reachable every session. The intended use is a dashboard or live tooling the project carries with it, rather than something you re-create each time.

It lives **in the repo**, at `.deepsteve/mods/<name>/`, and is meant to be committed — that is how it survives a re-clone and reaches anyone else working on the project. Its chrome belongs to *that* project — and since #647 a project can keep its rail rows on screen from anywhere.

### Launcher surfaces

Two independent axes: **`surfaces` says where the launchers go, `openMode` says what a launcher does.**

A mod declares which of three launcher placements it wants, via `surfaces`:

| Surface | Where it appears |
|---|---|
| `rail` (default) | An entry beneath its project in the projects rail. Rendered for the **active** project, and for any project set to always show its mods (#647) — the one surface that can appear while you are elsewhere. |
| `button` | A square button in the tab strip — the **top** of the strip in vertical tab layout, the **left** of it in horizontal. |
| `tab` | A pinned tab that **auto-opens in the background** whenever its project is the active one, and keeps running while you work elsewhere. Removing the surface closes the tab the pin opened; a tab *you* opened by clicking stays. |

Any combination is allowed; an empty list falls back to `["rail"]`, because a mod with no surface could never be opened.

### Open mode

| `openMode` | What a launcher does |
|---|---|
| `view` (default) | Takes over the content area and **consumes no tab at all**. Nothing is added to the strip, so the mod is represented by its launcher and nothing else — which is the point of choosing `button` in the first place. |
| `tab` | Opens a real, closeable tab at the end of the strip. What every mod did before the mode existed, and still right for a page you *work in* rather than glance at. |

The default was `tab` when the mode was introduced, so existing mods kept their behaviour. It is `view` now, because `tab` was quietly the wrong default for what a project mod usually is: an agent that never considers `open_mode` produced a dashboard that took a tab, permanently, whenever its project was active. The Terminal Wall mod is the worked example — its second commit is titled "rail-only launcher, opened as a view", correcting the default one commit after creation.

Nothing changes for a **pinned** mod: the `"tab"` surface overrides the stored mode while it is set, so a manifest with `surfaces: ["rail","tab"]` and no `openMode` opens exactly as it always did. What changes is the rail/button-only mod that never stated a preference.

A view:

- is dismissed by clicking its launcher again, by clicking any tab, or by switching to another project — it can't outlive the chrome that opens it, and it never leaves a back button behind;
- can't be closed by accident, because there is nothing closeable;
- reloads in place when `update_project_mod` / `edit_project_mod` rewrites its page;
- is **not** restored after a page reload. Re-opening is one click on a launcher that is, by definition, on screen.

`openMode: "view"` and the `"tab"` surface can't both be in force — a view can't also be a pinned background tab — but they resolve asymmetrically, and the asymmetry is the point (#645):

- **`open_mode: "view"` is a rewrite.** It drops a `"tab"` surface, because a view that a pin kept overriding would look like the setting did nothing.
- **The pin is an override, not a rewrite.** Adding `"tab"` to a view-mode mod leaves the stored `openMode` alone and simply wins for as long as the pin is there. Removing the pin restores the view, with no second gesture — which is what makes the right-click checklist undoable by un-ticking.

So `mod.json` legitimately holds `openMode: "view"` alongside a `"tab"` surface, meaning "a view, pinned for now". The wire shape resolves it for the client: `openMode` is the **effective** mode (`"tab"` while pinned) so no consumer has to know the rule, and `storedOpenMode` carries the standing choice underneath, used only to render "Open as a full view" as still-ticked-but-paused in the menu.

There is exactly **one** full-content view slot in the window, shared with fullscreen DeepSteve Mods: showing a second view replaces the first.

### Scoping

A mod belongs to a **git repo root**, resolved the same way a scheduled task's project is (`findGitRoot`, or the calling session's `repoRoot`). It shows when you are *looking at* that project:

- a project selected in the rail → the mod's repo root is inside one of that project's folders;
- the **All** view → the active tab's cwd is inside the mod's repo root.

Both directions are the same folder-prefix rule the rest of the Projects feature uses, so worktrees under `<repo>/.claude/worktrees/…` are included for free.

### Authoring

```
create_project_mod({
  session_id: process.env.DEEPSTEVE_SESSION_ID,   // infers the project from your session
  name: "Build Dashboard",
  icon: "📊",                                     // optional; else a monogram from the name
  surfaces: ["rail", "button"],                   // where the launchers go
  open_mode: "view",                              // …and what they do; "tab" is the default
  file_path: "/repo/tools/dashboard.html",        // or inline `html`
  replacements: { "%%REPO%%": "deepsteve" },      // optional literal find→replace
})
```

`name` also seeds the directory name (kebab-cased, uniquified within the repo), and the result comes back as `path` alongside the id, with a `commitReminder`.

Then `update_project_mod` (page and/or metadata — `name`, `icon`, `surfaces`, `open_mode`, `enabled`), `edit_project_mod` (exact-substring patch, like the Edit tool), `list_project_mods` (`scope: "project" | "all"`, each result carrying its `path`), and `delete_project_mod` — which removes the whole directory. Exactly one of `html` / `file_path` — the same `resolveHtml()` display tabs use.

Since #638 the tools are a convenience, not the only door: the mod is a directory of ordinary files, so editing `index.html` with your own Edit tool works and the daemon notices (`updatedAt` is the directory's newest mtime). The tools still earn their place for *creating* one — they pick the directory name, write the manifest and tell the browser immediately.

The page is served same-origin from `GET /api/project-mods/:id/page`, so it calls back into deepsteve with relative `/api/...` URLs (never a hard-coded port), and the host injects `window.deepsteve` into its iframe — the same bridge documented above — so a project mod can drive tabs, not just render. Sibling files in the mod's directory are served from `GET /api/project-mods/:id/<file>`, which is what a relative `./style.css` in the page resolves to — so a mod can be a small site rather than one document. Nothing outside its own directory is reachable.

### Managing one

Right-click its rail row or its strip button: Open, Rename, Set icon, toggle each of the three launcher surfaces, toggle "Open as a full view (no tab)", Disable, Delete. Renaming its tab renames the mod. Closing its tab does **not** delete it — a pinned mod returns the next time its project is active. **Un-pinning** it does close it, and it stays closed, across a page reload too.

**Compact view** (#646) is the odd one out in that menu, and also appears on the *project* row's right-click menu whenever the project has rail mods. It drops the names and lays the mods out as bare icon squares, flowing left-to-right and wrapping down, so a project's tooling costs one rail line instead of one line per mod. It applies to **all** project mods, not the one you right-clicked — hence the parenthetical in the label. It is a per-browser display preference in `localStorage` (`deepsteve-project-mods-compact`), not a setting: it never reaches the server and has no `SETTINGS_SCHEMA` entry, because how tall the rows are is nobody's business but this browser's. Off by default, and off renders exactly the DOM it did before the option existed — `appendRailRows()` in `public/js/project-mods.js` only emits the `.project-mod-flow` wrapper when it is on.

Both modes build the **same row**, label included; compact hides it in CSS (`display: none`), so the toggle needs no second DOM shape and the name a square drops is still on the row's `title`. Squares show for every mod, chosen icon or derived monogram — the same override the collapsed icon rail applies, since `.has-icon` would otherwise leave an icon-less mod as an empty box. The chip owning the view slot is marked with an outline rather than the `.active` row background, which with the label gone is indistinguishable from `:hover`. The collapsed 48px rail falls back to a single column of 22px squares, matching the project rows above them.

### Always show a project's mods (#647)

The three surfaces above are all scoped to the project you are looking at, so a dashboard was only ever on screen once you had navigated to it — which is the opposite of what a dashboard is for. **Always show this project's mods** lifts that for the rail: a project with the flag set draws its mod rows beneath its row *whatever* project is selected.

- **Per-project and persisted**, on `contexts.json` beside `archived`, and **on by default** — including for every project written before the flag existed (`loadContexts()` normalizes an absent field to `true`, which is the whole migration). Toggled from the **project row's** right-click menu, offered whenever the project has rail mods, right above Compact view.
- Its own route, `POST /api/contexts/:id/always-show-mods`, for the same reason `archived` has one: a name/dirs edit from the project editor must not reset a display choice.
- Deliberately **not** a browser-local preference the way compact view is. Which projects are worth watching is a property of the projects, and should follow you to another window and another machine.
- **Rail rows only.** The strip button and the pinned background tab stay scoped to the active project: they are chrome for the project you are *working in*, and a dozen projects' buttons in the strip is the wall this option is careful not to build.
- Pressing a row drawn under another project **selects that project first** — a project mod's tab carries `cwd = <its repo root>`, so the tab filter would hide it, and an `openMode: "view"` mod would be torn down by the next `syncModView()` pass. That is why a rail row now carries the project it was drawn under (`appendRailRows(list, mods, ctxId)` → `makeRailRow(mod, ownerContextId)` → `openMod(id, { fromContextId })`), and why `app.js` injects a `selectProject` callback: `project-mods.js` still never imports `context-views.js`.

Right-clicking a project row also **lists that project's mods** at the top of its menu, above Edit/Archive/Delete — press one and it opens. That list ignores `surfaces` (a mod pinned only as a background tab is in it too): `surfaces` scopes the three launchers `project-mods.js` owns, and the project menu is a fourth that is always present. `modsForProject(ctx)` is that list; `railModsFor` is it filtered by surface.

### Disk layout

One directory per mod, inside the repo:

```
<repoRoot>/.deepsteve/mods/<name>/mod.json     # the manifest
<repoRoot>/.deepsteve/mods/<name>/index.html   # the entry page (override with "entry")
<repoRoot>/.deepsteve/mods/<name>/…            # anything else the page loads
```

```jsonc
{
  "scope": "project",   // REQUIRED — the marker that says this directory is a project mod
  "name": "Pulse",
  "icon": "💓",
  "surfaces": ["rail", "button"],
  "openMode": "view",
  "enabled": true,
  "entry": "index.html",
  "createdAt": 1786565041879
}
```

Four things follow from this that didn't before:

- **`scope: "project"` is what marks the directory as ours.** A repo may perfectly well ship a regular DeepSteve Mod under `.deepsteve/mods/`; without the marker the daemon skips it rather than adopting it, and never writes to it.
- **`.deepsteve/` is never gitignored.** Committing it is the entire point, so don't add it to a `.gitignore` — not this repo's, not a template, not an install script. `test/unit/project-mods-repo-storage.test.js` is the guard. The corollary is that an *uncommitted* mod leaves the working tree dirty, which is enough to make `merge_worktree` refuse a merge into that checkout — the same trap `.claude/` has in [sessions.md](sessions.md), with the opposite fix: commit the mod. `create_project_mod` returns a `commitReminder` saying so.
- **There is no id and no registry on disk.** A mod's id is derived as `sha1(repoRoot + "\0" + dirname).slice(0,8)` at scan time, which keeps it stable across restarts (the browser persists it in a pinned tab's session entry) while two checkouts of the same repo still get distinct ids. `updatedAt` is derived too — the newest mtime in the mod's directory — so a page you edit *as a file* reloads an open tab exactly like one written through `update_project_mod`.
- **`enabled` is committed**, because it is in the manifest. Disabling a mod is a change to the project, not a per-user preference.

Unlike `display-tabs/`, these are **not** swept for staleness, and nothing outside a mod's own directory is ever deleted.

### Discovery

The daemon does not walk your disk. It looks in exactly the repos named by your **registered projects** (`contexts.json`) — for each project dir, its git root, then that root's `.deepsteve/mods/`. The scan is re-run behind a short TTL, so a mod arriving by `git pull` or a branch switch appears on the browser's next refresh.

Two consequences worth knowing:

- A fresh clone lights up as soon as the repo is part of a project. Nothing has to be re-registered.
- `create_project_mod` **refuses** a repo that isn't part of a registered project, rather than writing a directory nobody would ever scan.

### Trust

A project mod's page is agent-authored HTML served same-origin, in an iframe with `allow-same-origin` (required for the bridge). That is the same authority an agent-authored display tab already has — a continuation of the existing model, not a new one. The server-authoritative kill switch is the `projectModsEnabled` setting: off hides every surface and refuses every write (MCP `isError`, REST 403), while reads stay open so existing mods remain inspectable.

Storing the mod in the repo (#638) *improves* this rather than widening it. The page used to appear in a home directory where nothing would ever show it to you; now it arrives in a diff, is reviewed like any other code, and its history is `git log`. The thing to be careful about is the other direction — a project mod is code that runs with the host's authority as soon as you look at its project, so **a mod that arrives in a repo you pulled is a mod you should read before opening the project**. That is the same judgement you already make about a repo's build scripts, and the reason it is worth stating is that a `.deepsteve/` directory is easy to skim past in a diff.

### Implementation notes (#618, #628)

Everything above is what a project mod *is*; this is what you need before changing how it
works.

- **Naming:** the rail this hangs off is **Projects**, not Contexts — user-facing strings only (`renderRail`'s header, `+ New project`, the editor, the ⌘? descriptions, the settings section). Every internal identifier is unchanged: `contextViewsEnabled`, `/api/contexts`, `contexts.json`, `{type:'contexts'}`, `.context-*` CSS and `window.deepsteve.onContextsChanged` — so no settings/disk migration and no broken third-party mods. The **Scheduled Tasks panel** had the collision (it called contexts "Groups" and a single repo root "Project"); its vocabulary was fixed *inside the panel* — groups→**Projects**, repo root→**Repo** — with no REST/MCP field renamed. Rail header text is duplicated in `autoSizeRail`'s measurement list (`context-views.js`) — change both or double-click-to-auto-fit sizes against the wrong string.
- **Storage is a scan, not a registry (#638).** There is no file of our own anywhere: `scan()` walks `scanRoots()` — the git roots of every registered project's dirs — reads each `.deepsteve/mods/*/mod.json`, keeps only `scope: "project"`, and rebuilds the whole in-memory list. Total, so a renamed or deleted directory needs no bookkeeping. Cached behind a ~2s TTL and force-rescanned after every write. `scan()` **no-ops until `init()` supplies a context**: with no way to ask which projects are registered, an empty result is not a fact and caching it would hide the first real one. The repo path is built by `projectModsDir()` in root `paths.js`, never inline — `test/unit/paths.test.js`'s `GUARDED` list covers every `mods/*/tools.js`.
- **Canonicalize both sides of "which repo is this".** `resolveProject()` now runs the *session* branch through `findGitRoot` too, not just the explicit-path branch. `findGitRoot` realpaths, and the resolved project is compared against `scanRoots()` for membership — so without this a repo reached through a symlink (`/var/…` → `/private/var/…` on macOS) never matches the same repo registered as a project, and every create is refused. `canonicalRoot()` is the one helper both sides call.
- **Server:** `mods/project-mods/tools.js` — `create/update/edit/list/delete_project_mod` plus `GET /api/project-mods`, `GET /api/project-mods/:id/page`, `GET /api/project-mods/:id/*` (sibling assets), `PUT`/`DELETE /api/project-mods/:id`. The project is resolved as a scheduled task's is (explicit path → `findGitRoot`, else the caller's `sessionPaths().repoRoot`); unlike a task there is **no homedir fallback** — a project mod with no project is meaningless — and unlike #618 there is a second refusal, for a repo outside every registered project, because writing there would produce a mod nothing could ever find. `resolveHtml()` (html | file_path | replacements) lives in root `html-source.js` and is shared with display-tab.
- **Two containment checks, and both are load-bearing** now that these are paths inside a user's repo. The `:id` is never concatenated into a path before it has matched a *scanned* mod, so the directory is always one we found rather than one the request named. On top of that, `resolveInMod()` resolves the asset route's wildcard against the mod directory and requires the result to still be under it — a resolved-prefix test, so `..%2f`, `a/../../b` and an absolute path all collapse before it compares. `removeMod()` re-derives the directory from the repo root and dirname and refuses anything outside, because a recursive delete is the wrong place to trust a cached row; it then prunes empty parents with `rmdir`, whose failure on a non-empty directory is exactly the guard wanted.
- **The asset route is declared after `/page`**, which must keep winning the match. An extensionless or unknown file falls back to `application/octet-stream` via `sendFile`.
- **Client:** `public/js/project-mods.js` owns the three surfaces, all of which are host chrome no mod iframe can reach. The rail row is drawn by `context-views.js`'s `renderRail` (the one-way import); the square button is inserted into `#tabs` before `#tabs-list-wrapper`, with `.nav-btn.is-glyph` supplying the shape and the collapsed-rail treatment.
- **`openMode` and `surfaces` are cross-validated in ONE place**, `cleanPlacement()` (called from create/update/REST-PUT, with `applyPlacement()` sharing the partial-update rule between the last two): `'view'` and the `'tab'` surface can't both be in force, and **a deliberate `openMode` write wins** — it drops the pin. A **surfaces-only** write resolves nothing (#645): the pin overrides the stored mode via `effectiveOpenMode()`, which is what `serialize()` ships as `openMode`, so un-ticking the pin restores the view with nothing to undo. That is also why `normalize()` reads the two fields separately instead of through `cleanPlacement()` — a pinned view is a legal thing to find on disk now, and resolving it on load would wipe the override on the very next scan. That separation is also what makes the `'view'` default safe on old manifests: `normalize()` cleans an absent `openMode` to `'view'`, but a manifest that also carries the `'tab'` surface still opens as a tab because the pin wins. There is no migration step; there never was one.
- **The pinned tab carries its own origin.** `autoOpenPinned()` is the only caller that passes `{background: true, pinned: true}`, and `createProjectModTab()` stamps `pinned` onto both the session record and the entry it persists through `SessionStores.add`. That flag is the whole basis for un-pinning being undoable (#645): `syncOpenTabs()`'s `closePinnedModTab` branch closes only what the pin opened, so a tab you opened by clicking a `openMode:'tab'` mod survives, and `ensureProjectModTab()`'s already-open branch deliberately does **not** stamp it later. It has to be persisted because the restore path is the only thing that survives a reload — which is where the second half lives: the entry is rejected only once the registry has landed (`known && !known.surfaces.includes('tab')`), because rejecting mid-flight would drop legitimate tabs, and `syncOpenTabs()` is the backstop for that window. Don't "simplify" that ordering.
- **One takeover mechanism, not two.** `mod-manager.js`'s single fullscreen slot was generalized from a bare mod id (`activeViewId`) to a descriptor (`activeView = {id, name, src, sandbox, allow, persist, dismissOnLeave}`) with `showView`/`hideView`/`getActiveViewId`; `_showMod()` is now just its first caller. A project-mod view occupies that slot under the id **`project-mod:<modId>`** — the same string its bridge is already injected under, which is precisely what makes `_hideMod()`'s per-view callback sweeps, the toolbar `.active` sweep and `handleModChanged()`'s cache-bust correct for it, while every DeepSteve-mod comparison (`activeView?.id === modId`) correctly never matches. A second container would have raced `switchTo()`'s `isModViewVisible()` delegation (`app.js`) and `_showPanel()`'s `!modViewVisible` guard. The takeover is a flex-sibling `display` swap, not an overlay, so `activeId` / `.terminal-container.active` are never touched and "back to where you were" is free. **The one selection the slot does own is the tab strip's** (#639): a tab is styled selected because its terminal is what you are looking at, so while the slot is up none may be, and when it comes down the active session's tab is again. Every write to `modViewVisible` goes through `_setModViewVisible()`, which flips `TabManager.setActive()` with it — that funnel is what stops the strip and the screen drifting apart, and it is why entering the slot no longer leaves the outgoing tab marked. Two deliberate differences from a DeepSteve Mod view: **`dismissOnLeave`** — clicking a tab tears a project-mod view down rather than parking it behind a `←` button, because its launcher is already in the strip and a back button would be the second thing representing one mod; and **`persist: false`** — it is not restored across a page reload, which could only ever be racy (`restoreSessions()`'s trailing `focusTab()` goes through `switchTo()`, which leaves any front view). While in there, `_forgetViewCallbacks()` fixed a pre-existing leak: switching straight from one view to another destroyed the iframe but swept none of its callbacks.
- **Reconciliation is one rule**, `syncModView()`: the slot may only hold a mod that `visibleMods()` still returns *in view mode*. Deleted, disabled, `projectModsEnabled` off, flipped back to `'tab'`, and "you switched project" all collapse into it — so a view can never outlive the chrome that opens it. It must stay **idempotent**, because hiding fires `onViewChanged` → `render()` and only the existing re-entrancy guard plus an immediate second-pass return makes that terminate. **There is no Escape binding**: `showModView()` focuses the iframe, so a host-level keydown would fire only when chrome happens to hold focus — unpredictable is worse than absent, and injecting into the same-origin iframe would steal Escape from the page. Hence `test/unit/shortcuts-registry.test.js`'s exact-id set is untouched.
- **Two invariants the first build got wrong, both now pinned by tests.** (1) **`render()` must never call back into the rail.** `cb.renderRail()` runs `applyFilter()`, whose `onContextViewApplied` hook calls `render()` — so only `refresh()` may call it, and `render()` additionally carries a re-entrancy guard, because opening a pinned tab runs `notifyTabsChanged()` → `applyFilter()` → `render()`. Without both, the first pinned mod recursed ~1600 deep and no surface finished rendering. `renameProjectModTab` notifies **only when a name actually changed** for the same reason. (2) **The tab id is derived, not minted** — `tabIdFor(modId)` = `pm-<modId>`. A pinned mod is opened from three directions (restore, auto-open, click) and with random ids each was a separate tab that accumulated across reloads; deriving makes a duplicate impossible by construction. `viewIdFor(modId)` = `project-mod:<modId>` follows the same rule for the view slot. `tabNameFor(mod)` prefixes the icon into the **label** because `tabIcon()` reads the chip off the label — otherwise a 📊 mod is a "B" in the vertical rail, where the chip is the whole tab; it is idempotent for the icon-less stub the restore path passes.
- **The client did not change for #638.** The wire shape is identical (`serialize()` keeps `root`/`dirname`/`dir`/`entry` off it, which is what that function was always for) and `/api/project-mods/:id/page` kept its URL, so `app.js`, `project-mods.js` and `context-views.js` are untouched — which is the check that the storage move really is only a storage move.
- Tests: `test/unit/project-mods.test.js` (the scan, derived ids, the `scope` filter, tools, REST, assets and traversal, the gate, the `cleanPlacement` truth table), `test/unit/project-mods-repo-storage.test.js` (`.deepsteve` is never gitignored and no script writes a repo-relative one) and `test/unit/project-mods-client.test.js` (scoping, the three surfaces, derived identity, the re-entrancy invariant, view mode — whose `setup()` carries a **simulated view slot** rather than bare recorders, because `openMod`'s toggle and `syncModView` both read the slot back — plus the un-pin teardown and the right-click menu's paused-view item).

## Display tabs

A **display tab** is a one-shot agent-authored page that lives for the session — the throwaway
sibling of a project mod. `create_display_tab` / `update_display_tab` build one.

**They take `file_path`, not just inline HTML (#599).** The tools accept **exactly one** of `html` or `file_path` (both or neither → `isError`). `file_path` must be absolute (a leading `~/` is expanded), ≤5MB, and is read **once, as a snapshot** — the HTML is copied into `~/.deepsteve/display-tabs/<id>.html` exactly as an inline string would be, so later edits to the source file need another `update_display_tab`. Prefer it whenever the page already exists on disk: the model emits ~15 tokens instead of the whole document. An optional `replacements` map (`{"%%CHANNEL%%": "slot-ab3f9c12"}`) is applied server-side as **literal** find→replace (split/join, longest key first — `$&` in a value stays literal), so a file on disk can stay a reusable template. Display tabs are served same-origin (`GET /api/display-tab/:id`), so pages call back into deepsteve via `window.location.origin` or a relative `/api/...` URL — **never** a hard-coded port, and no port substitution is needed. Shared resolver: `resolveHtml()` in **`html-source.js`** (repo root, so it ships automatically); tests in `test/unit/display-tab-source.test.js`.

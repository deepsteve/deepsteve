# Mods Guide

There are two kinds of mod, and they are not the same thing:

- **DeepSteve Mods** — mods on the UI of the DeepSteve platform itself. They live in `mods/`, are **global to the install** (every session loads every mod's `tools.js`), are enabled per browser, and can be published to the marketplace. This guide is about these.
- **Project Mods** — custom behaviour, like a dashboard, that an agent implements **for one project**. One page, registered to one git repo root, stored outside the repo in `~/.deepsteve/`, visible only when you are looking at that project, and **never shared** — no store, no publishing, no other project. See [Project Mods](#project-mods) at the end.

A rule of thumb: if the thing belongs to *deepsteve*, it's a DeepSteve Mod. If it belongs to *what you're building*, it's a Project Mod.

## Using Mods

### Enable/Disable

Open the **Mods** dropdown in the toolbar to see all available mods. Toggle the checkbox to enable or disable each mod. Mods with `enabledByDefault: true` are auto-enabled on first visit.

### Per-Mod Settings

Mods can define settings (boolean or number). Click the gear icon next to a mod in the dropdown to configure it. Settings are saved immediately to localStorage.

### Display Modes

Mods have three display modes:

- **Fullscreen** — activated via a toolbar button, replaces the terminal view. Clicking a session in the mod switches back to the terminal with a back button to return. Only one fullscreen mod iframe exists at a time; it's created on show and destroyed on hide.
- **Panel** — docked to the right side of the terminal area, with tabs if multiple panel mods are enabled. A drag handle allows resizing. Panel iframes stay alive even when hidden, so MCP tools keep working.
- **Tools-only** — no UI, no iframe, no toolbar button. Only provides MCP tools to sessions. Omit both `display` and `entry` from `mod.json`.

### Built-in Mods

| Mod | Display | Default | Description | MCP Tools |
|---|---|---|---|---|
| **Action Required** | panel | on | Auto-cycle through tabs needing input | — |
| **Agent Chat** | panel | off | Shared message bus for agent-to-agent communication | `send_message`, `read_messages`, `list_channels` |
| **Console** | panel | off | Browser console passthrough for Agents | `browser_eval`, `browser_console` |
| **Go Karts** | fullscreen | off | 3D go-kart racing with your Claude sessions | — |
| **Screenshots** | panel | off | Capture terminal screenshots as PNG | `screenshot_capture` |
| **Session Info** | tools-only | on | Sessions discover their own identity and tab name | `get_my_session_id`, `get_session_info` |
| **Tasks** | panel | on | Task list populated by Agent sessions | `add_task`, `update_task`, `complete_task`, `list_tasks` |
| **Tower** | fullscreen | off | Pixel art skyscraper view of sessions | — |

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
| `description` | string | no | Short description shown in the Mods dropdown |
| `enabledByDefault` | boolean | no | If `true`, mod is enabled on first visit without user action |
| `entry` | string | no | HTML entry point, defaults to `"index.html"`. Omit for tools-only mods. |
| `display` | string | no | `"panel"` for docked panel. Omit for fullscreen (default) or tools-only mods. |
| `panel.position` | string | no | `"right"` (only value currently supported) |
| `panel.defaultWidth` | number | no | Initial panel width in pixels |
| `panel.minWidth` | number | no | Minimum panel width when resizing |
| `toolbar.label` | string | no | Label shown in the toolbar button (fullscreen mods) or panel tab (panel mods) |
| `settings` | array | no | Per-mod settings (see below) |
| `tools` | array | no | MCP tool declarations (see [MCP Tools](#mcp-tools-toolsjs)) |

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

**Tool entries:**

```json
{ "name": "add_task", "description": "Add a task for the human" }
```

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
  "tools": [
    { "name": "add_task", "description": "Add a task for the human" },
    { "name": "update_task", "description": "Update a task" },
    { "name": "complete_task", "description": "Mark a task as done" },
    { "name": "list_tasks", "description": "List current tasks" }
  ],
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
  "description": "MCP tool for sessions to discover their own identity and tab name",
  "tools": [
    { "name": "get_my_session_id", "description": "Get this session's deepsteve ID (no params needed)" },
    { "name": "get_session_info", "description": "Get session metadata by deepsteve session ID" }
  ]
}
```

## Bridge API (`deepsteve.*`)

Every mod iframe gets a `deepsteve` object injected on its `window` after load. This is the only interface between mods and the host application.

### `getDeepsteveVersion()`
Returns the deepsteve version string (e.g. `"0.3.0"`).

### `getSessions()`
Returns an array of session objects with the current state of all sessions.

### `focusSession(id)`
Switches from the mod view to the terminal view and focuses the given session. For fullscreen mods, this hides the mod and shows a back button.

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

## MCP Tools (`tools.js`)

Mods can expose tools to Claude Code sessions via the MCP protocol. Tools are defined in a `tools.js` file using CommonJS exports.

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
- **`description`** — shown to Claude in the MCP tool listing
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

If a mod declares `minDeepsteveVersion`, the server compares it against its own version using semver. Incompatible mods appear in the Mods dropdown but are disabled (checkbox grayed out) with a "Requires deepsteve vX.Y.Z+" warning.

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

Panel mods are auto-enabled on first visit (when no mod preferences have been saved yet).

## Tutorials

- [Three.js VR Skeleton](../mod-tutorials/threejs-vr-skeleton/) — Minimal three.js + WebXR starter template for building VR mods

---

## Project Mods

A **Project Mod** is a page an agent writes for **one project** and nowhere else. Where a display tab is a one-shot snapshot that disappears with the session, a project mod is durable: it stays registered to the project and is reachable every session. The intended use is a dashboard or live tooling the project carries with it, rather than something you re-create each time.

It is **entirely local**: the registry and the page live in `~/.deepsteve/`, never in the repo, never uploaded, never visible from another project.

### Launcher surfaces

Two independent axes: **`surfaces` says where the launchers go, `openMode` says what a launcher does.**

A mod declares which of three launcher placements it wants, via `surfaces`:

| Surface | Where it appears |
|---|---|
| `rail` (default) | An entry beneath its project in the projects rail. Rendered for the **active** project only. |
| `button` | A square button in the tab strip — the **top** of the strip in vertical tab layout, the **left** of it in horizontal. |
| `tab` | A pinned tab that **auto-opens in the background** whenever its project is the active one, and keeps running while you work elsewhere. Not available with `openMode: "view"`. |

Any combination is allowed; an empty list falls back to `["rail"]`, because a mod with no surface could never be opened.

### Open mode

| `openMode` | What a launcher does |
|---|---|
| `tab` (default) | Opens a real, closeable tab at the end of the strip. This is what every mod did before the mode existed, so nothing changes for one that doesn't ask. |
| `view` | Takes over the content area and **consumes no tab at all**. Nothing is added to the strip, so the mod is represented by its launcher and nothing else — which is the point of choosing `button` in the first place. |

A view:

- is dismissed by clicking its launcher again, by clicking any tab, or by switching to another project — it can't outlive the chrome that opens it, and it never leaves a back button behind;
- can't be closed by accident, because there is nothing closeable;
- reloads in place when `update_project_mod` / `edit_project_mod` rewrites its page;
- is **not** restored after a page reload. Re-opening is one click on a launcher that is, by definition, on screen.

`openMode: "view"` and the `"tab"` surface are mutually exclusive — a view can't also be a pinned background tab. Set either one and the other yields: passing `open_mode: "view"` drops a `"tab"` surface, and adding `"tab"` back to a view-mode mod flips it to `openMode: "tab"`. That is what lets the right-click checklist toggle in both directions with a single click.

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

Then `update_project_mod` (page and/or metadata — `name`, `icon`, `surfaces`, `open_mode`, `enabled`), `edit_project_mod` (exact-substring patch, like the Edit tool), `list_project_mods` (`scope: "project" | "all"`), and `delete_project_mod`. Exactly one of `html` / `file_path` — the same `resolveHtml()` display tabs use.

The page is served same-origin from `GET /api/project-mods/:id/page`, so it calls back into deepsteve with relative `/api/...` URLs (never a hard-coded port), and the host injects `window.deepsteve` into its iframe — the same bridge documented above — so a project mod can drive tabs, not just render.

### Managing one

Right-click its rail row or its strip button: Open, Rename, Set icon, toggle each of the three launcher surfaces, toggle "Open as a full view (no tab)", Disable, Delete. Renaming its tab renames the mod. Closing its tab does **not** delete it — a pinned mod returns the next time its project is active.

### Disk layout

```
~/.deepsteve/project-mods.json        # [{id, project, name, icon, surfaces, openMode, enabled, …}]
~/.deepsteve/project-mods/<id>.html   # one page per mod
```

Deliberately outside the repo, so "not shared" is a guarantee rather than a gitignore convention. Unlike `display-tabs/`, these are **not** swept for staleness.

### Trust

A project mod's page is agent-authored HTML served same-origin, in an iframe with `allow-same-origin` (required for the bridge). That is the same authority an agent-authored display tab already has — a continuation of the existing model, not a new one. The server-authoritative kill switch is the `projectModsEnabled` setting: off hides every surface and refuses every write (MCP `isError`, REST 403), while reads stay open so existing mods remain inspectable.

### Implementation notes (#618, #628)

Everything above is what a project mod *is*; this is what you need before changing how it
works.

- **Naming:** the rail this hangs off is **Projects**, not Contexts — user-facing strings only (`renderRail`'s header, `+ New project`, the editor, the ⌘? descriptions, the settings section). Every internal identifier is unchanged: `contextViewsEnabled`, `/api/contexts`, `contexts.json`, `{type:'contexts'}`, `.context-*` CSS and `window.deepsteve.onContextsChanged` — so no settings/disk migration and no broken third-party mods. The **Scheduled Tasks panel** had the collision (it called contexts "Groups" and a single repo root "Project"); its vocabulary was fixed *inside the panel* — groups→**Projects**, repo root→**Repo** — with no REST/MCP field renamed. Rail header text is duplicated in `autoSizeRail`'s measurement list (`context-views.js`) — change both or double-click-to-auto-fit sizes against the wrong string.
- **Storage:** load-on-start / write-through with tmp+rename, the `mods/scheduled-tasks` shape; an orphan sweep at `init()` drops pages with no registry row.
- **Server:** `mods/project-mods/tools.js` — `create/update/edit/list/delete_project_mod` plus `GET /api/project-mods`, `GET /api/project-mods/:id/page`, `PUT`/`DELETE /api/project-mods/:id`. The project is resolved exactly as a scheduled task's is (explicit path → `findGitRoot`, else the caller's `sessionPaths().repoRoot`); unlike a task there is **no homedir fallback** — a project mod with no project is meaningless, so it's an `isError`. `resolveHtml()` (html | file_path | replacements) lives in root `html-source.js` and is shared with display-tab. The `:id` is only ever concatenated into a path *after* matching a registry row, which is what keeps a crafted id inside `PAGES_DIR`.
- **Client:** `public/js/project-mods.js` owns the three surfaces, all of which are host chrome no mod iframe can reach. The rail row is drawn by `context-views.js`'s `renderRail` (the one-way import); the square button is inserted into `#tabs` before `#tabs-list-wrapper`, with `.nav-btn.is-glyph` supplying the shape and the collapsed-rail treatment.
- **`openMode` and `surfaces` are cross-validated in ONE place**, `cleanPlacement()` (called from `normalize`/create/update/REST-PUT, with `applyPlacement()` sharing the partial-update rule between the last two): `'view'` and the `'tab'` surface are mutually exclusive, and **whichever field the caller explicitly passed wins** — which is what lets the right-click checklist flip either way with a single-field PUT. `normalize()` cleaning an absent `openMode` to `'tab'` *is* the migration; there is no other one.
- **One takeover mechanism, not two.** `mod-manager.js`'s single fullscreen slot was generalized from a bare mod id (`activeViewId`) to a descriptor (`activeView = {id, name, src, sandbox, allow, persist, dismissOnLeave}`) with `showView`/`hideView`/`getActiveViewId`; `_showMod()` is now just its first caller. A project-mod view occupies that slot under the id **`project-mod:<modId>`** — the same string its bridge is already injected under, which is precisely what makes `_hideMod()`'s per-view callback sweeps, the toolbar `.active` sweep and `handleModChanged()`'s cache-bust correct for it, while every DeepSteve-mod comparison (`activeView?.id === modId`) correctly never matches. A second container would have raced `switchTo()`'s `isModViewVisible()` delegation (`app.js`) and `_showPanel()`'s `!modViewVisible` guard. The takeover is a flex-sibling `display` swap, not an overlay, so `activeId` / `.terminal-container.active` are never touched and "back to where you were" is free. Two deliberate differences from a DeepSteve Mod view: **`dismissOnLeave`** — clicking a tab tears a project-mod view down rather than parking it behind a `←` button, because its launcher is already in the strip and a back button would be the second thing representing one mod; and **`persist: false`** — it is not restored across a page reload, which could only ever be racy (`restoreSessions()`'s trailing `focusTab()` goes through `switchTo()`, which leaves any front view). While in there, `_forgetViewCallbacks()` fixed a pre-existing leak: switching straight from one view to another destroyed the iframe but swept none of its callbacks.
- **Reconciliation is one rule**, `syncModView()`: the slot may only hold a mod that `visibleMods()` still returns *in view mode*. Deleted, disabled, `projectModsEnabled` off, flipped back to `'tab'`, and "you switched project" all collapse into it — so a view can never outlive the chrome that opens it. It must stay **idempotent**, because hiding fires `onViewChanged` → `render()` and only the existing re-entrancy guard plus an immediate second-pass return makes that terminate. **There is no Escape binding**: `showModView()` focuses the iframe, so a host-level keydown would fire only when chrome happens to hold focus — unpredictable is worse than absent, and injecting into the same-origin iframe would steal Escape from the page. Hence `test/unit/shortcuts-registry.test.js`'s exact-id set is untouched.
- **Two invariants the first build got wrong, both now pinned by tests.** (1) **`render()` must never call back into the rail.** `cb.renderRail()` runs `applyFilter()`, whose `onContextViewApplied` hook calls `render()` — so only `refresh()` may call it, and `render()` additionally carries a re-entrancy guard, because opening a pinned tab runs `notifyTabsChanged()` → `applyFilter()` → `render()`. Without both, the first pinned mod recursed ~1600 deep and no surface finished rendering. `renameProjectModTab` notifies **only when a name actually changed** for the same reason. (2) **The tab id is derived, not minted** — `tabIdFor(modId)` = `pm-<modId>`. A pinned mod is opened from three directions (restore, auto-open, click) and with random ids each was a separate tab that accumulated across reloads; deriving makes a duplicate impossible by construction. `viewIdFor(modId)` = `project-mod:<modId>` follows the same rule for the view slot. `tabNameFor(mod)` prefixes the icon into the **label** because `tabIcon()` reads the chip off the label — otherwise a 📊 mod is a "B" in the vertical rail, where the chip is the whole tab; it is idempotent for the icon-less stub the restore path passes.
- Tests: `test/unit/project-mods.test.js` (registry, tools, REST, gate, the `cleanPlacement` truth table) and `test/unit/project-mods-client.test.js` (scoping, the three surfaces, derived identity, the re-entrancy invariant, and view mode — whose `setup()` carries a **simulated view slot** rather than bare recorders, because `openMod`'s toggle and `syncModView` both read the slot back).

## Display tabs

A **display tab** is a one-shot agent-authored page that lives for the session — the throwaway
sibling of a project mod. `create_display_tab` / `update_display_tab` build one.

**They take `file_path`, not just inline HTML (#599).** The tools accept **exactly one** of `html` or `file_path` (both or neither → `isError`). `file_path` must be absolute (a leading `~/` is expanded), ≤5MB, and is read **once, as a snapshot** — the HTML is copied into `~/.deepsteve/display-tabs/<id>.html` exactly as an inline string would be, so later edits to the source file need another `update_display_tab`. Prefer it whenever the page already exists on disk: the model emits ~15 tokens instead of the whole document. An optional `replacements` map (`{"%%CHANNEL%%": "slot-ab3f9c12"}`) is applied server-side as **literal** find→replace (split/join, longest key first — `$&` in a value stays literal), so a file on disk can stay a reusable template. Display tabs are served same-origin (`GET /api/display-tab/:id`), so pages call back into deepsteve via `window.location.origin` or a relative `/api/...` URL — **never** a hard-coded port, and no port substitution is needed. Shared resolver: `resolveHtml()` in **`html-source.js`** (repo root, so it ships automatically); tests in `test/unit/display-tab-source.test.js`.

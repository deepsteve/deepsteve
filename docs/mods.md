# Mods Guide

There are two kinds of mod, and they are not the same thing:

- **DeepSteve Mods** — mods on the UI of the DeepSteve platform itself. They live in `mods/`, are **global to the install** (every session loads every mod's `tools.js`), are enabled per browser, and can be published to the marketplace. This guide is about these.
- **Project Mods** — custom behaviour, like a dashboard, that an agent implements **for one project**. A directory of files, registered to one git repo root and **stored in that repo** at `.deepsteve/mods/<name>/`, visible only when you are looking at that project. It is committed, so it travels with the checkout. See [Project Mods](#project-mods) at the end.

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

This is a highlights list, not an inventory — it names neither every mod nor the tools each one
registers. Those are declared in the mod's `tools.js` and reported by `GET /api/mods`, which derives
the list at runtime (#644); the Mods dropdown is the live version of this table.

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

There is no `tools` field. A mod's MCP tools are declared only in `tools.js` — see
[MCP Tools](#mcp-tools-toolsjs). `validate-mods.js` fails a manifest that declares one.

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

### `openScheduledHistory()`
Opens the cross-project scheduled-run history page (#633). Like `showAutoCycleToast`, this is a host hook a single mod uses rather than a general capability — the Scheduled Tasks panel calls it from its header button. The page deliberately renders in the **top document**, not in the calling iframe, because mod iframes receive no theme variables; see [scheduled-tasks.md](scheduled-tasks.md).

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

It lives **in the repo**, at `.deepsteve/mods/<name>/`, and is meant to be committed — that is how it survives a re-clone and reaches anyone else working on the project. It is still only ever visible when you are looking at *that* project.

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

`name` also seeds the directory name (kebab-cased, uniquified within the repo), and the result comes back as `path` alongside the id, with a `commitReminder`.

Then `update_project_mod` (page and/or metadata — `name`, `icon`, `surfaces`, `open_mode`, `enabled`), `edit_project_mod` (exact-substring patch, like the Edit tool), `list_project_mods` (`scope: "project" | "all"`, each result carrying its `path`), and `delete_project_mod` — which removes the whole directory. Exactly one of `html` / `file_path` — the same `resolveHtml()` display tabs use.

Since #638 the tools are a convenience, not the only door: the mod is a directory of ordinary files, so editing `index.html` with your own Edit tool works and the daemon notices (`updatedAt` is the directory's newest mtime). The tools still earn their place for *creating* one — they pick the directory name, write the manifest and tell the browser immediately.

The page is served same-origin from `GET /api/project-mods/:id/page`, so it calls back into deepsteve with relative `/api/...` URLs (never a hard-coded port), and the host injects `window.deepsteve` into its iframe — the same bridge documented above — so a project mod can drive tabs, not just render. Sibling files in the mod's directory are served from `GET /api/project-mods/:id/<file>`, which is what a relative `./style.css` in the page resolves to — so a mod can be a small site rather than one document. Nothing outside its own directory is reachable.

### Managing one

Right-click its rail row or its strip button: Open, Rename, Set icon, toggle each of the three launcher surfaces, toggle "Open as a full view (no tab)", Disable, Delete. Renaming its tab renames the mod. Closing its tab does **not** delete it — a pinned mod returns the next time its project is active.

**Compact view** (#646) is the odd one out in that menu, and also appears on the *project* row's right-click menu whenever the project has rail mods. It lays every project mod's rail row out left-to-right in a wrapping grid instead of one per line, so half a dozen mods cost two rail lines rather than six. It applies to **all** project mods, not the one you right-clicked — hence the parenthetical in the label. It is a per-browser display preference in `localStorage` (`deepsteve-project-mods-compact`), not a setting: it never reaches the server and has no `SETTINGS_SCHEMA` entry, because how tall the rows are is nobody's business but this browser's. Off by default, and off renders exactly the DOM it did before the option existed — `appendRailRows()` in `public/js/project-mods.js` only emits the `.project-mod-flow` wrapper when it is on. The grid is `auto-fill`/`minmax`, so a rail dragged wider earns a third column and the collapsed 48px icon rail falls back to the single column of squares.

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
- **`openMode` and `surfaces` are cross-validated in ONE place**, `cleanPlacement()` (called from `normalize`/create/update/REST-PUT, with `applyPlacement()` sharing the partial-update rule between the last two): `'view'` and the `'tab'` surface are mutually exclusive, and **whichever field the caller explicitly passed wins** — which is what lets the right-click checklist flip either way with a single-field PUT. `normalize()` cleaning an absent `openMode` to `'tab'` *is* the migration; there is no other one.
- **One takeover mechanism, not two.** `mod-manager.js`'s single fullscreen slot was generalized from a bare mod id (`activeViewId`) to a descriptor (`activeView = {id, name, src, sandbox, allow, persist, dismissOnLeave}`) with `showView`/`hideView`/`getActiveViewId`; `_showMod()` is now just its first caller. A project-mod view occupies that slot under the id **`project-mod:<modId>`** — the same string its bridge is already injected under, which is precisely what makes `_hideMod()`'s per-view callback sweeps, the toolbar `.active` sweep and `handleModChanged()`'s cache-bust correct for it, while every DeepSteve-mod comparison (`activeView?.id === modId`) correctly never matches. A second container would have raced `switchTo()`'s `isModViewVisible()` delegation (`app.js`) and `_showPanel()`'s `!modViewVisible` guard. The takeover is a flex-sibling `display` swap, not an overlay, so `activeId` / `.terminal-container.active` are never touched and "back to where you were" is free. **The one selection the slot does own is the tab strip's** (#639): a tab is styled selected because its terminal is what you are looking at, so while the slot is up none may be, and when it comes down the active session's tab is again. Every write to `modViewVisible` goes through `_setModViewVisible()`, which flips `TabManager.setActive()` with it — that funnel is what stops the strip and the screen drifting apart, and it is why entering the slot no longer leaves the outgoing tab marked. Two deliberate differences from a DeepSteve Mod view: **`dismissOnLeave`** — clicking a tab tears a project-mod view down rather than parking it behind a `←` button, because its launcher is already in the strip and a back button would be the second thing representing one mod; and **`persist: false`** — it is not restored across a page reload, which could only ever be racy (`restoreSessions()`'s trailing `focusTab()` goes through `switchTo()`, which leaves any front view). While in there, `_forgetViewCallbacks()` fixed a pre-existing leak: switching straight from one view to another destroyed the iframe but swept none of its callbacks.
- **Reconciliation is one rule**, `syncModView()`: the slot may only hold a mod that `visibleMods()` still returns *in view mode*. Deleted, disabled, `projectModsEnabled` off, flipped back to `'tab'`, and "you switched project" all collapse into it — so a view can never outlive the chrome that opens it. It must stay **idempotent**, because hiding fires `onViewChanged` → `render()` and only the existing re-entrancy guard plus an immediate second-pass return makes that terminate. **There is no Escape binding**: `showModView()` focuses the iframe, so a host-level keydown would fire only when chrome happens to hold focus — unpredictable is worse than absent, and injecting into the same-origin iframe would steal Escape from the page. Hence `test/unit/shortcuts-registry.test.js`'s exact-id set is untouched.
- **Two invariants the first build got wrong, both now pinned by tests.** (1) **`render()` must never call back into the rail.** `cb.renderRail()` runs `applyFilter()`, whose `onContextViewApplied` hook calls `render()` — so only `refresh()` may call it, and `render()` additionally carries a re-entrancy guard, because opening a pinned tab runs `notifyTabsChanged()` → `applyFilter()` → `render()`. Without both, the first pinned mod recursed ~1600 deep and no surface finished rendering. `renameProjectModTab` notifies **only when a name actually changed** for the same reason. (2) **The tab id is derived, not minted** — `tabIdFor(modId)` = `pm-<modId>`. A pinned mod is opened from three directions (restore, auto-open, click) and with random ids each was a separate tab that accumulated across reloads; deriving makes a duplicate impossible by construction. `viewIdFor(modId)` = `project-mod:<modId>` follows the same rule for the view slot. `tabNameFor(mod)` prefixes the icon into the **label** because `tabIcon()` reads the chip off the label — otherwise a 📊 mod is a "B" in the vertical rail, where the chip is the whole tab; it is idempotent for the icon-less stub the restore path passes.
- **The client did not change for #638.** The wire shape is identical (`serialize()` keeps `root`/`dirname`/`dir`/`entry` off it, which is what that function was always for) and `/api/project-mods/:id/page` kept its URL, so `app.js`, `project-mods.js` and `context-views.js` are untouched — which is the check that the storage move really is only a storage move.
- Tests: `test/unit/project-mods.test.js` (the scan, derived ids, the `scope` filter, tools, REST, assets and traversal, the gate, the `cleanPlacement` truth table), `test/unit/project-mods-repo-storage.test.js` (`.deepsteve` is never gitignored and no script writes a repo-relative one) and `test/unit/project-mods-client.test.js` (scoping, the three surfaces, derived identity, the re-entrancy invariant, and view mode — whose `setup()` carries a **simulated view slot** rather than bare recorders, because `openMod`'s toggle and `syncModView` both read the slot back).

## Display tabs

A **display tab** is a one-shot agent-authored page that lives for the session — the throwaway
sibling of a project mod. `create_display_tab` / `update_display_tab` build one.

**They take `file_path`, not just inline HTML (#599).** The tools accept **exactly one** of `html` or `file_path` (both or neither → `isError`). `file_path` must be absolute (a leading `~/` is expanded), ≤5MB, and is read **once, as a snapshot** — the HTML is copied into `~/.deepsteve/display-tabs/<id>.html` exactly as an inline string would be, so later edits to the source file need another `update_display_tab`. Prefer it whenever the page already exists on disk: the model emits ~15 tokens instead of the whole document. An optional `replacements` map (`{"%%CHANNEL%%": "slot-ab3f9c12"}`) is applied server-side as **literal** find→replace (split/join, longest key first — `$&` in a value stays literal), so a file on disk can stay a reusable template. Display tabs are served same-origin (`GET /api/display-tab/:id`), so pages call back into deepsteve via `window.location.origin` or a relative `/api/...` URL — **never** a hard-coded port, and no port substitution is needed. Shared resolver: `resolveHtml()` in **`html-source.js`** (repo root, so it ships automatically); tests in `test/unit/display-tab-source.test.js`.

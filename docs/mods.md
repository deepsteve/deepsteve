# Mods Guide

Mods are extensions that add visual views and MCP tools to deepsteve. They run in sandboxed iframes with access to session data through a bridge API.

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
| **Session Info** | tools-only | on | Sessions discover their own identity and tab name | `get_session_info` |
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

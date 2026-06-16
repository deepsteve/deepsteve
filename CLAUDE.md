# deepsteve

Web UI for running multiple Claude Code instances in browser tabs using real PTYs.

## Development Workflow

### Restart the daemon after making changes:
```bash
./restart.sh            # silent restart — browser reconnects via WebSocket
./restart.sh --refresh  # restart + force browser page reload
```
Use `--refresh` when changes affect anything the browser loads (frontend JS/CSS/HTML, server endpoints, settings). Plain `./restart.sh` only restarts the server process — open browser tabs just silently reconnect their WebSocket, so they keep running old frontend code and won't see new server-side behavior until the page is reloaded.

**`Restart cancelled.` has two causes.** `./restart.sh` first POSTs to `/api/request-restart`, which shows a confirm dialog in the browser. The script prints `Restart cancelled.` and exits if either (a) the user actively dismissed the dialog, or (b) nobody responded within the 60s timeout. Don't assume it was an explicit rejection — the user may have been away from the screen. Ask them to retry or confirm when they're ready rather than silently giving up.

**Worktree sessions:** `./restart.sh` deploys from the directory it lives in — it sets `SCRIPT_DIR="$(dirname "$0")"` and copies that directory's `server.js`, `mods/*`, `public/*`, etc. into `~/.deepsteve/`. So running the **worktree's own** `./restart.sh --refresh` *does* deploy that worktree's edits without merging first — handy for testing a change in place. Caveat: it also stamps `.install-source.json` with the worktree path as `sourcePath`, and the in-app auto-update (git-pull) runs against that path. Since worktrees are temporary and sit on feature branches, prefer running `./restart.sh` from the **main repo checkout** for a durable install, and re-run it there after merging.

### View logs:
```bash
tail -f ~/Library/Logs/deepsteve.log
tail -f ~/Library/Logs/deepsteve.error.log
```

### Check if running:
```bash
launchctl list | grep deepsteve
```

### Stop the daemon:
```bash
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist
```

### Full reinstall:
```bash
~/.deepsteve/uninstall.sh
./release.sh   # generates install.sh from source
./install.sh
```

## Architecture

### Overview

deepsteve runs as a macOS LaunchAgent daemon that serves a web UI for managing multiple Claude Code terminal sessions. Each browser tab gets its own PTY-backed Claude instance.

### Session Persistence

When daemon restarts:
1. SIGTERM triggers `saveState()` → writes shell IDs + cwds + claudeSessionIds to `state.json`
2. `stateFrozen` flag prevents shell `onExit` handlers from overwriting state.json during shutdown
3. On startup, loads `state.json`
4. When client reconnects with saved ID, spawns `claude --resume <claudeSessionId>` in saved cwd
5. If `--resume` fails (exits within 5s), falls back to `claude -c --fork-session --session-id <newUUID>`

### Security

DeepSteve has **no authentication, no CORS, and no WebSocket origin checking**. It is designed for localhost use only. The server binds to `127.0.0.1` by default (overridable with `--bind`). All API endpoints, the MCP endpoint, and WebSocket connections are unauthenticated.

### Adding a New Setting

Settings are declared once in the `SETTINGS_SCHEMA` array in `server.js`. Defaults, POST `/api/settings` validation, and `broadcastSettings()` all flow from that single entry — you do **not** hand-write a branch in the POST handler or an explicit field in the broadcast payload.

To add a setting, append one entry to `SETTINGS_SCHEMA`:

```js
{ name: 'myNewSetting', type: 'boolean', default: false }
```

Supported `type` values: `string` (opt-in `fallbackOnEmpty` restores the default when an empty string is POSTed), `boolean`, `number` (opt-in `clamp: [lo, hi]`, `round: true`, `fallback` for the NaN/0 case), `enum` (`values: [...]` or `values: () => [...]` for runtime-dependent enums like `engine`), `array` (`itemEnum` filters, `nonEmpty: true` rejects empty writes), and `custom` (provide a `sanitize(raw)` that returns `null` to reject or a cleaned value to accept — used by `windowConfigs`).

Optional per-entry hooks:
- `broadcast: false` — omit from the WebSocket `settings` message (use for server-internal fields like `wandPlanMode` or binary paths).
- `sideEffect: (val, s) => { ... }` — mutate other settings on accept (e.g. `enabledAgents` re-points `defaultAgent`). Schema declaration order matters: a field later in the array can override a side-effect earlier in the same POST.
- `logValue: v => '...'` — customize the `Settings updated: ...` log line (used by `wandPromptTemplate` and `windowConfigs`).

The client sends fields by name in the POST body and applies them locally on save (`app.js`). Always verify that a second open browser window picks up the change via WebSocket.

**Out-of-schema exceptions:** `activeTheme` and `enabledSkills` intentionally bypass this pipeline — they use dedicated endpoints (`POST /api/themes/active`, `POST /api/skills/{enable,disable}`) and dedicated broadcasts (`broadcastTheme`, `broadcastSkills`) because they ship side payloads (theme CSS) or perform file I/O (copying skill `.md` files). Their defaults live in `NON_SCHEMA_DEFAULTS` next to the schema.

### Command Palette

Cmd+K opens a command palette for keyboard-driven access to tabs, settings, and custom user scripts.

- **Settings**: `commandPaletteEnabled` (default `true`) and `commandPaletteShortcut` (default `Meta+k`) follow the 3-place settings pattern (defaults, POST handler, broadcastSettings).
- **Built-in commands**: Hard-coded in `BUILTIN_COMMANDS` array (new-tab, close-tab, settings, mods, next/prev-tab). Client dispatches these via callbacks.
- **Custom commands**: Executable files in `~/.deepsteve/commands/`. Optional `.json` sidecar for name/description metadata. Executed server-side via `zsh -l -c` (for PATH). Not the same as Skills (which are Claude slash commands in `skills/*.md`).
- **API**: `GET /api/commands` returns built-in + custom commands. `POST /api/commands/execute` runs a custom command by ID.
- **Client**: `command-palette.js` is a self-contained ES module (like `cmd-tab-switch.js`) with `init()`, `setEnabled()`, `setShortcut()` exports.

### Skills System

Skills are slash commands that agents can invoke (e.g. `/chat`, `/merge`). Source files live in `skills/*.md`.

- **Auto-discovery**: The server reads `skills/*.md` and exposes them in `GET /api/mods` with `type: 'skill'`. They appear in the mods UI automatically.
- **Enable/disable**: `POST /api/skills/enable` copies the `.md` to `~/.claude/commands/deepsteve/{id}.md`. Frontmatter `name: {id}` makes it available as `/{id}` in Claude Code. `POST /api/skills/disable` removes it.
- **Reconciliation**: On startup, `reconcileSkills()` re-copies all enabled skills to `~/.claude/commands/deepsteve/`.
- **Frontmatter**: Each skill `.md` has YAML frontmatter with `name` (slash command name), `description`, and optional `argument-hint`. The `name` field determines the slash command (e.g. `name: chat` → `/chat`).
- **ID from filename**: `chat.md` → skill ID `chat`, installed as `~/.claude/commands/deepsteve/chat.md`, invoked as `/chat`.

### Gotchas and Non-Obvious Behavior

- **Ink input parsing**: `shell.write("text\r")` doesn't work for submitting to Claude. Text and `\r` must be sent separately with a 1s delay (`submitToShell()`), because Ink only recognizes Enter when `\r` arrives as its own stdin read.
- **BEL detection / waiting classifier**: Claude emits `\x07` (BEL) when it reaches its input prompt — its "I need attention" signal. The server tracks `lastBelTime` (and `lastInputTime`, set whenever input is written to the PTY). `waitingForInput` flips true only after ~2s of PTY silence **and** a BEL has fired since the user last submitted (`lastBelTime >= lastInputTime`) — so a long, quiet tool call (bash, slow network) is no longer mis-classified as "waiting" (#500). Sessions that have never emitted a BEL (terminal bell disabled) fall back to the legacy silence-only heuristic. This `waitingForInput` state drives browser notifications, the hash-commands overlay, the overview waiting dot, the Action Required auto-cycle mod, and auto-submission of `initialPrompt`.
- **Graceful shutdown**: The shutdown sequence tries `/exit` first (with Ctrl+C interrupt if Claude is busy), waits 8s, then SIGTERM, then 2s more, then SIGKILL. Process group kills (`-pid`) are attempted first for child process cleanup.
- **Two-tier session storage on client**: `TabSessions` (sessionStorage) is the authoritative per-tab source that survives page refresh. `SessionStore` (localStorage) is for cross-tab/window coordination (orphan detection, restore modal). Both must be kept in sync.
- **Orphan detection**: Uses BroadcastChannel for cross-tab heartbeats. When a new tab opens and finds localStorage windows with no heartbeat response within 1.5s, those sessions are offered for restore.
- **Scrollback buffer**: Each shell keeps a ~100KB circular buffer. On reconnect/restore, the full buffer is replayed to the terminal before any new output, so you see history.
- **`restart.sh` runs in background**: It re-execs itself with `nohup` so the terminal returns immediately. Use `--refresh` flag to force browser page reload (vs silent WebSocket reconnect).
- **Terminal tab persistence on restart**: Plain terminal tabs (`agentType: 'terminal'`, spawned via `open_terminal` or the `deepsteve:terminal` skill) are persisted in `state.json` the same way Claude sessions are, and are restored on reconnect by re-spawning `zsh -l` in the saved `cwd`. What survives: the tab, its name, and its `cwd`. What does NOT survive: running processes (SIGTERM/SIGKILL during shutdown), the scrollback buffer (in-memory only), and any env set during the session. `--refresh` does not change what's persisted — it only controls whether the browser force-reloads vs. silently reconnects its WebSocket; the server-side restore path is identical. Users who need running processes to survive daemon restarts should switch to the `tmux` engine, which runs independently of the deepsteve daemon.
- **`release.sh` generates `install.sh`**: The installer is a single self-contained bash script with all source files embedded as heredocs (text) or base64 (images). Binary images are base64-encoded. `install.sh` is NOT checked into the repo — it is generated on demand and attached to GitHub releases.
- **node-pty**: Uses `.removeListener()` not `.off()`. Must `delete env.CLAUDECODE` when spawning nested Claude instances.
- **LaunchAgent PATH**: `execSync` uses `/bin/sh` without Homebrew paths. Commands like `gh` and `git` must be wrapped in `zsh -l -c '...'` to get the user's full PATH.
- **Worktrees**: Sessions can be created with a `--worktree <name>` flag that's passed through to Claude Code. The worktree name is persisted in state.json for restore. `./restart.sh` deploys from wherever it lives (`dirname $0`), so the worktree's own `./restart.sh` *does* copy that worktree's contents to `~/.deepsteve/` — useful for testing in-worktree changes without merging. Caveat: it stamps the worktree path into `.install-source.json` (which the in-app auto-update's `git pull` runs against), so for a durable install prefer running `./restart.sh` from the main checkout after merging.
- **Session self-discovery**: Agents can call the `get_my_session_id` MCP tool (no parameters) to get their 8-char shell ID without needing Bash permissions. The shell ID is embedded in the MCP URL via `--mcp-config` at spawn time. Each PTY also gets env vars at spawn: `DEEPSTEVE_SESSION_ID` (8-char shell ID), `DEEPSTEVE_TAB_NAME` (initial tab name), `DEEPSTEVE_WORKTREE` (worktree **name** or empty), `DEEPSTEVE_CWD` (the agent's actual working directory — the `.claude/worktrees/<name>` path for worktree sessions, otherwise the session cwd), `DEEPSTEVE_WINDOW_ID` (browser window ID or empty), and `DEEPSTEVE_API_URL` (e.g. `http://localhost:3000`). For live metadata (e.g. after a tab rename), use `get_session_info` MCP tool or `GET $DEEPSTEVE_API_URL/api/shells/$DEEPSTEVE_SESSION_ID/info` — both return `cwd` (actual working directory, i.e. the worktree path for worktree sessions), `repoRoot` (the main repo checkout), and `worktree` (the worktree name or null). **Worktree gotcha:** for Claude (which has native `--worktree` support), the PTY is spawned in the main repo and Claude Code itself moves into `.claude/worktrees/<name>`; `entry.cwd` therefore holds the main repo path, so `cwd`/`DEEPSTEVE_CWD` are resolved to the worktree subdir via `sessionPaths()` rather than reported raw.
- **Session self-close**: The `close_session` MCP tool closes a session from within Claude. The MCP response is sent synchronously before the PTY teardown begins (`killShell` uses `setTimeout` for escalation), so Claude always receives the acknowledgment. A session can close itself or any other session.
- **Meta Controls (`meta_type`)**: The `meta_type` MCP tool (in `deepsteve-core`) lets an agent type text into its own or another session's PTY — `text` plus an optional `session_id` (defaults to the caller) and `submit` flag (default `true`). It builds on `submitToShell()` (text then `\r` after 1s for Ink), so `submit:true` presses Enter; `submit:false` stages input without submitting (writes via the session's `engine.write`). Self-typing enables recursive/self-driving loops, so it is gated behind the `metaControlsEnabled` setting (default **off**). The handler reads `settings.metaControlsEnabled` live, so toggling it in Settings takes effect with no restart; the tool itself is always registered (like all mod tools) and just refuses when the setting is off.
- **HTTPS support**: Opt-in via `--https` flag or `DEEPSTEVE_HTTPS=1`. Runs a second server on port 3443 (configurable via `--https-port` or `DEEPSTEVE_HTTPS_PORT`). HTTP and HTTPS run simultaneously — HTTP for localhost, HTTPS for LAN/Quest. Certs auto-generated at startup using `mkcert` (if available) or `selfsigned` package. Certs regenerate when LAN IPs change. MCP stays HTTP-only (localhost, avoids self-signed cert issues with SDK).
- **Browser Console / Screenshots MCP tools**: These operate on the deepsteve UI tab only — they do NOT access your project's website or any other browser tab. `screenshot_capture` and `scene_snapshot` save PNGs to disk and return the file path; use the `Read` tool on that path to view the image. Do NOT try to base64-decode or re-save — the bytes are already on disk at the returned path.
- **Recursive windows (Baby Browser)**: Opening DeepSteve inside its own Baby Browser proxy shares the same origin, so sessionStorage/localStorage/BroadcastChannel would collide. `storage-namespace.js` detects iframe nesting depth and prefixes all keys with `ds{depth}-` (e.g., `ds1-deepsteve`). Depth 0 (top-level) uses no prefix for backward compatibility. Each recursion level gets fully isolated sessions, tabs, and layout state.
- **Pi agent (`@mariozechner/pi-coding-agent`)**: Each pi tab is spawned with `--session-dir ~/.deepsteve/pi-sessions/<shellId>/`, so resume is always `pi --session-dir <same-dir> -c` — no UUID tracking needed. Shutdown uses SIGTERM (pi's graceful signal); Ctrl+C only cancels the current turn. Pi has no MCP support by design, so deepsteve MCP tools (`send_message`, `close_session`, etc.) are not wired into pi sessions — `DEEPSTEVE_*` env vars still propagate, reachable via pi's `bash` tool if needed.

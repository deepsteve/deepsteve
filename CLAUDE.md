# deepsteve

Web UI for running multiple Claude Code instances in browser tabs using real PTYs.

## Development Workflow

### Restart the daemon after making changes:
```bash
./restart.sh            # silent restart — browser reconnects via WebSocket
./restart.sh --refresh  # restart + force browser page reload
```
Use `--refresh` when changes affect anything the browser loads (frontend JS/CSS/HTML, server endpoints, settings). Plain `./restart.sh` only restarts the server process — open browser tabs just silently reconnect their WebSocket, so they keep running old frontend code and won't see new server-side behavior until the page is reloaded.

**Worktree sessions:** `./restart.sh` must be run from the main repo checkout — it copies files from the repo root to `~/.deepsteve/`. Worktree directories are not used for deployment, so edits made in a worktree won't take effect until they're merged to the main branch and `./restart.sh` is run from there.

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

Every setting must be wired in **three places** in `server.js`, plus the client UI:

1. **Default value** — add to the `settings` initializer (~line 200)
2. **POST `/api/settings` handler** — read from `req.body`, validate, and assign to `settings`
3. **`broadcastSettings()`** — include in the WebSocket message so all windows receive updates

The client sends the value in the POST body and applies it locally on save (`app.js`), which masks bugs where the server silently drops the field. Always verify that other browser windows pick up the change via WebSocket.

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
- **Reconciliation**: On startup, `reconcileSkills()` re-copies all enabled skills to `~/.claude/commands/deepsteve/` and cleans up old `deepsteve-{id}.md` flat files from the prior naming scheme.
- **Frontmatter**: Each skill `.md` has YAML frontmatter with `name` (slash command name), `description`, and optional `argument-hint`. The `name` field determines the slash command (e.g. `name: chat` → `/chat`).
- **ID from filename**: `chat.md` → skill ID `chat`, installed as `~/.claude/commands/deepsteve/chat.md`, invoked as `/chat`.

### Gotchas and Non-Obvious Behavior

- **Ink input parsing**: `shell.write("text\r")` doesn't work for submitting to Claude. Text and `\r` must be sent separately with a 1s delay (`submitToShell()`), because Ink only recognizes Enter when `\r` arrives as its own stdin read.
- **BEL detection**: The server detects `\x07` (BEL) in PTY output to know Claude is waiting for input. This drives the `waitingForInput` state, browser notifications, and auto-submission of `initialPrompt`.
- **Graceful shutdown**: The shutdown sequence tries `/exit` first (with Ctrl+C interrupt if Claude is busy), waits 8s, then SIGTERM, then 2s more, then SIGKILL. Process group kills (`-pid`) are attempted first for child process cleanup.
- **Two-tier session storage on client**: `TabSessions` (sessionStorage) is the authoritative per-tab source that survives page refresh. `SessionStore` (localStorage) is for cross-tab/window coordination (orphan detection, restore modal). Both must be kept in sync.
- **Orphan detection**: Uses BroadcastChannel for cross-tab heartbeats. When a new tab opens and finds localStorage windows with no heartbeat response within 1.5s, those sessions are offered for restore.
- **Scrollback buffer**: Each shell keeps a ~100KB circular buffer. On reconnect/restore, the full buffer is replayed to the terminal before any new output, so you see history.
- **`restart.sh` runs in background**: It re-execs itself with `nohup` so the terminal returns immediately. Use `--refresh` flag to force browser page reload (vs silent WebSocket reconnect).
- **`release.sh` generates `install.sh`**: The installer is a single self-contained bash script with all source files embedded as heredocs (text) or base64 (images). Binary images are base64-encoded. `install.sh` is NOT checked into the repo — it is generated on demand and attached to GitHub releases.
- **node-pty**: Uses `.removeListener()` not `.off()`. Must `delete env.CLAUDECODE` when spawning nested Claude instances.
- **LaunchAgent PATH**: `execSync` uses `/bin/sh` without Homebrew paths. Commands like `gh` and `git` must be wrapped in `zsh -l -c '...'` to get the user's full PATH.
- **Worktrees**: Sessions can be created with a `--worktree <name>` flag that's passed through to Claude Code. The worktree name is persisted in state.json for restore. `./restart.sh` only deploys from the main repo checkout — it does NOT copy worktree contents to `~/.deepsteve/`. Merge changes to main first, then restart from the main repo.
- **Session self-discovery**: Each PTY gets env vars at spawn: `DEEPSTEVE_SESSION_ID` (8-char shell ID), `DEEPSTEVE_TAB_NAME` (initial tab name), `DEEPSTEVE_WORKTREE` (worktree name or empty), `DEEPSTEVE_WINDOW_ID` (browser window ID or empty), and `DEEPSTEVE_API_URL` (e.g. `http://localhost:3000`). For live metadata (e.g. after a tab rename), use `GET $DEEPSTEVE_API_URL/api/shells/$DEEPSTEVE_SESSION_ID/info` or the `get_session_info` MCP tool.
- **Session self-close**: The `close_session` MCP tool closes a session from within Claude. The MCP response is sent synchronously before the PTY teardown begins (`killShell` uses `setTimeout` for escalation), so Claude always receives the acknowledgment. A session can close itself or any other session.
- **HTTPS support**: Opt-in via `--https` flag or `DEEPSTEVE_HTTPS=1`. Runs a second server on port 3443 (configurable via `--https-port` or `DEEPSTEVE_HTTPS_PORT`). HTTP and HTTPS run simultaneously — HTTP for localhost, HTTPS for LAN/Quest. Certs auto-generated at startup using `mkcert` (if available) or `selfsigned` package. Certs regenerate when LAN IPs change. MCP stays HTTP-only (localhost, avoids self-signed cert issues with SDK).
- **Browser Console / Screenshots MCP tools**: These operate on the deepsteve UI tab only — they do NOT access your project's website or any other browser tab.
- **Recursive windows (Baby Browser)**: Opening DeepSteve inside its own Baby Browser proxy shares the same origin, so sessionStorage/localStorage/BroadcastChannel would collide. `storage-namespace.js` detects iframe nesting depth and prefixes all keys with `ds{depth}-` (e.g., `ds1-deepsteve`). Depth 0 (top-level) uses no prefix for backward compatibility. Each recursion level gets fully isolated sessions, tabs, and layout state.

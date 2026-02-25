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
./install.sh
```

## Architecture

### Overview

deepsteve runs as a macOS LaunchAgent daemon that serves a web UI for managing multiple Claude Code terminal sessions. Each browser tab gets its own PTY-backed Claude instance.

### Components

**`server.js`** - Node.js backend (Express + WebSocket)
- Spawns Claude Code processes via `node-pty` for real PTY support
- WebSocket server multiplexes terminal I/O between browser and PTY
- Persists session state to `~/.deepsteve/state.json` on shutdown (SIGTERM)
- Restores sessions on startup with `claude -c` (continue flag)
- 30-second grace period before killing shells to allow page refresh reconnection

**`public/index.html`** - Single-page frontend
- xterm.js terminal emulator with FitAddon for responsive sizing
- Tab management with localStorage persistence
- Directory picker modal for choosing working directory
- Context menu for tab renaming
- Shift+Enter sends CSI u escape sequence (`\x1b[13;2u`) for multi-line input

**`install.sh`** - Installer
- Copies files to `~/.deepsteve/`
- Installs npm dependencies
- Sets up LaunchAgent plist at `~/Library/LaunchAgents/com.deepsteve.plist`
- Fixes node-pty spawn-helper permissions

### Session Persistence

When daemon restarts:
1. SIGTERM triggers `saveState()` → writes shell IDs + cwds + claudeSessionIds to `state.json`
2. `stateFrozen` flag prevents shell `onExit` handlers from overwriting state.json during shutdown
3. On startup, loads `state.json`
4. When client reconnects with saved ID, spawns `claude --resume <claudeSessionId>` in saved cwd
5. If `--resume` fails (exits within 5s), falls back to `claude -c --fork-session --session-id <newUUID>`

### Terminal I/O Flow

```
Browser (xterm.js) ←→ WebSocket ←→ server.js ←→ node-pty ←→ Claude Code
```

Key input handling:
- Regular keys: xterm.js → WebSocket → PTY
- Shift+Enter: intercepted, sends `\x1b[13;2u` (CSI u encoding)
- Resize: FitAddon calculates cols/rows, sends JSON message to server

### Security

DeepSteve has **no authentication, no CORS, and no WebSocket origin checking**. It is designed for localhost use only. The server binds to all interfaces (`0.0.0.0`) — do not expose port 3000 to untrusted networks. All API endpoints, the MCP endpoint, and WebSocket connections are unauthenticated.

### Gotchas and Non-Obvious Behavior

- **Ink input parsing**: `shell.write("text\r")` doesn't work for submitting to Claude. Text and `\r` must be sent separately with a 1s delay (`submitToShell()`), because Ink only recognizes Enter when `\r` arrives as its own stdin read.
- **BEL detection**: The server detects `\x07` (BEL) in PTY output to know Claude is waiting for input. This drives the `waitingForInput` state, browser notifications, and auto-submission of `initialPrompt`.
- **Graceful shutdown**: The shutdown sequence tries `/exit` first (with Ctrl+C interrupt if Claude is busy), waits 8s, then SIGTERM, then 2s more, then SIGKILL. Process group kills (`-pid`) are attempted first for child process cleanup.
- **Two-tier session storage on client**: `TabSessions` (sessionStorage) is the authoritative per-tab source that survives page refresh. `SessionStore` (localStorage) is for cross-tab/window coordination (orphan detection, restore modal). Both must be kept in sync.
- **Orphan detection**: Uses BroadcastChannel for cross-tab heartbeats. When a new tab opens and finds localStorage windows with no heartbeat response within 1.5s, those sessions are offered for restore.
- **Scrollback buffer**: Each shell keeps a ~100KB circular buffer. On reconnect/restore, the full buffer is replayed to the terminal before any new output, so you see history.
- **`restart.sh` runs in background**: It re-execs itself with `nohup` so the terminal returns immediately. Use `--refresh` flag to force browser page reload (vs silent WebSocket reconnect).
- **`release.sh` generates `install.sh`**: The installer is a single self-contained bash script with all source files embedded as heredocs (text) or base64 (images). Binary images are base64-encoded.
- **node-pty**: Uses `.removeListener()` not `.off()`. Must `delete env.CLAUDECODE` when spawning nested Claude instances.
- **LaunchAgent PATH**: `execSync` uses `/bin/sh` without Homebrew paths. Commands like `gh` and `git` must be wrapped in `zsh -l -c '...'` to get the user's full PATH.
- **Worktrees**: Sessions can be created with a `--worktree <name>` flag that's passed through to Claude Code. The worktree name is persisted in state.json for restore. `./restart.sh` only deploys from the main repo checkout — it does NOT copy worktree contents to `~/.deepsteve/`. Merge changes to main first, then restart from the main repo.

### Frontend Module Structure

The frontend is split into ES modules under `public/js/`:
- `app.js` — Main entry, session lifecycle, settings/issue picker modals
- `ws-client.js` — WebSocket wrapper with auto-reconnect (1s interval)
- `tab-manager.js` — Tab bar UI (create, switch, close, rename, badges)
- `terminal.js` — xterm.js setup, fit, Shift+Enter handling
- `session-store.js` — localStorage multi-window session persistence
- `window-manager.js` — BroadcastChannel heartbeats, orphan detection
- `layout-manager.js` — Horizontal/vertical tab layout toggle + resizer
- `dir-picker.js` — Directory browser modal for choosing cwd
- `window-restore-modal.js` — Modal for adopting orphaned sessions
- `live-reload.js` — Dedicated WS for hot reload on `restart.sh --refresh`
- `mod-manager.js` — Mod system: iframe views with bridge API (`deepsteve.getSessions()`, etc.)

### File Locations

- Repo: `the repo root`
- Install: `~/.deepsteve/`
- Logs: `~/Library/Logs/deepsteve.log`, `~/Library/Logs/deepsteve.error.log`
- State: `~/.deepsteve/state.json`
- Settings: `~/.deepsteve/settings.json`
- Themes: `~/.deepsteve/themes/*.css` (watched with `fs.watch()` for live reload of active theme)
- Mods: `mods/<name>/mod.json` + `index.html`
- LaunchAgent: `~/Library/LaunchAgents/com.deepsteve.plist`

**Important:** After editing repo files, run `./restart.sh --refresh` to sync, restart, and reload browser tabs.

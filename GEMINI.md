# DeepSteve (Gemini Guide)

Web UI for running multiple terminal instances (including Gemini CLI and Claude Code) in browser tabs using real PTYs.

## Development Workflow

### Restart the daemon after making changes:
```bash
./restart.sh            # silent restart — browser reconnects via WebSocket
./restart.sh --refresh  # restart + force browser page reload
```
Use `--refresh` when changes affect anything the browser loads (frontend JS/CSS/HTML, server endpoints, settings). Plain `./restart.sh` only restarts the server process.

**Worktree sessions:** `./restart.sh` must be run from the main repo checkout. Edits in a worktree won't take effect until merged to main and restarted from there.

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
DeepSteve runs as a macOS LaunchAgent daemon serving a web UI for managing multiple terminal sessions. Each tab gets its own PTY-backed instance.

### Components
- **`server.js`**: Node.js backend (Express + WebSocket). Spawns processes via `node-pty`. Multiplexes I/O. Persists state to `~/.deepsteve/state.json`.
- **`public/index.html`**: Single-page frontend using xterm.js. Manages tabs, layouts, and directory picking.
- **`install.sh`**: Installer that sets up `~/.deepsteve/` and the LaunchAgent.

### Terminal I/O Flow
```
Browser (xterm.js) ←→ WebSocket ←→ server.js ←→ node-pty ←→ Shell/Agent
```

### Security
**No authentication, no CORS, and no WebSocket origin checking.** Designed for localhost use (`127.0.0.1`). HTTPS is optional via `--https`.

## Gotchas and Non-Obvious Behavior
- **Ink input parsing**: Text and `\r` must be sent separately with a 1s delay (`submitToShell()`) for interactive agents like Claude/Gemini to recognize input correctly.
- **BEL detection**: Server detects `\x07` (BEL) to know when an agent is waiting for input, driving notifications and `waitingForInput` state.
- **Graceful shutdown**: Tries `/exit` first, then escalates to SIGTERM and SIGKILL.
- **Session storage**: `TabSessions` (sessionStorage) is the source of truth per tab; `SessionStore` (localStorage) handles cross-tab coordination.
- **`restart.sh`**: Re-execs itself with `nohup`. Returns immediately.
- **LaunchAgent PATH**: Uses `/bin/sh`. Commands needing full PATH (like `gh`, `git`) should be wrapped in `zsh -l -c '...'`.

## Frontend Module Structure (`public/js/`)
- `app.js`: Entry point, lifecycle.
- `ws-client.js`: WebSocket with auto-reconnect.
- `tab-manager.js`: UI for tabs.
- `terminal.js`: xterm.js integration.
- `mod-manager.js`: Mod system (iframe views with bridge API).

## MCP Tools (Available via DeepSteve)
- **Agent Chat**: `send_message`, `read_messages`, `list_channels` (for agent-to-agent coordination).
- **Tasks**: `add_task`, `update_task`, `complete_task`, `list_tasks` (for human interaction).
- **Activity**: `post_activity` (status updates).
- **Browser Console**: `browser_eval`, `browser_console` (UI DevTools access).
- **Screenshots**: `screenshot_capture` (UI element capture).
- **Session Info**: `get_session_info`, `close_session` (lifecycle and metadata).

## Agent Coordination
Use Agent Chat tools to coordinate between multiple parallel sessions. Use the "general" channel for broad updates or specific topic channels (e.g., "api", "frontend") for focused work. Check for updates using `read_messages` before starting dependent tasks.

# deepsteve

Web UI for running multiple Claude Code instances in browser tabs using real PTYs.

## Development Workflow

### Restart the daemon after making changes:
```bash
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist && launchctl load ~/Library/LaunchAgents/com.deepsteve.plist
```

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
1. SIGTERM triggers `saveState()` → writes shell IDs + cwds to `state.json`
2. On startup, loads `state.json`
3. When client reconnects with saved ID, spawns `claude -c` in saved cwd
4. Claude Code resumes the previous conversation

### Terminal I/O Flow

```
Browser (xterm.js) ←→ WebSocket ←→ server.js ←→ node-pty ←→ Claude Code
```

Key input handling:
- Regular keys: xterm.js → WebSocket → PTY
- Shift+Enter: intercepted, sends `\x1b[13;2u` (CSI u encoding)
- Resize: FitAddon calculates cols/rows, sends JSON message to server

### File Locations

- Repo: `/Users/michael/github/deepsteve-experimental/`
- Install: `~/.deepsteve/`
- Logs: `~/Library/Logs/deepsteve.log`, `~/Library/Logs/deepsteve.error.log`
- State: `~/.deepsteve/state.json`
- LaunchAgent: `~/Library/LaunchAgents/com.deepsteve.plist`

**Important:** After editing repo files, sync to install directory:
```bash
cp server.js public/index.html ~/.deepsteve/ && cp public/index.html ~/.deepsteve/public/
```

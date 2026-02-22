# deepsteve

Run multiple Claude Code sessions side-by-side in your browser, each with full terminal capabilities and persistent conversation history.

## Features

- **Multiple sessions** - Open as many Claude Code instances as you need in separate tabs
- **Real terminal emulation** - Full PTY support via xterm.js, not a fake terminal
- **Session persistence** - Conversations survive server restarts and page refreshes
- **Directory picker** - Start each session in any working directory
- **Runs as a daemon** - Always available in the background on your Mac

## Installation

```bash
./install.sh
```

This installs deepsteve to `~/.deepsteve/` and sets up a macOS LaunchAgent to run automatically.

## Usage

Open [http://localhost:3000](http://localhost:3000) in your browser.

- Click **+** to create a new Claude Code session
- Right-click a tab to rename it
- Use **Shift+Enter** for multi-line input

## Managing the Daemon

```bash
# Restart after making changes
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist && launchctl load ~/Library/LaunchAgents/com.deepsteve.plist

# View logs
tail -f ~/Library/Logs/deepsteve.log

# Stop
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist

# Check status
launchctl list | grep deepsteve
```

## Uninstall

```bash
~/.deepsteve/uninstall.sh
```

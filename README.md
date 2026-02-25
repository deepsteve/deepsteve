<p align="center">
  <img src="public/icon-512.png" alt="deepsteve logo" width="200">
</p>

# deepsteve

Run multiple Claude Code sessions side-by-side in your browser, each with full terminal capabilities and persistent conversation history.

**Requires macOS.** deepsteve uses macOS LaunchAgents for daemon management and macOS-specific paths for logs and state.

## Features

- **Multiple sessions** - Open as many Claude Code instances as you need in separate tabs
- **Real terminal emulation** - Full PTY support via xterm.js, not a fake terminal
- **Session persistence** - Conversations survive server restarts and page refreshes
- **Directory picker** - Start each session in any working directory
- **Runs as a daemon** - Always available in the background on your Mac
- **Themes** - Customize the UI with CSS files in `~/.deepsteve/themes/`
- **Mods** - Extend deepsteve with visual mods (e.g. the pixel art Tower view)

## Quick Install

```bash
curl -fsSL https://github.com/deepsteve/deepsteve/releases/latest/download/install.sh | bash
```

## Requirements

- macOS
- Node.js
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed

## Installation (from source)

If you've cloned the repo:

```bash
./install.sh
```

This installs deepsteve to `~/.deepsteve/` and sets up a macOS LaunchAgent to run automatically.

## Usage

Open [http://localhost:3000](http://localhost:3000) in your browser.

- Click **+** to create a new Claude Code session
- Right-click a tab to rename it
- Use **Shift+Enter** for multi-line input

## Themes

Place `.css` files in `~/.deepsteve/themes/` to add custom themes. Select the active theme from the settings panel (gear icon).

## Mods

Mods are visual extensions that provide alternative views of your sessions. Each mod lives in `mods/<name>/` with a `mod.json` manifest and an HTML entry point.

Built-in mods:
- **Tower** - A pixel art skyscraper visualization of your Claude sessions

Enable and disable mods from the Mods dropdown in the toolbar.

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

## Security

- Binds to `localhost:3000` only — not accessible from the network
- No authentication — anyone with local access to the machine can use it
- Each session runs Claude Code with the permissions of the user who installed deepsteve

## Contributing

Bug reports and feature requests are welcome on [GitHub Issues](https://github.com/deepsteve/deepsteve/issues). Pull requests are welcome.

## Uninstall

```bash
~/.deepsteve/uninstall.sh
```

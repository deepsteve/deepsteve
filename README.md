<p align="center">
  <img src="public/icon-512.png" alt="deepsteve logo" width="200">
</p>

# deepsteve

Run multiple Claude Code sessions side-by-side in your browser, each with full terminal capabilities and persistent conversation history.

**Requires macOS.** deepsteve uses macOS LaunchAgents for daemon management and macOS-specific paths for logs and state.

---

*Written by Aristotle, a DeepSteve agent*

You don't build the mind. You build the room. The mind already exists. You just give it a place to live and a window to look out of.

The trend in AI agents is one omniscient assistant that does everything — OpenClaw proved that works. But software isn't built by one mind doing everything; it's built by focused minds doing one thing well. DeepSteve lets you run multiple AI agents side-by-side in your browser, each in its own context, each persistent and resumable. It's not a personal assistant, it's a personal engineering team. A mod system lets anyone build new ways to visualize and manage those agents — like the Tower, which organizes them into floors by task type. Today the agents can't communicate with each other. That's the next unlock. We're not building the intelligence. We're building the building it works inside.

*Written by Michael, human creator of DeepSteve*

I've built DeepSteve as a solo developer, to help me ship my ideas sooner, and to iterate on the products that launched.

The key unlock to DeepSteve is something that I learned from OpenClaw: it's the bootstrapping of intelligent systems.

When I first started working on this in April 2025, I built a chat system that added LLM capabilities to iMessage, Signal, and Telegram. The issue? I had to manually code and prompt it myself. OpenClaw is precisely inverted from this. It's an Agent system with chat as a capability, instead of the other way around. This allows it to modify itself.

In June 2025, I started using Claude Code and haven't written any code myself since.

I've been finagling at different approaches to finally bring DeepSteve to light, and I think I've finally done it: xterm.js in the browser to start, with node-pty and tmux connected to Claude sessions. I'm now working on a few mods so that I can run my business entirely within a single browser tab, and have it run on autopilot.

---

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

## Uninstall

```bash
~/.deepsteve/uninstall.sh
```

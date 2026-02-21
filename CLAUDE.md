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

- `server.js` - Express + WebSocket server that spawns Claude PTYs via node-pty
- `public/index.html` - xterm.js frontend with tab management and directory picker
- `install.sh` - Self-contained installer that sets up LaunchAgent daemon

## Known Issues

- node-pty spawn-helper needs execute permission after npm install (handled in install.sh)
- Shells have 30-second grace period before cleanup to allow page refresh reconnection

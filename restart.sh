#!/bin/bash
# Restart deepsteve daemon - just run ./restart.sh
# Pass --refresh to force browser page reload after restart.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REFRESH=0

# Parse flags (before --bg re-exec)
for arg in "$@"; do
    case "$arg" in
        --refresh) REFRESH=1 ;;
    esac
done

# Re-exec in background if not already
if [[ "$1" != "--bg" ]]; then
    # Ask browser for confirmation before restarting
    RESULT=$(curl -s -m 120 -X POST http://localhost:3000/api/request-restart 2>/dev/null | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
    if [ "$RESULT" != "confirmed" ]; then
        echo "Restart cancelled."
        exit 0
    fi

    nohup "$0" --bg "$SCRIPT_DIR" $([ "$REFRESH" = 1 ] && echo --refresh) >/dev/null 2>&1 &
    disown
    echo "Restarting in background..."
    exit 0
fi

SCRIPT_DIR="$2"
cd "$SCRIPT_DIR"

cp package.json ~/.deepsteve/
cp server.js ~/.deepsteve/
cp mcp-server.js ~/.deepsteve/
mkdir -p ~/.deepsteve/engines
cp engines/*.js ~/.deepsteve/engines/
cp -r public/* ~/.deepsteve/public/
mkdir -p ~/.deepsteve/themes
cp -n themes/*.css ~/.deepsteve/themes/ 2>/dev/null || true
mkdir -p ~/.deepsteve/mods
cp -r mods/* ~/.deepsteve/mods/ 2>/dev/null || true

# Prune stale repo mods (keep user-installed mods that have a .source marker)
for deployed in ~/.deepsteve/mods/*/; do
    modname=$(basename "$deployed")
    if [ ! -d "mods/$modname" ] && [ ! -f "$deployed/.source" ]; then
        rm -rf "$deployed"
    fi
done
mkdir -p ~/.deepsteve/commands
mkdir -p ~/.deepsteve/skills
cp -r skills/*.md ~/.deepsteve/skills/ 2>/dev/null || true

# Install deps if package.json changed
if ! diff -q package.json ~/.deepsteve/package.json.prev &>/dev/null; then
    (cd ~/.deepsteve && npm install --omit=dev 2>&1 | tail -1)
    cp package.json ~/.deepsteve/package.json.prev
fi

# Register deepsteve as MCP server with Claude Code (idempotent)
if command -v claude &>/dev/null; then
    claude mcp add --transport http deepsteve http://localhost:3000/mcp 2>/dev/null || true
fi

# Signal the server to tell browsers to reload (only with --refresh)
if [ "$REFRESH" = 1 ]; then
    touch ~/.deepsteve/.reload
fi

# --- Stop old server ---
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist 2>/dev/null

# Wait for old server process to fully exit (up to 15s).
# The server's graceful shutdown can take ~12s worst case (8s shell exit +
# 2s SIGTERM + 2s SIGKILL + 0.5s drain).
WAITED=0
while [ "$WAITED" -lt 15 ] && launchctl list 2>/dev/null | grep -q com.deepsteve; do
    sleep 1
    WAITED=$((WAITED + 1))
done

# Safety net: ensure the port is actually free (handles edge cases like
# a child process holding the socket after the main process exits).
WAITED=0
while [ "$WAITED" -lt 5 ] && lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; do
    sleep 1
    WAITED=$((WAITED + 1))
done

# --- Start new server ---
launchctl load ~/Library/LaunchAgents/com.deepsteve.plist

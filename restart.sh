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

launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist 2>/dev/null
sleep 3
launchctl load ~/Library/LaunchAgents/com.deepsteve.plist

#!/bin/bash
# Restart deepsteve daemon - just run ./restart.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Re-exec in background if not already
if [[ "$1" != "--bg" ]]; then
    nohup "$0" --bg "$SCRIPT_DIR" >/dev/null 2>&1 &
    disown
    echo "Restarting in background..."
    exit 0
fi

SCRIPT_DIR="$2"
cd "$SCRIPT_DIR"

cp server.js ~/.deepsteve/
cp -r public/* ~/.deepsteve/public/

launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist 2>/dev/null
sleep 3
launchctl load ~/Library/LaunchAgents/com.deepsteve.plist

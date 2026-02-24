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

cp server.js ~/.deepsteve/
mkdir -p ~/.deepsteve/engines
cp engines/*.js ~/.deepsteve/engines/
cp -r public/* ~/.deepsteve/public/
mkdir -p ~/.deepsteve/themes
cp -n themes/*.css ~/.deepsteve/themes/ 2>/dev/null || true
mkdir -p ~/.deepsteve/mods
cp -r mods/* ~/.deepsteve/mods/ 2>/dev/null || true

# Signal the server to tell browsers to reload (only with --refresh)
if [ "$REFRESH" = 1 ]; then
    touch ~/.deepsteve/.reload
fi

launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist 2>/dev/null
sleep 3
launchctl load ~/Library/LaunchAgents/com.deepsteve.plist

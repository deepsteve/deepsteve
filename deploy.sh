#!/bin/bash
# Deploy deepsteve changes to ~/.deepsteve and restart daemon

set -e

DEST="$HOME/.deepsteve"

# Copy all files
cp server.js "$DEST/"
cp -r public/* "$DEST/public/"

# Restart daemon
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.deepsteve.plist

echo "Deployed and restarted"

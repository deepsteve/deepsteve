#!/bin/bash
launchctl unload "$HOME/Library/LaunchAgents/com.deepsteve.plist" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/com.deepsteve.plist"
rm -rf "$HOME/.deepsteve"
rm -f "$HOME/Library/Logs/deepsteve.log" "$HOME/Library/Logs/deepsteve.error.log"
echo "deepsteve uninstalled"

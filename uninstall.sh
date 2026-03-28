#!/bin/bash
OS=$(uname -s)

if [ "$OS" = "Darwin" ]; then
    launchctl unload "$HOME/Library/LaunchAgents/com.deepsteve.plist" 2>/dev/null
    rm -f "$HOME/Library/LaunchAgents/com.deepsteve.plist"
    rm -f "$HOME/Library/Logs/deepsteve.log" "$HOME/Library/Logs/deepsteve.error.log"
else
    systemctl --user stop deepsteve 2>/dev/null
    systemctl --user disable deepsteve 2>/dev/null
    rm -f "$HOME/.config/systemd/user/deepsteve.service"
    systemctl --user daemon-reload 2>/dev/null
    rm -rf "$HOME/.local/share/deepsteve/logs"
fi

rm -rf "$HOME/.deepsteve"

# Remove installed skills from Claude Code commands
rm -f "$HOME/.claude/commands/deepsteve-"*.md

# Remove Claude Code MCP registration
if command -v claude &>/dev/null; then
    claude mcp remove --scope user deepsteve 2>/dev/null || true
fi

# Remove deepsteve from OpenCode global config
OC_CONFIG="$HOME/.config/opencode/opencode.json"
if [ -f "$OC_CONFIG" ] && command -v node &>/dev/null; then
    node -e '
        const fs = require("fs");
        const p = process.argv[1];
        try {
            const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
            if (cfg.mcp && cfg.mcp.deepsteve) {
                delete cfg.mcp.deepsteve;
                if (Object.keys(cfg.mcp).length === 0) delete cfg.mcp;
                if (Object.keys(cfg).length === 0 || (Object.keys(cfg).length === 1 && cfg["$schema"])) {
                    fs.unlinkSync(p);
                } else {
                    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
                }
            }
        } catch {}
    ' "$OC_CONFIG" 2>/dev/null || true
fi

echo "deepsteve uninstalled"

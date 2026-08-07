#!/bin/bash
# Tear down a deepsteve install.
#
# Runs from two places: ~/.deepsteve/uninstall.sh (where install.sh and restart.sh both
# put it) and a git checkout (./uninstall.sh). service.sh sits next to it in both cases,
# so try there first and fall back to the install dir.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -r "$SCRIPT_DIR/service.sh" ]; then
    # shellcheck source=service.sh
    . "$SCRIPT_DIR/service.sh"
elif [ -r "$HOME/.deepsteve/service.sh" ]; then
    . "$HOME/.deepsteve/service.sh"
else
    # Deliberately NOT a duplicated inline teardown — a second copy of the platform
    # branch is exactly the drift #621 removed. Tell the user what to run instead.
    echo "deepsteve: service.sh not found (looked in $SCRIPT_DIR and $HOME/.deepsteve)." >&2
    echo "The install dir can be removed with:  rm -rf ~/.deepsteve" >&2
    echo "Then stop the service manually:" >&2
    echo "  macOS: launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist && rm -f ~/Library/LaunchAgents/com.deepsteve.plist" >&2
    echo "  Linux: systemctl --user disable --now deepsteve && rm -f ~/.config/systemd/user/deepsteve.service" >&2
    exit 1
fi

# Stop, disable, and remove the plist/unit — one implementation for both platforms.
ds_service_uninstall

# Logs live outside the install dir, so they need removing separately.
LOG_DIR="$(ds_log_dir)"
rm -f "$LOG_DIR/deepsteve.log" "$LOG_DIR/deepsteve.error.log" \
      "$LOG_DIR/deepsteve.log.1" "$LOG_DIR/deepsteve.error.log.1"
# The Linux log dir is ours (~/.local/share/deepsteve/logs) so it can go entirely;
# ~/Library/Logs on macOS is shared with every other app and must NOT be removed.
if [ "$(ds_platform)" != "darwin" ]; then
    rmdir "$LOG_DIR" 2>/dev/null || true
fi

rm -rf "$(ds_install_dir)"

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

#!/bin/bash
# Restart deepsteve daemon - just run ./restart.sh
#
# Flags:
#   --refresh   force a browser page reload after restart (default: silent
#               WebSocket reconnect).
#   --force     skip the in-app browser confirmation modal. Acceptance instead
#               moves to Claude Code's permission prompt for this command
#               (#504), in two steps:
#                 1) ./restart.sh --force
#                      -> prints the live session count and the exact confirm
#                         command to run (no restart, read-only).
#                 2) ./restart.sh --force --prompt "<text from step 1>"
#                      -> restarts after re-validating <text> against the
#                         server's current message.
#               Do NOT allowlist this command: the guarantee that a restart can
#               never happen unilaterally depends on it staying prompt-gated.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# One interface over launchd and systemd (#621). Sourced HERE, at the very top, for two
# reasons beyond tidiness:
#
#  1. It fails before anything irreversible. A missing library aborts before the confirm
#     handshake, before .restarting is touched, and before the old daemon is stopped.
#  2. It makes the mid-restart edit hazard smaller, not larger. bash reads a script
#     lazily by byte offset, so editing restart.sh while its background phase is running
#     can resume it at a garbage offset — and the stop/start code used to be read from
#     disk ~20s into the run. Sourcing parses every ds_* body into memory at second
#     zero, so editing service.sh mid-restart now has no effect at all.
if [ ! -r "$SCRIPT_DIR/service.sh" ]; then
    echo "deepsteve: $SCRIPT_DIR/service.sh is missing — cannot restart." >&2
    exit 1
fi
# shellcheck source=service.sh
. "$SCRIPT_DIR/service.sh"

REFRESH=0
FORCE=0
HAS_PROMPT=0
FORCE_PROMPT=""
BG=0
BG_DIR=""

# Detect the internal background re-exec first; its positional args
# (--bg <dir>) must be read before we consume the rest as flags.
if [[ "$1" == "--bg" ]]; then
    BG=1
    BG_DIR="$2"
    shift 2
fi

# Parse flags (applies to both the user invocation and the --bg re-exec).
while [ $# -gt 0 ]; do
    case "$1" in
        --refresh) REFRESH=1 ;;
        --force)   FORCE=1 ;;
        --prompt)  HAS_PROMPT=1; shift; FORCE_PROMPT="$1" ;;
    esac
    shift
done

# Auth token (#536): the daemon owns ~/.deepsteve/auth-token and is its sole creator. Read it (if
# present) so our control curls to the running daemon authenticate. Absent (very first install,
# daemon never booted) → no header, which is harmless: the old/absent daemon has no auth to satisfy.
AUTH_TOKEN_FILE="$HOME/.deepsteve/auth-token"
AUTH_HEADER=()
build_auth_header() {
    AUTH_HEADER=()
    if [ -f "$AUTH_TOKEN_FILE" ]; then
        local tok
        tok=$(cat "$AUTH_TOKEN_FILE" 2>/dev/null)
        [ -n "$tok" ] && AUTH_HEADER=(-H "Authorization: Bearer $tok")
    fi
}
build_auth_header

# Re-exec in background if not already
if [ "$BG" != 1 ]; then
    # --- Forced restart path (#504): bypass the in-app browser modal. ---
    # Acceptance moves to Claude Code's permission prompt for this command. The
    # server owns the confirmation wording; we echo it back and re-validate so a
    # stale or forged message can't slip through.
    if [ "$FORCE" = 1 ]; then
        SERVER_PROMPT=$(curl -s -m 10 "${AUTH_HEADER[@]}" "$(ds_url)/api/restart-prompt" 2>/dev/null)
        if [ -z "$SERVER_PROMPT" ]; then
            # Daemon unreachable: deterministic text so step 1 and step 2 agree.
            SERVER_PROMPT="Restarting DeepSteve (daemon not running - no active sessions)"
        fi

        REFRESH_ARG=""
        [ "$REFRESH" = 1 ] && REFRESH_ARG=" --refresh"

        if [ "$HAS_PROMPT" != 1 ]; then
            # Step 1: report the live blast radius and the exact confirm command.
            echo "$SERVER_PROMPT"
            echo "To confirm, run: ./restart.sh --force --prompt \"$SERVER_PROMPT\"$REFRESH_ARG"
            exit 0
        fi

        if [ "$FORCE_PROMPT" != "$SERVER_PROMPT" ]; then
            # Echoed text is stale/forged — refuse and reprint the current one.
            echo "Confirmation text does not match the current server state."
            echo "$SERVER_PROMPT"
            echo "Re-run: ./restart.sh --force --prompt \"$SERVER_PROMPT\"$REFRESH_ARG"
            exit 1
        fi

        # Confirmed — graceful restart, skipping the browser modal entirely.
        nohup "$0" --bg "$SCRIPT_DIR" $([ "$REFRESH" = 1 ] && echo --refresh) >/dev/null 2>&1 &
        disown
        echo "Restarting in background..."
        exit 0
    fi

    # Default path: ask the browser(s) for confirmation before restarting.
    RESULT=$(curl -s -m 120 "${AUTH_HEADER[@]}" -X POST "$(ds_url)/api/request-restart" 2>/dev/null | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
    if [ "$RESULT" != "confirmed" ]; then
        echo "Restart cancelled."
        exit 0
    fi

    nohup "$0" --bg "$SCRIPT_DIR" $([ "$REFRESH" = 1 ] && echo --refresh) >/dev/null 2>&1 &
    disown
    echo "Restarting in background..."
    exit 0
fi

SCRIPT_DIR="$BG_DIR"
cd "$SCRIPT_DIR"

cp package.json ~/.deepsteve/
# ALL root modules, not a hand-maintained list: a new require() in server.js
# (e.g. sleep-watch.js in #563) must never be missable here — a missed copy
# crash-loops the daemon on the next restart with MODULE_NOT_FOUND.
cp *.js ~/.deepsteve/
# Ship the shell library and the read-only entry point too (#621), so a git-checkout
# install's ~/.deepsteve/{uninstall,status}.sh source the SAME service.sh this script
# just used. Before this, restart.sh copied no .sh at all, so a pure git install had no
# uninstall.sh whatsoever — only install.sh ever put one there.
#
# Deliberately NOT `cp *.sh`: restart.sh must never land inside its own deploy target
# (a copy in ~/.deepsteve would be a second restart entry point, and it would try to
# deploy ~/.deepsteve onto itself), and release.sh is a maintainer tool. The list is
# hand-maintained on purpose and pinned by test/unit/shell-deploy.test.js.
cp service.sh uninstall.sh status.sh ~/.deepsteve/
chmod +x ~/.deepsteve/uninstall.sh ~/.deepsteve/status.sh
# service.sh stays non-executable: that is what keeps `./service.sh restart` from being
# a second, unguarded way to restart the daemon. See its header.
chmod 644 ~/.deepsteve/service.sh
mkdir -p ~/.deepsteve/engines
cp engines/*.js ~/.deepsteve/engines/
cp -r public/* ~/.deepsteve/public/
mkdir -p ~/.deepsteve/themes
# Force-overwrite built-in themes so CSS edits actually redeploy. cp -n silently
# skipped any theme that already existed, stranding theme updates on installs that
# already had the file (user-added themes not in the repo are still left untouched).
cp -f themes/*.css ~/.deepsteve/themes/ 2>/dev/null || true
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

# Stamp install-source marker so the server knows this is a git-checkout install.
# Used by the auto-update system (GET /api/version, POST /api/update/git-pull).
INSTALL_VERSION=$(node -p "require('$SCRIPT_DIR/package.json').version" 2>/dev/null || echo "unknown")
REPO_REMOTE=$(git -C "$SCRIPT_DIR" config --get remote.origin.url 2>/dev/null || echo "")
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > ~/.deepsteve/.install-source.json <<MARKEREOF
{
  "type": "git",
  "installedAt": "$INSTALLED_AT",
  "installVersion": "$INSTALL_VERSION",
  "sourcePath": "$SCRIPT_DIR",
  "repoRemote": "$REPO_REMOTE"
}
MARKEREOF

# NOTE: the global `claude mcp add` registration is deferred to AFTER the server starts (below),
# because it now needs the auth token (#536) which the server creates on first boot.

# Signal the server to tell browsers to reload (only with --refresh)
if [ "$REFRESH" = 1 ]; then
    touch ~/.deepsteve/.reload
fi

# Mark this as a restart so the new server skips its auto-open-browser timer.
# Without this, existing browsers that are silently reconnecting their
# WebSockets can lose the 3–5s race and the server ends up opening a phantom
# new tab. The new server deletes this flag on startup.
touch ~/.deepsteve/.restarting

# --- Stop old server ---
# launchctl on macOS, `systemctl --user` on Linux — one interface, in service.sh (#621).
# Until then this whole block was launchctl-only with no platform branch at all, which
# is why restart.sh (and therefore the in-app git-pull auto-update, which spawns it)
# simply did not work on Linux.
ds_service_stop

# Wait for the old process to fully exit (up to 15s), then for the port to actually be
# free — a child can hold the socket briefly after the parent goes. Graceful shutdown is
# ~12s worst case (8s shell exit + 2s SIGTERM + 2s SIGKILL + 0.5s drain).
# The port check replaced `lsof -i :3000`: lsof is absent on minimal Linux images, and
# the port now comes from the service definition rather than being hardcoded.
ds_wait_stopped 15 || echo "Warning: the old daemon is still running after 15s; starting anyway." >&2

# --- Start new server ---
ds_service_start || {
    echo "deepsteve: the service manager refused to start the daemon. Recover with:" >&2
    ds_start_hint >&2
    exit 1
}

# Global MCP registrations run AFTER the server is up so the auth token exists (#536/#538).
# Wait up to ~15s for the freshly-booted server's public health endpoint.
if command -v claude &>/dev/null || command -v opencode &>/dev/null; then
    WAITED=0
    while [ "$WAITED" -lt 15 ] && ! curl -sf -m 2 "$(ds_url)/healthz" >/dev/null 2>&1; do
        sleep 1
        WAITED=$((WAITED + 1))
    done
fi

# Register deepsteve as a global MCP server with Claude Code (idempotent). The per-session
# deepsteve config injected at spawn time is separate and already carries the token; this global
# registration is only for `claude` runs outside deepsteve.
if command -v claude &>/dev/null; then
    build_auth_header   # re-read the now-created token
    if [ ${#AUTH_HEADER[@]} -gt 0 ]; then
        claude mcp add --transport http deepsteve "$(ds_url)/mcp" \
            --header "Authorization: Bearer $(cat "$AUTH_TOKEN_FILE" 2>/dev/null)" 2>/dev/null || true
    else
        claude mcp add --transport http deepsteve "$(ds_url)/mcp" 2>/dev/null || true
    fi
fi

# Configure OpenCode global MCP (idempotent upsert; also heals pre-#538 unauthenticated configs).
# The {file:...} reference makes opencode read the token at its own startup, so the secret never
# lands in this (non-0600) config file and token rotation needs no re-write (#538).
if command -v opencode &>/dev/null; then
    OC_CONFIG_DIR="$HOME/.config/opencode"
    OC_CONFIG="$OC_CONFIG_DIR/opencode.json"
    mkdir -p "$OC_CONFIG_DIR"
    node -e '
        const fs = require("fs"), os = require("os"), path = require("path");
        const p = process.argv[1];
        let cfg = null;
        try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
        if (!cfg || typeof cfg !== "object") cfg = { "$schema": "https://opencode.ai/config.json" };
        if (!cfg.mcp) cfg.mcp = {};
        const entry = { type: "remote", url: process.argv[2] };
        // opencode errors out at config load on a {file:...} pointing at a missing file, so
        // only reference the token if the server actually created it.
        if (fs.existsSync(path.join(os.homedir(), ".deepsteve", "auth-token"))) {
            entry.headers = { Authorization: "Bearer {file:~/.deepsteve/auth-token}" };
        }
        cfg.mcp.deepsteve = entry;
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    ' "$OC_CONFIG" "http://127.0.0.1:$(ds_port)/mcp" 2>/dev/null || true
fi

#!/bin/bash
# Generates install.sh from current source files.
# Run this before cutting a release.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Fail if package.json version matches the latest git tag (forgot to bump)
PKG_VERSION=$(node -p "require('./package.json').version")
LATEST_TAG=$(git tag --sort=-version:refname 2>/dev/null | head -1)
if [ "v$PKG_VERSION" = "$LATEST_TAG" ]; then
  echo "ERROR: package.json version ($PKG_VERSION) matches latest tag ($LATEST_TAG)." >&2
  echo "Bump the version in package.json before running release.sh." >&2
  exit 1
fi
echo "Version: $PKG_VERSION (latest tag: ${LATEST_TAG:-none})"

NODE_VERSION="22.14.0"
NODE_SHA256_ARM64="e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42"
NODE_SHA256_X64="6698587713ab565a94a360e091df9f6d91c8fadda6d00f0cf6526e9b40bed250"
NODE_SHA256_LINUX_ARM64="8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0"
NODE_SHA256_LINUX_X64="9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2"

OUT="install.sh"

# --- Preamble ---
cat > "$OUT" << 'PREAMBLE'
#!/bin/bash
set -e

OS=$(uname -s)

if ! command -v node &>/dev/null; then
  echo "Node.js not found, installing..."
  if command -v brew &>/dev/null; then
    brew install node
  else
    ARCH=$(uname -m)
    case "$ARCH" in arm64|aarch64) ARCH="arm64";; *) ARCH="x64";; esac
    NODE_VERSION="__NODE_VERSION__"
    if [ "$OS" = "Darwin" ]; then
      NODE_PLATFORM="darwin"
      if [ "$ARCH" = "arm64" ]; then NODE_SHA256="__NODE_SHA256_ARM64__"; else NODE_SHA256="__NODE_SHA256_X64__"; fi
    else
      NODE_PLATFORM="linux"
      if [ "$ARCH" = "arm64" ]; then NODE_SHA256="__NODE_SHA256_LINUX_ARM64__"; else NODE_SHA256="__NODE_SHA256_LINUX_X64__"; fi
    fi
    NODE_DIR="$HOME/.deepsteve/node"
    mkdir -p "$NODE_DIR"
    NODE_TGZ=$(mktemp)
    trap 'rm -f "$NODE_TGZ"' EXIT
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_PLATFORM}-${ARCH}.tar.gz" -o "$NODE_TGZ"
    if command -v shasum &>/dev/null; then
      ACTUAL_SHA256=$(shasum -a 256 "$NODE_TGZ" | awk '{print $1}')
    else
      ACTUAL_SHA256=$(sha256sum "$NODE_TGZ" | awk '{print $1}')
    fi
    if [ "$ACTUAL_SHA256" != "$NODE_SHA256" ]; then
      echo "ERROR: Node.js checksum verification failed!" >&2
      echo "  Expected: $NODE_SHA256" >&2
      echo "  Got:      $ACTUAL_SHA256" >&2
      rm -f "$NODE_TGZ"
      exit 1
    fi
    tar xz -C "$NODE_DIR" --strip-components=1 < "$NODE_TGZ"
    rm -f "$NODE_TGZ"
    export PATH="$NODE_DIR/bin:$PATH"
  fi
fi

INSTALL_DIR="$HOME/.deepsteve"
NODE_PATH=$(which node)

if [ "$OS" = "Darwin" ]; then
  SERVICE_PATH="$HOME/Library/LaunchAgents/com.deepsteve.plist"
  LOG_DIR="$HOME/Library/Logs"
  mkdir -p "$HOME/Library/LaunchAgents"
else
  SERVICE_PATH="$HOME/.config/systemd/user/deepsteve.service"
  LOG_DIR="$HOME/.local/share/deepsteve/logs"
  mkdir -p "$HOME/.config/systemd/user"
  mkdir -p "$LOG_DIR"
fi

mkdir -p "$INSTALL_DIR/public/js"
mkdir -p "$INSTALL_DIR/public/css"
mkdir -p "$INSTALL_DIR/engines"
mkdir -p "$INSTALL_DIR/themes"
mkdir -p "$INSTALL_DIR/skills"

PREAMBLE

# Validate all mods before embedding
node validate-mods.js || exit 1

# Generate mkdir for each mod directory
for moddir in mods/*/; do
  modname=$(basename "$moddir")
  echo "mkdir -p \"\$INSTALL_DIR/mods/$modname\"" >> "$OUT"
done
echo "" >> "$OUT"

sed -i '' "s/__NODE_VERSION__/$NODE_VERSION/g" "$OUT"
sed -i '' "s/__NODE_SHA256_ARM64__/$NODE_SHA256_ARM64/g" "$OUT"
sed -i '' "s/__NODE_SHA256_X64__/$NODE_SHA256_X64/g" "$OUT"
sed -i '' "s/__NODE_SHA256_LINUX_ARM64__/$NODE_SHA256_LINUX_ARM64/g" "$OUT"
sed -i '' "s/__NODE_SHA256_LINUX_X64__/$NODE_SHA256_LINUX_X64/g" "$OUT"

# --- Embed text files as heredocs ---

embed_text() {
  local src="$1"
  local dest="$2"
  # Use a unique EOF marker that won't appear in source files
  echo "cat > \"\$INSTALL_DIR/$dest\" << 'DEEPSTEVE_FILE_EOF'" >> "$OUT"
  cat "$src" >> "$OUT"
  echo "DEEPSTEVE_FILE_EOF" >> "$OUT"
  echo "" >> "$OUT"
}

# Core files
embed_text "package.json" "package.json"
embed_text "server.js" "server.js"
embed_text "mcp-server.js" "mcp-server.js"
embed_text "security.js" "security.js"

# Engine files
embed_text "engines/engine.js" "engines/engine.js"
embed_text "engines/node-pty.js" "engines/node-pty.js"
embed_text "engines/tmux.js" "engines/tmux.js"

# Public files
embed_text "public/index.html" "public/index.html"
embed_text "public/sw.js" "public/sw.js"
embed_text "public/manifest.json" "public/manifest.json"

# CSS
embed_text "public/css/styles.css" "public/css/styles.css"

# JS modules
for jsfile in public/js/*.js; do
  embed_text "$jsfile" "$jsfile"
done

# Theme CSS files
for theme in themes/*.css; do
  embed_text "$theme" "$theme"
done

# Mod files
for moddir in mods/*/; do
  for f in "$moddir"*; do
    [ -f "$f" ] && embed_text "$f" "$f"
  done
done

# Skill files
for skill in skills/*.md; do
  embed_text "$skill" "$skill"
done

# --- Embed binary files as base64 ---

embed_binary() {
  local src="$1"
  local dest="$2"
  echo "base64 -d << 'DEEPSTEVE_B64_EOF' > \"\$INSTALL_DIR/$dest\"" >> "$OUT"
  base64 < "$src" >> "$OUT"
  echo "DEEPSTEVE_B64_EOF" >> "$OUT"
  echo "" >> "$OUT"
}

embed_binary "public/favicon.png" "public/favicon.png"
embed_binary "public/icon-192.png" "public/icon-192.png"
embed_binary "public/icon-512.png" "public/icon-512.png"

# --- Uninstall script (use embed_text to avoid nested heredoc issues) ---
embed_text "uninstall.sh" "uninstall.sh"
{
  echo 'chmod +x "$INSTALL_DIR/uninstall.sh"'
  echo ""
} >> "$OUT"

# --- Service file (platform-conditional, needs variable expansion at install time) ---
# Uses unquoted heredoc delimiters so $VARS expand at install time
{
  echo 'if [ "$OS" = "Darwin" ]; then'
  echo 'cat > "$SERVICE_PATH" << PLISTEOF'
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0">'
  echo '<dict>'
  echo '    <key>Label</key>'
  echo '    <string>com.deepsteve</string>'
  echo '    <key>ProgramArguments</key>'
  echo '    <array>'
  echo '        <string>$NODE_PATH</string>'
  echo '        <string>$INSTALL_DIR/server.js</string>'
  echo '    </array>'
  echo '    <key>WorkingDirectory</key>'
  echo '    <string>$INSTALL_DIR</string>'
  echo '    <key>EnvironmentVariables</key>'
  echo '    <dict>'
  echo '        <key>NODE_ENV</key>'
  echo '        <string>production</string>'
  echo '        <key>PORT</key>'
  echo '        <string>3000</string>'
  echo '        <key>DEEPSTEVE_BIND</key>'
  echo '        <string>127.0.0.1</string>'
  echo '        <key>PATH</key>'
  echo '        <string>$INSTALL_DIR/node/bin:$HOME/.local/bin:$(dirname $NODE_PATH):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>'
  echo '    </dict>'
  echo '    <key>RunAtLoad</key>'
  echo '    <true/>'
  echo '    <key>KeepAlive</key>'
  echo '    <true/>'
  echo '    <key>StandardOutPath</key>'
  echo '    <string>$LOG_DIR/deepsteve.log</string>'
  echo '    <key>StandardErrorPath</key>'
  echo '    <string>$LOG_DIR/deepsteve.error.log</string>'
  echo '</dict>'
  echo '</plist>'
  echo 'PLISTEOF'
  echo 'else'
  echo 'cat > "$SERVICE_PATH" << UNITEOF'
  echo '[Unit]'
  echo 'Description=deepsteve daemon'
  echo 'After=network.target'
  echo ''
  echo '[Service]'
  echo 'Type=simple'
  echo 'ExecStart=$NODE_PATH $INSTALL_DIR/server.js'
  echo 'WorkingDirectory=$INSTALL_DIR'
  echo 'Environment=NODE_ENV=production'
  echo 'Environment=PORT=3000'
  echo 'Environment=DEEPSTEVE_BIND=127.0.0.1'
  echo 'Environment=PATH=$INSTALL_DIR/node/bin:$HOME/.local/bin:$(dirname $NODE_PATH):/usr/local/bin:/usr/bin:/bin'
  echo 'Restart=always'
  echo 'RestartSec=5'
  echo 'StandardOutput=append:$LOG_DIR/deepsteve.log'
  echo 'StandardError=append:$LOG_DIR/deepsteve.error.log'
  echo ''
  echo '[Install]'
  echo 'WantedBy=default.target'
  echo 'UNITEOF'
  echo 'fi'
  echo ""
} >> "$OUT"

# --- Postamble: npm install, fix permissions, start ---
cat >> "$OUT" << 'POSTAMBLE'
cd "$INSTALL_DIR"
npm install

# Fix node-pty spawn-helper permissions
find "$INSTALL_DIR/node_modules/node-pty" -name "spawn-helper" -exec chmod +x {} \;

# Stamp install-source marker so the server knows this is a curl-pipe install.
# Used by the auto-update system (GET /api/version, POST /api/update/curl-reinstall).
INSTALL_VERSION=$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo "unknown")
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$INSTALL_DIR/.install-source.json" <<MARKEREOF
{
  "type": "curl",
  "installedAt": "$INSTALLED_AT",
  "installVersion": "$INSTALL_VERSION",
  "releaseTag": "v$INSTALL_VERSION"
}
MARKEREOF

# NOTE: the global Claude Code and OpenCode MCP registrations are deferred to AFTER the server
# starts (below), because they need the auth token (#536/#538), which the server creates on
# first boot.

if [ "$OS" = "Darwin" ]; then
  launchctl unload "$SERVICE_PATH" 2>/dev/null
  launchctl load "$SERVICE_PATH"
else
  if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable --now deepsteve
  else
    echo "Note: systemd not available. Start manually: node $INSTALL_DIR/server.js"
  fi
fi

# Global MCP registrations run AFTER the server is up so the auth token exists (#536/#538).
# Wait up to ~15s for the freshly-booted server's public health endpoint.
if command -v claude &>/dev/null || command -v opencode &>/dev/null; then
    WAITED=0
    while [ "$WAITED" -lt 15 ] && ! curl -sf -m 2 http://localhost:3000/healthz >/dev/null 2>&1; do
        sleep 1; WAITED=$((WAITED + 1))
    done
fi

# Register deepsteve as a global MCP server with Claude Code. deepsteve-spawned claude sessions
# get a separate per-session config carrying the token; this global one is only for `claude` runs
# outside deepsteve.
if command -v claude &>/dev/null; then
    DS_TOKEN=$(cat "$HOME/.deepsteve/auth-token" 2>/dev/null)
    if [ -n "$DS_TOKEN" ]; then
        claude mcp add --scope user --transport http deepsteve http://localhost:3000/mcp \
            --header "Authorization: Bearer $DS_TOKEN" 2>/dev/null || true
    else
        claude mcp add --scope user --transport http deepsteve http://localhost:3000/mcp 2>/dev/null || true
    fi
fi

# Configure OpenCode global MCP (merges with existing config). The {file:...} reference makes
# opencode read the token at its own startup, so the secret never lands in this (non-0600) config
# file and token rotation needs no re-write (#538).
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
        const entry = { type: "remote", url: "http://127.0.0.1:3000/mcp" };
        // opencode errors out at config load on a {file:...} pointing at a missing file, so
        // only reference the token if the server actually created it.
        if (fs.existsSync(path.join(os.homedir(), ".deepsteve", "auth-token"))) {
            entry.headers = { Authorization: "Bearer {file:~/.deepsteve/auth-token}" };
        }
        cfg.mcp.deepsteve = entry;
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    ' "$OC_CONFIG" 2>/dev/null || true
fi

echo "deepsteve installed and running at http://deepsteve.localhost:3000"
echo "To uninstall: ~/.deepsteve/uninstall.sh"
echo ""
echo "⚠️  Security: DeepSteve is localhost-only and token-authenticated (~/.deepsteve/auth-token)."
echo "   Binding to a network address (--bind) still exposes control to anyone who can reach it."
POSTAMBLE

chmod +x "$OUT"
echo "Generated $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"

# Report deployed mods not in the repo
if [ -d "$HOME/.deepsteve/mods" ]; then
  STALE=""
  for deployed in "$HOME/.deepsteve/mods"/*/; do
    modname=$(basename "$deployed")
    if [ ! -d "mods/$modname" ]; then
      if [ -f "$deployed/.source" ]; then
        STALE="$STALE  $modname (user-installed)\n"
      else
        STALE="$STALE  $modname (stale — no .source, not in repo)\n"
      fi
    fi
  done
  if [ -n "$STALE" ]; then
    echo ""
    echo "⚠️  Deployed mods not in repo:"
    printf "$STALE"
  fi
fi

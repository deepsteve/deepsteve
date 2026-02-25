#!/bin/bash
# Generates install.sh from current source files.
# Run this before cutting a release.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

OUT="install.sh"

# --- Preamble ---
cat > "$OUT" << 'PREAMBLE'
#!/bin/bash
set -e

if ! command -v node &>/dev/null; then
  echo "Node.js not found, installing..."
  if command -v brew &>/dev/null; then
    brew install node
  else
    ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH="x64"
    NODE_DIR="$HOME/.deepsteve/node"
    mkdir -p "$NODE_DIR"
    curl -fsSL "https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-${ARCH}.tar.gz" | tar xz -C "$NODE_DIR" --strip-components=1
    export PATH="$NODE_DIR/bin:$PATH"
  fi
fi

INSTALL_DIR="$HOME/.deepsteve"
PLIST_PATH="$HOME/Library/LaunchAgents/com.deepsteve.plist"
NODE_PATH=$(which node)

mkdir -p "$INSTALL_DIR/public/js"
mkdir -p "$INSTALL_DIR/public/css"
mkdir -p "$INSTALL_DIR/themes"
mkdir -p "$HOME/Library/LaunchAgents"

PREAMBLE

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

# --- LaunchAgent plist (needs variable expansion at install time) ---
# This section uses an unquoted heredoc delimiter so $VARS expand at install time
{
  echo 'cat > "$PLIST_PATH" << PLISTEOF'
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
  echo '    <string>$HOME/Library/Logs/deepsteve.log</string>'
  echo '    <key>StandardErrorPath</key>'
  echo '    <string>$HOME/Library/Logs/deepsteve.error.log</string>'
  echo '</dict>'
  echo '</plist>'
  echo 'PLISTEOF'
  echo ""
} >> "$OUT"

# --- Postamble: npm install, fix permissions, start ---
cat >> "$OUT" << 'POSTAMBLE'
cd "$INSTALL_DIR"
npm install

# Fix node-pty spawn-helper permissions
find "$INSTALL_DIR/node_modules/node-pty" -name "spawn-helper" -exec chmod +x {} \;

launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo "deepsteve installed and running at http://localhost:3000"
echo "To uninstall: ~/.deepsteve/uninstall.sh"
POSTAMBLE

chmod +x "$OUT"
echo "Generated $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"

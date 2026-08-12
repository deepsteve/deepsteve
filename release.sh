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
# Fail if package-lock.json has drifted from package.json. Bumping package.json by hand
# leaves the lock behind; `npm version` writes both. npm ci tolerates the mismatch, so
# nothing else catches it — but the stale lock then lands as noise in an unrelated PR the
# next time anyone runs npm install. check-installer.yml runs this script on every push
# to main, so this guard is the CI check too.
LOCK_VERSION=$(node -p "require('./package-lock.json').version")
LOCK_ROOT_VERSION=$(node -p "require('./package-lock.json').packages[''].version")
if [ "$LOCK_VERSION" != "$PKG_VERSION" ] || [ "$LOCK_ROOT_VERSION" != "$PKG_VERSION" ]; then
  echo "ERROR: package-lock.json ($LOCK_VERSION / $LOCK_ROOT_VERSION) does not match package.json ($PKG_VERSION)." >&2
  echo "Run: npm version $PKG_VERSION --no-git-tag-version --allow-same-version" >&2
  exit 1
fi

echo "Version: $PKG_VERSION (latest tag: ${LATEST_TAG:-none}, lock in sync)"

# Warn if the deepsteve.com demo lags the released tag (#584). The site serves the
# tag it vendored at /demo/VERSION; a healthy demo equals LATEST_TAG at this point
# (this script runs pre-tag). Warn-only and network-tolerant: check-installer.yml
# runs this script in CI on every push, so it must never fail or hang here.
DEMO_TAG=$(curl -fsSL --max-time 5 https://deepsteve.com/demo/VERSION 2>/dev/null || true)
if [ -n "$DEMO_TAG" ] && [ -n "$LATEST_TAG" ] && [ "$DEMO_TAG" != "$LATEST_TAG" ]; then
  echo "WARNING: deepsteve.com demo is vendored at $DEMO_TAG but the latest release is $LATEST_TAG." >&2
  echo "         After this release: run tools/revendor-demo.sh in the site repo (RELEASING.md step 7)." >&2
fi

NODE_VERSION="22.14.0"
NODE_SHA256_ARM64="e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42"
NODE_SHA256_X64="6698587713ab565a94a360e091df9f6d91c8fadda6d00f0cf6526e9b40bed250"
NODE_SHA256_LINUX_ARM64="8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0"
NODE_SHA256_LINUX_X64="9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2"

OUT="install.sh"

# --- Pinned constants ---
# An UNQUOTED heredoc, so these expand now, at generation time.
#
# They used to be __PLACEHOLDER__ tokens inside the quoted preamble below, substituted
# afterwards with `sed -i ''` — BSD-only syntax that made this generator refuse to run
# on Linux (GNU sed reads the '' as the script and the real script as a filename). That
# is why check-installer.yml is pinned to macos-latest, and why `npm run test:install`,
# which starts with `bash release.sh`, could not be run by a Linux contributor at all.
# Emitting them directly deletes the sed calls and the placeholders together (#621).
cat > "$OUT" << EOF
#!/bin/bash
set -e

# Pinned by release.sh at generation time.
NODE_VERSION="$NODE_VERSION"
NODE_SHA256_ARM64="$NODE_SHA256_ARM64"
NODE_SHA256_X64="$NODE_SHA256_X64"
NODE_SHA256_LINUX_ARM64="$NODE_SHA256_LINUX_ARM64"
NODE_SHA256_LINUX_X64="$NODE_SHA256_LINUX_X64"
EOF

# --- Preamble ---
cat >> "$OUT" << 'PREAMBLE'

OS=$(uname -s)

if ! command -v node &>/dev/null; then
  echo "Node.js not found, installing..."
  if command -v brew &>/dev/null; then
    brew install node
  else
    ARCH=$(uname -m)
    case "$ARCH" in arm64|aarch64) ARCH="arm64";; *) ARCH="x64";; esac
    if [ "$OS" = "Darwin" ]; then
      NODE_PLATFORM="darwin"
      if [ "$ARCH" = "arm64" ]; then NODE_SHA256="$NODE_SHA256_ARM64"; else NODE_SHA256="$NODE_SHA256_X64"; fi
    else
      NODE_PLATFORM="linux"
      if [ "$ARCH" = "arm64" ]; then NODE_SHA256="$NODE_SHA256_LINUX_ARM64"; else NODE_SHA256="$NODE_SHA256_LINUX_X64"; fi
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

# tmux is a declared dependency off macOS (#620/#621), and this is where declaring it
# is cheap: a human is watching a terminal right now.
#
# Not merely a preference. deepsteve sessions live inside tmux so they survive a daemon
# restart, and on Linux the daemon is restarted by systemd on every crash and every
# unattended upgrade — so without tmux, sessions die at moments nobody chose. macOS keeps
# node-pty as a supported fallback because there the daemon only restarts when the user
# asks it to.
#
# Deliberately fatal here and NOT at daemon startup: refusing to boot on a headless box
# means the UI that would explain why never comes up.
if [ "$OS" != "Darwin" ] && ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux is required on Linux." >&2
  echo "       deepsteve runs each session inside tmux so it survives a daemon restart;" >&2
  echo "       node-pty is a macOS-only fallback. Install tmux and re-run this installer:" >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "         sudo apt-get install -y tmux" >&2
  elif command -v dnf >/dev/null 2>&1; then
    echo "         sudo dnf install -y tmux" >&2
  elif command -v pacman >/dev/null 2>&1; then
    echo "         sudo pacman -S --noconfirm tmux" >&2
  elif command -v apk >/dev/null 2>&1; then
    echo "         sudo apk add tmux" >&2
  else
    echo "         (install tmux with your package manager)" >&2
  fi
  exit 1
fi

INSTALL_DIR="$HOME/.deepsteve"
NODE_PATH=$(which node)

# The SERVICE_PATH / LOG_DIR branch that used to live here now lives in service.sh
# (#621), which is embedded below and sourced before anything needs it —
# ds_service_write creates both directories itself. $OS above is still needed for the
# node download (platform + arch + checksum), which is a different question.

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

# Core files — every root module, not a hand-maintained list: a new require()
# in server.js (e.g. sleep-watch.js in #563) missing here would crash-loop
# every fresh install with MODULE_NOT_FOUND.
embed_text "package.json" "package.json"
for rootjs in *.js; do
  embed_text "$rootjs" "$rootjs"
done

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

# Skill files. A skill whose frontmatter carries `maintainer: true` drives this repo's
# own maintenance rather than the user's project, so it is deliberately left out of the
# installed build: it exists only in a git clone, and even there it ships disabled until
# someone enables it in Mods. The match is scoped to the frontmatter block so a skill
# that merely mentions the key in its prose does not vanish from the installer.
#
# A withheld skill is also deleted on upgrade. An install made before it was withheld
# still has the file, and the server lists whatever is in skills/ — so without this it
# would keep showing up in Mods forever. Once the file is gone, reconcileSkills() drops
# it from enabledSkills and unlinks the copies it made in ~/.claude and ~/.agents.
for skill in skills/*.md; do
  if sed -n '2,/^---$/p' "$skill" | grep -q '^maintainer: *true'; then
    echo "rm -f \"\$INSTALL_DIR/$skill\"" >> "$OUT"
    echo "" >> "$OUT"
    continue
  fi
  embed_text "$skill" "$skill"
done

# --- Embed binary files as base64 ---

embed_binary() {
  local src="$1"
  local dest="$2"
  echo "base64 -d << 'DEEPSTEVE_B64_EOF' > \"\$INSTALL_DIR/$dest\"" >> "$OUT"
  # Normalize the line wrapping: macOS base64 emits one unwrapped line, GNU wraps at 76.
  # `base64 -d` reads either, so this was never a correctness problem — but it meant the
  # same commit produced a byte-different install.sh depending on which OS generated it,
  # which would defeat any future reproducibility check. Now that release.sh can run on
  # Linux at all (#621), that matters. `fold` emits no trailing newline, hence the echo.
  base64 < "$src" | tr -d '\n' | fold -w 76 >> "$OUT"
  echo "" >> "$OUT"
  echo "DEEPSTEVE_B64_EOF" >> "$OUT"
  echo "" >> "$OUT"
}

embed_binary "public/favicon.png" "public/favicon.png"
embed_binary "public/icon-192.png" "public/icon-192.png"
embed_binary "public/icon-512.png" "public/icon-512.png"

# --- Shell library + entry points (use embed_text to avoid nested heredoc issues) ---
# service.sh must be embedded BEFORE the source line below; uninstall.sh and status.sh
# both source it from $INSTALL_DIR at run time. This is the ship list restart.sh's `cp`
# mirrors, and test/unit/shell-deploy.test.js asserts the two agree.
embed_text "service.sh" "service.sh"
embed_text "uninstall.sh" "uninstall.sh"
embed_text "status.sh" "status.sh"
{
  # service.sh is deliberately NOT chmod +x — it is a sourced library, never an entry
  # point, which is what keeps `./service.sh restart` from existing (see its header).
  echo 'chmod +x "$INSTALL_DIR/uninstall.sh" "$INSTALL_DIR/status.sh"'
  echo 'chmod 644 "$INSTALL_DIR/service.sh"'
  echo ""
} >> "$OUT"

# --- Service definition ---
# The plist and unit bodies live in service.sh (embedded above), so there is exactly
# one copy of each and restart.sh/uninstall.sh drive the same verbs (#621). The
# unquoted heredocs inside ds_service_write still expand at INSTALL time — a heredoc
# expands when it executes, and a function body in a sourced file is no different — so
# the emitted files are byte-identical to what this block used to produce.
{
  echo '. "$INSTALL_DIR/service.sh"'
  echo 'ds_service_write || { echo "deepsteve: could not write the service definition" >&2; exit 1; }'
  echo ""
} >> "$OUT"

# --- Postamble: npm install, fix permissions, start ---
cat >> "$OUT" << 'POSTAMBLE'
cd "$INSTALL_DIR"
npm install

# Fix node-pty spawn-helper permissions.
# Tolerate a missing dir: install.sh runs under `set -e`, so if npm install didn't
# produce node_modules/node-pty, `find` exiting nonzero used to abort the installer
# right here — BEFORE the service was ever written or started, leaving a half-install
# with no daemon and no explanation. tmux is the default engine since #620, so an
# absent node-pty is degraded, not fatal.
find "$INSTALL_DIR/node_modules/node-pty" -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

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

if ds_manager_available; then
  ds_service_stop
  ds_service_start || {
    echo "deepsteve: the service manager refused to start the daemon. Try:" >&2
    ds_start_hint >&2
    exit 1
  }
  # Prints the loginctl enable-linger advice on Linux when lingering is off, so a
  # headless install learns that the daemon dies at logout. Never enables it silently.
  ds_maybe_enable_linger
else
  echo "Note: no service manager available. Start manually: node $INSTALL_DIR/server.js"
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
    # `|| true`: install.sh runs under `set -e`, and an assignment whose command
    # substitution fails aborts the script. The token only exists once the daemon has
    # booted and written it, so on any box where the daemon did NOT start — a Linux
    # host with no systemd user bus being the case #621 cares about — the installer
    # used to die right here, silently, before printing the "start it manually"
    # instructions the user needed. An empty token is handled two lines down.
    DS_TOKEN=$(cat "$HOME/.deepsteve/auth-token" 2>/dev/null || true)
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

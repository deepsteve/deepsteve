#!/bin/bash
# Is the deepsteve daemon healthy, and if not, where is it stuck? (#621)
#
# READ-ONLY, ON PURPOSE — and that is the reason this is its own script rather than a
# `--status` flag on restart.sh.
#
# Status is only useful if it is frictionless, and frictionless means allowlisted. But
# every allowlist pattern broad enough to cover `./restart.sh --status` — the obvious
# `Bash(./restart.sh:*)` — would also cover `./restart.sh --force --prompt "…"`, the
# one command CLAUDE.md says must always stay behind Claude Code's permission prompt.
# Keeping the dangerous verb's command string unique and un-allowlistable-by-accident
# is worth a second file.
#
# So: `./status.sh` is safe to allowlist. `./restart.sh` is not. This script calls no
# mutating ds_* verb (test/unit/service-lib.test.js greps to keep it that way) and
# ignores its arguments entirely.
#
# Exit 0 when the daemon answers /healthz, 1 otherwise — so `until ./status.sh` works
# — but it always prints the full report either way, because the interesting case is
# the failing one.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -r "$SCRIPT_DIR/service.sh" ]; then
    echo "deepsteve: $SCRIPT_DIR/service.sh is missing — cannot report status." >&2
    exit 1
fi
# shellcheck source=service.sh
. "$SCRIPT_DIR/service.sh"

ds_service_status

# Where this install came from, if it has been installed at all. Not in service.sh:
# it is deepsteve's own bookkeeping, not the service manager's.
MARKER="$(ds_install_dir)/.install-source.json"
if [ -f "$MARKER" ] && command -v node >/dev/null 2>&1; then
    node -e '
const fs = require("fs");
try {
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const where = m.sourcePath || m.releaseTag || "";
  process.stdout.write(`  install       ${m.type || "?"}  ${where}  v${m.installVersion || "?"}\n`);
} catch { /* unreadable marker is not worth a stack trace */ }
' "$MARKER" 2>/dev/null
fi

# The tmux server deepsteve owns (#625). Worth a line: it is where every session
# actually lives, its length is what decides whether tmux works at all (~104-byte
# sun_path), and "how many sessions survived that restart" is the first thing anyone
# asks. Read-only — list-sessions mutates nothing.
if command -v tmux >/dev/null 2>&1; then
    DS_SOCK="$(ds_tmux_socket)"
    if [ -S "$DS_SOCK" ]; then
        DS_SESSIONS="$(tmux -S "$DS_SOCK" list-sessions -F '#{session_name}' 2>/dev/null | grep -c . || true)"
        printf '  tmux          %s  (%s session(s))\n' "$DS_SOCK" "${DS_SESSIONS:-0}"
    else
        printf '  tmux          %s  (no server running)\n' "$DS_SOCK"
    fi
fi

ds_is_responding 3

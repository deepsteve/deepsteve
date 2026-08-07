#!/bin/sh
# Run the standalone integration tests — suites that spawn their OWN throwaway
# daemon (scratch HOME, stub agent binaries, random port) so they can restart
# the server under test. Kept separate from test/run-integration.sh, whose
# suites all attach to one long-lived shared server and must never restart it.
#
# Usage: run-standalone.sh
set -e

# Keep every temp path SHORT, because tmux sockets live under one.
#
# Each suite sets TMUX_TMPDIR inside its mkdtemp $HOME (it must — tmux's default
# socket is per-UID, not per-HOME, so a scratch daemon would otherwise see and
# reattach the real one's ds-* sessions). tmux then appends `tmux-<uid>/default`,
# and the whole thing has to fit a Unix socket's sun_path: 104 bytes on macOS.
# macOS's default $TMPDIR is /var/folders/<2>/<28>/T/ — 52 characters before the
# suite's own directory — which put the socket at exactly 104 and made
# `tmux new-session` fail with "File name too long".
#
# That matters more since #620 made tmux the default: the daemon now degrades to
# node-pty instead of crashing, so the suite would go green while testing the
# engine we are trying to move off. Short TMPDIR here, and node's os.tmpdir()
# (which reads TMPDIR) shortens every path the suites derive from it.
#
# Running a single file by hand (`node --test test/integration-standalone/x.js`)
# skips this — prefix it with `TMPDIR=/tmp/ds-test` if a suite reports tmux
# falling back.
TMPDIR="${DS_TEST_TMPDIR:-/tmp/ds-test}"
mkdir -p "$TMPDIR"
export TMPDIR

for f in test/integration-standalone/*.test.js; do
  echo "--- running $f ---"
  node --test --test-concurrency=1 --test-timeout 180000 "$f"
done

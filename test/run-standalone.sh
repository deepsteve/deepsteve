#!/bin/sh
# Run the standalone integration tests — suites that spawn their OWN throwaway
# daemon (scratch HOME, stub agent binaries, random port) so they can restart
# the server under test. Kept separate from test/run-integration.sh, whose
# suites all attach to one long-lived shared server and must never restart it.
#
# Usage: run-standalone.sh
set -e

# Keep every temp path SHORT, because a tmux socket lives under one.
#
# Since #625 each suite's daemon binds `$HOME/.deepsteve/tmux.sock` — where $HOME is
# the suite's mkdtemp — and passes it to tmux as `-S`. That is EXACT (tmux appends no
# `tmux-<uid>/default` of its own) and it is much shorter than the old path, but it
# still has to fit a Unix socket's sun_path: 104 bytes on macOS. macOS's default
# $TMPDIR is /var/folders/<2>/<28>/T/ — ~49 characters before the suite's own
# directory — which leaves single-digit margin once a long mkdtemp prefix like
# `ds-scheduled-restore-offer-` is added. So: keep TMPDIR short.
#
# What changed is the failure MODE, and it is the good half of #625. It used to be
# silent: tmux fell back, the daemon degraded to node-pty (#620), and the suite went
# green while testing the engine we are trying to move off — catchable only by
# tmux-durability.test.js's `tmuxRuntimeFailure === null` tripwire. Now TmuxSandbox's
# constructor measures the exact path it is about to use and throws with the byte
# count, so an over-long path fails the suite that has it, by name.
#
# Running a single file by hand (`node --test test/integration-standalone/x.js`)
# skips this — prefix it with `TMPDIR=/tmp/ds-test` if a suite reports the socket
# path being too long.
TMPDIR="${DS_TEST_TMPDIR:-/tmp/ds-test}"
mkdir -p "$TMPDIR"
export TMPDIR

for f in test/integration-standalone/*.test.js; do
  echo "--- running $f ---"
  node --test --test-concurrency=1 --test-timeout 180000 "$f"
done

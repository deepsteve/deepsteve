#!/bin/sh
# Run each integration test file in its own `node --test` process, one at a time.
#
# Serial execution is REQUIRED, not just nice-to-have: the suite assumes
# exclusive access to the single shared server. cleanupSessions() (test/helpers/
# ws-client.js) calls the GLOBAL POST /api/shells/killall after every test, and
# the "killall removes all active sessions" test asserts the server has zero
# active sessions. If a second test file is creating or holding sessions at the
# same time, one file's killall wipes another file's in-flight session — the
# victim then sees "Session <id> not found" (e.g. open_terminal's caller lookup).
#
# We deliberately do NOT rely on `node --test --test-concurrency=1` for this: that
# flag is honored inconsistently across Node 22.x patch releases. #493 added it and
# the public install suite still flaked in CI (newer node:22 ran the files in
# parallel anyway). Running exactly one file per `node --test` invocation guarantees
# no overlap regardless of Node version, because each process fully exits — including
# its afterEach cleanup — before the next one starts.
#
# Usage: run-integration.sh [SKIP_PATTERN]
#   SKIP_PATTERN  optional grep pattern of files to skip (e.g. "tmux-engine" when
#                 the server under test has no tmux installed).
set -e

skip="${1:-}"

for f in test/integration/*.test.js; do
  if [ -n "$skip" ] && echo "$f" | grep -q "$skip"; then
    echo "--- skipping $f ---"
    continue
  fi
  echo "--- running $f ---"
  # --test-concurrency=1 here only serializes suites WITHIN this one file (cheap
  # insurance if a file ever holds two session-using describes); cross-file
  # serialization is what the per-file invocation above guarantees.
  node --test --test-concurrency=1 --test-timeout 60000 "$f"
done

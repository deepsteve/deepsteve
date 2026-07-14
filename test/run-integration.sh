#!/bin/sh
# Run each integration test file in its own `node --test` process, one at a time.
#
# Serial execution is REQUIRED, not just nice-to-have: the suite shares one
# server, and the "killall removes all active sessions" tests (session-lifecycle,
# tmux-engine) exercise the GLOBAL POST /api/shells/killall and assert the server
# has zero active sessions afterward. Those are inherently server-wide, so if a
# second file is creating or holding sessions at the same time, the killall wipes
# it and the victim sees "Session <id> not found" (e.g. open_terminal's caller).
#
# Per-test cleanup is already scoped to a test's own sessions (cleanupSessions()
# in test/helpers/ws-client.js deletes only owned ids, never the global killall),
# so the high-frequency afterEach path no longer cross-contaminates. Serial
# execution remains required only for the two deliberate global killall tests.
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
  # -E so SKIP_PATTERN can be an alternation, e.g. "security-auth|tmux-engine" (the public-install
  # suite skips both). A single-word pattern behaves identically under -E, so existing callers are
  # unaffected.
  if [ -n "$skip" ] && echo "$f" | grep -Eq "$skip"; then
    echo "--- skipping $f ---"
    continue
  fi
  echo "--- running $f ---"
  # --test-concurrency=1 here only serializes suites WITHIN this one file (cheap
  # insurance if a file ever holds two session-using describes); cross-file
  # serialization is what the per-file invocation above guarantees.
  node --test --test-concurrency=1 --test-timeout 60000 "$f"
done

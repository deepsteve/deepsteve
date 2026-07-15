#!/bin/sh
# Run each integration test file in its own `node --test` process, one at a time.
#
# Target selection (#562): DEEPSTEVE_URL is REQUIRED by the test helpers — there is
# no localhost:3000 fallback (a bare run once hit the developer's LIVE daemon and its
# killall cleanup destroyed every real session). If DEEPSTEVE_URL is set (the docker
# composes set it to http://server:3000), it is used as-is — the helpers still verify
# the target reports /api/version.testMode === true before any destructive call.
# If it is NOT set, this script provisions a throwaway daemon: scratch HOME (own
# auth-token/state/settings), random port, DEEPSTEVE_TEST_MODE=1, and an isolated
# TMUX_TMPDIR — tmux's default socket is per-UID, NOT per-HOME, so without it the
# scratch daemon would see the developer's real ds-* tmux sessions and destroy them
# as orphans at startup. The daemon and scratch dir are torn down on exit.
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
#                 the machine or server under test has no tmux installed).
set -e

cd "$(dirname "$0")/.."

skip="${1:-}"

if [ -z "$DEEPSTEVE_URL" ]; then
  # Don't leak the invoking environment into the daemon or the tests: CLAUDECODE
  # marks a nested Claude, and DEEPSTEVE_* are present when this runs inside a
  # deepsteve agent tab (mirrors integration-standalone's startDaemon()).
  for v in $(env | awk -F= '/^DEEPSTEVE_/{print $1}'); do unset "$v"; done
  unset CLAUDECODE

  SCRATCH="$(mktemp -d)"
  PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})')"
  mkdir -p "$SCRATCH/.deepsteve" "$SCRATCH/tmux"
  # Backstop against the browser auto-open (TEST_MODE already skips it server-side).
  : > "$SCRATCH/.deepsteve/.restarting"

  HOME="$SCRATCH" PORT="$PORT" DEEPSTEVE_TEST_MODE=1 TMUX_TMPDIR="$SCRATCH/tmux" \
    node server.js >"$SCRATCH/server.log" 2>&1 &
  SERVER_PID=$!
  cleanup() {
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    rm -rf "$SCRATCH"
  }
  trap cleanup EXIT INT TERM

  # Readiness = auth token written AND authed /api/version answers testMode:true
  # (the runner verifies its own provisioning). node, not curl: node is guaranteed
  # (it runs the tests), and it can assert on the JSON body.
  i=0; ready=""
  while [ "$i" -lt 150 ]; do
    if HOME="$SCRATCH" node -e '
      const fs=require("fs"),os=require("os"),p=require("path");
      const tok=fs.readFileSync(p.join(os.homedir(),".deepsteve","auth-token"),"utf8").trim();
      fetch(process.argv[1]+"/api/version",{headers:{Authorization:"Bearer "+tok}})
        .then(r=>r.json()).then(b=>process.exit(b.testMode===true?0:1))
        .catch(()=>process.exit(1));
    ' "http://127.0.0.1:$PORT" 2>/dev/null; then ready=1; break; fi
    i=$((i+1)); sleep 0.2
  done
  if [ -z "$ready" ]; then
    echo "!!! provisioned test server never became ready; log follows" >&2
    cat "$SCRATCH/server.log" >&2
    exit 1
  fi

  # Same-HOME token discovery is the helpers' documented design: they read
  # $HOME/.deepsteve/auth-token, which must be the file the server just wrote.
  export HOME="$SCRATCH"
  export DEEPSTEVE_URL="http://127.0.0.1:$PORT"
  echo "--- provisioned isolated test server: $DEEPSTEVE_URL (HOME=$SCRATCH) ---"
fi

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

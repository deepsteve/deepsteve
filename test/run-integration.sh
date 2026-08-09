#!/bin/sh
# Run each integration test file in its own `node --test` process, one at a time.
#
# Target selection (#562): DEEPSTEVE_URL is REQUIRED by the test helpers — there is
# no localhost:3000 fallback (a bare run once hit the developer's LIVE daemon and its
# killall cleanup destroyed every real session). If DEEPSTEVE_URL is set (the docker
# composes set it to http://server:3000), it is used as-is — the helpers still verify
# the target reports /api/version.testMode === true before any destructive call.
# If it is NOT set, this script provisions a throwaway daemon: scratch HOME (own
# auth-token/state/settings), random port, DEEPSTEVE_TEST_MODE=1. The scratch HOME is
# also what isolates tmux since #625 — the daemon runs its own tmux server on
# $HOME/.deepsteve/tmux.sock and passes it as `-S`, so there is no TMUX_TMPDIR here and
# there must not be one: that variable has a silent fallback to the developer's real
# per-UID socket, and isolation resting on it is what let a test destroy every live
# agent on the machine. The daemon and scratch dir are torn down on exit.
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

  # Saved BEFORE the `export HOME="$SCRATCH"` further down: the reaper in cleanup()
  # anchors a TmuxSandbox, which refuses to point at whatever the current $HOME is —
  # and by then $HOME *is* the scratch dir we are trying to reap.
  REAL_HOME="$HOME"
  SCRATCH="$(mktemp -d)"
  PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})')"
  # This is also the tmux socket's directory since #625, so pre-creating it is newly
  # load-bearing rather than merely tidy.
  mkdir -p "$SCRATCH/.deepsteve"
  # Backstop against the browser auto-open (TEST_MODE already skips it server-side).
  : > "$SCRATCH/.deepsteve/.restarting"

  HOME="$SCRATCH" PORT="$PORT" DEEPSTEVE_TEST_MODE=1 \
    node server.js >"$SCRATCH/server.log" 2>&1 &
  SERVER_PID=$!
  cleanup() {
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    # Shutdown DETACHES tmux sessions (#620), so the scratch tmux server outlives the
    # daemon and the rm below would only unlink its socket — leaving a running server
    # nothing can ever reach again. Reaped through the one helper allowed to exec tmux,
    # which is also why this is `node -e` and not a `tmux` command here (#625).
    env HOME="$REAL_HOME" \
      node -e 'require("./test/helpers/tmux-sandbox").TmuxSandbox.reapHome(process.argv[1])' \
      "$SCRATCH" 2>/dev/null || true
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

# Every failing file is remembered, and the script exits nonzero if ANY failed (#621).
#
# This loop used to just run each file, so the script's exit status was whatever the LAST
# `node --test` returned — there is no `set -e` here, and there cannot be one (the
# provisioning above relies on non-fatal failures). Everything that consumes this script
# takes its exit code as the verdict: `npm test`, all three docker suites, and CI's
# integration job via `--exit-code-from test`. So a failure in any file but the
# alphabetically last one (websocket.test.js) was reported as a pass — for every suite,
# on every run.
failed=""
for f in test/integration/*.test.js; do
  # -E so SKIP_PATTERN can be an alternation, e.g. "security-auth|tmux-engine". A single-word
  # pattern behaves identically under -E, so existing callers are unaffected. The only skip in
  # use is the public-install suite's "tmux-engine" (that image installs just zsh + curl); do
  # NOT add entries here for features the server under test predates — the public suite runs
  # each release's own tests against that release, so version skew can't arise (#588).
  if [ -n "$skip" ] && echo "$f" | grep -Eq "$skip"; then
    echo "--- skipping $f ---"
    continue
  fi
  echo "--- running $f ---"
  # --test-concurrency=1 here only serializes suites WITHIN this one file (cheap
  # insurance if a file ever holds two session-using describes); cross-file
  # serialization is what the per-file invocation above guarantees.
  if ! node --test --test-concurrency=1 --test-timeout 60000 "$f"; then
    failed="$failed $f"
  fi
done

if [ -n "$failed" ]; then
  echo "=== FAILED:$failed ==="
  exit 1
fi
echo "=== all integration files passed ==="

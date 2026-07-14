#!/bin/sh
# Run the standalone integration tests — suites that spawn their OWN throwaway
# daemon (scratch HOME, stub agent binaries, random port) so they can restart
# the server under test. Kept separate from test/run-integration.sh, whose
# suites all attach to one long-lived shared server and must never restart it.
#
# Usage: run-standalone.sh
set -e

for f in test/integration-standalone/*.test.js; do
  echo "--- running $f ---"
  node --test --test-concurrency=1 --test-timeout 180000 "$f"
done

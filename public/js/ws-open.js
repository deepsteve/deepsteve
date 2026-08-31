/**
 * The one place in the client that constructs a WebSocket (#674, #553).
 *
 * WHY A CHOKE POINT — read server-probe.js's header for the mechanism; the short version
 * is that Firefox keys its RFC 6455 FailDelay entry on {address, path, port,
 * originSuffix}, `path` excludes the query string, and every DeepSteve socket is
 * ws://host/?params. So there is ONE entry for the whole browser, shared across tabs,
 * windows and nested Baby Browser instances. Every failed handshake ramps it x1.5 to a 60s
 * cap; a later connect to a delayed host is parked in CONNECTING_DELAYED with no traffic
 * and no error event, and the entry outlives any usable retry interval. One socket
 * anywhere in the browser poisons all of them, and no backoff schedule can undo it.
 *
 * That is a property no individual call site can be trusted to remember. #553 gave
 * ws-client.js a /healthz gate and left live-reload.js's first connect() ungated; #674
 * found that same module hot-looping doomed handshakes with no backoff at all. Both were
 * correct-looking code written by someone who knew the rule. So the rule now has one
 * implementation, and test/unit/ws-single-construct.test.js asserts that `new WebSocket(`
 * appears exactly once under public/ — here.
 *
 * The gate has two halves, and both are necessary:
 *
 *   1. /healthz — is the server there at all? HTTP has no shared failure accounting, so
 *      probing costs nothing a failed handshake would cost.
 *   2. /api/version — will it accept US? A missing or stale ds_auth cookie makes
 *      security.js's verifyWsClient reject the upgrade with 401, and the browser never
 *      shows us that status (every failed handshake is close code 1006, identical to
 *      "server down"). Asking over HTTP is the only way to know before we commit.
 */

import { waitForServer, jitter } from './server-probe.js';
import { maybeHealAuth } from './auth-heal.js';
import { traceSocket } from './ws-trace.js';

// Pacing for an attempt that got past the gate and still failed — the server is up but
// something about this socket doesn't work. Shared by both callers so neither can end up
// with the unbounded retry live-reload.js had before #674.
export const WS_BACKOFF_BASE_MS = 1_000;
export const WS_BACKOFF_MAX_MS = 30_000;
// A socket that stayed open at least this long was a real connection — its drop gets an
// immediate, backoff-free retry (the gate still re-checks /healthz first). One that died
// sooner is treated as a failed attempt: a server that accepts upgrades and instantly
// kills them would otherwise spin a hot connect loop.
export const WS_STABLE_MS = 2_000;

/** Jittered exponential delay for the Nth consecutive failure. */
export function backoffDelay(failures) {
  return jitter(Math.min(WS_BACKOFF_BASE_MS * 2 ** failures, WS_BACKOFF_MAX_MS));
}

/**
 * Open a socket, or explain why we deliberately did not.
 *
 * Resolves to { socket, reason }:
 *   { socket, reason: 'ok' }          the handshake is out, and we expect it to succeed
 *   { socket: null, reason: 'stopped' }   shouldStop() went true, or a page reload is
 *                                         pending. Nothing was emitted; the caller's own
 *                                         loop decides whether to retire or park.
 *   { socket: null, reason: 'unauthed' }  the server is up and told us over HTTP that it
 *                                         will reject this upgrade. Nothing was emitted.
 *                                         The caller MUST pace its retry — a bare retry
 *                                         here spins at fetch speed and is the shape that
 *                                         pins FailDelay at its cap.
 *
 * Deliberately stateless. Relative imports don't inherit a test's ?cachebust query, so
 * this module is a single shared instance across every suite that loads it; state here
 * would leak between cases.
 */
export async function openGatedSocket(url, { shouldStop = () => false, label = 'socket' } = {}) {
  const up = await waitForServer(shouldStop);
  if (!up || shouldStop()) return { socket: null, reason: 'stopped' };

  const verdict = await maybeHealAuth();

  // Re-check AFTER the await. This is a real interleaving point that did not exist before
  // the heal was awaited: a close() or a heal reload landing here would otherwise get a
  // live, unowned socket constructed on its way out — and for a new session that means the
  // server spawns a shell for a create the caller just cancelled.
  if (shouldStop() || window.__deepsteveReloadPending) return { socket: null, reason: 'stopped' };
  if (verdict === 'unauthed') return { socket: null, reason: 'unauthed' };

  // Handlers are attached by the caller, in its own synchronous turn after this resolves.
  // Safe, and deliberately not done here: WebSocket events dispatch as tasks rather than
  // microtasks, so none can fire before the caller is wired up — and attaching onopen /
  // onclose here would be silently clobbered by the caller's own assignments. traceSocket
  // uses addEventListener for exactly that reason.
  const socket = new WebSocket(url);
  traceSocket(socket, label);
  return { socket, reason: 'ok' };
}

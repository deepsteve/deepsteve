/**
 * Integration tests for GET /api/shells/:id/transcript — the History view's
 * endpoint (#672).
 *
 * Deliberately thin. This suite's daemon has no real `claude` binary and does not
 * share a filesystem with the test process under the docker suites, so it cannot
 * plant a transcript to read; that half lives in
 * test/integration-standalone/transcript-history.test.js, which owns its daemon's
 * $HOME. What belongs HERE is the envelope: which sessions the route answers for,
 * which non-happy states are 200s rather than errors, and — the part worth a
 * daemon — that the query parameters are clamped.
 *
 * That last one is not paranoia. Display tabs and project mods are same-origin
 * and trusted (CLAUDE.md), so "behind the auth gate" is a much lower bar than it
 * sounds: any agent-authored page can call this. `?window=1e9` without a clamp is
 * a one-line daemon OOM, and a coerced `?before=-1` is an infinite scroll loop.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { WsClient, httpGet, cleanupSessions, BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');
const { makeServerDir, removeServerDir } = require('../helpers/server-dir');

// httpGet returns only the parsed body, and half of these assertions are about
// the status code.
async function raw(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, body };
}

describe('GET /api/shells/:id/transcript (#672)', () => {
  const term = new WsClient();
  let cwd = null;

  before(async () => {
    // The daemon's filesystem is not this process's under the docker suites, so
    // scratch dirs come from the helper, never os.tmpdir() (#637).
    cwd = makeServerDir('ds-transcript-');
    await term.connect({ new: '1', agentType: 'terminal', cwd });
    await term.waitForOutput(/\$|%|#/, 15000);
  });

  after(async () => {
    // Before close(), which nulls sessionId — the helper reads the ids off the
    // clients it is given.
    await cleanupSessions([term]);
    if (cwd) removeServerDir(cwd);
  });

  it('404s for a session id nobody has ever heard of', async () => {
    const { status, body } = await raw('/api/shells/no-such-session/transcript');
    assert.strictEqual(status, 404);
    assert.match(body.error, /not found/i);
  });

  it('answers 200 with supported:false for an agent that keeps no transcript', async () => {
    // Not an error. "This agent writes no transcript" is a property of a valid
    // session that the pane has to render; routing it through the error path
    // would make every legitimate empty state look like a failure.
    const { status, body } = await raw(`/api/shells/${term.sessionId}/transcript`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.supported, false);
    assert.strictEqual(body.reason, 'unsupported-agent');
    assert.strictEqual(body.agentType, 'terminal');
    assert.deepStrictEqual(body.entries, []);
  });

  it('reports the session as live while its tab is open', async () => {
    const { body } = await raw(`/api/shells/${term.sessionId}/transcript`);
    assert.strictEqual(body.live, true);
    assert.strictEqual(body.closed, false);
  });

  it('rejects a malformed cursor instead of coercing it', async () => {
    // A cursor is a position, and a wrong position is not a smaller position: a
    // coerced `before=-1` reads as "start at the tail", so the pane pages back to
    // the beginning, is handed the tail again, and scrolls forever.
    for (const q of ['before=abc', 'before=-1', 'before=1.5', 'before=1e9', 'after=xyz', 'after=-2']) {
      const { status } = await raw(`/api/shells/${term.sessionId}/transcript?${q}`);
      assert.strictEqual(status, 400, `?${q} should have been rejected`);
    }
  });

  it('clamps a malformed SIZE rather than rejecting it', async () => {
    // The other half of the same rule. `limit` and `window` are hints about how
    // much to do, so a nonsensical one has a sensible nearest value and the
    // request still means something. Only a garbage token is refused.
    for (const q of ['limit=0', 'limit=99999', 'window=1', 'window=1000000000']) {
      const { status } = await raw(`/api/shells/${term.sessionId}/transcript?${q}`);
      assert.strictEqual(status, 200, `?${q} should have been clamped`);
    }
    for (const q of ['limit=-5', 'limit=abc', 'window=huge']) {
      const { status } = await raw(`/api/shells/${term.sessionId}/transcript?${q}`);
      assert.strictEqual(status, 400, `?${q} is not a number at all`);
    }
  });

  it('rejects before and after together — they are opposite directions', async () => {
    const { status } = await raw(`/api/shells/${term.sessionId}/transcript?before=10&after=10`);
    assert.strictEqual(status, 400);
  });

  it('clamps an absurd window rather than allocating it', async () => {
    const { status } = await raw(`/api/shells/${term.sessionId}/transcript?window=1000000000&limit=999999`);
    assert.strictEqual(status, 200, 'the clamp must accept and bound, not fail');
    // And the daemon is still answering afterwards, which is the real assertion.
    const after = await httpGet('/api/version');
    assert.ok(after.current, 'daemon survived the oversized request');
  });

  it('requires auth like every other /api route', async () => {
    const res = await fetch(`${BASE_URL}/api/shells/${term.sessionId}/transcript`);
    assert.strictEqual(res.status, 401);
  });
});

/**
 * Integration tests for GET /api/restart-prompt — the line ./restart.sh --force
 * echoes into Claude Code's permission prompt, which is the human-visible
 * acceptance gate for a restart with nobody at the browser (#504).
 *
 * The claim under test is not the phrasing, it is the *truthfulness*: since #620
 * a tmux-backed agent belongs to the tmux server and shutdown() detaches rather
 * than kills it, so a prompt that says N sessions "will be interrupted" when
 * none of them will is training the reader to click through the one gate that
 * exists. Assertions therefore key off the engine the daemon actually gave the
 * session — this suite's daemon may have tmux or not — rather than hardcoding
 * one outcome.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { WsClient, cleanupSessions, BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');
const { makeServerDir, removeServerDir } = require('../helpers/server-dir');

async function prompt() {
  const res = await fetch(`${BASE_URL}/api/restart-prompt`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.strictEqual(res.status, 200);
  return (await res.text()).trim();
}

describe('GET /api/restart-prompt', () => {
  const term = new WsClient();
  let cwd = null;
  let engineType = null;

  before(async () => {
    // The daemon's filesystem is not this process's under the docker suites (#637).
    cwd = makeServerDir('ds-restart-prompt-');
    const session = await term.connect({ new: '1', agentType: 'terminal', cwd });
    engineType = session.engineType;
    await term.waitForOutput(/\$|%|#/, 15000);
  });

  after(async () => {
    await cleanupSessions([term]);
    try { term.close(); } catch {}
    removeServerDir(cwd);
  });

  it('never claims a tmux-backed session will be interrupted', async () => {
    const line = await prompt();
    assert.ok(line.startsWith('Restarting'), line);
    if (engineType === 'tmux') {
      // The whole point: this session survives the restart, so the line must not
      // count it as a casualty.
      assert.match(line, /running under tmux/, line);
      assert.doesNotMatch(line, /^Restarting - 1 session will be interrupted$/, line);
    } else {
      assert.match(line, /will be interrupted/, line);
    }
  });

  it('counts the live session, and says so with agreeing grammar', async () => {
    const line = await prompt();
    // One session either way — never "1 sessions", and never a bare "no active
    // sessions" while one is plainly connected.
    assert.match(line, /\b1 session\b/, line);
    assert.doesNotMatch(line, /1 sessions/, line);
    assert.doesNotMatch(line, /no active sessions/, line);
  });

  it('is stable across calls, so step 1 and step 2 of --force agree', async () => {
    // restart.sh re-fetches this line and refuses the restart if the echoed text
    // has drifted; a non-deterministic phrasing would make --force unusable.
    assert.strictEqual(await prompt(), await prompt());
  });
});

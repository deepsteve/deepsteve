// Always show a project's mods (#647): the flag is server-owned, defaults ON (including
// for every context written before it existed), survives a plain name/dirs edit, and
// round-trips through GET /api/contexts. Driven over REST against the isolated test
// daemon (run-integration.sh auto-provisions one — #562). Sibling of context-archive.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { httpGet, httpPost, httpDelete, BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');

const authHeaders = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
const findCtx = (list, id) => (list || []).find(c => c.id === id);

function setAlwaysShow(id, alwaysShowMods) {
  return fetch(`${BASE_URL}/api/contexts/${id}/always-show-mods`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ alwaysShowMods }),
  });
}

describe('Context always-show-mods (#647)', () => {
  const id = 'asm-test-' + Math.random().toString(36).slice(2, 8);

  before(async () => {
    const { contexts } = await httpPost('/api/contexts', { id, name: 'Always Show Test', dirs: ['/tmp'] });
    const c = findCtx(contexts, id);
    assert.ok(c, 'context should be created');
    // A project mod is a dashboard; the default has to be the one where you can see it.
    assert.strictEqual(c.alwaysShowMods, true, 'new contexts start with it on');
  });

  after(async () => { await httpDelete(`/api/contexts/${id}`); });

  it('turns off, and the flag persists on GET', async () => {
    const r = await setAlwaysShow(id, false);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(findCtx((await r.json()).contexts, id).alwaysShowMods, false);

    const { contexts } = await httpGet('/api/contexts');
    assert.strictEqual(findCtx(contexts, id).alwaysShowMods, false, 'still off after a re-read');
  });

  it('a name/dirs edit through POST /api/contexts leaves it alone', async () => {
    // Same guarantee `archived` has, and the reason this is its own route: the project
    // editor sends name+dirs only, and must not silently reset a display choice.
    const { contexts } = await httpPost('/api/contexts', { id, name: 'Always Show Test 2', dirs: ['/tmp', '/var'] });
    const c = findCtx(contexts, id);
    assert.strictEqual(c.name, 'Always Show Test 2', 'the edit applied');
    assert.strictEqual(c.alwaysShowMods, false, 'the upsert must not flip it back on');
  });

  it('turns back on', async () => {
    const r = await setAlwaysShow(id, true);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(findCtx((await r.json()).contexts, id).alwaysShowMods, true);

    const { contexts } = await httpGet('/api/contexts');
    assert.strictEqual(findCtx(contexts, id).alwaysShowMods, true);
  });

  it('every context reports the flag, so a pre-#647 one reads as on', async () => {
    // loadContexts() normalizes an absent field to true, which is the whole migration:
    // contexts.json files written before the flag existed light up without a rewrite.
    const { contexts } = await httpGet('/api/contexts');
    for (const c of contexts) {
      assert.strictEqual(typeof c.alwaysShowMods, 'boolean', `${c.id} carries the flag`);
    }
  });

  it('404s on an unknown context id', async () => {
    const r = await setAlwaysShow('no-such-context-id', true);
    assert.strictEqual(r.status, 404);
  });
});

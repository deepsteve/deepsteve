// Context archive / unarchive (#601): the flag is server-owned, survives a plain
// name/dirs edit, and round-trips through GET /api/contexts. Driven over REST
// against the isolated test daemon (run-integration.sh auto-provisions one — #562).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { httpGet, httpPost, httpDelete, BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');

const authHeaders = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
const findCtx = (list, id) => (list || []).find(c => c.id === id);

function archive(id, archived) {
  return fetch(`${BASE_URL}/api/contexts/${id}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ archived }),
  });
}

describe('Context archive (#601)', () => {
  const id = 'arch-test-' + Math.random().toString(36).slice(2, 8);

  before(async () => {
    const { contexts } = await httpPost('/api/contexts', { id, name: 'Archive Test', dirs: ['/tmp'] });
    const c = findCtx(contexts, id);
    assert.ok(c, 'context should be created');
    assert.strictEqual(c.archived, false, 'new contexts start unarchived');
  });

  after(async () => { await httpDelete(`/api/contexts/${id}`); });

  it('archives, and the flag persists on GET', async () => {
    const r = await archive(id, true);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(findCtx((await r.json()).contexts, id).archived, true);

    const { contexts } = await httpGet('/api/contexts');
    assert.strictEqual(findCtx(contexts, id).archived, true, 'archived after a re-read');
  });

  it('a name/dirs edit through POST /api/contexts leaves it archived', async () => {
    const { contexts } = await httpPost('/api/contexts', { id, name: 'Archive Test 2', dirs: ['/tmp', '/var'] });
    const c = findCtx(contexts, id);
    assert.strictEqual(c.name, 'Archive Test 2', 'the edit applied');
    assert.strictEqual(c.archived, true, 'upsert must not resurrect an archived context');
  });

  it('unarchives', async () => {
    const r = await archive(id, false);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(findCtx((await r.json()).contexts, id).archived, false);

    const { contexts } = await httpGet('/api/contexts');
    assert.strictEqual(findCtx(contexts, id).archived, false);
  });

  it('404s on an unknown context id', async () => {
    const r = await archive('no-such-context-id', true);
    assert.strictEqual(r.status, 404);
  });
});

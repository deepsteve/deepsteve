// The built-in Deep Steve project (#696): seeded at load, not deletable, and its
// welcome tab opens exactly once. Driven over REST against the isolated test daemon
// (run-integration.sh auto-provisions one — #562).
//
// The seed is observable here because the provisioned daemon gets a scratch HOME, so its
// contexts.json is brand new. It has no .install-source.json either, which is what makes
// this the fallback branch of deepsteveProjectDir() — the folder is that HOME's
// .deepsteve, the one directory every install has by definition.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { httpGet, httpPost, BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');

const authHeaders = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
const BUILTIN_ID = 'deepsteve';
const findCtx = (list, id) => (list || []).find(c => c.id === id);

const post = (path, body) => fetch(`${BASE_URL}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: JSON.stringify(body || {}),
});
const del = (path) => fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers: authHeaders });
const readBuiltin = async () => findCtx((await httpGet('/api/contexts')).contexts, BUILTIN_ID);

describe('The built-in Deep Steve project (#696)', () => {
  // Restored in after(): every suite shares one daemon, so a renamed or repointed project
  // left behind would be another suite's surprise.
  let original = null;

  before(async () => {
    original = await readBuiltin();
    assert.ok(original, 'the built-in project is seeded with no setup step');
  });

  after(async () => {
    if (original) {
      await httpPost('/api/contexts', { id: BUILTIN_ID, name: original.name, dirs: original.dirs });
    }
  });

  it('is present out of the box, flagged, and points at a folder', async () => {
    const c = await readBuiltin();
    assert.strictEqual(c.builtin, true);
    assert.strictEqual(c.name, 'Deep Steve');
    assert.strictEqual(c.archived, false, 'it starts visible in the rail');
    assert.strictEqual(c.dirs.length, 1, 'exactly one folder is seeded');
    assert.ok(c.dirs[0].startsWith('/'), `expected an absolute folder, got ${c.dirs[0]}`);
    assert.ok(Number.isFinite(c.welcomedAt), 'welcomedAt is a number, not undefined');
  });

  it('no other project claims the flag', async () => {
    const { contexts } = await httpGet('/api/contexts');
    assert.deepStrictEqual(contexts.filter(c => c.builtin === true).map(c => c.id), [BUILTIN_ID]);
  });

  it('cannot be minted by a client — POST ignores a forged builtin flag', async () => {
    const id = 'forge-' + Math.random().toString(36).slice(2, 8);
    try {
      const { contexts } = await httpPost('/api/contexts',
        { id, name: 'Forged', dirs: ['/tmp'], builtin: true, welcomedAt: 123 });
      const c = findCtx(contexts, id);
      assert.strictEqual(c.builtin, false, 'only the seed mints a built-in');
      assert.strictEqual(c.welcomedAt, 0, 'only the welcome route stamps a visit');
    } finally {
      await del(`/api/contexts/${id}`);
    }
  });

  it('refuses to be deleted, and is still there afterwards', async () => {
    const r = await del(`/api/contexts/${BUILTIN_ID}`);
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /archived, not deleted/);
    assert.ok(await readBuiltin(), 'the refusal left it in place');
  });

  it('an ordinary project is still deletable', async () => {
    const id = 'del-' + Math.random().toString(36).slice(2, 8);
    await httpPost('/api/contexts', { id, name: 'Deletable', dirs: ['/tmp'] });
    const r = await del(`/api/contexts/${id}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(findCtx((await httpGet('/api/contexts')).contexts, id), undefined);
  });

  it('hides and shows through the shared archive route', async () => {
    const on = await post(`/api/contexts/${BUILTIN_ID}/archive`, { archived: true });
    assert.strictEqual(on.status, 200);
    assert.strictEqual((await readBuiltin()).archived, true, 'hidden non-destructively');

    const off = await post(`/api/contexts/${BUILTIN_ID}/archive`, { archived: false });
    assert.strictEqual(off.status, 200);
    assert.strictEqual((await readBuiltin()).archived, false, 'and brought back');
  });

  it('survives a name and folder edit without being demoted', async () => {
    const before_ = await readBuiltin();
    const { contexts } = await httpPost('/api/contexts',
      { id: BUILTIN_ID, name: 'DS trunk', dirs: ['/tmp', '/var'] });
    const c = findCtx(contexts, BUILTIN_ID);
    assert.strictEqual(c.name, 'DS trunk', 'the edit applied');
    assert.deepStrictEqual(c.dirs, ['/tmp', '/var'], 'the folder is configurable');
    assert.strictEqual(c.builtin, true, 'an edit must not demote it');
    assert.strictEqual(c.welcomedAt, before_.welcomedAt, 'an edit must not un-see the welcome');
  });

  it('opens the welcome tab once, then never again', async () => {
    // Order-independent on purpose: a fresh daemon has welcomedAt 0 and the first call
    // opens the tab, but a suite re-run against a persisted DEEPSTEVE_URL daemon starts
    // already stamped. What must hold in both cases is that a second ask opens nothing and
    // does not move the stamp.
    const wasUnwelcomed = (await readBuiltin()).welcomedAt === 0;

    const first = await post(`/api/contexts/${BUILTIN_ID}/welcome`);
    assert.strictEqual(first.status, 200);
    assert.strictEqual((await first.json()).opened, wasUnwelcomed);

    const stamped = (await readBuiltin()).welcomedAt;
    assert.ok(stamped > 0, 'the visit is recorded server-side, not per-browser');

    const second = await post(`/api/contexts/${BUILTIN_ID}/welcome`);
    assert.strictEqual(second.status, 200);
    assert.strictEqual((await second.json()).opened, false);
    assert.strictEqual((await readBuiltin()).welcomedAt, stamped, 'the stamp does not move');
  });

  it('refuses a welcome for a project that is not the built-in', async () => {
    const id = 'welc-' + Math.random().toString(36).slice(2, 8);
    await httpPost('/api/contexts', { id, name: 'Not Built In', dirs: ['/tmp'] });
    try {
      const r = await post(`/api/contexts/${id}/welcome`);
      assert.strictEqual(r.status, 400);
    } finally {
      await del(`/api/contexts/${id}`);
    }
  });

  it('404s a welcome for an unknown project', async () => {
    const r = await post('/api/contexts/no-such-project-id/welcome');
    assert.strictEqual(r.status, 404);
  });

  it('serves the seeded icon image', async () => {
    const r = await fetch(`${BASE_URL}/api/contexts/${BUILTIN_ID}/icon`, { headers: authHeaders });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'image/png');
  });
});

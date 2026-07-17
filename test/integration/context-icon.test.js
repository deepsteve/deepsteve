// Context icon images (#579): upload → serve → replace → emoji/image mutual exclusivity
// → clear → cleanup. Driven entirely over REST against the isolated test daemon
// (run-integration.sh auto-provisions one; no live-daemon risk — #562).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { httpGet, httpPost, httpDelete, BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');

const authHeaders = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};

// A real 1×1 PNG (valid signature + IHDR/IDAT/IEND) and a minimal SVG.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>', 'utf8');

function putIcon(id, ext, body, contentType = 'application/octet-stream') {
  return fetch(`${BASE_URL}/api/contexts/${id}/icon?ext=${ext}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...authHeaders },
    body,
  });
}
function getIcon(id) {
  return fetch(`${BASE_URL}/api/contexts/${id}/icon`, { headers: { ...authHeaders } });
}
const findCtx = (list, id) => (list || []).find(c => c.id === id);

describe('Context icon images (#579)', () => {
  const id = 'ico-test-' + Math.random().toString(36).slice(2, 8);

  before(async () => {
    const { contexts } = await httpPost('/api/contexts', { id, name: 'Icon Test', dirs: [] });
    const c = findCtx(contexts, id);
    assert.ok(c, 'context should be created');
    assert.strictEqual(c.iconImage, '', 'new context has no image');
  });

  after(async () => { await httpDelete(`/api/contexts/${id}`); });

  it('uploads a PNG, serves it back, and drops any emoji', async () => {
    const r = await putIcon(id, 'png', PNG_1x1);
    assert.strictEqual(r.status, 200, 'PNG upload succeeds');
    const c = findCtx((await r.json()).contexts, id);
    assert.strictEqual(c.iconImage, 'png', 'iconImage records the ext');
    assert.strictEqual(c.icon, '', 'image drops the emoji (mutually exclusive)');

    const g = await getIcon(id);
    assert.strictEqual(g.status, 200, 'icon serves');
    assert.match(g.headers.get('content-type') || '', /^image\/png/, 'served as image/png');
    assert.strictEqual(g.headers.get('x-content-type-options'), 'nosniff', 'nosniff header set');
    assert.ok((g.headers.get('content-security-policy') || '').includes('sandbox'), 'sandbox CSP set');
    const bytes = Buffer.from(await g.arrayBuffer());
    assert.ok(bytes.equals(PNG_1x1), 'served bytes are byte-identical to the upload');
  });

  it('replaces the PNG with an SVG (new content-type, no stale png)', async () => {
    const r = await putIcon(id, 'svg', SVG, 'image/svg+xml');
    assert.strictEqual(r.status, 200, 'SVG upload succeeds');
    assert.strictEqual(findCtx((await r.json()).contexts, id).iconImage, 'svg');

    const g = await getIcon(id);
    assert.strictEqual(g.status, 200);
    assert.match(g.headers.get('content-type') || '', /image\/svg\+xml/, 'served as image/svg+xml');
    assert.ok(Buffer.from(await g.arrayBuffer()).equals(SVG), 'served the SVG bytes');
  });

  it('setting an emoji clears the image', async () => {
    await httpPost('/api/contexts', { id, name: 'Icon Test', dirs: [], icon: '🚀' });
    const c = findCtx(await httpGet('/api/contexts').then(d => d.contexts), id);
    assert.strictEqual(c.icon, '🚀', 'emoji is stored');
    assert.strictEqual(c.iconImage, '', 'emoji cleared the image');
    assert.strictEqual((await getIcon(id)).status, 404, 'no image is served after clearing');
  });

  it('DELETE /api/contexts/:id/icon clears emoji and image', async () => {
    await putIcon(id, 'png', PNG_1x1);
    const del = await fetch(`${BASE_URL}/api/contexts/${id}/icon`, { method: 'DELETE', headers: { ...authHeaders } });
    assert.strictEqual(del.status, 200);
    const c = findCtx((await del.json()).contexts, id);
    assert.strictEqual(c.icon, '', 'emoji cleared');
    assert.strictEqual(c.iconImage, '', 'image cleared');
    assert.strictEqual((await getIcon(id)).status, 404, 'image no longer served');
  });

  it('rejects an unsupported extension', async () => {
    const r = await putIcon(id, 'gif', PNG_1x1);
    assert.strictEqual(r.status, 400, 'ext must be png or svg');
  });

  it('rejects bytes that are not the claimed format', async () => {
    const r = await putIcon(id, 'png', Buffer.from('this is not a png'));
    assert.strictEqual(r.status, 400, 'bad magic bytes rejected');
    assert.strictEqual((await getIcon(id)).status, 404, 'nothing stored from the rejected upload');
  });

  it('404s the icon endpoint for an unknown context', async () => {
    assert.strictEqual((await getIcon('nope-nope')).status, 404);
    assert.strictEqual((await putIcon('nope-nope', 'png', PNG_1x1)).status, 404);
  });
});

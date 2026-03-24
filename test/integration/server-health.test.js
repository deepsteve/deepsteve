const { describe, it } = require('node:test');
const assert = require('node:assert');
const { httpGet, BASE_URL } = require('../helpers/ws-client');

describe('Server Health', () => {
  it('GET /api/version returns a version string', async () => {
    const data = await httpGet('/api/version');
    assert.ok(data.current, 'should have a current version');
    assert.match(data.current, /^\d+\.\d+\.\d+$/, 'version should be semver');
  });

  it('GET /api/shells returns empty list initially', async () => {
    const data = await httpGet('/api/shells');
    assert.ok(Array.isArray(data.shells), 'shells should be an array');
  });

  it('GET /api/settings returns settings object', async () => {
    const data = await httpGet('/api/settings');
    assert.ok(data, 'should return settings');
    assert.ok('engine' in data, 'should have engine setting');
  });

  it('GET / serves the HTML page', async () => {
    const res = await fetch(BASE_URL + '/');
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html>') || html.includes('<html'), 'should serve HTML');
  });

  it('GET /api/home returns home directory', async () => {
    const data = await httpGet('/api/home');
    assert.ok(data.home, 'should have home path');
    assert.ok(data.home.startsWith('/'), 'home should be an absolute path');
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { httpGet, httpPost } = require('../helpers/ws-client');

describe('Settings API', () => {
  it('POST /api/settings updates a setting', async () => {
    // Get current settings first
    const before = await httpGet('/api/settings');
    const originalValue = before.commandPaletteEnabled;

    // Toggle the setting
    const newValue = !originalValue;
    await httpPost('/api/settings', { commandPaletteEnabled: newValue });

    // Verify the change
    const after = await httpGet('/api/settings');
    assert.strictEqual(after.commandPaletteEnabled, newValue, 'setting should be updated');

    // Restore original
    await httpPost('/api/settings', { commandPaletteEnabled: originalValue });
  });

  it('GET /api/settings returns expected default keys', async () => {
    const settings = await httpGet('/api/settings');
    const expectedKeys = ['engine', 'commandPaletteEnabled', 'commandPaletteShortcut'];
    for (const key of expectedKeys) {
      assert.ok(key in settings, `settings should contain "${key}"`);
    }
  });

  it('POST /api/settings warns when enabledAgents items are pruned (#519)', async () => {
    const original = (await httpGet('/api/settings')).enabledAgents;

    // A stale/unknown agent id (like the issue's leftover "gemini") is pruned by
    // the itemEnum filter — the response must say so instead of dropping it silently.
    const resp = await httpPost('/api/settings', { enabledAgents: [...original, 'gemini'] });
    assert.ok(Array.isArray(resp.warnings), 'response should carry a warnings array');
    assert.ok(resp.warnings.some(w => w.includes('enabledAgents') && w.includes('gemini')),
      `warnings should name the dropped item, got: ${JSON.stringify(resp.warnings)}`);
    assert.deepStrictEqual(resp.enabledAgents, original, 'unknown id is pruned from the stored value');

    // A clean save carries no warnings key at all.
    const clean = await httpPost('/api/settings', { enabledAgents: original });
    assert.strictEqual(clean.warnings, undefined, 'clean saves must not grow a warnings key');
    assert.deepStrictEqual((await httpGet('/api/settings')).enabledAgents, original);
  });
});

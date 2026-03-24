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
});

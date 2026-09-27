// Every key a mod destructures out of its init(context) must be one server.js passes to initMCP.
//
// mcp-server.js hands each mod's init() the very object server.js builds in its initMCP({...})
// call, so a key missing there is `undefined` in the mod, and nothing says so until the code
// path runs. display-tab destructured `pendingOpens`, which server.js never passed: every
// create_display_tab made while no browser window was connected threw "Cannot read properties
// of undefined (reading 'push')" (#716). Its unit tests build their own ctx, with pendingOpens,
// so they passed. This reads both sides as source — no daemon, no mod required.
//
// Run: node --test test/unit/mod-context-keys.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function passedKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = src.match(/\ninitMCP\(\{([^}]*)\}\)/);
  assert.ok(m, 'server.js no longer calls initMCP({ ... }) on one line — update this test');
  return new Set(m[1].split(',').map((part) => part.split(':')[0].trim()).filter(Boolean));
}

function destructuredKeys(file) {
  const src = fs.readFileSync(file, 'utf8');
  const keys = [];
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*context\s*;/g)) {
    for (const part of m[1].split(',')) {
      const key = part.split(/[:=]/)[0].trim();
      if (key) keys.push(key);
    }
  }
  return keys;
}

test('server.js passes every context key a mod destructures', () => {
  const passed = passedKeys();
  assert.ok(passed.has('shells') && passed.has('log'), 'the initMCP key list did not parse');
  const modsDir = path.join(ROOT, 'mods');
  const missing = [];
  let checked = 0;
  for (const mod of fs.readdirSync(modsDir)) {
    const file = path.join(modsDir, mod, 'tools.js');
    if (!fs.existsSync(file)) continue;
    for (const key of destructuredKeys(file)) {
      checked++;
      if (!passed.has(key)) missing.push(`mods/${mod}/tools.js: ${key}`);
    }
  }
  assert.ok(checked > 10, `only ${checked} destructured keys found — the pattern no longer matches`);
  assert.deepStrictEqual(missing, [], 'destructured from context but never passed to initMCP in server.js');
});

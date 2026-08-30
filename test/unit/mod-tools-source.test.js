// Anti-drift test for #644: tools.js is the ONLY place a mod's MCP tools are declared.
//
// The problem this exists for: every mod.json carried a parallel
//   "tools": [{ "name": …, "description": … }]
// array that no client ever read. mcp-server.js registers whatever a mod's tools.js
// init() returns and never opens the manifest, so the array was documentation with
// nothing behind it — and, being hand-maintained, it rotted: 48 names across 15
// manifests against 55 actually registered. Agent Chat's three lock tools, Display Tabs'
// edit_display_tab and three of Screenshots' four were missing outright, and the short
// human-facing descriptions had been rewritten independently of the long model-facing
// ones the agent really sees. mods/steveonardo declared "tools": [] while shipping no
// tools.js at all — a manifest making a claim about a file that does not exist.
//
// The fix was to delete the array and DERIVE the inventory: mcp-server.js indexes what
// each mod's init() returns and GET /api/mods reports that. This file is the guard that
// the second copy cannot come back — a manifest that regains a `tools` key, or an
// /api/mods that goes back to trusting the manifest, fails here.
//
// What it can and cannot prove. It is a pure fs read: no tools.js is required, because
// requiring one is side-effectful (mods/scheduled-tasks/tools.js starts a setInterval
// scheduler and writes under stateDir() at init; mods/agent-chat/tools.js loads state at
// module load). So it proves the manifests are clean, the wiring is spelled correctly,
// the release-time validator carries the rule, and the doc teaches it — but NOT that the
// derived list is CORRECT. That needs every init() to really run, and lives in
// test/integration-standalone/mcp-tool-index.test.js.
//
// Pure file read + JSON.parse — no server boot, no shell — so it runs in the bare `unit`
// CI job, which has no zsh.
//
// Run: node --test test/unit/mod-tools-source.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODS_DIR = path.join(ROOT, 'mods');

const modDirs = fs.readdirSync(MODS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const manifests = modDirs
  .filter((id) => fs.existsSync(path.join(MODS_DIR, id, 'mod.json')))
  .map((id) => ({
    id,
    rel: `mods/${id}/mod.json`,
    raw: fs.readFileSync(path.join(MODS_DIR, id, 'mod.json'), 'utf8'),
  }));

const withToolsJs = modDirs.filter((id) => fs.existsSync(path.join(MODS_DIR, id, 'tools.js')));

const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mcpSource = fs.readFileSync(path.join(ROOT, 'mcp-server.js'), 'utf8');
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'mods.md'), 'utf8');

test('the scan actually finds the mods (#644)', () => {
  // Without this, a moved mods/ dir or a bad filter turns every assertion below into a
  // silent pass — the failure mode compose-projects.test.js (#616) opens with too.
  assert.ok(manifests.length >= 15,
    `expected the repo's mods to be found; got ${manifests.length} mod.json files`);
  for (const id of ['deepsteve-core', 'display-tab', 'tasks', 'screenshots', 'agent-chat', 'steveonardo']) {
    assert.ok(manifests.some((m) => m.id === id),
      `mods/${id}/mod.json must be in the scan — it is one of the manifests #644 emptied. ` +
      'If the mod was renamed or removed, update this list; the assertions below are ' +
      'vacuous when the scan misses.');
  }
  assert.ok(withToolsJs.length >= 10,
    `expected the tools.js files to be found; got ${withToolsJs.length}`);
  assert.ok(withToolsJs.includes('deepsteve-core'), 'mods/deepsteve-core/tools.js must exist');
});

test('no mod.json declares tools (#644)', () => {
  const offenders = [];
  for (const { rel, raw } of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (e) {
      assert.fail(`${rel} is not valid JSON: ${e.message}`);
    }
    if ('tools' in manifest) {
      offenders.push(`${rel} (${Array.isArray(manifest.tools) ? manifest.tools.length : '?'} entries)`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    "A mod's MCP tools are declared in its tools.js and nowhere else (#644). The manifest " +
    'copy was hand-maintained, read by no client, and had already drifted to 48 names ' +
    'against 55 real ones with independently-written descriptions. GET /api/mods now ' +
    "derives the list from mcp-server.js's index, so a manifest entry could only ever be a " +
    `second, wrong answer. Delete the key. Offenders:\n  ${offenders.join('\n  ')}`);
});

test('mcp-server.js indexes tools by mod and exports the accessors (#644)', () => {
  assert.match(mcpSource, /module\.exports = \{[^}]*\bgetModTools\b/,
    'mcp-server.js must export getModTools — it is what GET /api/mods reads');
  assert.match(mcpSource, /module\.exports = \{[^}]*\bisMcpReady\b/,
    'mcp-server.js must export isMcpReady, so an empty index can be told apart from an ' +
    'unscanned one while initMCP is still awaiting the ESM SDK import');
  assert.match(mcpSource, /modToolIndex\.set\(entry\.name,/,
    'the index must be keyed by the mod DIRECTORY name, which is the id GET /api/mods ' +
    'reports. Before #644 the mod association was discarded at registration and survived ' +
    'only in a log line.');
  assert.match(mcpSource, /description: def\.description/,
    'the indexed description must be the one handed to server.tool(), not a second ' +
    'wording — a parallel human-facing description is exactly the drift #644 removed');
});

test('GET /api/mods derives tools instead of trusting the manifest (#644)', () => {
  assert.match(serverSource, /const \{[^}]*\bgetModTools\b[^}]*\} = require\('\.\/mcp-server'\)/,
    'server.js must import getModTools from ./mcp-server');
  const push = serverSource.match(/^\s*mods\.push\(\{ id: entry\.name.*$/m);
  assert.ok(push, 'the GET /api/mods push line was not found — has the handler been rewritten?');
  assert.match(push[0], /\.\.\.manifest,\s*tools: getModTools\(entry\.name\)/,
    'the derived list must come AFTER the manifest spread so later-key-wins makes it ' +
    'authoritative. Third-party mods arrive as tarballs whose manifests we do not control ' +
    '(POST /api/mods/install) and may still ship a stale tools array (#644).');
});

test('validate-mods.js rejects a manifest that declares tools (#644)', () => {
  // The rules are a pure function so they can be exercised here rather than only at
  // release time — release.sh:159 is the ONLY caller of the CLI, so without this the gate
  // would live in a script no pull request runs.
  const { validateManifest } = require('../../validate-mods');
  assert.deepStrictEqual(
    validateManifest('demo', { name: 'D', version: '1.0.0', description: 'd' }), [],
    'a clean manifest must produce no errors, or the assertion below proves nothing');
  const errors = validateManifest('demo', {
    name: 'D', version: '1.0.0', description: 'd',
    tools: [{ name: 'x', description: 'y' }],
  });
  assert.ok(errors.some((e) => /tools/.test(e)),
    `validate-mods.js must reject a "tools" key; got: ${JSON.stringify(errors)}`);
});

test('validate-mods.js requires an entry for "app": true (#661)', () => {
  // An App owns the fullscreen view slot and lends you out to sessions from a page. A
  // tools-only mod has none, so the flag would buy a rail row that opens nothing.
  const { validateManifest } = require('../../validate-mods');
  const base = { name: 'D', version: '1.0.0', description: 'd' };
  assert.deepStrictEqual(validateManifest('demo', { ...base, app: true, entry: 'index.html' }), []);
  const errors = validateManifest('demo', { ...base, app: true });
  assert.ok(errors.some((e) => /app/.test(e) && /entry/.test(e)),
    `an app without an entry must be rejected; got: ${JSON.stringify(errors)}`);
  // Absent means today's behaviour exactly — the flag is purely additive.
  assert.deepStrictEqual(validateManifest('demo', base), []);
});

test('docs/mods.md teaches the rule and stops teaching the old one (#644)', () => {
  assert.doesNotMatch(doc, /^\|\s*`tools`\s*\|/m,
    'the mod.json field reference must not list a `tools` field — there is none (#644)');
  assert.doesNotMatch(doc, /"tools":\s*\[/,
    'no example manifest in docs/mods.md may show a `tools` array (#644)');
  assert.match(doc, /only place a mod's MCP tools are declared/,
    'the MCP Tools section must state that tools.js is the only declaration');
  assert.match(doc, /`GET \/api\/mods` now derives/,
    'docs/mods.md must say that the inventory is derived and where it is served');
});

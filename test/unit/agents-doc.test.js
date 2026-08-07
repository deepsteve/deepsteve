// Anti-drift test binding docs/agents.md to AGENT_CATALOG in server.js (#622).
//
// The problem this exists for: deepsteve shipped five agent integrations at wildly
// different levels of support and nothing stated what those levels were. AGENT_CONFIGS
// was the only real source of truth, "(experimental)" was hardcoded into the server's
// agent names AND again into the Settings HTML, and Hermes was in neither — so it read
// as experimental in the README and as fully supported in the UI.
//
// So the support tier is now DATA (AGENT_CATALOG.tier), and this file makes the doc a
// build dependency of that data. Adding an agent without documenting it fails here;
// so does moving an agent between tiers in one place and not the other.
//
// Pure file read + vm eval of a literal — no server boot, no shell — so it runs in the
// bare `unit` CI job, which has no zsh.
//
// Run: node --test test/unit/agents-doc.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'agents.md'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

// The catalog is a pure literal, so it evaluates standalone — no server dependencies.
function loadCatalog() {
  const from = serverSource.indexOf('const AGENT_CATALOG');
  const to = serverSource.indexOf('const SETTINGS_SCHEMA', from);
  assert.ok(from >= 0, 'AGENT_CATALOG not found in server.js');
  assert.ok(to > from, 'SETTINGS_SCHEMA marker not found after AGENT_CATALOG');
  const context = {};
  vm.runInNewContext(`${serverSource.slice(from, to)}
result = { AGENT_CATALOG, AGENT_TYPES }`, context);
  return context.result;
}

const { AGENT_CATALOG, AGENT_TYPES } = loadCatalog();
const TIERS = ['supported', 'experimental'];

// `terminal` is not a selectable agent (deliberately absent from AGENT_CATALOG, so it
// can't be a default or appear in the picker) but it IS an agentType with its own
// AGENT_CONFIGS row, so the doc has to cover it.
const DOC_ONLY_IDS = ['terminal'];

/** The section between a heading and the next heading at the same level. */
function section(heading, level = '## ') {
  const start = doc.indexOf(`\n${level}${heading}`);
  assert.ok(start >= 0, `docs/agents.md is missing the "${level}${heading}" section`);
  const after = start + 1;
  const next = doc.indexOf(`\n${level}`, after);
  return doc.slice(after, next === -1 ? doc.length : next);
}

test('every catalog entry declares a known tier and a clean name', () => {
  assert.ok(AGENT_CATALOG.length > 0, 'AGENT_CATALOG is empty');
  for (const a of AGENT_CATALOG) {
    assert.ok(TIERS.includes(a.tier), `${a.id}: tier must be one of ${TIERS.join('/')}, got ${a.tier}`);
    assert.ok(a.name && a.shortName, `${a.id}: needs a name and shortName`);
    // The tier is rendered by agentLabel(); baking it into the name is what let the
    // server and the Settings HTML disagree in the first place.
    assert.doesNotMatch(a.name, /experimental|unsupported|beta/i,
      `${a.id}: don't bake the tier into name — set tier and let agentLabel() render it`);
  }
  assert.deepStrictEqual(AGENT_TYPES, AGENT_CATALOG.map(a => a.id),
    'AGENT_TYPES must be derived from AGENT_CATALOG');
});

test('the tier lists in the doc match AGENT_CATALOG', () => {
  const listed = new Map();
  for (const tier of TIERS) {
    // "### Supported" / "### Experimental" — list items of the form: - `id` — Name
    const heading = tier[0].toUpperCase() + tier.slice(1);
    for (const m of section(heading, '### ').matchAll(/^-\s+`([a-z0-9-]+)`/gm)) {
      assert.ok(!listed.has(m[1]), `${m[1]} is listed under more than one tier`);
      listed.set(m[1], tier);
    }
  }
  for (const a of AGENT_CATALOG) {
    assert.strictEqual(listed.get(a.id), a.tier,
      `${a.id} is "${a.tier}" in AGENT_CATALOG but "${listed.get(a.id) || 'absent'}" in docs/agents.md`);
  }
  // Catches an integration that was deleted from the code but left in the doc.
  for (const id of listed.keys()) {
    assert.ok(AGENT_TYPES.includes(id), `docs/agents.md lists "${id}", which is not in AGENT_CATALOG`);
  }
});

test('every agent has its own section in the doc', () => {
  // Headings carry the id so this can't be fooled by a renamed display name:
  //   ## Claude Code (`claude`)
  const documented = [...doc.matchAll(/^## .*\(`([a-z0-9-]+)`\)/gm)].map(m => m[1]);
  for (const id of [...AGENT_TYPES, ...DOC_ONLY_IDS]) {
    assert.ok(documented.includes(id), `docs/agents.md has no "## … (\`${id}\`)" section`);
  }
  for (const id of documented) {
    assert.ok([...AGENT_TYPES, ...DOC_ONLY_IDS].includes(id),
      `docs/agents.md documents "${id}", which is not a real agentType`);
  }
});

test('the capability matrix has a column for every agent', () => {
  const table = section('Capability matrix');
  const header = table.split('\n').find(l => l.trim().startsWith('|'));
  assert.ok(header, 'no table found under "## Capability matrix"');
  const columns = header.split('|').map(c => c.trim()).filter(Boolean);
  for (const a of AGENT_CATALOG) {
    assert.ok(columns.includes(a.name),
      `capability matrix has no "${a.name}" column (columns: ${columns.join(', ')})`);
  }
  assert.ok(columns.some(c => /terminal/i.test(c)), 'capability matrix has no plain-terminal column');
  // A row per capability is the point; a matrix that lost its body still parses.
  const rows = table.split('\n').filter(l => l.trim().startsWith('|'));
  assert.ok(rows.length > 10, `capability matrix looks truncated (${rows.length} lines)`);
});

test('the experimental suffix is rendered from the tier, not hardcoded in the client', () => {
  assert.match(appSource, /function agentLabel\(/,
    'public/js/app.js must keep agentLabel() as the single place the tier becomes text');
  for (const a of AGENT_CATALOG) {
    assert.ok(!appSource.includes(`${a.name} (experimental)`),
      `public/js/app.js hardcodes "${a.name} (experimental)" — render it via agentLabel(agent) instead`);
  }
});

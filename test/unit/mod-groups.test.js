// Grouping, search and enabled-state for the Mods modal (#673).
//
// public/js/mod-groups.js is pure — no DOM, no fetch, no module state — precisely so the
// behaviour worth pinning can be pinned without a fake browser. The modal's own rendering is
// DOM glue on top of this; what a group-by actually gets wrong is not the markup, it is
// dropping an entry that matches no bucket, or re-ordering, or letting a filter and a
// grouping become the same thing again.
//
// Run: node --test test/unit/mod-groups.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE_URL = pathToFileURL(
  path.join(__dirname, '..', '..', 'public', 'js', 'mod-groups.js')
).href;

// One entry per section, plus the two shapes that are easy to lose: an unknown kind, and a
// catalog row that is not installed.
const FIXTURE = [
  { id: 'workshop', name: 'Workshop', kind: 'app', description: 'One inbox for every agent' },
  { id: 'tasks', name: 'Tasks', kind: 'panel', description: 'Task list for human actions',
    tools: [{ name: 'add_task' }] },
  { id: 'screenshots', name: 'Screenshots', kind: 'panel', description: 'Capture terminal images',
    tools: [{ name: 'screenshot_capture' }] },
  { id: 'tower', name: 'Tower', kind: 'fullscreen', description: 'Pixel art skyscraper' },
  { id: 'agent-poker', name: 'Agent Poker', kind: 'game', tags: ['games'], description: 'Cards' },
  { id: 'baby-browser', name: 'Baby Browser', kind: 'tab', description: 'A browser in a tab' },
  { id: 'deepsteve-core', name: 'Core', kind: 'background', description: 'Core tools' },
  { id: 'skill:merge', name: '/merge', kind: 'skill', type: 'skill', enabled: true,
    slashCommand: '/merge', description: 'Merge the worktree branch' },
  { id: 'skill:fork', name: '/fork', kind: 'skill', type: 'skill', enabled: false,
    slashCommand: '/fork', description: 'Fork this conversation' },
  { id: 'remote-thing', name: 'Remote Thing', kind: 'available', description: 'Not installed yet' },
  { id: 'wormhole', name: 'Wormhole', kind: 'wormhole', description: 'A kind from the future' },
];

const labelsOf = (groups) => groups.map(g => g.label);
const idsIn = (groups, label) => (groups.find(g => g.label === label)?.items || []).map(m => m.id);

test('sections come back in a fixed order, and an empty one leaves no heading', async () => {
  const { groupMods, MOD_GROUPS } = await import(MODULE_URL);

  assert.deepStrictEqual(labelsOf(groupMods(FIXTURE)),
    ['Apps', 'Panels', 'Fullscreen', 'Games', 'Tabs', 'Background', 'Skills', 'Available', 'Other'],
    'order is MOD_GROUPS, not input order and not alphabetical');

  // Drop the one game and the section must VANISH, not come back empty. A heading with
  // nothing under it is worse than the flat list this replaced.
  const noGames = FIXTURE.filter(m => m.kind !== 'game');
  assert.ok(!labelsOf(groupMods(noGames)).includes('Games'));

  assert.deepStrictEqual(labelsOf(groupMods([])), [], 'nothing in, no headings out');
  assert.strictEqual(MOD_GROUPS.length, 9);
});

test('nothing vanishes — an unrecognised kind still gets a heading', async () => {
  const { groupMods } = await import(MODULE_URL);
  const groups = groupMods(FIXTURE);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.strictEqual(total, FIXTURE.length, 'a group-by that silently drops an entry is the failure mode');

  // This is the whole reason `other` exists: a kind added to mod-kind.js and not yet taught
  // to the client must still be reachable in the UI.
  assert.deepStrictEqual(idsIn(groups, 'Other'), ['wormhole']);
});

test('skills get their own section and appear nowhere else', async () => {
  const { groupMods } = await import(MODULE_URL);
  const groups = groupMods(FIXTURE);

  assert.deepStrictEqual(idsIn(groups, 'Skills'), ['skill:merge', 'skill:fork']);
  for (const g of groups) {
    if (g.label === 'Skills') continue;
    assert.ok(!g.items.some(m => m.type === 'skill'),
      `a skill leaked into ${g.label} — that conflation is the issue itself`);
  }
});

test('search spans every section', async () => {
  const { groupMods } = await import(MODULE_URL);

  // A query that hits a mod and a skill returns BOTH sections. The old pills could not do
  // this: they were single-select, so you saw one kind at a time.
  const both = groupMods(FIXTURE, { query: 'or' });
  assert.ok(labelsOf(both).includes('Panels') && labelsOf(both).includes('Skills'));

  assert.deepStrictEqual(labelsOf(groupMods(FIXTURE, { query: 'poker' })), ['Games']);
  assert.deepStrictEqual(idsIn(groupMods(FIXTURE, { query: '/merge' }), 'Skills'), ['skill:merge']);
  // Tool names are searchable because the expanded row now lists them.
  assert.deepStrictEqual(idsIn(groupMods(FIXTURE, { query: 'screenshot_capture' }), 'Panels'), ['screenshots']);
  assert.deepStrictEqual(idsIn(groupMods(FIXTURE, { query: 'GAMES' }), 'Games'), ['agent-poker'],
    'tags are searched, case-insensitively');
  assert.deepStrictEqual(labelsOf(groupMods(FIXTURE, { query: 'zzz' })), []);
});

test('enabled state is read from two different places, and stays that way', async () => {
  const { groupMods, isModEnabled } = await import(MODULE_URL);

  // A skill is installed as files on the server, so its state rides the wire as mod.enabled.
  // A mod is a per-browser localStorage preference, so its state is the Set. Asking the Set
  // about a skill is the bug that used to uncheck every skill toggle on a dependency cascade.
  const enabledIds = new Set(['tasks']);
  assert.strictEqual(isModEnabled({ id: 'tasks' }, enabledIds), true);
  assert.strictEqual(isModEnabled({ id: 'skill:merge', type: 'skill', enabled: true }, enabledIds), true);
  assert.strictEqual(isModEnabled({ id: 'skill:merge', type: 'skill', enabled: true }, new Set()), true,
    'a skill is enabled on the server; the mods Set never contains a skill: id');
  assert.strictEqual(isModEnabled({ id: 'skill:fork', type: 'skill', enabled: false }, enabledIds), false);

  const groups = groupMods(FIXTURE, { enabledOnly: true, enabledIds });
  assert.deepStrictEqual(labelsOf(groups), ['Panels', 'Skills']);
  assert.deepStrictEqual(idsIn(groups, 'Panels'), ['tasks']);
  assert.deepStrictEqual(idsIn(groups, 'Skills'), ['skill:merge']);
});

test('search and enabled-only compose, and no argument can turn a chip back into a filter', async () => {
  const { groupMods } = await import(MODULE_URL);
  const enabledIds = new Set(['tasks', 'tower']);

  assert.deepStrictEqual(labelsOf(groupMods(FIXTURE, { query: 'Tower', enabledOnly: true, enabledIds })),
    ['Fullscreen'], 'the two narrow together, as an AND');
  assert.deepStrictEqual(labelsOf(groupMods(FIXTURE, { query: 'Tower', enabledOnly: true, enabledIds: new Set() })),
    [], 'and either one alone can empty the list');

  // groupMods takes no section/kind argument at all. That is the structural expression of
  // "the pills stopped being an exclusive filter" — there is nothing to pass.
  const ignored = groupMods(FIXTURE, { kind: 'app', section: 'Apps', activeFilter: 'games' });
  assert.strictEqual(ignored.reduce((n, g) => n + g.items.length, 0), FIXTURE.length);
});

test('order inside a section is the order the server sent', async () => {
  const { groupMods } = await import(MODULE_URL);
  // GET /api/mods already localeCompares by name, so every section is alphabetical for free
  // and a client-side re-sort would just be a second, competing ordering.
  const reversed = [
    { id: 'z-panel', name: 'Zebra', kind: 'panel' },
    { id: 'a-panel', name: 'Aardvark', kind: 'panel' },
  ];
  assert.deepStrictEqual(idsIn(groupMods(reversed), 'Panels'), ['z-panel', 'a-panel']);
});

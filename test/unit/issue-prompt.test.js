// Unit tests for issue-prompt.js and the single-implementation guarantee (#642).
//
// Starting a session for a GitHub issue used to be written three times — the wand
// picker rendered the template in the browser, POST /api/start-issue rendered it on
// the server, and MCP start_issue rendered it again — and the three had drifted.
// The pure derivations moved into issue-prompt.js; the orchestration moved into
// server.js's startIssueSession. The rendering cases below pin the first, and the
// source guards at the bottom are the drift alarm for the second: they are cheap,
// and they fail the moment someone reintroduces a second copy.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  renderIssuePrompt, normalizeLabels, issueWorktreeName, issueTabName, ISSUE_BODY_LIMIT,
  ISSUE_COMPLETE_INSTRUCTION,
} = require('../../issue-prompt.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TEMPLATE = 'issue #{{number}}: "{{title}}"\nLabels: {{labels}}\nURL: {{url}}\n\n{{body}}';

// Since #643 every rendered prompt also carries the issue_complete instruction.
// The substitution cases below are about the {{var}} half, so they assert against
// the part before that suffix — and renderBody throws if the suffix is missing,
// which quietly makes every one of them a check that it is still appended.
const SUFFIX = `\n\n${ISSUE_COMPLETE_INSTRUCTION}`;
function renderBody(template, fields) {
  const out = renderIssuePrompt(template, fields);
  assert.ok(out.endsWith(SUFFIX),
    'every rendered prompt must end with the issue_complete instruction (#643)');
  return out.slice(0, -SUFFIX.length);
}

test('renders every documented variable', () => {
  const out = renderBody(TEMPLATE, {
    number: 642, title: 'Unify start-issue', labels: 'bug, chore',
    url: 'https://example.test/642', body: 'do the thing',
  });
  assert.equal(out, 'issue #642: "Unify start-issue"\nLabels: bug, chore\nURL: https://example.test/642\n\ndo the thing');
});

test('an unknown variable renders empty, never a literal {{typo}}', () => {
  // A user-edited template must not leak its own typo into a prompt an agent
  // is about to act on.
  assert.equal(renderBody('a{{nope}}b', { number: 1, title: 't' }), 'ab');
});

test('a missing body becomes (no description), not an empty gap', () => {
  assert.equal(renderBody('{{body}}', { number: 1, title: 't' }), '(no description)');
  assert.equal(renderBody('{{body}}', { number: 1, title: 't', body: '' }), '(no description)');
});

test('body is clipped to the composer limit', () => {
  const long = 'x'.repeat(ISSUE_BODY_LIMIT + 500);
  assert.equal(renderBody('{{body}}', { number: 1, title: 't', body: long }).length, ISSUE_BODY_LIMIT);
});

test('a missing url renders empty rather than undefined', () => {
  assert.equal(renderBody('[{{url}}]', { number: 1, title: 't' }), '[]');
});

test('labels normalize from all three shapes callers actually send', () => {
  // gh --json labels gives [{name}]; MCP/HTTP callers send a joined string.
  assert.equal(normalizeLabels([{ name: 'bug' }, { name: 'ui' }]), 'bug, ui');
  assert.equal(normalizeLabels(['bug', 'ui']), 'bug, ui');
  assert.equal(normalizeLabels('bug, ui'), 'bug, ui');
});

test('absent labels are the word none, in every empty shape', () => {
  // The HTTP path used to render an empty array as '' and only a null as 'none'.
  for (const empty of [undefined, null, '', '   ', [], [{}], [null]]) {
    assert.equal(normalizeLabels(empty), 'none', `for ${JSON.stringify(empty)}`);
  }
});

test('tab name truncates at maxIssueTitleLength with an ellipsis', () => {
  assert.equal(issueTabName(7, 'short', 25), '#7 short');
  assert.equal(issueTabName(7, 'a'.repeat(50), 10), '#7 aaaaaaa…');
  assert.equal(issueTabName(7, 'a'.repeat(50), 10).length, 11); // limit + the ellipsis
});

test('tab name falls back to 25 when the setting is missing or nonsense', () => {
  for (const bad of [undefined, null, 0, -5, NaN, 'x']) {
    assert.equal(issueTabName(1, 'y'.repeat(40), bad).length, 26);
  }
});

test('worktree name is the branch convention the merge skill matches on', () => {
  // skills/merge.md keys "close the GitHub issue" off *github-issue-<n>*.
  assert.equal(issueWorktreeName(642), 'github-issue-642');
});

// --- autopilot: the completion instruction (#643) ---------------------------

test('the completion instruction is appended to every prompt, whatever the template', () => {
  // The flag changes what issue_complete ANSWERS, never whether the instruction
  // was delivered — so there is no state in which this line is absent.
  for (const template of ['', 'no variables at all', TEMPLATE, '{{body}}']) {
    assert.ok(renderIssuePrompt(template, { number: 1, title: 't' }).endsWith(SUFFIX),
      `template ${JSON.stringify(template)} lost the issue_complete instruction`);
  }
  assert.match(ISSUE_COMPLETE_INSTRUCTION, /issue_complete/);
});

test('the instruction is NOT in the shipped default template', () => {
  // The settings modal POSTs wandPromptTemplate on every save, so any install
  // where the user has ever hit Save has the old default materialized. A token
  // added to the shipped default would silently never appear there — which is
  // why renderIssuePrompt appends it instead.
  const server = read('server.js');
  const start = server.indexOf('const WAND_DEFAULT_TEMPLATE');
  const template = server.slice(start, server.indexOf('`;', start));
  assert.ok(start > 0 && !template.includes('issue_complete'),
    'WAND_DEFAULT_TEMPLATE must not carry the issue_complete line — append it in renderIssuePrompt (#643)');
});

test('autopilot is persisted, not just held in memory', () => {
  // serializeShellEntry is the one place that decides what survives a restart:
  // the shutdown-final snapshot wins the merge, so a field only a call site
  // writes is wiped for every live shell on a graceful restart.
  const server = read('server.js');
  const ser = server.slice(server.indexOf('function serializeShellEntry('));
  assert.ok(/autopilot: !!entry\.autopilot/.test(ser.slice(0, ser.indexOf('\n}'))),
    'serializeShellEntry must carry autopilot (#643)');
  // ...and the WS restore path hand-lists its fields, so it has to read it back.
  assert.ok(/autopilot: !!restored\.autopilot/.test(server),
    'the WS restore path must restore autopilot onto the live entry (#643)');
});

test('an omitted autopilot seeds from the remembered preference, not from off (#651)', () => {
  // The bug this guards: `autopilot = false` in the signature (and `!!autopilot`
  // at the call sites) made "not specified" indistinguishable from "off", so every
  // MCP / skill / autonomous start ignored the user's choice — and those are the
  // paths most runs take.
  const server = read('server.js');
  const sig = server.slice(server.indexOf('function startIssueSession('));
  const head = sig.slice(0, sig.indexOf(') {'));
  assert.ok(!/autopilot\s*=/.test(head),
    'startIssueSession must not hard-default autopilot in its signature (#651)');
  assert.ok(/autopilot == null \? !!settings\.issueAutopilot/.test(sig.slice(0, sig.indexOf('\n}'))),
    'startIssueSession must fall back to settings.issueAutopilot (#651)');

  // Both server entry points have to pass the field through un-coerced, or the
  // fallback above never sees an undefined.
  assert.ok(!/autopilot: !!autopilot/.test(server),
    'POST /api/start-issue must pass autopilot through raw, not !!-ed (#651)');
  assert.ok(!/autopilot: !!autopilot/.test(read('mods/deepsteve-core/tools.js')),
    'MCP start_issue must pass autopilot through raw, not !!-ed (#651)');

  // And it is a real setting, so it is persisted and validated like every other one.
  assert.ok(/name: 'issueAutopilot',\s+type: 'boolean'/.test(server),
    'issueAutopilot must be a SETTINGS_SCHEMA entry (#651)');
});

// --- drift guards: one implementation, one reader ---------------------------

test('the wand template has exactly one reader, and it is issue-prompt.js', () => {
  const rendering = /wandPromptTemplate\s*\.replace|wandPromptTemplate\)\.replace/;
  for (const f of ['server.js', 'mods/deepsteve-core/tools.js', 'public/js/app.js']) {
    assert.ok(!rendering.test(read(f)),
      `${f} renders wandPromptTemplate itself — route it through renderIssuePrompt() instead (#642)`);
  }
});

test('the browser does not render the prompt', () => {
  // The picker sends the issue fields and the server renders them. A client-side
  // copy of the template is a second reader that silently disagrees with the
  // server's whenever the user edits it.
  const app = read('public/js/app.js');
  assert.ok(!/\{\{\(\\w\+\)\}\}/.test(app) && !app.includes("replace(/\\{\\{(\\w+)\\}\\}/g"),
    'public/js/app.js still does {{var}} substitution — the server owns that (#642)');
  assert.ok(app.includes("type: 'issue'"),
    'public/js/app.js should send {type:\'issue\'} for the wand start path (#642)');
});

test('both server entry points delegate to startIssueSession', () => {
  const server = read('server.js');
  const tools = read('mods/deepsteve-core/tools.js');
  assert.ok(/function startIssueSession\(/.test(server), 'server.js should define startIssueSession');
  assert.ok(server.includes('startIssueSession({'), '/api/start-issue should call startIssueSession');
  assert.ok(tools.includes('startIssueSession({'), 'MCP start_issue should call startIssueSession');
  // The tell-tale of a reimplementation: building the issue worktree name inline.
  assert.ok(!tools.includes("'github-issue-'"),
    'mods/deepsteve-core/tools.js builds an issue worktree name itself — that belongs to startIssueSession (#642)');
});

test('startIssueSession records the engine that actually spawned', () => {
  // The MCP copy used to derive engineType from getDefaultEngine() *before*
  // spawning, so a tmux spawn that fell back to node-pty recorded a lie.
  const server = read('server.js');
  const fn = server.slice(server.indexOf('function startIssueSession('));
  const body = fn.slice(0, fn.indexOf('\napp.post('));
  assert.ok(/const sessionEngine = spawnSession\(/.test(body),
    'startIssueSession must take its engine from spawnSession\'s return value');
  assert.ok(!/constructor\.name === 'TmuxEngine'/.test(body),
    'engineType must not be guessed from the requested engine');
});

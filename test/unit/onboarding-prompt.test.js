// Unit tests for onboarding-prompt.js and the first-run flow's source guards (#695).
//
// The flow has one failure mode that is invisible until a stranger hits it on a fresh
// machine, which is the worst possible place to find it: the guide session is spawned
// with a `--allowedTools` grant, and it is told to call exactly the tools in that grant.
// If the two lists drift, either a permission dialog appears in front of somebody's
// first thirty seconds with the product, or the session carries a permission nobody
// uses. Neither shows up locally, because a developer's machine has already answered
// every prompt. So the agreement is asserted here, in both directions.
//
// The other half is deployment. create_display_tab reads the tour page off disk, so a
// page that ships in the repo but not in install.sh fails this flow on precisely the
// fresh install it exists to serve — and passes every test on the maintainer's machine,
// where the checkout's copy is right there.
//
// Run: node --test test/unit/onboarding-prompt.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  renderOnboardingPrompt, ONBOARDING_TOOLS, TOUR_PAGE_REL, PROMPT_LIMIT,
} = require('../../onboarding-prompt.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TOUR_PATH = '/Users/example/.deepsteve/public/onboarding-tour.html';
const render = () => renderOnboardingPrompt({ tourPath: TOUR_PATH });

// Every mcp__deepsteve__* name the prompt mentions, deduped.
function toolsNamedIn(text) {
  return [...new Set(text.match(/mcp__deepsteve__[A-Za-z0-9_]+/g) || [])].sort();
}

test('the prompt carries the absolute tour path verbatim', () => {
  const out = render();
  assert.ok(out.includes(TOUR_PATH),
    'the agent must be handed the exact path — resolveHtml() refuses a relative one');
});

test('the prompt names every granted tool, and no ungranted one', () => {
  // Both directions. A granted tool the prompt never mentions is a permission widening
  // that buys nothing; a mentioned tool that was not granted is the permission dialog
  // this whole design exists to avoid.
  const named = toolsNamedIn(render());
  assert.deepStrictEqual(named, [...ONBOARDING_TOOLS].sort(),
    'ONBOARDING_TOOLS and the tools the prompt tells the agent to call must be the same set');
});

test('the grant is small enough and shaped right for --allowedTools', () => {
  // Re-derived from server.js rather than copied, so this fails if either rule moves.
  const server = read('server.js');
  const maxMatch = server.match(/const MAX_ALLOWED_TOOLS = (\d+);/);
  assert.ok(maxMatch, 'expected MAX_ALLOWED_TOOLS in server.js');
  assert.ok(ONBOARDING_TOOLS.length <= Number(maxMatch[1]),
    `ONBOARDING_TOOLS must fit inside MAX_ALLOWED_TOOLS (${maxMatch[1]})`);

  // validateToolName's regex, lifted from server.js so a tightening there is caught here
  // rather than at argv time, where the grant is silently dropped and the failure looks
  // like a permission prompt instead of a bad name.
  const reMatch = server.match(/function validateToolName\(value\) \{[\s\S]*?if \(!(\/\^[^\n]*?\/)\.test\(v\)\) return null;/);
  assert.ok(reMatch, 'expected validateToolName to test a regex in server.js');
  const re = new RegExp(reMatch[1].slice(1, -1));
  for (const name of ONBOARDING_TOOLS) {
    assert.ok(re.test(name), `${name} would be dropped by validateToolName at the argv boundary`);
  }
  assert.strictEqual(new Set(ONBOARDING_TOOLS).size, ONBOARDING_TOOLS.length,
    'ONBOARDING_TOOLS must not repeat a name');
});

test('the prompt stays inside the composer budget', () => {
  const out = render();
  assert.ok(out.length <= PROMPT_LIMIT,
    `onboarding prompt is ${out.length} chars, over the ${PROMPT_LIMIT} budget — this is typed `
    + 'into a TUI composer on a machine whose agent may still be cold');
});

test('the prompt tells the agent to use the file, not to write one', () => {
  const out = render();
  assert.ok(/file_path/.test(out), 'must name file_path — the whole point is not re-emitting the page');
  assert.ok(/do not pass an html argument/i.test(out),
    'must forbid the inline html form: passing both is an isError, and improvising the page '
    + 'defeats shipping a reviewed one');
});

test('server.js spawns the guide from the shared array, never an inline copy', () => {
  const server = read('server.js');
  const fn = server.slice(server.indexOf('function startOnboardingSession('));
  const body = fn.slice(0, fn.indexOf("\napp.post('/api/start-onboarding'"));
  assert.ok(body.length > 0, 'expected startOnboardingSession followed by its endpoint');

  assert.ok(/allowedTools: ONBOARDING_TOOLS/.test(body),
    'the spawn must pass the shared ONBOARDING_TOOLS array (a literal here would drift from the prompt)');
  assert.ok(/allowedTools: ONBOARDING_TOOLS/.test(body.slice(body.indexOf('shells.set('))),
    'the shell entry must record allowedTools, or a restart-resumed guide loses its grant (#612)');
  assert.ok(!/mcp__deepsteve__/.test(body),
    'server.js must not name an onboarding tool inline — onboarding-prompt.js owns that list');

  // The recipe order that every spawn path in this file shares. engineType has to come
  // from what spawnSession RETURNED, since a tmux spawn can fall back to node-pty.
  assert.ok(/const sessionEngine = spawnSession\(/.test(body),
    'must record the engine spawnSession returned, not the one requested');
  assert.ok(body.indexOf('wireShellOutput(id)') < body.indexOf('deliverPromptWhenReady(id'),
    'output must be wired before the prompt is queued');
  assert.ok(/deliverPromptWhenReady\(id, renderOnboardingPrompt\(/.test(body),
    'the prompt must go through deliverPromptWhenReady — never a raw write');
  assert.ok(/spawnCwdProblem\(cwd\)/.test(body),
    'the spawn cwd must be pre-flighted (#632), even one that "cannot" be missing');
});

test('the guide never types into a dialog, and never blocks the user out of one', () => {
  // These three are not defensive style — each replaces an observed failure from a live
  // run against a scratch install, where ~/.deepsteve had never been opened in Claude
  // Code and the guide's first screen was the "Is this a project you trust?" dialog:
  //
  //   1. The shared delivery path gives up on readiness after 30s and submits anyway.
  //      The prompt went into the dialog and the trailing Enter accepted its default
  //      option, "No, exit". The guide killed itself 8s after the prompt was written.
  //   2. `loading: true` sets inputBlocked for up to 60s, so the one person who could
  //      answer the dialog could not type.
  //   3. 30s of ambiguity is an agent-startup budget. What is actually being waited for
  //      is a human reading a security prompt.
  const server = read('server.js');
  const fn = server.slice(server.indexOf('function startOnboardingSession('));
  const body = fn.slice(0, fn.indexOf("\napp.post('/api/start-onboarding'"));
  // The negative assertion below reads code only: the function's own comment explains
  // why `loading: true` is absent, and spelling the thing out is not doing it.
  const codeOnly = body.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  assert.ok(/skipIf:/.test(body) && /computeWaiting\(live\)/.test(body),
    'the onboarding delivery must carry a skipIf that refuses any screen which is not an '
    + 'idle composer — the deadline path would otherwise answer a modal');
  assert.ok(/readyDeadlineMs: ONBOARDING_READY_DEADLINE_MS/.test(body),
    'the onboarding delivery must buy a longer readiness window than the shared default');
  assert.ok(!/loading: true/.test(codeOnly),
    'the guide session must not be marked loading — inputBlocked would stop the user '
    + 'answering the trust dialog that is standing in the way');

  // The longer window has to be worth having: minutes, since it is a person reading.
  const ms = server.match(/const ONBOARDING_READY_DEADLINE_MS = ([^;]+);/);
  assert.ok(ms, 'expected ONBOARDING_READY_DEADLINE_MS in server.js');
  // eslint-disable-next-line no-eval -- a literal arithmetic expression from our own source
  const value = eval(ms[1]);
  assert.ok(value >= 60000, `ONBOARDING_READY_DEADLINE_MS is ${value}ms — too short for a human`);
});

test('the per-prompt readiness window is plumbed through the shared delivery path', () => {
  // The option is only meaningful if BOTH halves honour it: the arm, and the refresh
  // servePendingDelivery does whenever the screen reads as decisively working. Extending
  // by the shared constant there would silently shorten a caller's longer window.
  const server = read('server.js');
  assert.ok(/const readyMs = Number\(options\.readyDeadlineMs\) > 0/.test(server),
    'drainPromptQueue must accept a per-prompt readiness window');
  assert.ok(/pending\.deadline = Date\.now\(\) \+ \(pending\.readyMs \|\| PROMPT_READY_DEADLINE_MS\)/.test(server),
    "servePendingDelivery's 'working' refresh must extend by the window the prompt was armed with");
  // The default is untouched for every other caller.
  assert.ok(/const PROMPT_READY_DEADLINE_MS = parseInt\(process\.env\.DEEPSTEVE_PROMPT_READY_DEADLINE_MS, 10\) \|\| 30000;/.test(server),
    'the shared 30s default must not have moved — only onboarding opts out of it');
});

test('the tour page exists and is shaped for a display-tab iframe', () => {
  const page = read(TOUR_PAGE_REL);
  // The "must not contain" checks run against the page with HTML comments stripped. A
  // comment that spells out one of these constraints is the file documenting the rule
  // for whoever edits it next, which is the opposite of breaking it.
  const code = page.replace(/<!--[\s\S]*?-->/g, '');

  assert.ok(page.trimStart().startsWith('<!DOCTYPE html>'),
    'the server injects a script after <head>; a page without a doctype can land in quirks mode');
  assert.ok(/<head>/.test(page), 'must contain a <head> for the same reason');

  // The sandbox is "allow-scripts allow-forms allow-same-origin" — no allow-modals and
  // no allow-popups — so each of these is silently inert rather than broken-looking.
  for (const inert of ['alert(', 'confirm(', 'prompt(', 'window.open(']) {
    assert.ok(!code.includes(inert),
      `${inert} is inert inside a display-tab iframe (no allow-modals / allow-popups)`);
  }

  // It must render with no network at all: a first run is exactly when a CDN is least
  // affordable, and mod iframes get no theme variables either, so colours are literal.
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(code),
    'the tour page must not load anything external');
  assert.ok(!/var\(--ds-/.test(code),
    'mod and display-tab iframes receive no theme variables — the palette must be literal');

  // A display tab has no window.deepsteve bridge, so a page that tried to drive the UI
  // would fail silently. The agent in the next tab is the interactive half.
  assert.ok(!/window\.deepsteve|deepsteve\.\w+\(/.test(code),
    'display tabs get no window.deepsteve bridge — the page must not try to drive the UI');
});

test('the tour covers every surface the feature promises', () => {
  // The acceptance list from the issue. Spelled as user-facing words, because that is
  // what a reader is scanning for — a rewrite may move these around but must not drop one.
  const page = read(TOUR_PAGE_REL).toLowerCase();
  for (const topic of ['mods', 'project mods', 'projects', 'apps', 'scheduled task', 'skills', 'display tab']) {
    assert.ok(page.includes(topic), `the tour page must cover ${topic}`);
  }
});

test('the tour page ships in every install channel', () => {
  // restart.sh copies public/ wholesale and package.json's files has `public/`, so those
  // two are covered by their own guards. release.sh's public list is hand-maintained.
  assert.ok(read('release.sh').includes(`embed_text "${TOUR_PAGE_REL}"`),
    `release.sh must embed ${TOUR_PAGE_REL}, or a curl install has no page to open`);
});

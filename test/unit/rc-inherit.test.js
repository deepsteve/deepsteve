// `/rc` inheritance reads the parent's CURRENT screen, not its byte history.
//
// The bug this file pins: sessionHasRemoteControl grepped the last 8KB of raw
// scrollback for Claude Code's "/rc active" footer. That tail is a concatenation
// of overlapping repaint frames, so the footer from before the user toggled /rc
// OFF stayed in it until 8KB of fresh output pushed it out — and a tab parked at
// its prompt produces none. Every child opened from that tab then had `/rc` typed
// into it on the strength of a footer the parent no longer had, which is exactly
// the "I keep turning it off and new tabs keep coming up with it on" report.
//
// Runs the REAL server.js source (sessionHasRemoteControl + maybeInheritRemoteControl)
// in a vm against a REAL @xterm/headless emulator fed REAL repaint sequences, so a
// regression to any history-scanning shortcut fails here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { TerminalScreen } = require('../../terminal-screen');

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return serverSource.slice(from, to);
}

const RC_SOURCE = sourceBetween(
  'const RC_FOOTER_ROWS = 8;',
  'function sessionInputState',
);

const PARENT = 'parent01';
const CHILD = 'child001';

// A Claude Code footer, with and without the Remote Control segment.
const FOOTER_RC = '  ⏵⏵ auto mode on (shift+tab to cycle) · /rc active · ← for agents';
const FOOTER_PLAIN = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
// From the sixth session that sees the pill, Claude Code stops spelling it out and
// right-aligns a bare "/rc" on the same footer line instead.
const FOOTER_RC_COLLAPSED = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents' + ' '.repeat(40) + '/rc';
// The same three characters, typed by the user into the composer box.
const COMPOSER_RC = '╭──────────╮\r\n│ > /rc\r\n╰──────────╯';

// Enough transcript above the composer that a scrolled-away footer is out of the
// bottom-rows window the detector reads.
const TRANSCRIPT = Array.from({ length: 30 }, (_, i) => `line ${i} of the conversation transcript`);

/**
 * Feed a session's PTY bytes to a real emulator, exactly as wireShellOutput does,
 * and keep the raw chunks so a test can assert what the OLD tail scan would have
 * seen from the same stream.
 */
async function makeSession(chunks) {
  const screen = new TerminalScreen({ cols: 120, rows: 40 });
  for (const c of chunks) screen.write(c);
  await screen.lines(1); // let xterm finish parsing before any sync read
  return { terminalScreen: screen, rawTail: chunks.join('').slice(-8192) };
}

function makeHarness(parentEntry) {
  const shells = new Map();
  const logs = [];
  const delivered = [];
  if (parentEntry) shells.set(PARENT, parentEntry);
  shells.set(CHILD, { agentType: 'claude' });

  const context = {
    shells,
    settings: { inheritRemoteControl: true, inheritRemoteControlOnFork: true },
    log: (m) => logs.push(m),
    deliverPromptWhenReady: (id, prompt, options = {}) => delivered.push({ id, prompt, options }),
  };
  vm.runInNewContext(`${RC_SOURCE}
result = { sessionHasRemoteControl, rcMarkerOnScreen, maybeInheritRemoteControl, RC_FOOTER_ROWS }`, context);

  return { ...context.result, shells, logs, delivered, settings: context.settings };
}

const inherit = (h) => h.maybeInheritRemoteControl({ newId: CHILD, agentType: 'claude', isFork: false, parentId: PARENT });

// --- the regression ---------------------------------------------------------

test('a parent that toggled /rc off does not hand /rc to a new tab', async () => {
  // The footer is repainted in place: carriage return, erase the row, redraw it
  // without the Remote Control segment. This is what Claude Code does on toggle,
  // and it is why the rendered screen and the byte stream disagree.
  const parent = await makeSession([
    TRANSCRIPT.join('\r\n') + '\r\n',
    FOOTER_RC,
    '\r\x1b[2K' + FOOTER_PLAIN,
  ]);
  const h = makeHarness(parent);

  assert.ok(parent.rawTail.includes('/rc active'),
    'precondition: the raw byte tail still carries the stale footer — that is the trap');
  assert.strictEqual(h.sessionHasRemoteControl(PARENT), false,
    'the screen says Remote Control is off, and the screen is what counts');

  inherit(h);
  assert.deepStrictEqual(h.delivered, [], 'nothing is typed into the child');
});

test('a parent with /rc on right now still hands it down', async () => {
  const parent = await makeSession([TRANSCRIPT.join('\r\n') + '\r\n', FOOTER_RC]);
  const h = makeHarness(parent);

  assert.strictEqual(h.sessionHasRemoteControl(PARENT), true);
  inherit(h);
  assert.deepStrictEqual(h.delivered.map(d => ({ id: d.id, prompt: d.prompt })), [{ id: CHILD, prompt: '/rc' }]);
  assert.ok(h.logs.some((l) => l.includes('[rc-check]') && l.includes('queue /rc')),
    'the decision is logged at spawn');
  h.delivered[0].options.onDeliver();
  assert.ok(h.logs.some((l) => l.includes('[rc-inherit]')),
    '[rc-inherit] marks the keystroke, not the intention');
});

test('a footer scrolled up into the transcript is history, not state', async () => {
  // A tmux reattach replays the pane's history, so an old "/rc active" frame can
  // land in the buffer above the live composer. /rc does not survive --resume, so
  // reading it as "on" made every restored session a permanent inheritance source.
  const parent = await makeSession([
    FOOTER_RC + '\r\n',
    TRANSCRIPT.join('\r\n') + '\r\n',
    FOOTER_PLAIN,
  ]);
  const h = makeHarness(parent);

  assert.ok(parent.rawTail.includes('/rc active'), 'precondition: still in the byte tail');
  assert.strictEqual(h.sessionHasRemoteControl(PARENT), false);
});

// --- the surrounding gates --------------------------------------------------

test('a session with no emulator reads as off rather than falling back to bytes', async () => {
  const h = makeHarness({ scrollback: [FOOTER_RC] });
  assert.strictEqual(h.sessionHasRemoteControl(PARENT), false);
  assert.strictEqual(h.sessionHasRemoteControl('nosuchid'), false);
});

test('the settings gate gets the first word', async () => {
  const parent = await makeSession([FOOTER_RC]);

  const off = makeHarness(parent);
  off.settings.inheritRemoteControl = false;
  inherit(off);
  assert.deepStrictEqual(off.delivered, []);

  // The fork path is gated separately, and by the fork flag.
  const forkOff = makeHarness(parent);
  forkOff.settings.inheritRemoteControlOnFork = false;
  forkOff.maybeInheritRemoteControl({ newId: CHILD, agentType: 'claude', isFork: true, parentId: PARENT });
  assert.deepStrictEqual(forkOff.delivered, []);

  // ...and /rc is a Claude Code feature; no other agent gets it typed at them.
  const other = makeHarness(parent);
  other.maybeInheritRemoteControl({ newId: CHILD, agentType: 'codex', isFork: false, parentId: PARENT });
  assert.deepStrictEqual(other.delivered, []);
});

test('only the bottom rows of the screen are read', () => {
  const h = makeHarness(null);
  assert.ok(h.RC_FOOTER_ROWS > 0 && h.RC_FOOTER_ROWS <= 12,
    'the window must stay a footer read; widening it reintroduces the history scan');
});


// --- the collapsed pill -----------------------------------------------------

test('the collapsed "/rc" pill counts as on', async () => {
  // Matching only "/rc active" made this detector answer "off" for every session on
  // a machine past the five-sighting threshold — silently, because Claude Code turns
  // Remote Control on by itself, so nothing looked missing.
  const parent = await makeSession([TRANSCRIPT.join('\r\n') + '\r\n', FOOTER_RC_COLLAPSED]);
  const h = makeHarness(parent);

  assert.strictEqual(h.rcMarkerOnScreen(PARENT), '/rc', 'the collapsed pill is the marker');
  inherit(h);
  assert.deepStrictEqual(h.delivered.map(d => ({ id: d.id, prompt: d.prompt })), [{ id: CHILD, prompt: '/rc' }]);
});

test('the verbose pill still reports itself as the verbose one', async () => {
  const parent = await makeSession([FOOTER_RC]);
  assert.strictEqual(makeHarness(parent).rcMarkerOnScreen(PARENT), '/rc active',
    'the log has to be able to name which form matched, or the next drift is invisible again');
});

test('a "/rc" the user typed is not a pill', async () => {
  // The collapsed pill is three characters long, so the composer has to be excluded
  // by something other than its text: it carries no footer segment.
  const parent = await makeSession([TRANSCRIPT.join('\r\n') + '\r\n', COMPOSER_RC]);
  const h = makeHarness(parent);

  assert.strictEqual(h.rcMarkerOnScreen(PARENT), null);
  inherit(h);
  assert.deepStrictEqual(h.delivered, [], 'nothing is typed into the child');
});

test('every spawn logs its decision, including the skips', async () => {
  // Deep Steve passes no launch flag for Remote Control — it types `/rc`. This line is
  // the only evidence of whether a session got it from here or from Claude Code.
  const off = await makeSession([FOOTER_PLAIN]);
  const h = makeHarness(off);
  inherit(h);
  const line = h.logs.find((l) => l.includes('[rc-check]'));
  assert.ok(line, 'a skip is logged too');
  assert.match(line, /skip: parent shows no \/rc marker/);
  assert.match(line, /footer=/, 'and it quotes what the detector actually saw');

  const noParent = makeHarness(null);
  noParent.maybeInheritRemoteControl({ newId: CHILD, agentType: 'claude', isFork: false, parentId: null });
  assert.match(noParent.logs.join('\n'), /\[rc-check\].*skip: no live parent session/);
});


// --- the child gets the last word -------------------------------------------

test('the queued /rc is dropped when the child already has its own pill', async () => {
  // The bug this pins, seen live: Claude Code turns Remote Control on by itself, so
  // EVERY parent shows the pill and every new tab inherited a `/rc` — typed into a
  // session that already had Remote Control on. `/rc` is a toggle, so the inherited
  // keystroke was an OFF switch. Three tabs in thirteen minutes on one machine.
  const parent = await makeSession([FOOTER_RC_COLLAPSED]);
  const h = makeHarness(parent);
  h.shells.set(CHILD, { agentType: 'claude', terminalScreen: (await makeSession([FOOTER_RC_COLLAPSED])).terminalScreen });

  inherit(h);
  const queued = h.delivered[0];
  assert.ok(queued, 'it is still queued — the child has drawn nothing at queue time');
  assert.strictEqual(typeof queued.options.skipIf, 'function', 'the decision rides to delivery time');
  assert.strictEqual(queued.options.skipIf(), true, 'and at delivery time it drops the prompt');
});

test('a child with no Remote Control of its own still gets /rc', async () => {
  // The feature has to keep working if the server-driven auto-on default flips off, or
  // the user sets remoteControlAtStartup:false. Inheritance is only redundant while
  // Claude Code is doing it for us.
  const parent = await makeSession([FOOTER_RC_COLLAPSED]);
  const h = makeHarness(parent);
  h.shells.set(CHILD, { agentType: 'claude', terminalScreen: (await makeSession([FOOTER_PLAIN])).terminalScreen });

  inherit(h);
  assert.strictEqual(h.delivered[0].options.skipIf(), false, 'nothing to defer to — type it');
});

test('a child still CONNECTING is left alone', async () => {
  // The pill is "/rc connecting…" before it is "/rc active". Matching only the active
  // form would type `/rc` into a session that was one second from having it on, and
  // the toggle would land as an off switch.
  const CONNECTING = '  ⏵⏵ auto mode on (shift+tab to cycle) · /rc connecting… · ← for agents';
  const parent = await makeSession([FOOTER_RC_COLLAPSED]);
  const h = makeHarness(parent);
  h.shells.set(CHILD, { agentType: 'claude', terminalScreen: (await makeSession([CONNECTING])).terminalScreen });

  inherit(h);
  assert.strictEqual(h.delivered[0].options.skipIf(), true);
});


// --- the chain ---------------------------------------------------------------

test('a session we typed /rc into never becomes a source itself', async () => {
  // The bug: our own keystroke made the child show the pill, which qualified IT as a
  // parent, so its tabs were typed at too, and theirs. One hand-enabled session
  // propagated Remote Control through the whole tree and could not be switched off,
  // because every new tab was seeded from some other tab that still had it. That is
  // what "it types /rc into every one of my sessions" actually was.
  const parent = await makeSession([FOOTER_RC_COLLAPSED]);
  const h = makeHarness(parent);
  h.shells.set(CHILD, { agentType: 'claude', terminalScreen: (await makeSession([FOOTER_PLAIN])).terminalScreen });

  inherit(h);
  assert.strictEqual(h.delivered.length, 1, 'a hand-enabled parent still hands it down');
  h.delivered[0].options.onDeliver();
  assert.strictEqual(h.shells.get(CHILD).rcInherited, true, 'and the child is marked as ours');

  // Now open a grandchild from that child, which by now shows the pill we caused.
  const GRAND = 'grand001';
  h.shells.set(GRAND, { agentType: 'claude' });
  h.shells.get(CHILD).terminalScreen = (await makeSession([FOOTER_RC_COLLAPSED])).terminalScreen;
  h.maybeInheritRemoteControl({ newId: GRAND, agentType: 'claude', isFork: false, parentId: CHILD });

  assert.strictEqual(h.delivered.length, 1, 'the chain stops — nothing queued for the grandchild');
  assert.ok(h.logs.some((l) => l.includes('inheritance does not chain')), 'and it says why');
});

test('provenance is recorded on the keystroke, not on the queueing', async () => {
  // A queued /rc that gets dropped never made the session ours, so a dropped child
  // must still be eligible to pass a hand-enabled parent's Remote Control on.
  const parent = await makeSession([FOOTER_RC_COLLAPSED]);
  const h = makeHarness(parent);
  h.shells.set(CHILD, { agentType: 'claude', terminalScreen: (await makeSession([FOOTER_RC_COLLAPSED])).terminalScreen });

  inherit(h);
  assert.strictEqual(h.delivered[0].options.skipIf(), true, 'it will be dropped');
  assert.notStrictEqual(h.shells.get(CHILD).rcInherited, true,
    'a prompt that never went out must not mark the session as ours');
});

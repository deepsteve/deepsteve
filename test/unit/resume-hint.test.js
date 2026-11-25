// Unit tests for the exit-time resume hint (resume-hint.js) and the server.js detector that reads
// it off a tab's output (observeResumeHint).
//
// The bug these pin: the detector believed any `claude --resume <id>` in a tab's output, and a
// tab's output is also where its agent's tool results are drawn. A `ps` listing carrying another
// tab's argv, and a meta_type screen_tail carrying another pane's command line, each re-pointed
// the tab that displayed them at that other tab's conversation. Meanwhile the hint Claude Code
// really prints (with launch flags, or the worktree `-w … -r` form) did not match at all.
//
// Every resume line below is assembled at run time. A literal one in this file would be drawn on
// the screen of whichever agent tab opens it, and the daemon running the old matcher would
// re-point that tab.
//
// Run: node --test test/unit/resume-hint.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { resumeHintId, createResumeHintScanner } = require('../../resume-hint');

const OURS = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';
const OTHER = '9f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19';
const AFTER_CLEAR = '1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d';

const words = (...w) => w.join(' ');
const HEADER = 'Resume this session with:';
const DIM = '\x1b[2m';
const UNDIM = '\x1b[22m';
// What `printResumeHint` writes: a dim block, a blank line, the header, the command, a newline.
const exitHint = (command) => `${DIM}\n${HEADER}\n${command}\n${UNDIM}`;

// Claude Code 2.1.332's command shapes.
const SHAPES = {
  'bare': (id) => words('claude', '--resume', id),
  'launch flags': (id) => words('claude', '--permission-mode', 'auto', '--resume', id),
  'worktree, long flags': (id) => words('claude', '--permission-mode', 'auto', '--worktree', '"issue-812"', '--resume', id),
  'worktree, short flags': (id) => words('claude', '--permission-mode', 'auto', '-w', '"issue-812"', '-r', id),
  'environment prefix': (id) => words('CLAUDE_CODE_SOMETHING=1', 'claude', '--resume', id),
  'launcher program': (id) => words('my-claude', '--resume', id),
};

// What an agent's tool output looks like when Claude Code draws it, each carrying OTHER.
const TOOL_OUTPUT = {
  'a ps listing with another tab\'s argv':
    `⏺ Bash(ps -axo pid,command)\n  ⎿  12345 ${words('claude', '--resume', OTHER, '--permission-mode', 'auto')}\n     12399 zsh -l\n`,
  'a meta_type screen_tail with another pane\'s command line':
    `⏺ deepsteve - meta_type (MCP)(session_id: "a1b2c3d4", text: "ls")\n  ⎿  {"ok":true,"screen_tail":"% ${words('claude', '--resume', OTHER)}\\n% ls\\n"}\n`,
  'a bare resume command with no header':
    `${words('claude', '--resume', OTHER)}\n`,
  'a tmux-drawn ps row (lines placed by cursor moves)':
    `\x1b[12;3H⎿  12345 \x1b[12;12H${words('claude', '--resume', OTHER)}\x1b[13;1H`,
};

// The daemon's own escape stripper, so fixtures go through exactly what the PTY handler does.
const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return serverSource.slice(from, to);
}
const stripEscapeSequences = vm.runInNewContext(
  `${sourceBetween('function stripEscapeSequences', 'const SCREEN_TAIL_BYTES')}; stripEscapeSequences`,
);

test('every shape of the hint Claude Code prints on exit yields its id', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    assert.strictEqual(resumeHintId(stripEscapeSequences(exitHint(shape(OURS)))), OURS, name);
  }
});

test('the bytes a tmux attach client received when Claude Code 2.1.332 exited are read', () => {
  // Captured 2026-11-24: claude on a private tmux socket, a bash-mode command (so a transcript
  // exists and the hint is printed), then /exit; recorded from the attach client's PTY, which is
  // what the daemon reads. Only the id is substituted.
  const tail = `\x1b[K\r\n\x1b[K\x1b[?12l\x1b[?25h\x1b[H\x1b[?25l\x1b[?12l\x1b[?25h\r\n${DIM}${HEADER}\r\n` +
    `${SHAPES.bare(OURS)}\r\n\x1b(B\x1b[m\x1b[1;40r\x1b(B\x1b[m\x1b[?1l\x1b>\x1b[H\x1b[2J\x1b[?12l\x1b[?25h` +
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l\x1b[?2004l\x1b[?7727l\x1b[?1004l\x1b[?1049l\x1b[23;0;0t\x1b[?2031l[exited]\r\n';
  assert.strictEqual(resumeHintId(stripEscapeSequences(tail)), OURS);
});

test('a hint whose next line was placed by a cursor move (tmux) is still read', () => {
  const drawn = `\x1b[40;1H${HEADER}\x1b[41;1H${SHAPES['worktree, short flags'](OURS)}\x1b[42;1H`;
  assert.strictEqual(resumeHintId(stripEscapeSequences(drawn)), OURS);
});

test('tool output that carries another session\'s resume command yields nothing', () => {
  for (const [name, text] of Object.entries(TOOL_OUTPUT)) {
    assert.strictEqual(resumeHintId(stripEscapeSequences(text)), null, name);
  }
});

test('hints that name no local conversation yield nothing', () => {
  assert.strictEqual(resumeHintId(exitHint(words('claude', '--cloud', OURS))), null, 'a cloud session');
  assert.strictEqual(resumeHintId(exitHint(words('claude', '--resume'))), null, 'no id printed');
  assert.strictEqual(resumeHintId(exitHint(words('claude', '--resume', `${OURS}0`))), null, 'not a whole id');
});

test('the scanner reads a hint cut across chunks, once', () => {
  const plain = stripEscapeSequences(exitHint(SHAPES['launch flags'](OURS)));
  for (let cut = 1; cut < plain.length; cut++) {
    const s = createResumeHintScanner();
    const got = [s.push(plain.slice(0, cut)), s.push(plain.slice(cut))].filter(Boolean);
    assert.deepStrictEqual(got, [OURS], `cut at ${cut}`);
  }
  const s = createResumeHintScanner();
  assert.strictEqual(s.push(plain), OURS);
  assert.strictEqual(s.push('\n'), null, 'the same hint is not reported again');
});

test('the scanner\'s carry is bounded', () => {
  const s = createResumeHintScanner();
  assert.strictEqual(s.push(HEADER), null);
  assert.strictEqual(s.push('x'.repeat(5000)), null);
  assert.strictEqual(s.push(`\n${SHAPES.bare(OURS)}\n`), null, 'a header 5000 characters back is forgotten');
});

// --- server.js: observeResumeHint feeding adoptClaudeSession -------------------------------

function harness() {
  const shells = new Map();
  const logs = [];
  const context = {
    shells,
    savedState: {},
    shuttingDown: false,
    log: (m) => logs.push(m),
    traceSession: () => {},
    saveState: () => {},
    recordRecentSession: () => {},
    loadStateFile: () => ({}),
    writeStateFile: () => {},
    createResumeHintScanner,
    stripEscapeSequences,
    console,
  };
  vm.runInNewContext(
    `${sourceBetween('function claudeSessionOwnedElsewhere', 'function watchClaudeSessionDir')}
     result = { observeResumeHint };`,
    context,
  );
  const add = (id, over = {}) => {
    const e = { claudeSessionId: OURS, planMode: false, cwd: '/repo', ...over };
    shells.set(id, e);
    return e;
  };
  // What the PTY handler does with a chunk: strip it, then hand it to the detector.
  const output = (id, data) => context.result.observeResumeHint(shells.get(id), id, stripEscapeSequences(data));
  return { add, output, logs, shells };
}

test('a tool-output rendering of another session\'s resume line does not change claudeSessionId', () => {
  for (const [name, text] of Object.entries(TOOL_OUTPUT)) {
    for (const record of [OURS, undefined]) {
      const h = harness();
      const e = h.add('f41595de', { claudeProcessSessionId: record });
      h.output('f41595de', text);
      assert.strictEqual(e.claudeSessionId, OURS, `${name} (process record ${record ? 'seen' : 'never seen'})`);
    }
  }
});

test('a whole exit hint drawn from another screen is refused once the process record has named the tab', () => {
  const h = harness();
  const e = h.add('f41595de', { claudeProcessSessionId: OURS });
  // An agent printing another tab's screen with that tab's exit hint still on it.
  h.output('f41595de', `⏺ read_session_screen\n  ⎿  ${HEADER}\n     ${SHAPES.bare(OTHER)}\n`);
  assert.strictEqual(e.claudeSessionId, OURS);
  assert.ok(h.logs.some((m) => m.includes(`ignoring resume hint ${OTHER}`)), 'the refusal is logged');
});

test('the exit hint moves a tab its process record has never named', () => {
  const h = harness();
  const e = h.add('f41595de', { planMode: true });
  h.output('f41595de', exitHint(SHAPES['worktree, short flags'](AFTER_CLEAR)));
  assert.strictEqual(e.claudeSessionId, AFTER_CLEAR);
  assert.strictEqual(e.planMode, false, 'adoptClaudeSession ran, with its side effects');
  assert.ok(h.logs.some((m) => m.includes('(pty-output)')));
});

test('the exit hint still honours the #497 ownership guard', () => {
  const h = harness();
  h.add('child', { claudeSessionId: OTHER });
  const e = h.add('f41595de');
  h.output('f41595de', exitHint(SHAPES.bare(OTHER)));
  assert.strictEqual(e.claudeSessionId, OURS);
});

test('a hint naming the conversation the tab is already on is silent', () => {
  const h = harness();
  h.add('f41595de', { claudeProcessSessionId: OURS });
  h.output('f41595de', exitHint(SHAPES['launch flags'](OURS)));
  assert.deepStrictEqual(h.logs, []);
});

test('server.js reads the hint only through observeResumeHint, and remembers the process record', () => {
  assert.match(serverSource, /if \(config\.emitsBel\) \{[^}]*observeResumeHint\(e, id, plain\);/);
  // The old matcher, a resume command anywhere in the output, must not come back.
  assert.doesNotMatch(serverSource, /plain\.match\(\/claude --resume/);
  assert.match(serverSource, /onConversation: \(id\) => \{[^}]*e\.claudeProcessSessionId = id;[^}]*adoptClaudeSession\(shellId, id, 'claude-process'\);/);
});

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
  ISSUE_COMPLETE_INSTRUCTION, WORKFLOW_STAGES,
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

test('a body inside the limit is delivered whole and unmarked', () => {
  // #656: the limit was 2000, so nearly every real issue arrived clipped mid-word.
  const body = 'x'.repeat(ISSUE_BODY_LIMIT);
  const out = renderBody('{{body}}', { number: 1, title: 't', body });
  assert.equal(out, body);
  assert.ok(!out.includes('truncated'));
});

test('a clipped body says so, and names the command that gets the rest', () => {
  // The clip used to be silent: the agent acted on half an issue with no way to know.
  const long = 'x'.repeat(ISSUE_BODY_LIMIT + 500);
  const out = renderBody('{{body}}', { number: 656, title: 't', body: long });
  assert.ok(out.startsWith('x'.repeat(ISSUE_BODY_LIMIT)), 'the clip itself is unchanged');
  assert.ok(out.includes(`truncated at ${ISSUE_BODY_LIMIT} characters`), out.slice(-200));
  assert.ok(out.includes('gh issue view 656'), out.slice(-200));
});

test('the clip marker survives a body with no usable issue number', () => {
  const long = 'x'.repeat(ISSUE_BODY_LIMIT + 1);
  const out = renderBody('{{body}}', { number: undefined, title: 't', body: long });
  assert.ok(out.includes('gh issue view`'), 'no number, no dangling argument');
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
  // Same argument, same failure mode, for the workflow stages (#668).
  assert.ok(!template.includes('workshop'),
    'WAND_DEFAULT_TEMPLATE must not carry the workflow stages — append them in renderIssuePrompt (#668)');
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

// --- workflow stages (#668) -------------------------------------------------

test('the stages land after the completion instruction, at the very end', () => {
  // Stage 4 already ends in issue_complete, so putting the stages last means the
  // completion instruction above reads as the rule the workflow then refines, and
  // nothing is repeated after the list.
  const out = renderIssuePrompt('BODY', { number: 1, title: 't' }, { stages: 'STAGES' });
  assert.equal(out, `BODY\n\n${ISSUE_COMPLETE_INSTRUCTION}\n\nSTAGES`);
});

test('no stages renders byte-for-byte what it rendered before (#668)', () => {
  // issueStagesEnabled is default-off, so this is the path nearly every install takes
  // and the third argument must be invisible on it.
  const fields = { number: 668, title: 'stages off', body: 'b', labels: 'x', url: 'u' };
  const base = renderIssuePrompt(TEMPLATE, fields);
  for (const opts of [undefined, {}, { stages: null }, { stages: '' }, { stages: false }]) {
    assert.equal(renderIssuePrompt(TEMPLATE, fields, opts), base,
      `stages=${JSON.stringify(opts)} must not change the prompt (#668)`);
  }
});

test('a user-edited template can neither drop the stages nor reorder them', () => {
  // Same guarantee the completion instruction has: they are appended AFTER
  // substitution, so no template can lose them.
  for (const template of ['', 'no variables at all', TEMPLATE, '{{body}}']) {
    const out = renderIssuePrompt(template, { number: 1, title: 't' }, { stages: WORKFLOW_STAGES });
    assert.ok(out.endsWith(WORKFLOW_STAGES),
      `template ${JSON.stringify(template)} lost the workflow stages`);
    assert.ok(out.includes(ISSUE_COMPLETE_INSTRUCTION),
      'the completion instruction must still be delivered alongside them');
  }
});

test('the shipped stage text stays cheap enough to paste on every issue', () => {
  // This is typed into a TUI composer on every issue start, on top of a body already
  // clipped at ISSUE_BODY_LIMIT. A budget is the only thing that stops it growing a
  // paragraph per release until it is bigger than the issue it is about.
  assert.ok(WORKFLOW_STAGES.length <= 900,
    `the stages are ${WORKFLOW_STAGES.length} characters — keep them under 900 (#668)`);
});

test('the stage text names only tools a mod actually registers (#668)', () => {
  // The stages point an agent at tools BY NAME. Naming one that does not exist is the
  // failure issue_complete already guards against for the merge skill: the agent gets
  // "no such tool" and improvises. PENDING held share_result while #668 shipped ahead of
  // it; #669 landed the tool, so the set is empty and every name is now checked for real.
  const PENDING = new Set();
  const sources = ['mods/workshop/tools.js', 'mods/deepsteve-core/tools.js'].map(read);
  const named = [...new Set([...WORKFLOW_STAGES.matchAll(
    /(?:mcp__deepsteve__)?\b(workshop_\w+|issue_complete|share_result)\b/g)].map(m => m[1]))];
  assert.ok(named.length >= 3, 'the stages should name the tools they want called');
  for (const name of named) {
    if (PENDING.has(name)) continue;
    // Tool keys sit at exactly four-space indentation in both files.
    assert.ok(sources.some(s => new RegExp(`^ {4}${name}: \\{`, 'm').test(s)),
      `the workflow stages name "${name}", which no mod registers (#668)`);
  }
});

// Two of the three renderIssuePrompt call sites are one-liners and one spans seven
// lines, so the "read to the next `});`" terminator the #653 guard gets away with would
// slice the wrong text here. Balance parens from the call's own opening one instead.
function callSlice(src, at) {
  let depth = 0;
  for (let i = src.indexOf('(', at); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced renderIssuePrompt( call at offset ${at}`);
}

test('every renderIssuePrompt call site decides about stages (#668)', () => {
  // Miss one and that surface silently starts a DIFFERENT KIND of session from the
  // other two — the picker gets no stages while MCP and HTTP do. That is the drift #642
  // collapsed, and nothing in the running system would show it: the prompt is delivered,
  // the session works, the reporting just never happens.
  const server = read('server.js');
  let from = 0, sites = 0;
  for (;;) {
    // The require at the top of server.js names it without a paren, so it is not matched.
    const at = server.indexOf('renderIssuePrompt(', from);
    if (at === -1) break;
    from = at + 1;
    sites++;
    const call = callSlice(server, at);
    assert.match(call, /\bstages\b/,
      `a renderIssuePrompt call site does not pass stages (#668):\n${call}`);
    // Same argument for `resume` (#689): a surface that forgets it is a surface where
    // an agent walks into someone else's commits believing the worktree is its own.
    assert.match(call, /\bresume\b/,
      `a renderIssuePrompt call site does not pass resume (#689):\n${call}`);
  }
  // The COUNT matters as much as the per-site check: a refactor that inlined a site to
  // zero would pass the loop vacuously.
  assert.equal(sites, 3,
    `expected the 3 known renderIssuePrompt call sites in server.js, found ${sites} — `
    + 'a new issue-start surface has to decide about stages too (#668)');
});

test('the stages setting is read in exactly one place (#668)', () => {
  // startIssueSession renders TWICE — inline body now, gh-fetch body seconds later in a
  // .then() — and logs the decision once, at spawn. Three live reads is three chances
  // for a Settings flip mid-flight to make the log describe a prompt nobody got.
  const server = read('server.js');
  assert.equal(server.split('settings.issueStagesEnabled').length - 1, 1,
    'settings.issueStagesEnabled must be read once, in issueStagesText() (#668)');
});

test('issueStagesEnabled is a server setting, and it is off by default (#668)', () => {
  // A mod's own settings are per-browser localStorage and never reach the server; this
  // decision is made server-side at spawn time, so it needs a real schema entry — the
  // same reason projectModsEnabled and scheduledTasksEnabled exist.
  assert.ok(/name: 'issueStagesEnabled',\s+type: 'boolean',\s+default: false/.test(read('server.js')),
    'issueStagesEnabled must be a SETTINGS_SCHEMA entry defaulting to false (#668)');
});

test('the [issue] start line says whether the session got the stages (#668)', () => {
  // "Started with stages" and "started without" are different runs, and the log is what
  // tells them apart afterwards.
  const server = read('server.js');
  const fn = server.slice(server.indexOf('function logIssueStart('));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /stages=/,
    'logIssueStart must report the stage decision on its one line');

  let from = 0, calls = 0;
  for (;;) {
    const at = server.indexOf('logIssueStart({', from);
    if (at === -1) break;
    from = at + 1;
    if (server.slice(0, at).endsWith('function ')) continue; // the declaration, not a call
    calls++;
    assert.match(server.slice(at, server.indexOf('});', at)), /\bstages:/,
      'a logIssueStart call site omits stages — its line would read stages=unknown (#668)');
  }
  assert.equal(calls, 2, `expected the 2 known logIssueStart call sites, found ${calls}`);
});

test('the Settings checkbox actually reaches the server (#668)', () => {
  // applySettingsFromBody skips any key absent from the body, so a checkbox that is
  // rendered and wired but left out of settingsPayload is a switch that silently does
  // nothing — no error, no log line. That is the likeliest failure in this change.
  const app = read('public/js/app.js');
  assert.ok(app.includes('id="wand-issue-stages"'), 'the GitHub tab needs the checkbox (#668)');
  const payload = app.slice(app.indexOf('const settingsPayload = {'));
  assert.match(payload.slice(0, payload.indexOf('};')), /\bissueStagesEnabled\b/,
    'issueStagesEnabled must be in settingsPayload or the checkbox does nothing (#668)');
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

test('every startIssueSession caller names its start path (#653)', () => {
  // The `[issue] #N:` line reports which surface started the session, and `source` is a
  // parameter precisely so it cannot be guessed. A caller that omits it silently logs
  // `unknown`, which is the same blind spot #642 left behind — one line for all paths.
  for (const f of ['server.js', 'mods/deepsteve-core/tools.js']) {
    const src = read(f);
    let from = 0, calls = 0;
    for (;;) {
      const at = src.indexOf('startIssueSession({', from);
      if (at === -1) break;
      from = at + 1;
      // `function startIssueSession({ ... })` matches too — it is the declaration, not a call.
      if (src.slice(0, at).endsWith('function ')) continue;
      calls++;
      const call = src.slice(at, src.indexOf('});', at));
      assert.ok(/\bsource:\s*'[a-z-]+'/.test(call),
        `${f}: a startIssueSession call site does not pass a source — it would log source=unknown (#653)`);
    }
    assert.ok(calls > 0, `${f} should contain a startIssueSession call site`);
  }
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

// --- resuming an existing worktree (#689) -----------------------------------

const { resumePromptText, humanAge, RESUME_TEXT_LIMIT } = require('../../issue-prompt.js');

const RESUMED = {
  name: 'x', path: '/repo/.claude/worktrees/x',
  branch: 'worktree-x-689', base: 'main',
  commits: 3, behind: 0, dirty: 12, head: 'a4b9061',
  lastTouched: Date.now() - 2 * 3600 * 1000,
};

test('the resume block lands between the issue and the completion instruction', () => {
  // It is context about the task, not a rule about finishing, so it reads before the
  // two tails. Putting it after them would separate stage 4's "...then issue_complete"
  // from the instruction it refines, and would bury the one fact that has to change the
  // agent's FIRST move rather than its last.
  const out = renderIssuePrompt('BODY', { number: 1, title: 't' }, { resume: 'RESUMING', stages: 'STAGES' });
  assert.equal(out, `BODY\n\nRESUMING\n\n${ISSUE_COMPLETE_INSTRUCTION}\n\nSTAGES`);
});

test('no resume renders byte-for-byte what it rendered before (#689)', () => {
  // Nearly every start is a fresh one, so the new argument must be invisible on it.
  const fields = { number: 689, title: 'resume off', body: 'b', labels: 'x', url: 'u' };
  for (const stages of [null, 'STAGES']) {
    const base = renderIssuePrompt(TEMPLATE, fields, { stages });
    for (const opts of [{ stages }, { stages, resume: null }, { stages, resume: '' }, { stages, resume: false }]) {
      assert.equal(renderIssuePrompt(TEMPLATE, fields, opts), base,
        `resume=${JSON.stringify(opts.resume)} must not change the prompt (#689)`);
    }
  }
});

test('a user-edited template can neither drop the resume block nor reorder it', () => {
  // Same guarantee the other two tails have: appended AFTER substitution.
  for (const template of ['', 'no variables at all', TEMPLATE, '{{body}}']) {
    const out = renderIssuePrompt(template, { number: 1, title: 't' }, { resume: 'RESUMING' });
    assert.ok(out.includes('RESUMING'), `template ${JSON.stringify(template)} lost the resume block`);
    assert.ok(out.indexOf('RESUMING') < out.indexOf(ISSUE_COMPLETE_INSTRUCTION),
      'the resume block must come before the completion instruction');
  }
});

test('the resume text names the branch and base it was READ from', () => {
  // A Claude session's branch is `worktree-github-issue-N` and an ensureWorktree one's
  // is `github-issue-N`. An agent handed the wrong name runs a rev-range against
  // nothing and concludes there was no prior work.
  const text = resumePromptText(RESUMED);
  assert.match(text, /RESUMING/);
  assert.ok(text.includes('worktree-x-689'), text);
  assert.ok(text.includes('3 commits ahead of `main`'), text);
  assert.ok(text.includes('12 uncommitted files'), text);
  assert.ok(text.includes('main..HEAD'), text);
});

test('an empty leftover worktree gets its own text, not a resume', () => {
  // The case that will dominate: a merged issue leaves its worktree behind, so pointing
  // an agent at a rev-range on a branch with nothing on it is a worse first turn than
  // the silence this feature replaces.
  const text = resumePromptText({ ...RESUMED, commits: 0, dirty: 0 });
  assert.ok(!text.includes('RESUMING'), text);
  assert.ok(text.includes('0 commits ahead'), text);
  assert.ok(text.includes('no uncommitted changes'), text);
});

test('an uncounted branch omits the count rather than claiming zero', () => {
  // "We could not ask git" and "there is nothing on the branch" are different answers
  // and must not look alike — they lead to different first moves.
  const text = resumePromptText({ ...RESUMED, commits: undefined, head: undefined });
  assert.ok(!/\bcommits? ahead\b/.test(text), text);
  assert.match(text, /RESUMING/, 'unknown commits with 12 dirty files is still prior work');
});

test('another live session on the worktree is called out', () => {
  // Two agents editing one checkout is the state a silent resume is most likely to
  // create and least able to recover from.
  const alone = resumePromptText(RESUMED, []);
  const shared = resumePromptText(RESUMED, [{ id: 'abc', name: '#689 thing' }]);
  assert.ok(!alone.includes('Another deepsteve session'), alone);
  assert.ok(shared.includes('Another deepsteve session'), shared);
});

test('no status renders nothing at all', () => {
  assert.equal(resumePromptText(null), null);
  assert.equal(resumePromptText(undefined), null);
});

test('the resume text stays cheap enough to paste on every resumed start', () => {
  // Typed into a TUI composer on top of a body already clipped at ISSUE_BODY_LIMIT.
  // A budget is the only thing that stops it growing a paragraph per release.
  const worst = resumePromptText(
    { ...RESUMED, branch: 'worktree-github-issue-689', base: 'main', commits: 1234, dirty: 5678 },
    [{ id: 'a', name: 'n' }],
  );
  assert.ok(worst.length <= RESUME_TEXT_LIMIT,
    `the resume block is ${worst.length} characters — keep it under ${RESUME_TEXT_LIMIT} (#689)`);
  assert.ok(resumePromptText({ ...RESUMED, commits: 0, dirty: 0 }).length <= RESUME_TEXT_LIMIT);
});

test('ages are spelled out, floored, and never negative', () => {
  const now = 1000000000000;
  assert.equal(humanAge(now - 30 * 1000, now), 'just now');
  assert.equal(humanAge(now - 60 * 1000, now), '1 minute ago');
  // Floored: 90 minutes is "1 hour ago", not "2 hours ago". This number tells an agent
  // how stale the work it inherited is, so overstating the gap is the wrong error.
  assert.equal(humanAge(now - 90 * 60 * 1000, now), '1 hour ago');
  assert.equal(humanAge(now - 6 * 86400 * 1000, now), '6 days ago');
  // A clock that moved backwards must not produce "-3 minutes ago" in a prompt.
  assert.equal(humanAge(now + 60000, now), 'just now');
});

test('the resume decision is made in exactly one place on the server (#689)', () => {
  // Same rule as issueStagesEnabled: renderIssuePrompt takes TEXT, so one function
  // decides what a resumed session is told and every surface goes through it.
  const server = read('server.js');
  assert.equal(server.split('resumePromptText(').length - 1, 1,
    'resumePromptText must have one reader in server.js, issueResumeText() (#689)');
});

test('the resumed snapshot is persisted, not just held in memory (#689)', () => {
  // It records which commits were already on the branch when this session started, it
  // cannot be recomputed later, and issue_complete reads it at the far end of the
  // session — so a restart in between must not erase it. Same argument as autopilot's,
  // and the same two hand-maintained places.
  const server = read('server.js');
  const ser = server.slice(server.indexOf('function serializeShellEntry('));
  assert.ok(/resumedWorktree: entry\.resumedWorktree \|\| null/.test(ser.slice(0, ser.indexOf('\n}'))),
    'serializeShellEntry must carry resumedWorktree (#689)');
  assert.ok(/resumedWorktree: restored\.resumedWorktree \|\| null/.test(server),
    'the WS restore path must restore resumedWorktree onto the live entry (#689)');
});

test('the worktree is read BEFORE anything can create it (#689)', () => {
  // The race this guards: a Claude session creates its own worktree directory seconds
  // after spawn, and the picker's prompt is delivered later still — so a stat taken at
  // prompt time reports "resuming" for a worktree this very session just made.
  const server = read('server.js');

  const fn = server.slice(server.indexOf('function startIssueSession('));
  const body = fn.slice(0, fn.indexOf('\napp.post('));
  assert.ok(body.indexOf('worktreeExists(cwd, worktree)') > 0
    && body.indexOf('worktreeExists(cwd, worktree)') < body.indexOf('ensureWorktree(cwd, worktree)'),
    'startIssueSession must read the worktree before ensureWorktree can create it (#689)');

  // The picker's path latches a boolean in the create block and does the expensive half
  // in the `issue` message handler.
  assert.ok(/const worktreeExisted = !!worktree && worktreeExists\(cwd, worktree\);/.test(server),
    'the WS create block must latch worktreeExisted (#689)');
  assert.ok(server.indexOf('const worktreeExisted =') < server.indexOf('worktreeCwd = ensureWorktree(cwd, worktree)'),
    'the latch must be read before ensureWorktree in the WS create block (#689)');
  assert.ok(/entry\.worktreeExisted && entry\.worktree/.test(server),
    'the issue handler must gate its work on the latch (#689)');
});

test('the browser never computes a fact about a worktree (#689)', () => {
  // It may NAME one — app.js has always minted the `github-issue-<n>` string, and a
  // comment there legitimately mentions the worktrees path — but every fact it SHOWS
  // comes off the server's row, and "Start fresh" is a request rather than a name.
  // Deliberately narrow: these are the strings that would mean git ran, or was
  // reimplemented, in the client, which is the thing that must not happen.
  const app = read('public/js/app.js');
  for (const forbidden of ['rev-list', 'for-each-ref', '--porcelain', 'ahead-behind']) {
    assert.ok(!app.includes(forbidden),
      `public/js/app.js must not contain ${forbidden} — the server owns worktree facts (#689)`);
  }
  // The positive half: the fresh-start choice leaves as a boolean, never as a name the
  // browser computed. A client-minted `<name>-2` could be taken by the time it arrives.
  assert.ok(/fresh: opts\.fresh/.test(app) && !/-2['"`]/.test(app.slice(app.indexOf('async function startIssue'), app.indexOf('async function fetchAndRender'))),
    'the picker must send fresh as a request, not a minted worktree name (#689)');
});

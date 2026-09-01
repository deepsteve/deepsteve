/**
 * Pure rendering helpers for GitHub-issue sessions (#642).
 *
 * Every entry point that starts an issue session used to recompute these three
 * values itself — the magic-wand picker (in the *browser*, from a copy of the
 * template fetched over /api/settings), POST /api/start-issue, and the MCP
 * start_issue tool. That is how one feature ended up with three implementations
 * that had quietly drifted apart. Keeping the derivations pure and here gives
 * `wandPromptTemplate` exactly one reader and makes the drift surface testable
 * without a daemon.
 *
 * Orchestration (worktree, spawn, prompt delivery) lives in server.js's
 * startIssueSession, which is the single caller of these on the spawn path.
 */

// Issue bodies go into a terminal composer, so they have always been clipped — but
// until #656 they were clipped SILENTLY, at 2000 characters, mid-word. Nearly every
// issue prompt in the daemon log was ~2450 characters, i.e. the template plus a body
// cut off at exactly 2000, and the agent was never told any of it was missing. The
// limit is now 8000, which covers essentially every real issue body, and a clip
// leaves a marker naming the command that fetches the rest.
//
// It is not unlimited: this text is typed into a TUI composer, and a pathological
// 100KB issue should not become a 100KB paste.
const ISSUE_BODY_LIMIT = 8000;

// Appended to the BODY (not the template) when the clip actually bites, so the agent
// knows to go and get the rest rather than acting on half an issue.
function clipBody(body, number) {
  const s = String(body);
  if (s.length <= ISSUE_BODY_LIMIT) return s;
  const ref = Number.isFinite(Number(number)) ? ` ${Number(number)}` : '';
  return `${s.slice(0, ISSUE_BODY_LIMIT)}\n\n[Issue body truncated at ${ISSUE_BODY_LIMIT} characters. `
    + `Run \`gh issue view${ref}\` for the full description.]`;
}

// Appended to EVERY issue prompt, in both autopilot states (#643). The flag is a
// server-side session variable that `issue_complete` reads at completion time; it
// changes what the tool ANSWERS, never whether the instruction was delivered. That
// is the whole design: nothing is queued at toggle time, so nothing has to be
// cancelled, and turning autopilot off stays meaningful right up until the call.
//
// It lives here rather than in WAND_DEFAULT_TEMPLATE because the settings modal
// POSTs wandPromptTemplate on every save — any install where the user has ever hit
// Save has the old default materialized, so a token added to the shipped default
// would silently never appear there.
const ISSUE_COMPLETE_INSTRUCTION =
  'When the work is done, call the `mcp__deepsteve__issue_complete` tool. '
  + 'It will tell you whether to merge this session or stop and leave the tab for review.';

// The workflow stages (#668). Appended only when the CALLER passes them: the toggle
// (`issueStagesEnabled`) is read in server.js, so this module stays pure and testable
// without a daemon — and so #669 can vary stage 4 on whether the tool it names is
// actually registered, which only the daemon can answer.
//
// Tool names carry the mcp__deepsteve__ prefix on first mention and go bare after,
// the way issue_complete's own degradation text does. This is typed into a TUI composer
// on EVERY issue start, on top of a body already clipped at ISSUE_BODY_LIMIT — keep it
// under ~900 characters and do not explain what the tools do; their descriptions do
// that at no prompt cost.
//
// Stage 4 names `share_result`, which #669 builds. That is why `issueStagesEnabled`
// ships OFF, and why the "names only registered tools" test carries an exemption.
const WORKFLOW_STAGES = [
  'Workflow for this issue — report as you go, so this work can be judged from the Workshop inbox without opening this tab:',
  '1. Orient. Before writing code, post one paragraph with `mcp__deepsteve__workshop_brief`: what you understand the task to be, and how you mean to approach it.',
  "2. Ask, don't guess. A decision you genuinely cannot make alone goes to `mcp__deepsteve__workshop_ask` with options — not into a silent assumption, and not into a comment in the code.",
  '3. Flag surprises when you find them. Something that changes the shape of the work — the bug is not where the issue says it is, the fix is three times bigger than it looked — is another `workshop_brief` at the moment you find it, not a line in the final summary.',
  '4. Justify before you merge. Call `share_result` with a writeup and evidence, then `issue_complete`.',
].join('\n');

// The resume block's budget (#689). Same argument as the stages budget below it: this
// is typed into a TUI composer on every resumed issue start, on top of a body already
// clipped at ISSUE_BODY_LIMIT. Smaller than the stages cap because it is per-start
// context rather than a standing workflow.
const RESUME_TEXT_LIMIT = 700;

// "3 minutes"/"2 hours"/"6 days" — spelled out, unlike the client's terse `2h ago`,
// because an agent reads this inside a prompt rather than scanning it in a tab strip.
// The buckets otherwise mirror relativeTime() in app.js, so the badge and the prompt
// never disagree about how old the same worktree is.
//
// Floor, not round: "2 hours ago" for something touched 90 minutes back overstates the
// gap, and this number exists to tell an agent how stale the work it inherited is.
function humanAge(ts, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/**
 * What a resumed issue session is told about the worktree it landed in (#689).
 *
 * `status` is worktree-status.js's shape; `liveSessions` is whatever else is open in
 * that directory. Returns null for no status, so a fresh start renders byte-for-byte
 * what it rendered before this existed.
 *
 * Two variants, and the empty one is not a rounding error — it is the case that will
 * dominate. A merged issue leaves its worktree behind (this repo has 25 such
 * directories), so "a worktree exists" very often means "someone already finished
 * this", and pointing an agent at `git log <base>..HEAD` for a branch with nothing on
 * it is a worse first turn than the silence this feature replaces. Naming the zero
 * explicitly is what keeps the block honest.
 *
 * Both variants name the branch and base they were READ from, never a guess: a Claude
 * session's branch is `worktree-github-issue-N` and an `ensureWorktree` one's is
 * `github-issue-N`, and an agent handed the wrong name runs a rev-range against
 * nothing and concludes there was no prior work.
 */
function resumePromptText(status, liveSessions = [], { now = Date.now() } = {}) {
  if (!status) return null;
  const branch = status.branch ? `\`${status.branch}\`` : "this worktree's branch";
  const base = status.base ? `\`${status.base}\`` : 'the base branch';
  const touched = `last touched ${humanAge(status.lastTouched, now)}`;
  // The most actionable fact of all, and free: two agents editing one worktree is the
  // state a silent resume is most likely to create and least able to recover from.
  const others = liveSessions.length
    ? '\nAnother deepsteve session is open on this worktree right now — coordinate before you edit anything.'
    : '';

  if (status.commits === 0 && !status.dirty) {
    return `A worktree for this issue already exists (branch ${branch}, ${touched}) but has nothing in it: `
      + `0 commits ahead of ${base}, no uncommitted changes. Either the earlier session did nothing, or its `
      + `work is already merged. Run \`git log --oneline -3\` to confirm before treating this as a clean `
      + `start.${others}`;
  }

  // A missing count is omitted rather than printed as 0 — "we could not ask git" and
  // "there is nothing on the branch" are different answers and must not look alike.
  const facts = [
    `branch ${branch}`,
    status.commits == null ? null : `${status.commits} commit${status.commits === 1 ? '' : 's'} ahead of ${base}`,
    status.dirty ? `${status.dirty} uncommitted file${status.dirty === 1 ? '' : 's'}` : null,
    touched,
  ].filter(Boolean).join(' · ');
  const range = status.base ? `\`git log --oneline ${status.base}..HEAD\`` : '`git log --oneline`';

  return `You are RESUMING this issue — an earlier session already worked in this worktree.\n${facts}.\n`
    + `Read what is there before you plan anything: ${range}, then \`git status\` and \`git diff\`. Continue `
    + `that work rather than restarting it, and when you report, be explicit about what you found already `
    + `done versus what you did.${others}`;
}

// Labels arrive in three shapes: a comma-joined string (MCP and HTTP callers),
// the `[{name}]` array `gh issue list --json labels` returns, or an array of
// plain strings. All three render as one comma-joined list, and "no labels" is
// the word `none` rather than an empty gap in the prompt.
function normalizeLabels(labels) {
  if (Array.isArray(labels)) {
    const names = labels.map(l => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
    return names.length ? names.join(', ') : 'none';
  }
  const s = typeof labels === 'string' ? labels.trim() : '';
  return s || 'none';
}

// `{{var}}` substitution against the fixed variable set. An unknown name renders
// as the empty string — a user-edited template must never leak a raw `{{typo}}`
// into the prompt an agent is about to act on.
//
// `stages` is TEXT, not a flag (#668): the module never reads settings, so the daemon
// stays the one place that decides whether a session gets the stages and — once #669
// lands — what they are allowed to name. `resume` (#689) is text for the same reason,
// and additionally because only the daemon can look at the worktree.
function renderIssuePrompt(template, { number, title, labels, url, body } = {}, { stages, resume } = {}) {
  const vars = {
    number,
    title,
    labels: normalizeLabels(labels),
    url: url || '',
    body: body ? clipBody(body, number) : '(no description)',
  };
  const rendered = String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  // All three tails are appended AFTER substitution so a user-edited template can
  // neither drop them nor reorder them away from the end (#643, #668, #689). Stages go
  // LAST: stage 4 already ends in issue_complete, so the completion instruction above
  // reads as the rule the workflow then refines, and nothing is repeated after the list.
  //
  // `resume` goes FIRST, straight after the issue itself, because it is context about
  // the task — what is already in the worktree — while the two tails below are rules
  // about how to finish. Putting it after them would separate stage 4's "…then
  // issue_complete" from the instruction it refines, and would bury the one fact that
  // has to change the agent's FIRST move rather than its last.
  const head = resume ? `${rendered}\n\n${String(resume).trim()}` : rendered;
  const out = `${head}\n\n${ISSUE_COMPLETE_INSTRUCTION}`;
  return stages ? `${out}\n\n${String(stages).trim()}` : out;
}

// The branch/worktree an issue session gets. Callers still pass the result
// through validateWorktree — this only fixes the naming convention in one place.
function issueWorktreeName(number) {
  return `github-issue-${number}`;
}

// Tab label, clipped to the user's maxIssueTitleLength.
function issueTabName(number, title, maxLen) {
  const full = `#${number} ${title}`;
  const limit = Number(maxLen) > 0 ? Number(maxLen) : 25;
  return full.length <= limit ? full : full.slice(0, limit) + '…';
}

module.exports = { renderIssuePrompt, normalizeLabels, issueWorktreeName, issueTabName, clipBody, resumePromptText, humanAge, ISSUE_BODY_LIMIT, ISSUE_COMPLETE_INSTRUCTION, WORKFLOW_STAGES, RESUME_TEXT_LIMIT };

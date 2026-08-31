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
// lands — what they are allowed to name.
function renderIssuePrompt(template, { number, title, labels, url, body } = {}, { stages } = {}) {
  const vars = {
    number,
    title,
    labels: normalizeLabels(labels),
    url: url || '',
    body: body ? clipBody(body, number) : '(no description)',
  };
  const rendered = String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  // Both tails are appended AFTER substitution so a user-edited template can neither
  // drop them nor reorder them away from the end (#643, #668). Stages go LAST: stage 4
  // already ends in issue_complete, so the completion instruction above reads as the
  // rule the workflow then refines, and nothing is repeated after the list.
  const out = `${rendered}\n\n${ISSUE_COMPLETE_INSTRUCTION}`;
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

module.exports = { renderIssuePrompt, normalizeLabels, issueWorktreeName, issueTabName, clipBody, ISSUE_BODY_LIMIT, ISSUE_COMPLETE_INSTRUCTION, WORKFLOW_STAGES };

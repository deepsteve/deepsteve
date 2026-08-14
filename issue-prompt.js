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

// Issue bodies go into a terminal composer, so they have always been clipped.
const ISSUE_BODY_LIMIT = 2000;

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
function renderIssuePrompt(template, { number, title, labels, url, body } = {}) {
  const vars = {
    number,
    title,
    labels: normalizeLabels(labels),
    url: url || '',
    body: body ? String(body).slice(0, ISSUE_BODY_LIMIT) : '(no description)',
  };
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
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

module.exports = { renderIssuePrompt, normalizeLabels, issueWorktreeName, issueTabName, ISSUE_BODY_LIMIT };

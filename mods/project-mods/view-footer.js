/**
 * View footers — the server half: the GitHub facts a footer draws for one tab.
 *
 * A view can carry a `footer` (see the "Project views" section of tools.js): a list of fields
 * drawn in a row along the bottom of the monitor whenever the tab you are looking at is in that
 * view. The fields describe the TAB, not the view — its repo, the issue it is working, when that
 * issue was opened, and the issue's title with the start of its body — so this file answers
 * "what are those for session X", and public/js/view-footer.js draws them.
 *
 * Local facts first, network last. The repo comes from the issue URL the session was stamped
 * with, else the checkout's `origin` remote, read with git. The issue NUMBER is local too: the
 * session's issue stamp, else a `github-issue-<n>` worktree name. Only the title, body and date
 * need `gh issue view`, cached per issue so switching back to a tab costs nothing.
 */

const { execFile } = require('child_process');
const path = require('path');
const { resolveBinary } = require('../../bin-path');

// What a footer can show, in the order the view file lists them.
const FOOTER_FIELDS = ['repo', 'issue', 'date', 'title'];

// The title plus the start of the body, capped at this many words in all. The browser clamps
// the row to two lines on top, so a narrow window ends in an ellipsis before the cap does.
const EXCERPT_WORDS = 100;

const ISSUE_TTL_MS = 10 * 60 * 1000;
// A failed lookup (no gh, offline, a deleted issue) is retried, but not on every tab switch.
const FAIL_TTL_MS = 60 * 1000;
const REMOTE_TTL_MS = 10 * 60 * 1000;
const EXEC_TIMEOUT_MS = 15000;

/**
 * The worktree a session is in: its own `worktree` (a worktree session, whose cwd is the repo
 * root), else the `<name>` of a cwd inside `.claude/worktrees/<name>/` (a terminal opened in one).
 */
function worktreeOf(entry) {
  if (entry && entry.worktree) return String(entry.worktree);
  const m = String((entry && entry.cwd) || '').match(/\/\.claude\/worktrees\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

// issueWorktreeName() in issue-prompt.js, read backwards.
const ISSUE_WORKTREE_RE = /^github-issue-(\d+)$/;

/** The issue a session is working: its stamp from start_issue, else its worktree's name. */
function issueNumberOf(entry) {
  const stamped = Number(entry && entry.issue && entry.issue.number);
  if (Number.isInteger(stamped) && stamped > 0) return stamped;
  const m = (worktreeOf(entry) || '').match(ISSUE_WORKTREE_RE);
  return m ? Number(m[1]) : null;
}

/**
 * `owner/name` out of any GitHub URL git or gh hands us — `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r`, `https://github.com/o/r.git`, an issue URL — else null.
 */
function parseGitHubRepo(url) {
  const m = String(url || '').trim().match(
    /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/[^\s]*)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * An issue body as one line of prose: markup, comments, code blocks and images dropped, and
 * headings too — "## Summary" read inline is just a stray word in the middle of a sentence.
 */
function plainText(md) {
  return String(md || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|~~|`|\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordsOf = (s) => String(s || '').split(/\s+/).filter(Boolean);

/** The start of the body, so that title + excerpt stay within `maxWords`; '…' when cut. */
function excerptOf(title, body, maxWords = EXCERPT_WORDS) {
  const budget = maxWords - wordsOf(title).length;
  if (budget <= 0) return '';
  const words = wordsOf(plainText(body));
  return words.length > budget ? words.slice(0, budget).join(' ') + '…' : words.join(' ');
}

function defaultExec(bin, args, cwd) {
  return new Promise((resolve) => {
    const abs = resolveBinary(bin);
    if (!abs) { resolve({ ok: false, error: `${bin} not found on PATH` }); return; }
    try {
      // The error carries stderr's first line: "Command failed" alone does not say whether gh
      // is logged out, offline, or looking at a deleted issue.
      execFile(abs, args, { cwd, encoding: 'utf8', timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (!err) { resolve({ ok: true, stdout }); return; }
        const why = String(stderr || '').trim().split('\n')[0];
        resolve({ ok: false, error: why ? `${err.message.split('\n')[0]} — ${why}` : err.message });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/**
 * The cached lookups behind GET /api/project-views/footer/:sessionId. `exec(bin, args, cwd)`
 * resolves `{ok, stdout}` and is injectable, so tests need neither git nor gh.
 */
function createFooterSource({ exec = defaultExec, now = Date.now, log = () => {} } = {}) {
  const remotes = new Map();    // cwd → { at, slug }
  const issues = new Map();     // "owner/name#n" → { at, ttl, value }
  const inflight = new Map();   // same key → the pending lookup, so a burst costs one gh call

  async function repoOf(entry, cwd) {
    const stamped = parseGitHubRepo(entry && entry.issue && entry.issue.url);
    if (stamped) return stamped;
    if (!cwd) return null;
    const hit = remotes.get(cwd);
    if (hit && now() - hit.at < REMOTE_TTL_MS) return hit.slug;
    const r = await exec('git', ['remote', 'get-url', 'origin'], cwd);
    const slug = r.ok ? parseGitHubRepo(r.stdout) : null;
    remotes.set(cwd, { at: now(), slug });
    return slug;
  }

  function issueDetails(slug, number, cwd) {
    const key = `${slug}#${number}`;
    const hit = issues.get(key);
    if (hit && now() - hit.at < hit.ttl) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const p = exec('gh', ['issue', 'view', String(number), '--repo', slug, '--json', 'title,body,createdAt,url'], cwd)
      .then((r) => {
        let value = null;
        if (r.ok) {
          try {
            const d = JSON.parse(r.stdout);
            const title = String(d.title || '');
            value = { title, excerpt: excerptOf(title, d.body), createdAt: d.createdAt || null, url: d.url || null };
          } catch { /* not JSON — treated as a failed lookup */ }
        }
        if (!value) log(`[view-footer] gh issue view ${key} failed: ${r.error || 'unreadable output'}`);
        issues.set(key, { at: now(), ttl: value ? ISSUE_TTL_MS : FAIL_TTL_MS, value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /**
   * `{ repo: {name, url}, issue: {number, url, title?, excerpt?, createdAt?} | null, worktree }`.
   * `paths` is sessionPaths(entry): `cwd` is where the agent actually works (the worktree),
   * `repoRoot` the checkout it belongs to.
   */
  async function footerFor(entry, paths = {}) {
    const cwd = paths.cwd || (entry && entry.cwd) || null;
    const slug = await repoOf(entry, cwd);
    const repo = slug
      ? { name: slug, url: `https://github.com/${slug}` }
      : { name: path.basename(paths.repoRoot || cwd || '') || null, url: null };
    const number = issueNumberOf(entry);
    let issue = null;
    if (number) {
      const stampedUrl = (entry && entry.issue && entry.issue.url) || null;
      issue = { number, url: stampedUrl || (slug ? `https://github.com/${slug}/issues/${number}` : null) };
      const d = slug ? await issueDetails(slug, number, cwd) : null;
      if (d) Object.assign(issue, { title: d.title, excerpt: d.excerpt, createdAt: d.createdAt, url: issue.url || d.url });
    }
    return { repo, issue, worktree: worktreeOf(entry) };
  }

  return { footerFor };
}

module.exports = {
  FOOTER_FIELDS, EXCERPT_WORDS,
  worktreeOf, issueNumberOf, parseGitHubRepo, plainText, excerptOf, createFooterSource,
};

/**
 * The Backlog: a project's open GitHub issues — all of them, or one label's worth —
 * matched to the tabs already working on them (#671, #679).
 *
 * Workshop's inbox answers "which agent needs me". This answers the other half of the
 * same question — "what is outstanding that nothing is working on yet" — and the whole
 * point of putting the two in one place is the MATCH between them. Reading a list of
 * open bugs on github.com is not the feature; reading it with "#664 already has a tab"
 * on the row is.
 *
 * Like inbox.js, this module never sees the initMCP `ctx`. Sessions arrive as a plain
 * array of `{ id, name, worktree, project }` and `gh` arrives as an injected fetcher,
 * which is what lets test/unit drive every rule here with no daemon, no subprocess and
 * no `gh` on PATH — the bare `unit` CI job has none of the three.
 *
 * Three things here are load-bearing and non-obvious:
 *
 *   1. The worktree tier of the match, not the title tier, is the authoritative one.
 *      An agent renames its own tab (the ws `{type:'rename'}` handler in server.js), and
 *      issue tabs routinely do: two `github-issue-<n>` sessions renamed themselves out
 *      of the `#N title` shape while this feature was being planned. `entry.worktree` is
 *      minted once by startIssueSession, persisted by serializeShellEntry, and never
 *      rewritten.
 *   2. A match is scoped to the project. Without that, a `github-issue-42` tab in an
 *      unrelated repo claims issue #42 in this one, and the row's "Show tab" opens a
 *      session that has never heard of it.
 *   3. Failures are cached. A repo with no GitHub remote fails in ~200ms, every poll,
 *      forever; the point of the short negative TTL is that it costs one `gh` spawn a
 *      refresh window instead of one per poll per browser window.
 */

// gh's own ceiling for one page. The panel is a sidebar section, not an issue tracker.
const MAX_ISSUES = 100;

/** The id namespace. Must not collide with `blocked:<sessionId>` or a stored `w<n>` ticket. */
const issueId = (number) => `issue:${number}`;

/**
 * `gh issue list` argv for one label, or for none.
 *
 * An empty label omits `--label` ENTIRELY rather than passing an empty one — that is the
 * unfiltered backlog, every open issue in the project (#679). `--label=` with nothing
 * after it is a real argument to gh and matches nothing, which is the opposite.
 *
 * `--label=<v>` is ONE token, not two: a label starting with `-` is otherwise read by
 * gh's own flag parser as a flag. There is no shell anywhere on this path, so the `=`
 * form costs nothing and closes that case.
 *
 * `--limit` is mandatory, not tidiness — gh defaults to 30 and truncates silently, which
 * looks exactly like "that is all there is".
 */
function issueListArgs(label) {
  return [
    'issue', 'list',
    ...(label ? [`--label=${label}`] : []),
    '--state', 'open',
    '--json', 'number,title,labels,url,updatedAt',
    '--limit', String(MAX_ISSUES),
  ];
}

/**
 * `gh issue list --json number,title,labels,url,updatedAt` → normalised rows.
 *
 * Tolerant on purpose: this is the output of a subprocess that can be truncated by a
 * timeout, and one malformed byte must degrade to an empty backlog rather than throw
 * inside a route and turn an accessory panel into a 500.
 */
function parseIssues(stdout) {
  let raw;
  try {
    raw = JSON.parse(String(stdout || ''));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const number = Number(r.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    out.push({
      number,
      title: String(r.title || '').trim(),
      url: typeof r.url === 'string' ? r.url : '',
      labels: Array.isArray(r.labels)
        ? r.labels.map((l) => String((l && l.name) || '')).filter(Boolean)
        : [],
      // ms epoch, not the ISO string: the panel does arithmetic on it every second.
      updatedAt: Date.parse(r.updatedAt) || 0,
    });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

/** `gh label list --json name,color` → `[{ name, color }]`. Same tolerance as above. */
function parseLabels(stdout) {
  let raw;
  try {
    raw = JSON.parse(String(stdout || ''));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const l of raw) {
    const name = String((l && l.name) || '').trim();
    if (!name) continue;
    out.push({ name, color: String((l && l.color) || '').replace(/^#/, '') });
  }
  return out;
}

/** `github-issue-671` → 671. Anything else → null. */
function worktreeIssueNumber(worktree) {
  const m = /^github-issue-(\d+)$/.exec(String(worktree || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Every `#N` a tab name claims. `\d+` is greedy and the lookahead rejects a trailing
 * digit, so `#6710` yields 6710 and never 671 — the one thing this regex is really for.
 */
function titleIssueNumbers(name) {
  const out = new Set();
  const re = /(^|\s)#(\d+)(?=\D|$)/g;
  let m;
  while ((m = re.exec(String(name || '')))) out.add(Number(m[2]));
  return out;
}

/**
 * Attach the sessions working on each issue.
 *
 * `sessions` is `[{ id, name, worktree, project }]` — live sessions only. A tombstoned
 * session is not "a tab working on it", so the caller reads ctx.shells and never
 * savedState.
 *
 * Every match is kept, not just the first: two tabs on one issue is a real state (a
 * restarted attempt beside the original), and collapsing it would make the row's
 * "Show tab" silently pick one of two without saying so.
 */
function matchSessions(issues, sessions, project) {
  const byWorktree = new Map();
  const byTitle = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || !s.id) continue;
    // Scope first: an issue number is only unique within a repo.
    if (project && s.project !== project) continue;
    const wn = worktreeIssueNumber(s.worktree);
    if (wn !== null) {
      if (!byWorktree.has(wn)) byWorktree.set(wn, []);
      byWorktree.get(wn).push(s);
    }
    for (const tn of titleIssueNumbers(s.name)) {
      if (!byTitle.has(tn)) byTitle.set(tn, []);
      byTitle.get(tn).push(s);
    }
  }

  return (Array.isArray(issues) ? issues : []).map((issue) => {
    const matched = [];
    const seen = new Set();
    // Worktree first, so a session matching both ways is reported as the exact match it
    // is rather than as a name coincidence.
    for (const s of byWorktree.get(issue.number) || []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      matched.push({ sessionId: s.id, sessionName: s.name || null, matchedBy: 'worktree' });
    }
    for (const s of byTitle.get(issue.number) || []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      matched.push({ sessionId: s.id, sessionName: s.name || null, matchedBy: 'title' });
    }
    return {
      ...issue,
      id: issueId(issue.number),
      kind: 'issue',
      matched,
      // Hoisted so the panel's existing visit() and bench header read an issue row the
      // same way they read an inbox row, with no branch.
      sessionId: matched.length ? matched[0].sessionId : null,
      sessionName: matched.length ? matched[0].sessionName : null,
    };
  });
}

// ── cache ────────────────────────────────────────────────────────────────────

const BACKLOG_TTL_MS = 120_000;   // the issue list changes on the order of minutes
const LABEL_TTL_MS = 600_000;     // a repo's label set changes on the order of never
const ERROR_TTL_MS = 20_000;      // long enough to stop a poll storm, short enough to recover
const CACHE_MAX = 50;

/**
 * A TTL cache with in-flight de-duplication.
 *
 * The de-dup is the half that is not optional. Two browser windows on the same project
 * poll independently, and `gh` takes ~0.5s; without it every refresh window spawns two
 * subprocesses to produce one identical answer, and a `gh` that has gone slow multiplies
 * by however many tabs are open.
 *
 * `fetcher` resolves to a value; a value carrying a truthy `error` is cached on the
 * short clock instead of the long one.
 */
function createCache({ ttlMs = BACKLOG_TTL_MS, errorTtlMs = ERROR_TTL_MS, max = CACHE_MAX } = {}) {
  const entries = new Map();   // key -> { value, ts }
  const inFlight = new Map();  // key -> Promise

  const ttlFor = (value) => (value && value.error ? errorTtlMs : ttlMs);

  async function get(key, fetcher, { now = Date.now(), maxAgeMs = null } = {}) {
    const hit = entries.get(key);
    if (hit) {
      const age = now - hit.ts;
      const limit = Math.min(ttlFor(hit.value), maxAgeMs == null ? Infinity : maxAgeMs);
      if (age < limit) return { ...hit.value, cached: true, ageMs: age };
    }

    const pending = inFlight.get(key);
    if (pending) return pending;

    const p = (async () => {
      const value = await fetcher();
      // Size cap the projectCache way (mods/workshop/tools.js): clear wholesale rather
      // than carry an LRU nobody will maintain. 50 project×label pairs is already far
      // past what one person looks at.
      if (entries.size >= max) entries.clear();
      entries.set(key, { value, ts: now });
      return { ...value, cached: false, ageMs: 0 };
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, p);
    return p;
  }

  return {
    get,
    clear: () => { entries.clear(); inFlight.clear(); },
    size: () => entries.size,
  };
}

module.exports = {
  MAX_ISSUES,
  BACKLOG_TTL_MS,
  LABEL_TTL_MS,
  ERROR_TTL_MS,
  CACHE_MAX,
  issueId,
  issueListArgs,
  parseIssues,
  parseLabels,
  worktreeIssueNumber,
  titleIssueNumbers,
  matchSessions,
  createCache,
};

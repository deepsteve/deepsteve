/**
 * The only way this mod talks to GitHub: REST GETs over fetch, made conditional with ETags.
 *
 * Why not `gh api` per poll: a 304 makes `gh api` exit 1, so every quiet poll would read as a
 * failure, and a subprocess per poll is the expensive part of polling. `gh` is used once, for
 * `gh auth token` (re-run on a 401), and to name a checkout's repo.
 *
 * Why conditional: GitHub's docs — "Making a conditional request does not count against your
 * primary rate limit if a 304 response is returned". Measured on this repo: four 304s left
 * X-RateLimit-Used unchanged, one 200 moved it by one. So every URL keeps its last ETag and
 * body, and a quiet poll costs nothing.
 *
 * Why the pause: the one ban GitHub's docs describe is for "continuing to make requests while
 * you are rate limited". A 403/429 carrying a rate-limit signal stops EVERY request from this
 * client until the reset GitHub names (or a minute, when it names none).
 *
 * Requests are serialized — one in flight at a time — which keeps us far inside the secondary
 * limits (100 concurrent, 900 points/minute) no matter how many sessions are watching.
 */
const API = 'https://api.github.com';
const ETAG_CACHE_MAX = 500;
const TOKEN_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 5;

function createGitHubClient({ ghPath, execFile, log = () => {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let token = null;
  let tokenAt = 0;
  let pausedUntil = 0;
  let chain = Promise.resolve();
  const cache = new Map(); // path -> { etag, data }
  const slugs = new Map(); // cwd -> { slug, at }
  const stats = { requests: 0, notModified: 0, errors: 0, since: now() };

  function runGh(args, cwd) {
    return new Promise((resolve) => {
      if (!ghPath) return resolve({ error: 'gh not found on PATH' });
      execFile(ghPath, args, { cwd, encoding: 'utf8', timeout: 15_000 }, (err, stdout, stderr) => {
        if (err) return resolve({ error: String(stderr || err.message).trim().split('\n')[0] });
        resolve({ stdout: String(stdout || '').trim() });
      });
    });
  }

  async function getToken(force = false) {
    if (!force && token && now() - tokenAt < TOKEN_TTL_MS) return token;
    const r = await runGh(['auth', 'token']);
    if (r.error || !r.stdout) {
      token = null;
      return null;
    }
    token = r.stdout;
    tokenAt = now();
    return token;
  }

  function rememberEtag(path, etag, data) {
    if (!etag) return;
    cache.delete(path);
    cache.set(path, { etag, data });
    while (cache.size > ETAG_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function pauseFrom(res) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    let until = now() + 60_000;
    if (Number.isFinite(retryAfter) && retryAfter > 0) until = now() + retryAfter * 1000;
    else if (Number.isFinite(reset) && reset > 0) until = Math.max(until, reset * 1000);
    pausedUntil = Math.max(pausedUntil, until);
    log(`[github] rate limited (${res.status}) — every request paused until ${new Date(pausedUntil).toISOString()}`);
  }

  async function request(path, { conditional = true, retried = false } = {}) {
    if (now() < pausedUntil) return { status: 0, error: 'rate-limited', pausedUntil };
    const tok = await getToken();
    if (!tok) return { status: 0, error: 'no-token' };
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${tok}`,
      'User-Agent': 'deepsteve',
    };
    const cached = conditional ? cache.get(path) : null;
    if (cached) headers['If-None-Match'] = cached.etag;
    let res;
    stats.requests++;
    try {
      res = await fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      stats.errors++;
      return { status: 0, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
    if (res.status === 304 && cached) {
      stats.notModified++;
      return { status: 304, changed: false, data: cached.data };
    }
    if (res.status === 401 && !retried) {
      await getToken(true);
      return request(path, { conditional, retried: true });
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && (remaining === '0' || res.headers.get('retry-after')))) {
      stats.errors++;
      pauseFrom(res);
      return { status: res.status, error: 'rate-limited', pausedUntil };
    }
    if (!res.ok) {
      stats.errors++;
      return { status: res.status, error: `http-${res.status}` };
    }
    let data;
    try { data = await res.json(); } catch { return { status: res.status, error: 'bad-json' }; }
    if (conditional) rememberEtag(path, res.headers.get('etag'), data);
    return { status: res.status, changed: true, data, link: res.headers.get('link') || '' };
  }

  /** One serialized GET. Resolves { status, changed, data } or { status, error }. */
  function get(path, opts) {
    const run = chain.then(() => request(path, opts));
    chain = run.catch(() => {});
    return run;
  }

  /** A paginated list, following rel="next" up to MAX_PAGES. Unconditional by design. */
  async function getAll(path) {
    const out = [];
    let next = path;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const r = await get(next, { conditional: false });
      if (r.error) return out.length ? { status: 200, data: out, partial: true } : r;
      if (Array.isArray(r.data)) out.push(...r.data);
      const m = /<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/.exec(r.link || '');
      next = m ? m[1] : null;
    }
    return { status: 200, data: out };
  }

  /** owner/repo for a checkout, as gh resolves it (it follows a fork's base repo). Cached. */
  async function repoSlug(cwd) {
    const hit = slugs.get(cwd);
    if (hit && now() - hit.at < 10 * 60_000) return hit.slug;
    const r = await runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd);
    const slug = !r.error && /^[\w.-]+\/[\w.-]+$/.test(r.stdout || '') ? r.stdout : null;
    slugs.set(cwd, { slug, at: now() });
    return slug;
  }

  return { get, getAll, repoSlug, stats: () => ({ ...stats, pausedUntil, cached: cache.size }) };
}

/** https://github.com/o/r/issues/12 → { slug: 'o/r', number: 12 }, else null. */
function parseIssueUrl(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(String(url || ''));
  return m ? { slug: m[1], number: Number(m[2]) } : null;
}

module.exports = { createGitHubClient, parseIssueUrl };

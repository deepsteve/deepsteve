/**
 * Claude logins (#748): several Claude accounts on one install, one per project.
 *
 * A login is a long-lived OAuth token from `claude setup-token`. Claude Code reads it
 * from CLAUDE_CODE_OAUTH_TOKEN and, measured on 2.1.317, that is ALL it changes:
 * `claude auth status` reports `authMethod: "oauth_token"` while `configDirectory` and
 * `projectsDirectory` stay `~/.claude`. Settings, transcripts and history are shared —
 * which is exactly the scope the issue asks for, and why this is not #537's
 * CLAUDE_CONFIG_DIR profiles (those relocate the whole config root).
 *
 * "System" is not a row here. It is the absence of a login: nothing is injected, and
 * Claude uses whatever `claude /login` stored. Every project starts there, so an
 * install that never adds a login spawns byte-for-byte what it did before.
 *
 * On disk, under <stateDir>/claude-logins/ (0700):
 *   index.json     { version: 1, logins: [{ id, name, hint, plan, addedAt }] }   (0600)
 *   <id>.token     the token itself, nothing else                          (0600)
 *
 * Not settings.json, on purpose: settings are broadcast to every browser, logged on
 * every change, and returned by GET /api/settings. The token never leaves this
 * directory through the API — callers get `hint` (the last four characters).
 *
 * The token never reaches a command line either. Under tmux the pane's environment is
 * passed as `new-session -e K=V` arguments, and argv is readable by anyone who can run
 * `ps`. So a session's env carries only the token FILE's path, and the pane's shell
 * reads the file itself (`withTokenFromFile`).
 *
 * Which login a session gets is decided at spawn, from the project its cwd is in,
 * every time — new, restored, resumed alike — so nothing about the login is stored on
 * a session, and moving a project takes effect the next time each session starts.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/** The variable Claude Code reads the token from. */
const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
/** The variable a session's env carries instead: the path of the token file. */
const TOKEN_FILE_ENV = 'DEEPSTEVE_CLAUDE_TOKEN_FILE';
/**
 * A token injected through CLAUDE_CODE_OAUTH_TOKEN carries no plan: Claude Code 2.1.317
 * builds it with `subscriptionType: CLAUDE_CODE_SUBSCRIPTION_TYPE || null`, and the
 * banner reads "Claude API". A null plan might be Team/Enterprise, so Claude also fetches
 * remote managed settings with the token, and when that fetch fails every session opens
 * on "⚠ Remote managed settings failed to load (authentication rejected (401))". Naming
 * a personal plan makes the fetch ineligible (measured: no request at all), so each login
 * stores its plan and its sessions get it in this variable. The plan also drives
 * client-side choices (the banner, usage messaging, plan-gated defaults), which is why it
 * is the account's real plan and not one fixed value.
 *
 * Personal plans only: a Team or Enterprise account has a policy to fetch, and this
 * would skip it.
 */
const SUBSCRIPTION_ENV = 'CLAUDE_CODE_SUBSCRIPTION_TYPE';
const PLANS = ['pro', 'max'];
// A login saved before plans existed. The only one there was is a Pro account.
const DEFAULT_PLAN = 'pro';
const isPlan = (p) => PLANS.includes(p);

const NAME_MAX = 40;
const TOKEN_MAX = 4096;
// Ids are minted here and become file names, so anything else is refused outright.
const ID_RE = /^[a-f0-9]{8}$/;
// Printable ASCII, no spaces. A pasted token with a line break or a stray space in
// it is a copy mistake, and saying so beats storing something that fails at login.
const TOKEN_RE = /^[!-~]+$/;

const isLoginId = (id) => typeof id === 'string' && ID_RE.test(id);

/** The last four characters, for the UI. Never more: the hint is shown everywhere. */
function tokenHint(token) {
  const t = String(token || '');
  return t.length > 8 ? '…' + t.slice(-4) : '…';
}

/** A cleaned token, or { error }. */
function cleanToken(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return { error: 'Paste the token from `claude setup-token`.' };
  if (t.length > TOKEN_MAX) return { error: 'That token is too long.' };
  if (!TOKEN_RE.test(t)) return { error: 'The token has spaces or line breaks in it — paste it as one line.' };
  return { token: t };
}

/** A cleaned display name, or { error }. `taken` holds the names already in use. */
function cleanName(raw, taken = []) {
  const n = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!n) return { error: 'Give the login a name.' };
  if (n.length > NAME_MAX) return { error: `Keep the name to ${NAME_MAX} characters.` };
  const lower = n.toLowerCase();
  if (lower === 'system') return { error: '"System" is the built-in login — pick another name.' };
  if (taken.some(t => String(t).toLowerCase() === lower)) return { error: `A login named "${n}" already exists.` };
  return { name: n };
}

// Write a file only its owner can read, atomically. The mode is set on the temp file
// before the rename, so the token is never on disk under a wider mode — not even for
// the moment between a write and a chmod.
function writePrivate(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // writeFileSync's mode is masked by umask; this is not
  fs.renameSync(tmp, file);
}

/**
 * The login store. `dir` is injected so tests (and a DEEPSTEVE_HOME instance) never
 * touch the real one.
 */
function createClaudeLogins({ dir, genId = () => randomUUID().replace(/-/g, '').slice(0, 8), now = Date.now, log = () => {} } = {}) {
  if (!dir) throw new Error('createClaudeLogins: dir is required');
  const indexFile = path.join(dir, 'index.json');
  let logins = [];

  const tokenPath = (id) => path.join(dir, `${id}.token`);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700); // an existing dir keeps its old mode otherwise
  }

  function load() {
    logins = [];
    let v;
    try {
      v = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') log(`[claude-logins] could not read ${indexFile}: ${e.message}`);
      return;
    }
    const rows = Array.isArray(v && v.logins) ? v.logins : [];
    for (const r of rows) {
      if (!r || !isLoginId(r.id) || typeof r.name !== 'string' || !r.name) continue;
      if (logins.some(l => l.id === r.id)) continue;
      logins.push({ id: r.id, name: r.name, hint: typeof r.hint === 'string' ? r.hint : '…', plan: isPlan(r.plan) ? r.plan : DEFAULT_PLAN, addedAt: Number(r.addedAt) || 0 });
    }
  }

  function save() {
    ensureDir();
    writePrivate(indexFile, JSON.stringify({ version: 1, logins }, null, 2));
  }

  /** Every login, safe to send anywhere: no token, and whether its file is still there. */
  function list() {
    return logins.map(l => ({ ...l, missing: !fs.existsSync(tokenPath(l.id)) }));
  }

  function get(id) {
    return isLoginId(id) ? logins.find(l => l.id === id) || null : null;
  }

  /** Add a login. Returns { login } (without the token) or { error }. */
  function add({ name, token, plan = DEFAULT_PLAN } = {}) {
    const n = cleanName(name, logins.map(l => l.name));
    if (n.error) return { error: n.error };
    const t = cleanToken(token);
    if (t.error) return { error: t.error };
    if (!isPlan(plan)) return { error: `The plan must be one of: ${PLANS.join(', ')}.` };
    let id = genId();
    for (let i = 0; i < 5 && (!isLoginId(id) || get(id)); i++) id = genId();
    if (!isLoginId(id) || get(id)) return { error: 'Could not mint a login id.' };
    ensureDir();
    // Token first, index second: a crash in between leaves an orphan file nothing
    // points at, never an index row whose token was never written.
    writePrivate(tokenPath(id), t.token);
    const login = { id, name: n.name, hint: tokenHint(t.token), plan, addedAt: now() };
    logins.push(login);
    save();
    log(`[claude-logins] added "${login.name}" (${id}, ${plan})`);
    return { login: { ...login, missing: false } };
  }

  /** Change a login's plan. Returns { login } or { error }; `notFound` for an unknown id. */
  function setPlan(id, plan) {
    const login = get(id);
    if (!login) return { error: 'No such login', notFound: true };
    if (!isPlan(plan)) return { error: `The plan must be one of: ${PLANS.join(', ')}.` };
    if (login.plan !== plan) {
      login.plan = plan;
      save();
      log(`[claude-logins] "${login.name}" (${id}) is now ${plan} (sessions started or resumed after this)`);
    }
    return { login: { ...login, missing: !fs.existsSync(tokenPath(id)) } };
  }

  /**
   * Replace a login's token, keeping its id — so every project on it stays on it. For a
   * token that was pasted wrong or has since been revoked. Returns { login } or { error };
   * `notFound` for an unknown id. A refused token leaves the old one in place.
   */
  function setToken(id, token) {
    const login = get(id);
    if (!login) return { error: 'No such login', notFound: true };
    const t = cleanToken(token);
    if (t.error) return { error: t.error };
    ensureDir();
    writePrivate(tokenPath(id), t.token);
    login.hint = tokenHint(t.token);
    save();
    log(`[claude-logins] replaced the token for "${login.name}" (${id}); sessions started or resumed after this use it`);
    return { login: { ...login, missing: false } };
  }

  /** Remove a login and its token file. False when there was no such login. */
  function remove(id) {
    const login = get(id);
    if (!login) return false;
    logins = logins.filter(l => l.id !== id);
    save();
    try { fs.unlinkSync(tokenPath(id)); } catch (e) {
      if (e.code !== 'ENOENT') log(`[claude-logins] could not delete the token file for ${id}: ${e.message}`);
    }
    log(`[claude-logins] removed "${login.name}" (${id})`);
    return true;
  }

  /** The token file's path for a known login whose file exists, else null. */
  function tokenFile(id) {
    if (!get(id)) return null;
    const p = tokenPath(id);
    return fs.existsSync(p) ? p : null;
  }

  load();
  return { list, get, add, setPlan, setToken, remove, tokenFile, load, dir };
}

// True when `p` is `dir` or inside it. Same rule as server.js's pathInside, so "this
// session is in that project" means the same thing here as in the rail.
function pathInside(p, dir) {
  if (!p || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  if (!base) return false;
  return p === base || p.startsWith(base + '/');
}

/**
 * The project a cwd belongs to: the one with the longest folder containing it, so a
 * project registered on a subfolder of another project's folder wins inside that
 * subfolder. Archived projects count — archiving hides a project, it does not change
 * what its sessions are.
 */
function projectForCwd(contexts, cwd) {
  if (!cwd || !Array.isArray(contexts)) return null;
  let best = null;
  let bestLen = -1;
  for (const c of contexts) {
    for (const d of (c && Array.isArray(c.dirs) ? c.dirs : [])) {
      const len = String(d).replace(/\/+$/, '').length;
      if (len > bestLen && pathInside(cwd, d)) { best = c; bestLen = len; }
    }
  }
  return best;
}

/**
 * Which login a session about to spawn should use: { project, login, tokenFile }, or
 * null for System. Only a Claude session gets one, and not a #537 profile session —
 * a profile carries its own credentials in its own config dir, and the user chose it
 * for that one tab, which is more specific than the project's choice.
 *
 * `missing: true` comes back when the project names a login whose token file is gone,
 * so the caller can say so; the session then runs as System.
 */
function loginForSpawn({ agentType, cwd, configDir, contexts, logins }) {
  if (agentType !== 'claude' || configDir || !logins) return null;
  const project = projectForCwd(contexts, cwd);
  const id = project && project.claudeLoginId;
  if (!id) return null;
  const login = logins.get(id);
  if (!login) return null;
  const file = logins.tokenFile(id);
  return file ? { project, login, tokenFile: file } : { project, login, tokenFile: null, missing: true };
}

/**
 * Prefix an agent command so the pane's own shell loads the token from the file named
 * in $DEEPSTEVE_CLAUDE_TOKEN_FILE. POSIX `VAR=value cmd` — the login shell is always a
 * POSIX shell (bin-path.js resolveLoginShell refuses anything else). The token is the
 * output of a command substitution inside double quotes, so its contents are never
 * parsed as shell, and only the variable NAME is in the command string.
 */
function withTokenFromFile(command) {
  return `${TOKEN_ENV}="$(cat "$${TOKEN_FILE_ENV}")" ${command}`;
}

module.exports = {
  createClaudeLogins, loginForSpawn, projectForCwd, withTokenFromFile,
  tokenHint, cleanToken, cleanName, isLoginId,
  TOKEN_ENV, TOKEN_FILE_ENV, SUBSCRIPTION_ENV, PLANS, DEFAULT_PLAN,
};

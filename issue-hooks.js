/**
 * The seams an issue session's lifecycle exposes to optional mods.
 *
 * The GitHub Webhooks mod watches an issue session's issue; the daemon and deepsteve-core
 * own starting the session and merging it. Rather than have core require an optional mod,
 * core calls these registries and a mod fills them. With nothing registered every call is a
 * no-op, so a session started on an install without the mod is byte-for-byte unchanged.
 *
 * It lives at the repo root, like mod-kind.js and git-root.js, so server.js, mods and a
 * plain `node --test` all require the same file — and, through require's cache, the same
 * registry instance.
 *
 * Three seams:
 *
 *   promptExtras   text for the issue session's FIRST prompt (`discussion`, `commentRule`).
 *                  Awaited before the prompt is typed, under a deadline, because the prompt
 *                  already waits for the agent to be ready — a GitHub read in that window
 *                  costs nothing — and a slow GitHub must never hold a session's first turn.
 *   mergeGates     asked right before an AGENT merges an issue session. null = allowed;
 *                  anything else is a refusal the agent reads. Human merges (the tab menu,
 *                  Inbox) are not gated: a person pressing Merge has already decided.
 *   issueClosed    told after a merge closed the issue, so a watch can take its last look.
 */

const PROMPT_EXTRAS_DEADLINE_MS = 8000;

const promptExtras = new Map();
const mergeGates = new Map();
const issueClosed = new Map();

/** The invisible tag every comment Deep Steve posts ends with. One definition, used by core and the mod. */
function commentMarker(sessionId) {
  return `<!-- deepsteve:session=${sessionId} -->`;
}

function registerPromptExtras(name, fn) { promptExtras.set(name, fn); }
function registerMergeGate(name, fn) { mergeGates.set(name, fn); }
function registerIssueClosed(name, fn) { issueClosed.set(name, fn); }

/**
 * Collect every registered extra for a new issue session's first prompt.
 * `args` = { id, entry, number, url, cwd }. Resolves { discussion, commentRule } — empty
 * strings when nothing is registered, every provider failed, or the deadline passed.
 */
async function collectPromptExtras(args, { log = () => {}, deadlineMs = PROMPT_EXTRAS_DEADLINE_MS } = {}) {
  const out = { discussion: '', commentRule: '' };
  if (promptExtras.size === 0) return out;
  const runs = [...promptExtras].map(async ([name, fn]) => {
    try {
      const r = await fn(args);
      return r && typeof r === 'object' ? r : null;
    } catch (e) {
      log(`[issue-hooks] prompt extras from ${name} failed: ${e.message}`);
      return null;
    }
  });
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve('deadline'), deadlineMs); });
  const settled = await Promise.race([Promise.all(runs), deadline]);
  clearTimeout(timer);
  if (settled === 'deadline') {
    log(`[issue-hooks] prompt extras for #${args && args.number} missed the ${deadlineMs}ms deadline — prompt sent without them`);
    return out;
  }
  for (const r of settled) {
    if (!r) continue;
    if (r.discussion) out.discussion = [out.discussion, String(r.discussion).trim()].filter(Boolean).join('\n\n');
    if (r.commentRule) out.commentRule = [out.commentRule, String(r.commentRule).trim()].filter(Boolean).join('\n');
  }
  return out;
}

/**
 * Ask every merge gate about an agent's merge. `args` = { id, entry, via }.
 * Resolves null (allowed) or the first refusal: { gate, next, instruction, ...extra }.
 * A gate that throws does not block — a broken mod must not wedge every merge — but it is logged.
 */
async function checkMergeGates(args, { log = () => {} } = {}) {
  for (const [name, fn] of mergeGates) {
    try {
      const r = await fn(args);
      if (r) return { gate: name, ...r };
    } catch (e) {
      log(`[issue-hooks] merge gate ${name} threw, allowing the merge: ${e.message}`);
    }
  }
  return null;
}

/** Tell every listener an issue session's issue was closed by its merge. Never throws. */
function notifyIssueClosed(args, { log = () => {} } = {}) {
  for (const [name, fn] of issueClosed) {
    try { Promise.resolve(fn(args)).catch(e => log(`[issue-hooks] issue-closed ${name} failed: ${e.message}`)); }
    catch (e) { log(`[issue-hooks] issue-closed ${name} failed: ${e.message}`); }
  }
}

/** For tests: forget every registration. */
function _reset() {
  promptExtras.clear();
  mergeGates.clear();
  issueClosed.clear();
}

module.exports = {
  PROMPT_EXTRAS_DEADLINE_MS,
  commentMarker,
  registerPromptExtras, registerMergeGate, registerIssueClosed,
  collectPromptExtras, checkMergeGates, notifyIssueClosed,
  _reset,
};

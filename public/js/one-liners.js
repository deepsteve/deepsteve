/**
 * One-liners — what a tab is for, in a line.
 *
 * A tab's one-liner is its Custom Label, else Claude Code's own title for the conversation (the
 * `ai-title` record it writes into the transcript during the first reply), else its first prompt
 * on one line. It is the header row's default (view-header.js); the task board titles its cards
 * with it (view-tasks.js), and overview mode labels its tiles with it.
 *
 * The facts come from GET /api/project-views/cards (mods/project-mods/view-cards.js), which is
 * Claude-only: any other agent, a plain terminal and a display tab answer `supported: false`.
 *
 * createOneLiners() is one cache of those facts. Its owner says which tabs it is showing with
 * want(ids), as often as it likes — once on show and then on a timer is the pattern — and only
 * the tabs worth asking about go out, in one request: never asked, missing the prompt or the
 * title while their agent keeps a transcript, or answered long enough ago that a /clear may have
 * started another conversation. One request is in flight at a time. onChange(ids) is called
 * whenever facts land, a Custom Label arrives or a tab's task changes, and is the owner's cue to
 * redraw. The facts carry the task each tab said it is working on (the Tasks mod's work_on_task).
 *
 * Imports nothing: a module that owns a surface makes its own cache, so a test that re-imports
 * that module starts from an empty one.
 */

export const FRESH_MS = 5 * 60 * 1000;

/**
 * A tab's one-liner from its facts: `{ text, empty }`, where `empty` marks a placeholder that
 * says why there is nothing to show (not asked yet, not prompted yet, no transcript).
 */
export function oneLiner(f) {
  if (!f) return { text: 'Loading…', empty: true };
  if (f.customLabel) return { text: f.customLabel, empty: false };
  if (f.title) return { text: f.title, empty: false };
  if (f.prompt) return { text: f.prompt.replace(/\s+/g, ' ').trim(), empty: false };
  return { text: f.supported ? 'No prompt yet' : 'No summary — this agent keeps no transcript', empty: true };
}

/** Worth asking the server about. */
export const needsAsk = (f, now, freshMs = FRESH_MS) =>
  !f || (f.supported && !(f.prompt && f.title)) || now - f.at >= freshMs;

export function createOneLiners({ onChange = () => {}, freshMs = FRESH_MS } = {}) {
  const facts = new Map();   // tab id → { at, prompt, title, customLabel, supported }
  let inFlight = false;

  /** Ask about whichever of `ids` needsAsk(). Resolves once the answer (or the failure) has landed. */
  async function want(ids) {
    if (inFlight) return;
    const now = Date.now();
    const need = [...new Set(ids)].filter(id => needsAsk(facts.get(id), now, freshMs));
    if (!need.length) return;
    inFlight = true;
    try {
      const res = await fetch('/api/project-views/cards?ids=' + need.map(encodeURIComponent).join(','));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const at = Date.now();
      for (const id of need) {
        const p = (data.prompts && data.prompts[id]) || {};
        facts.set(id, {
          at,
          prompt: p.prompt || null,
          title: p.title || null,
          customLabel: p.customLabel || null,
          supported: p.supported !== false,
          task: p.task || null,
        });
      }
    } catch {
      // Read as "no prompt yet", so a placeholder stops saying Loading… and the next ask retries.
      for (const id of need) {
        if (!facts.has(id)) facts.set(id, { at: Date.now(), prompt: null, title: null, customLabel: null, supported: true });
      }
    } finally {
      inFlight = false;
    }
    onChange(need);
  }

  /**
   * A tab's Custom Label was set or cleared (the 'custom-label' ping, or the owner's own write).
   * A tab never asked about is left to its first ask.
   */
  function onCustomLabel(id, customLabel) {
    const f = facts.get(id);
    if (!f) return;
    facts.set(id, { ...f, customLabel: customLabel || null });
    onChange([id]);
  }

  /**
   * The tasks some tabs are working on changed (the 'session-tasks' ping: `{ [id]: task | null }`).
   * Like a Custom Label, a tab never asked about is left to its first ask, which brings its task.
   */
  function onSessionTasks(map) {
    const changed = [];
    for (const [id, task] of Object.entries(map || {})) {
      const f = facts.get(id);
      if (!f) continue;
      facts.set(id, { ...f, task: task || null });
      changed.push(id);
    }
    if (changed.length) onChange(changed);
  }

  return {
    want,
    onCustomLabel,
    onSessionTasks,
    /** The task the tab is working on — `{ id, title, status }` — or null. */
    task: (id) => (facts.get(id) && facts.get(id).task) || null,
    get: (id) => facts.get(id),
    has: (id) => facts.has(id),
    set: (id, f) => facts.set(id, f),
    delete: (id) => facts.delete(id),
    /** The tab's one-liner, or null when there is only a placeholder to show. */
    text: (id) => {
      const o = oneLiner(facts.get(id));
      return o.empty ? null : o.text;
    },
  };
}

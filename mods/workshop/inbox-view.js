/**
 * The parts of the Workshop panel that break invisibly (#660).
 *
 * A browser ES module with zero imports, no DOM and no globals, so node:test can
 * drive it straight with `await import()` — the mods/village/data.js split, and the
 * same reason: everything else in workshop.jsx is layout, which you verify by looking
 * at it, while these five behaviours are wrong in ways you only notice a week later.
 *
 *   nextSelection + flattenGroups — a 2s poll rewriting the list under a live cursor.
 *   compareItems                  — needs a TOTAL order, or the list jitters.
 *   isTypingTarget + keyAction    — "the inbox ate my letter e".
 *
 * Nothing here polls, fetches or holds React state. A "pure" module that owns effects
 * is neither testable nor readable, and that is the line to hold.
 */

// Ranked on URGENCY, not kind: a workshop_ask question may legitimately be 'blocking',
// and one rule beats two.
export const URGENCY_RANK = { blocking: 0, normal: 1, fyi: 2 };

// Action Required's own thresholds (mods/action-required/action-required.jsx). The two
// surfaces describe the same wait, so they agree or neither is trustworthy.
export const AGE_WARN_MS = 30_000;
export const AGE_ALERT_MS = 60_000;

// An idle row's own clock (#682), an order of magnitude slower, because it is measuring
// something else. Thirty seconds of a blocked agent is thirty seconds of a machine
// stopped dead; thirty seconds of a finished one is nothing at all — it is the pause
// while you read what it wrote. On the shared scale every row on the bench went red
// within a minute, which is exactly how a colour stops being read.
export const IDLE_WARN_MS = 10 * 60_000;
export const IDLE_ALERT_MS = 45 * 60_000;

const COLOR_CALM = '#8b949e';
const COLOR_WARN = '#f0883e';
const COLOR_ALERT = '#f85149';
const COLOR_MUTED = '#6e7681';

// Boilerplate a permission dialog shows identically in every session, for every tool.
const GENERIC_SUBJECT_RE = /^(do you want to|would you like to)\b/i;

/**
 * Inbox order: most urgent, then longest-waiting, then id.
 *
 * The id tiebreak is load-bearing. Derived `blocked:` rows are rebuilt by the server on
 * every request, so the incoming array order carries no information and JS sort
 * stability buys nothing — without a total order the list reshuffles under the cursor
 * at every poll.
 */
export function compareItems(a, b) {
  const ra = URGENCY_RANK[a && a.urgency] ?? 1;
  const rb = URGENCY_RANK[b && b.urgency] ?? 1;
  if (ra !== rb) return ra - rb;
  const ca = (a && a.createdAt) || 0;
  const cb = (b && b.createdAt) || 0;
  if (ca !== cb) return ca - cb;
  return String(a && a.id).localeCompare(String(b && b.id));
}

export function sortItems(items) {
  return (Array.isArray(items) ? items.slice() : []).sort(compareItems);
}

/**
 * Bucket by project, ordered so the project holding the most urgent thing floats up.
 * Within a group, the same comparator as everywhere else.
 */
export function groupByProject(items) {
  const buckets = new Map();
  for (const item of sortItems(items)) {
    const key = item.project || '';
    if (!buckets.has(key)) {
      buckets.set(key, { project: key, name: item.projectName || 'No project', items: [] });
    }
    buckets.get(key).items.push(item);
  }
  return [...buckets.values()].sort((x, y) => compareItems(x.items[0], y.items[0]));
}

export function flattenGroups(groups) {
  return (Array.isArray(groups) ? groups : []).flatMap((g) => (g && g.items) || []);
}

/**
 * What the list actually renders, and — crucially — `order`, the flat id list in
 * RENDER order.
 *
 * Every keyboard move indexes into `order`, never into the sorted array. Getting that
 * wrong (arrows following sortItems while the DOM follows the grouping) is the single
 * most likely bug in this panel, which is why both halves come from one function.
 *
 * The Backlog (#671) is a second SECTION, not a second list, and it goes through here
 * for the same reason: two sections computing their own order independently is the same
 * bug with more places to make it. Backlog ids come last because the section renders
 * last, so ↑/↓ walks out of the inbox and into the backlog exactly as it looks.
 * `opts.backlog` is already sorted by the caller (backlog-view.js owns that order); a
 * collapsed section contributes rows to neither `backlog` nor `order`.
 */
export const TABS = ['bench', 'backlog'];

/**
 * Which tab a row belongs to (#682).
 *
 * The split is "does this ask something of me" versus "is this here to be read", and
 * it is the whole point of the two tabs. Workshop drifted into an informational panel
 * because the reading material and the obligations shared one scroll: on a machine
 * with nothing blocked — the normal case — the page WAS the issue list, so that is
 * what Workshop looked like it was for.
 *
 * A briefing is reading material by definition (workshop_brief is read-only and has
 * nothing to answer), so it moves across with the issues. Everything else is a row
 * with a verb on it.
 */
export function tabOf(item) {
  return (item && item.kind === 'briefing') ? 'backlog' : 'bench';
}

export function visibleItems(items, opts = {}) {
  const {
    tab = 'bench',
    showBriefings = true, blockingOnly = false, groupByProject: grouped = false,
    backlog = [], backlogCollapsed = false,
  } = opts;
  const onBench = tab !== 'backlog';

  let list = (Array.isArray(items) ? items : []).filter(Boolean)
    .filter((i) => (tabOf(i) === 'bench') === onBench);
  if (!showBriefings) list = list.filter((i) => i.kind !== 'briefing');
  if (blockingOnly && onBench) list = list.filter((i) => i.urgency === 'blocking');

  // Issues live on the backlog tab only, so on the bench there is no second section
  // and `order` is the bench list alone — which is what keeps ↓ from walking the
  // cursor off the end of the bench into rows that are not on screen.
  const issues = (onBench || backlogCollapsed)
    ? []
    : (Array.isArray(backlog) ? backlog : []).filter(Boolean);
  const tail = issues.map((i) => i.id);

  if (grouped) {
    const groups = groupByProject(list);
    const flat = flattenGroups(groups);
    return { groups, list: flat, backlog: issues, order: [...flat.map((i) => i.id), ...tail] };
  }
  const sorted = sortItems(list);
  return { groups: null, list: sorted, backlog: issues, order: [...sorted.map((i) => i.id), ...tail] };
}

/** '0s' '42s' '3m 5s' '7m' '1h 4m' '2d' — a briefing can sit for a day, and 1440m is unreadable. */
export function formatAge(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t < 1000) return '0s';
  const s = Math.floor(t / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rem = m % 60;
    return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  }
  return Math.floor(h / 24) + 'd';
}

/**
 * Colour never means urgency for an fyi — a briefing an hour old is still not urgent.
 *
 * `kind` picks the scale, and it is optional so every existing caller keeps the one it
 * had. Only 'idle' moves: see IDLE_WARN_MS for why a finished agent is not measured
 * against the same clock as a stopped one.
 */
export function ageColor(ms, urgency, kind) {
  if (urgency === 'fyi') return COLOR_MUTED;
  const t = Number(ms) || 0;
  const [warn, alert] = kind === 'idle'
    ? [IDLE_WARN_MS, IDLE_ALERT_MS]
    : [AGE_WARN_MS, AGE_ALERT_MS];
  if (t > alert) return COLOR_ALERT;
  if (t > warn) return COLOR_WARN;
  return COLOR_CALM;
}

/**
 * The one-line subject for a list row.
 *
 * "Do you want to proceed?" is what the most common blocked item says, identically,
 * in every session — eight of those rows is no improvement on Action Required's tab
 * names. Fold in the line above it, which is the tool banner that carries the meaning.
 */
export function itemSubject(item) {
  if (!item) return '';
  const headline = String(item.headline || '').trim();
  const contextLines = String(item.context || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const lead = contextLines.length ? contextLines[contextLines.length - 1] : '';
  if (!headline) return lead || String(item.question || '').trim();
  if (GENERIC_SUBJECT_RE.test(headline) && lead) return `${lead} — ${headline}`;
  return headline;
}

/**
 * The body text to render under the headline.
 *
 * A result has no headline argument of its own — its schema is prose — so the server
 * derives one from the first line of `summary` and keeps the WHOLE summary as the body,
 * which is the right call for the stored record and reads as a stutter on screen: the
 * H1 and the first line of the body are the same sentence. Drop the duplicate here
 * rather than truncating the record, so what is stored stays lossless and only the
 * rendering knows the two overlap.
 *
 * Scoped to results. A question's headline is a separate argument and any overlap with
 * its context is the agent's own doing.
 */
export function itemBody(item) {
  const context = String((item && item.context) || '');
  if (!item || item.kind !== 'result') return context;
  const headline = String(item.headline || '').trim();
  if (!headline) return context;
  const [first, ...rest] = context.split('\n');
  if (first.trim() !== headline) return context;
  return rest.join('\n').replace(/^\n+/, '');
}

/**
 * Is focus somewhere that owns its own keystrokes?
 *
 * A false negative means typing `e` in the reply box archives the item. A false
 * positive means `1`-`9` stop working the moment you click an option — which is
 * exactly when you would reach for them — so BUTTON must not count.
 */
export function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
}

/**
 * Map a bare keypress to an intent. Modifier handling stays in the JSX, because
 * whether a modifier is ours depends on where focus is.
 *
 * `repeat` blocks the two keys that commit — holding Enter must not fire ten answers,
 * and holding `e` must not archive the whole inbox — while leaving navigation
 * repeatable, which is what makes holding an arrow feel right.
 *
 * `issue` (#671) is set when the cursor is on a Backlog row. Nothing can be answered,
 * archived or option-picked on a GitHub issue, so those three return null rather than
 * firing against whatever inbox item happens to be nearby — and `g` opens the issue on
 * GitHub. Navigation, escape, help and `o` are identical either way, which is what lets
 * one cursor walk both sections.
 */
export function keyAction(key, { optionCount = 0, repeat = false, issue = false } = {}) {
  switch (key) {
    case 'ArrowDown': case 'j': return { type: 'move', delta: 1 };
    case 'ArrowUp': case 'k': return { type: 'move', delta: -1 };
    case 'Home': return { type: 'first' };
    case 'End': return { type: 'last' };
    case 'Escape': return { type: 'escape' };
    case '?': return { type: 'help' };
    case 'o': return { type: 'open' };
    case 'g': return issue ? { type: 'github' } : null;
    case 'r': return issue ? null : { type: 'focusReply' };
    // A Backlog row is a GitHub issue with no session behind it, so there is nothing to
    // hold a conversation with — same reason `r` and `e` go quiet there (#670).
    case 'c': return issue ? null : { type: 'toggleChat' };
    case 'e': return (issue || repeat) ? null : { type: 'archive' };
    // Session verbs (#682). Offered on every non-issue row and REFUSED by the caller
    // on the ones that cannot take them — a row whose session is gone, a merge on a
    // session that is not in a worktree. Deciding that here would mean this module
    // knowing what a worktree is, which is how a keymap turns into a policy.
    //
    // `x` and `m` are both repeat-blocked for the reason Enter is: holding a key must
    // not close five sessions. They also both go through a confirm in the panel, which
    // is the real guard — these two are the only keys in Workshop that are hard to undo.
    case 'x': return (issue || repeat) ? null : { type: 'closeSession' };
    case 'm': return (issue || repeat) ? null : { type: 'mergeWorktree' };
    case 'Enter': return (issue || repeat) ? null : { type: 'send' };
    default: break;
  }
  if (issue) return null;
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    return index < optionCount ? { type: 'pick', index } : null;
  }
  return null;
}

/**
 * What a keystroke means while focus is INSIDE a text box.
 *
 * Exactly two keys are ours in there; everything else — `e`, `o`, digits, bare Enter —
 * belongs to the box, and that is the "the inbox ate my letter e" fix. What the chat pane
 * (#670) adds is not a third key but a second box, and Cmd-Enter has to mean a different
 * thing in each: "send this answer" in the reply box, "send this message" in the composer.
 * The branch is therefore on WHICH box has focus, which is the honest distinction, and it
 * lives here rather than in the JSX so the whole truth table is testable.
 */
export function typingAction(key, { meta = false, chat = false } = {}) {
  if (key === 'Enter' && meta) return chat ? 'send-chat' : 'send-answer';
  // The composer sends on a bare Enter (Shift+Enter is a newline), which it handles on its
  // own element and stops from reaching the document. So a bare Enter never arrives here
  // from the composer, and in the reply box it is a newline like any other key.
  if (key === 'Escape') return 'blur';
  return null;
}

/**
 * Where the cursor goes after the list changed under it.
 *
 * The cursor follows the ITEM, not the position: at a 2s poll a row can move rank
 * without the human doing anything, and a cursor that stayed at index 3 would wander.
 * When the item is gone — answered here, or resolved in its own terminal — take its
 * place in the new list so the next thing is already selected.
 */
export function nextSelection(prevId, prevOrder, nextOrder) {
  const next = Array.isArray(nextOrder) ? nextOrder : [];
  if (next.length === 0) return null;
  if (prevId && next.includes(prevId)) return prevId;
  const prev = Array.isArray(prevOrder) ? prevOrder : [];
  const wasAt = prevId ? prev.indexOf(prevId) : -1;
  if (wasAt < 0) return next[0];
  return next[Math.min(wasAt, next.length - 1)];
}

/**
 * The index of a result's Approve option. Mirrors inbox.js's APPROVE_INDEX, which is
 * what mints the fixed pair — the panel never invents these two options, it renders the
 * ones the server sent.
 */
export const APPROVE_INDEX = 0;

/**
 * What to POST, or null when there is nothing to send.
 *
 * A blocked item never carries text: it is a live modal, a permission prompt has no
 * text field at all, and the server refuses it with a 400. Dropping it here means the
 * refusal is a design, not an error the user has to read.
 *
 * A result's Request changes needs text, and refusing here is the same idea applied to
 * the other end: an agent handed "Request changes" and nothing else learns only that it
 * was wrong, not how, and its next result is the same result. Approve needs none — the
 * work speaks for itself, and demanding a sentence to say yes is how a review gate
 * becomes a thing people turn off.
 */
export function answerPayload(item, { picked = null, draft = '' } = {}) {
  if (!item || item.kind === 'briefing') return null;
  const text = String(draft || '').trim();
  const hasPick = Number.isInteger(picked) && picked >= 0
    && Array.isArray(item.options) && picked < item.options.length;

  if (item.kind === 'blocked') {
    if (!hasPick) return null;
    const payload = { optionIndex: picked };
    const label = item.options[picked] && item.options[picked].label;
    if (label) payload.expect = fingerprint(label);
    return payload;
  }

  if (item.kind === 'result') {
    // Text alone is NOT a decision on a result: the server reads it as a request for
    // changes, and a human who typed a note meaning to approve would be surprised by
    // that. Make them press the button.
    if (!hasPick) return null;
    if (picked !== APPROVE_INDEX && !text) return null;
    const payload = { optionIndex: picked };
    if (text) payload.text = text;
    return payload;
  }

  if (hasPick) {
    const payload = { optionIndex: picked };
    if (text) payload.text = text;
    return payload;
  }
  // Where an idle row lands (#682), and deliberately: it carries no options and has
  // nothing to stage, so saying the next thing IS the whole answer. Empty text is null
  // rather than an empty payload — a bare Enter into a live composer submits whatever
  // is already sitting in it, which is not what "I pressed send on an empty box" means.
  return text ? { text } : null;
}

/**
 * Must stay byte-identical to dialog-parse.js's fingerprint(). The server compares the
 * label the human clicked against the label under the cursor at write time; if the two
 * sides normalize differently the comparison never matches and every answer is refused.
 */
export function fingerprint(label) {
  return String(label == null ? '' : label).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
}

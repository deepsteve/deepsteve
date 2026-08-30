/**
 * Workshop (#660) — one inbox for every agent that needs you.
 *
 * Three MCP tools let an agent post a question or a briefing; four REST routes let
 * the panel read the inbox and answer from it. Blocked sessions — the ones sitting
 * on a real Claude Code permission / AskUserQuestion dialog — are DERIVED per request
 * from ctx.shells and never stored, so they exist exactly as long as the dialog does.
 *
 * The panel POLLS its own /api/workshop/inbox rather than receiving a broadcast.
 * That is not an oversight: a new push feed would need a notifyX/onXChanged pair in
 * public/js/mod-manager.js plus a dispatch line in public/js/app.js, and this feature
 * ships with no host edit at all.
 *
 * ── Why Workshop deliberately does NOT go through requestMetaControlsConsent ──
 *
 * The meta-controls gate prices one specific risk: an AGENT typing into another
 * agent's session without the human knowing (#519). Every PTY write in this file
 * originates from a human pressing a key in the Workshop panel, in the host UI, on
 * this machine, behind the same auth cookie that already authorizes closing the
 * session outright. Routing it through the consent modal would ask the user to
 * approve their own click — and a DECLINE there starts a 60s cooldown that would then
 * block the next unrelated meta_type.
 *
 * The three MCP tools below write nothing to any PTY; they only append to the inbox.
 * The only PTY writes live in the answer paths, reachable exclusively from
 * POST /api/workshop/items/:id/answer, which no MCP tool calls. If that ever stops
 * being true — if an agent gains any way to answer another agent's item — this
 * decision must be revisited, because at that point Workshop becomes exactly the
 * thing #519 guards.
 */

const { z } = require('zod');
const projectScope = require('../../project-scope');
const inbox = require('./inbox');
const dialogParse = require('./dialog-parse');

// Stashed by init() and shared with registerRoutes(), the mods/scheduled-tasks and
// mods/project-mods pattern: mcp-server.js always calls init() first, and both halves
// need the same context object.
let ctx = null;

// Raw key bytes, from mods/deepsteve-core/tools.js's KEY_MAP.
const KEYS = { Up: '\x1b[A', Down: '\x1b[B', Enter: '\r' };

// meta_type's TIMINGS.keyGapMs. Ink only recognizes control bytes that arrive as
// SEPARATE stdin reads, so each byte is its own engine.write with this gap; sending
// "\x1b[B\x1b[B\r" in one write is not Down/Down/Enter, it is nothing at all.
const KEY_GAP_MS = 250;
const SETTLE_MS = 400;        // let the repaint reach the emulator before reading back
const MAX_STEPS = 12;         // refuse an implausible cursor journey rather than flail
const VERIFY_TRIES = 3;
const SCRAPE_ROWS = 30;
const WIDE_ROWS = 60;         // one retry when a 30-row read truncates the option run
const PREVIEW_ROWS = 15;
const READ_FRESH_TIMEOUT_MS = 1000;

// The MCP SDK's DEFAULT_REQUEST_TIMEOUT_MSEC is 60000
// (node_modules/@modelcontextprotocol/sdk/dist/cjs/shared/protocol.js). 50s leaves
// 10s of slack for transport and for our own bookkeeping either side of the hold.
// Raising this is not a free knob — past ~55s the request dies before the hold does
// and the agent sees an error instead of the fallback message.
const MAX_WAIT_SEC = 50;

// ctx.shells is EMPTY for a moment during the daemon's own boot, before sessions are
// restored. Don't run the dead-session sweep against that.
const BOOT_GRACE_MS = 60_000;
const BOOTED_AT = Date.now();

// Whether a digit key selects an option directly. Both false until measured against a
// real dialog on an isolated daemon: an unsupported digit lands in a text field, which
// is the worst failure this feature can have. The arrow path below is the fallback and
// stays regardless.
const DIGIT_SELECT = { permission: false, question: false };

// sessionId -> { seq, lines, detected, parsed, questionFp, blockedSince }
const scrapeCache = new Map();
// `${cwd}\0${worktree}` -> { project, projectName }
const projectCache = new Map();
const PROJECT_CACHE_MAX = 200;
// Sessions with a key dance in flight. A second concurrent answer would interleave
// two key streams into one dialog.
const inFlightChoices = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ content: [{ type: 'text', text: t }] });

// ── screen reading ───────────────────────────────────────────────────────────

/**
 * The listing read. linesSync, never ctx.readTerminalScreen, and all three reasons
 * bite at poll cadence:
 *
 *   1. readTerminalScreen lazily builds a fresh TerminalScreen and replays the ENTIRE
 *      scrollback when entry.terminalScreen is null — and would install an emulator on
 *      sessions that deliberately have none;
 *   2. it awaits idlePromise, which a session producing sustained output can defer
 *      indefinitely, stalling the whole /inbox response on one chatty tab;
 *   3. it is async, so a listing fans out one await per session.
 *
 * linesSync returns [] on a disposed screen and is a bounded backward scan. The cost
 * is that a chunk still in xterm's parse queue is not reflected — at most one poll of
 * staleness in a LISTING. The answer path uses readFresh instead.
 */
function screenLines(entry, n) {
  const scr = entry && entry.terminalScreen;
  if (!scr || typeof scr.linesSync !== 'function') return [];
  try {
    return scr.linesSync(n) || [];
  } catch {
    return [];
  }
}

/**
 * The answer-path read, where being one frame stale means pressing the wrong button.
 * Awaits the emulator's parse queue but races a timeout, so sustained output cannot
 * hang the request. Still never resurrects a disposed emulator.
 */
async function readFresh(entry, n) {
  const scr = entry && entry.terminalScreen;
  if (!scr) return [];
  const sync = () => screenLines(entry, n);
  if (typeof scr.lines !== 'function') return sync();
  try {
    return await Promise.race([
      scr.lines(n),
      new Promise((r) => setTimeout(() => r(sync()), READ_FRESH_TIMEOUT_MS)),
    ]);
  } catch {
    return sync();
  }
}

// ── project resolution ───────────────────────────────────────────────────────

/**
 * Cached because canonicalRoot runs findGitRoot (an fs walk) plus a statSync, and the
 * listing would otherwise redo that for every session at poll cadence for an answer
 * that essentially never changes.
 */
function projectFor(entry) {
  const key = (entry.cwd || '') + '\0' + (entry.worktree || '');
  let hit = projectCache.get(key);
  if (!hit) {
    let project = '';
    try {
      const { repoRoot } = ctx.sessionPaths(entry);
      project = projectScope.canonicalRoot(repoRoot || entry.cwd || '') || '';
    } catch {
      project = '';
    }
    hit = { project, projectName: projectScope.displayName(project) };
    if (projectCache.size >= PROJECT_CACHE_MAX) projectCache.clear();
    projectCache.set(key, hit);
  }
  return hit;
}

/**
 * Who is asking, and about what. The agent never supplies any of this — sessionId
 * comes off the shellId query param already on every MCP request, and the project is
 * derived from the session, so the inbox groups by project for free.
 */
function callerFields(extra) {
  const shellId = projectScope.callerShellId(extra);
  const entry = shellId ? ctx.shells.get(shellId) : null;
  // The shared #659 helper rather than projectFor(): this runs once per tool call,
  // not per session per poll, so the cache is not worth the divergence.
  const project = projectScope.resolveProject(null, shellId, ctx);
  return {
    sessionId: shellId,
    sessionName: (entry && entry.name) || null,
    worktree: (entry && entry.worktree) || null,
    project,
    projectName: projectScope.displayName(project),
  };
}

// ── derived blocked items ────────────────────────────────────────────────────

/**
 * Which of the three answer paths WOULD fire for a stored item, computed now. The
 * panel's send bar names it before you press Enter, because the three behave
 * completely differently and "resolves the agent's pending call" and "types into a
 * live dialog" should not look identical.
 */
function pendingPathFor(item) {
  if (inbox.hasWait(item.id)) return 'held';
  if (item.sessionId && ctx.shells.has(item.sessionId)) return 'prompt';
  return null;
}

function serializeStored(item) {
  return {
    ...item,
    pendingPath: pendingPathFor(item),
    sessionAlive: !!(item.sessionId && ctx.shells.has(item.sessionId)),
    answerable: item.kind !== 'briefing' && item.status === 'open',
  };
}

function scrapeFor(id, entry, now) {
  const seq = entry.outputSeq != null ? entry.outputSeq : (entry.lastActivity || 0);
  const prev = scrapeCache.get(id);
  if (prev && prev.seq === seq) return prev;

  let lines = screenLines(entry, SCRAPE_ROWS);
  let detected = dialogParse.detectDialog(lines);
  let parsed = detected ? dialogParse.parseDialog(lines) : null;

  // A dialog we can see but not read may simply have been cut off by the 30-row
  // window — nine options with wrapped labels overflow it. Widen once before giving
  // up and falling back to a raw preview.
  if (detected && !parsed) {
    const wide = screenLines(entry, WIDE_ROWS);
    if (wide.length > lines.length) {
      const wideDetected = dialogParse.detectDialog(wide);
      const wideParsed = wideDetected ? dialogParse.parseDialog(wide) : null;
      if (wideParsed) {
        lines = wide;
        detected = wideDetected;
        parsed = wideParsed;
      }
    }
  }

  const questionFp = parsed
    ? dialogParse.fingerprint(parsed.question || parsed.headline)
    : '';
  // Carry the clock forward across a repaint: a status-line tick or a resize bumps
  // outputSeq without changing the question, and resetting the age there would make
  // the wait colouring meaningless.
  const blockedSince = (prev && prev.blockedSince && prev.questionFp === questionFp)
    ? prev.blockedSince
    : now;

  const fresh = { seq, lines, detected, parsed, questionFp, blockedSince };
  scrapeCache.set(id, fresh);
  return fresh;
}

function derivedItems(now) {
  const out = [];
  const live = new Set();

  for (const [id, entry] of ctx.shells) {
    live.add(id);
    if (!entry || entry.killed) continue;
    // A tmux-attach entry is somebody else's terminal; we do not drive it.
    if (entry.agentType === 'tmux-attach') continue;
    // A cheap pre-filter, NOT the truth: sessionInputState maps 'waiting' to 'idle',
    // and 'idle' covers a session sitting at an empty composer just as much as one
    // showing a dialog. detectDialog below is the real membership gate.
    if (!entry.waitingForInput) continue;
    // Cost control: never make readTerminalScreen build an emulator from scrollback.
    if (!entry.terminalScreen) continue;

    const scrape = scrapeFor(id, entry, now);
    if (!scrape.detected) continue;

    const { project, projectName } = projectFor(entry);
    const parsed = scrape.parsed;
    out.push({
      id: inbox.blockedId(id),
      kind: 'blocked',
      status: 'open',
      urgency: 'blocking',
      sessionId: id,
      sessionName: entry.name || null,
      project,
      projectName,
      worktree: entry.worktree || null,
      dialogKind: scrape.detected.kind,
      headline: parsed ? parsed.headline : 'Waiting on a dialog',
      question: parsed ? parsed.question : '',
      context: parsed ? parsed.context.join('\n') : '',
      options: parsed
        ? parsed.options.map((o) => ({ label: o.label, selected: o.selected }))
        : [],
      recommendation: '',
      cursorIndex: parsed ? parsed.cursorIndex : null,
      multi: parsed ? parsed.multi : null,
      // Unparseable, or parsed with no locatable cursor, means we cannot move
      // relative to anything — the card falls back to a raw preview and "open the tab".
      answerable: !!(parsed && parsed.cursorIndex !== null),
      preview: parsed ? null : scrape.lines.slice(-PREVIEW_ROWS),
      createdAt: scrape.blockedSince,
      answeredAt: null,
      answer: null,
      deliveredVia: null,
      dismissedReason: null,
      pendingPath: 'dialog',
      sessionAlive: true,
      inFlight: inFlightChoices.has(id),
    });
  }

  for (const id of [...scrapeCache.keys()]) {
    if (!live.has(id)) scrapeCache.delete(id);
  }
  return out;
}

// ── path 3: answering a live dialog ──────────────────────────────────────────

function engineFor(entry) {
  return entry.engine || (ctx.getDefaultEngine && ctx.getDefaultEngine()) || null;
}

/**
 * Move the cursor RELATIVE to where it already is, confirm it landed, and only then
 * commit. #607's "confirmed, not assumed" lesson applied to a menu.
 *
 * Deliberately not submitToShell: its confirmEcho waits for the composer to echo the
 * text, and a modal has no composer, so every answer would burn the full cap waiting
 * for an echo that can never arrive.
 *
 * `expectFp` is the fingerprint of the label the human actually clicked. Between the
 * poll that drew the card and the click, the dialog can be replaced by a DIFFERENT
 * dialog with the same number of options, and a bare index comparison would happily
 * press the wrong button. Checked before the first key and again before Enter.
 */
async function sendChoice(sessionId, targetIndex, expectFp) {
  const entry = ctx.shells.get(sessionId);
  if (!entry) return { ok: false, reason: 'session-gone' };

  const before = dialogParse.parseDialog(await readFresh(entry, SCRAPE_ROWS));
  if (!before) return { ok: false, reason: 'no-dialog' };
  if (before.cursorIndex === null) return { ok: false, reason: 'no-cursor' };
  if (targetIndex >= before.options.length) return { ok: false, reason: 'bad-option' };
  if (expectFp && dialogParse.fingerprint(before.options[targetIndex].label) !== expectFp) {
    return { ok: false, reason: 'dialog-changed' };
  }

  const delta = targetIndex - before.cursorIndex;
  if (Math.abs(delta) > MAX_STEPS) return { ok: false, reason: 'too-far' };
  const key = delta > 0 ? KEYS.Down : KEYS.Up;

  for (let i = 0; i < Math.abs(delta); i++) {
    // Re-checked INSIDE the loop: at 250ms per key this can outlive the session.
    const live = ctx.shells.get(sessionId);
    if (!live || live.killed) return { ok: false, reason: 'session-gone' };
    const engine = engineFor(live);
    if (!engine) return { ok: false, reason: 'no-engine' };
    engine.write(sessionId, key);
    await sleep(KEY_GAP_MS);
  }

  await sleep(SETTLE_MS);

  let landed = null;
  let swapped = false;
  for (let attempt = 0; attempt < VERIFY_TRIES; attempt++) {
    const live = ctx.shells.get(sessionId);
    if (!live || live.killed) return { ok: false, reason: 'session-gone' };
    const after = dialogParse.parseDialog(await readFresh(live, SCRAPE_ROWS));
    if (after && after.cursorIndex === targetIndex) {
      const label = (after.options[targetIndex] || {}).label;
      if (!expectFp || dialogParse.fingerprint(label) === expectFp) { landed = after; break; }
      // The cursor went where we asked, but the row under it is no longer the row the
      // human clicked — the dialog was replaced mid-dance. A distinct reason, because
      // "retry" is right for a cursor that lagged and wrong for a swapped dialog.
      swapped = true;
    }
    await sleep(KEY_GAP_MS);
  }

  // THE point of the whole dance. An unverified Enter commits an unknown option in
  // someone's live session. Leaving the cursor moved but uncommitted is a real but
  // small side effect and strictly the better failure. We deliberately do NOT send
  // Escape to "restore": Escape cancels the dialog, which is a decision the human
  // did not make.
  if (!landed) {
    return {
      ok: false,
      reason: swapped ? 'dialog-changed' : 'cursor-did-not-land',
      steps: Math.abs(delta),
    };
  }

  const live = ctx.shells.get(sessionId);
  if (!live || live.killed) return { ok: false, reason: 'session-gone' };
  const engine = engineFor(live);
  if (!engine) return { ok: false, reason: 'no-engine' };
  engine.write(sessionId, KEYS.Enter);

  return {
    ok: true,
    steps: Math.abs(delta),
    direction: delta > 0 ? 'Down' : delta < 0 ? 'Up' : 'none',
    optionLabel: landed.options[targetIndex].label,
  };
}

// ── prompt text for path 2 ───────────────────────────────────────────────────

function answerSubject(item) {
  const raw = (item.headline || item.question || '').split('\n')[0].trim();
  return raw ? raw.slice(0, 200) : `question #${item.seq}`;
}

function formatAnswer(answer) {
  if (!answer) return '(no answer)';
  const parts = [];
  if (answer.optionLabel) parts.push(answer.optionLabel);
  if (answer.text) parts.push(answer.text);
  return parts.join('\n\n') || '(no answer)';
}

function answerPrompt(item) {
  return `[Workshop] Re: ${answerSubject(item)}\n\n${formatAnswer(item.answer)}`;
}

// ── MCP tools ────────────────────────────────────────────────────────────────

function init(context) {
  ctx = context;

  return {
    workshop_ask: {
      description:
        'Ask the human a question and put it on the Workshop inbox — the one surface they watch '
        + 'for everything that needs them. Returns IMMEDIATELY by default: the answer arrives '
        + 'later as a new message in this session, so end your turn instead of polling. Use it '
        + 'for a decision you genuinely cannot make alone, not for progress updates (use '
        + 'workshop_brief for those). Supply `options` whenever the decision is a choice — a '
        + 'human answers a menu far faster than a paragraph — and say which one you would pick '
        + 'in `recommendation`. Set `wait_seconds` only when you truly cannot proceed and a '
        + 'quick yes unblocks you. You never identify yourself: session, project and worktree '
        + 'are attached automatically.',
      schema: {
        question: z.string().describe('The decision you need, in one sentence, phrased so it can be answered without opening your tab.'),
        context: z.string().optional().describe('What the human needs in order to answer: what you tried, what is at stake, the file or command involved. Markdown is fine.'),
        options: z.array(z.object({
          label: z.string().describe('Short and pickable — a button caption, not a sentence.'),
          detail: z.string().optional().describe('One line on what choosing this means.'),
        })).max(9).optional().describe('The choices, in the order to show them. Max 9 — the inbox binds keys 1-9.'),
        recommendation: z.string().optional().describe('Which option you would pick and why, in one line.'),
        urgency: z.enum(['fyi', 'normal', 'blocking']).optional().describe('"blocking" means you are stopped until this is answered; it sorts to the top of the inbox. Default "normal".'),
        wait_seconds: z.number().int().min(1).max(MAX_WAIT_SEC).optional().describe(`Hold this call open up to N seconds waiting for an answer (1-${MAX_WAIT_SEC}). Omit unless you cannot continue — the MCP request itself dies at 60s.`),
      },
      handler: async (args, extra) => {
        if (inbox.openCount() >= inbox.MAX_OPEN) {
          return text(
            `The Workshop inbox already has ${inbox.MAX_OPEN} unanswered items, so this question `
            + 'was not added. Something is posting questions nobody is answering — stop and tell '
            + 'the user rather than retrying.',
          );
        }

        const item = inbox.add({
          kind: 'question',
          ...callerFields(extra),
          urgency: args.urgency,
          headline: args.question,
          context: args.context,
          options: args.options,
          recommendation: args.recommendation,
        });
        inbox.save();
        ctx.log(
          `[workshop] ask ${item.id} session=${item.sessionId || '?'} urgency=${item.urgency} `
          + `options=${item.options.length} wait=${args.wait_seconds || 0}`,
        );

        // Re-clamped even though the schema bounds it: `schema` is a raw Zod shape and
        // a non-validating client can hand the handler anything.
        const seconds = Number(args.wait_seconds) || 0;
        if (seconds > 0) {
          const ms = Math.min(MAX_WAIT_SEC, Math.max(1, Math.floor(seconds))) * 1000;
          const answer = await inbox.holdForAnswer(item, ms);
          if (answer) return text(`Answer to #${item.seq}: ${formatAnswer(answer)}`);
        }

        return text(
          `Question #${item.seq} is on the Workshop inbox. The answer will arrive as a new `
          + 'message — end your turn now rather than polling.',
        );
      },
    },

    workshop_brief: {
      description:
        'Post a short briefing to the Workshop inbox — something the human should see but does '
        + 'not have to answer. A milestone reached, a judgement call worth knowing about, '
        + 'something surprising you found. It needs no reply and archives with one key. Do not '
        + 'use it to ask a question (use workshop_ask), and do not narrate routine progress: a '
        + 'briefing that says nothing trains the human to stop reading them.',
      schema: {
        headline: z.string().describe('One line carrying the whole point, useful with nothing else read.'),
        detail: z.string().optional().describe('Supporting detail. Markdown is fine.'),
        tag: z.string().optional().describe('A short label grouping related briefings, e.g. "release" or "issue-660".'),
      },
      handler: async (args, extra) => {
        const item = inbox.add({
          kind: 'briefing',
          ...callerFields(extra),
          headline: args.headline,
          context: args.detail,
          tag: args.tag,
        });
        inbox.save();
        ctx.log(`[workshop] brief ${item.id} session=${item.sessionId || '?'} tag=${item.tag || '-'}`);
        return text(`Briefing #${item.seq} is on the Workshop inbox. No reply is needed.`);
      },
    },

    workshop_check: {
      description:
        'Check whether a Workshop question has been answered yet, by the ticket number '
        + 'workshop_ask returned. Only needed if you chose to keep working instead of ending '
        + 'your turn; the normal path is to end your turn and let the answer arrive as a new '
        + 'message. Returns the answer if one is in, otherwise says it is still open.',
      schema: {
        ticket: z.string().describe('The ticket workshop_ask returned, e.g. "12" or "#12".'),
      },
      handler: async ({ ticket }) => {
        const id = inbox.normalizeTicket(ticket);
        if (!id) {
          return text(`"${ticket}" is not a ticket number. Use the number workshop_ask returned, e.g. "12".`);
        }
        const item = inbox.byId(id);
        if (!item) return text(`There is no Workshop item ${id}.`);
        if (item.status === 'dismissed') {
          return text(`#${item.seq} was archived without an answer${item.dismissedReason ? ` (${item.dismissedReason})` : ''}. Do not wait on it.`);
        }
        if (item.status !== 'answered') {
          return text(
            `#${item.seq} is still open. Rather than checking again, end your turn — the answer `
            + 'will arrive as a new message in this session when the human gets to it.',
          );
        }
        return text(`Answer to #${item.seq}: ${formatAnswer(item.answer)}`);
      },
    },
  };
}

// ── REST ─────────────────────────────────────────────────────────────────────

function registerRoutes(app, context) {
  ctx = ctx || context;

  app.get('/api/workshop/inbox', (req, res) => {
    const now = Date.now();
    const stored = inbox.all();

    // Skip the sweep entirely while ctx.shells might still be filling up after boot,
    // or every restart dismisses the whole inbox.
    if (ctx.shells.size > 0 || now - BOOTED_AT > BOOT_GRACE_MS) {
      const changed = inbox.sweepDeadSessions(stored, (sid) => ctx.shells.has(sid), now);
      if (changed) inbox.save();
    }

    const includeClosed = req.query.all === '1';
    const items = inbox.sortForInbox([
      ...stored.filter((i) => includeClosed || i.status === 'open').map(serializeStored),
      ...derivedItems(now),
    ]);
    res.json({ items, generatedAt: now });
  });

  app.post('/api/workshop/items/:id/answer', async (req, res) => {
    const body = req.body || {};
    const blockedSession = inbox.parseBlockedId(req.params.id);
    if (blockedSession) return answerBlocked(res, blockedSession, body);
    return answerStored(res, req.params.id, body);
  });

  app.post('/api/workshop/items/:id/dismiss', (req, res) => {
    if (inbox.parseBlockedId(req.params.id)) {
      // A live dialog is not dismissible from an inbox: Escape IS a decision, and a
      // snooze would need exactly the derived-item state this design removes.
      return res.status(400).json({
        error: 'not-dismissible',
        hint: 'This is a live dialog, not a stored item. Answer it, or open the tab and deal with it there.',
      });
    }
    const item = inbox.byId(req.params.id);
    if (!item) return res.status(404).json({ error: 'not-found' });
    const status = inbox.applyDismiss(item, (req.body && req.body.reason) || 'archived');
    if (status !== 'ok') {
      return res.status(409).json({ error: status, item: serializeStored(item) });
    }
    inbox.save();
    ctx.log(`[workshop] dismiss ${item.id} reason=${item.dismissedReason}`);
    res.json({ item: serializeStored(item) });
  });

  app.get('/api/workshop/items/:id/screen', async (req, res) => {
    const stored = inbox.byId(req.params.id);
    const sessionId = inbox.parseBlockedId(req.params.id) || (stored && stored.sessionId);
    if (!sessionId) return res.status(404).json({ error: 'not-found' });
    const entry = ctx.shells.get(sessionId);
    if (!entry) return res.status(404).json({ error: 'session-gone' });
    const n = Math.max(1, Math.min(WIDE_ROWS, Number(req.query.lines) || PREVIEW_ROWS));
    res.json({ lines: screenLines(entry, n), state: ctx.sessionInputState(entry) });
  });
}

function answerStored(res, id, body) {
  const item = inbox.byId(id);
  if (!item) return res.status(404).json({ error: 'not-found' });

  const status = inbox.applyAnswer(item, { text: body.text, optionIndex: body.optionIndex });
  if (status !== 'ok') {
    // 409 for the two-browsers race, 400 for a malformed answer.
    return res.status(status === 'not-open' ? 409 : 400)
      .json({ error: status, item: serializeStored(item) });
  }

  // Path 1 BEFORE path 2, and only after applyAnswer, so a concurrent workshop_check
  // can never observe "answered, but no answer".
  let via;
  if (inbox.releaseWait(item.id, item.answer)) {
    via = 'inline';
  } else if (item.sessionId && ctx.shells.has(item.sessionId)) {
    // The FIFO, never submitToShell and never e.pendingDelivery directly — the queue
    // is what sequences this behind anything already staged for the session.
    ctx.deliverPromptWhenReady(item.sessionId, answerPrompt(item), {
      source: 'workshop',
      skipIf: (sid) => !ctx.shells.has(sid),
      skipReason: 'session gone before the Workshop answer could be delivered',
      onDeliver: (sid) => ctx.log(`[workshop] delivered ${item.id} -> ${sid}`),
    });
    via = 'prompt';
  } else {
    // Say so rather than swallowing it. An inbox that silently drops an answer is
    // worse than one that admits it went nowhere.
    via = 'undelivered';
  }

  item.deliveredVia = via;
  inbox.save();
  const opt = item.answer.optionIndex === null ? '-' : String(item.answer.optionIndex + 1);
  // Length, never content.
  ctx.log(
    `[workshop] answer ${item.id} via=${via} option=${opt} `
    + `${item.answer.optionLabel ? JSON.stringify(item.answer.optionLabel) : ''} `
    + `text=${item.answer.text.length}ch`,
  );
  res.json({ item: serializeStored(item), deliveredVia: via });
}

async function answerBlocked(res, sessionId, body) {
  const hasIndex = body.optionIndex !== undefined && body.optionIndex !== null && body.optionIndex !== '';
  if (!hasIndex) {
    // Free text into a modal is refused by design. A permission prompt has no text
    // field at all, and Escape-then-type would cancel the very tool call the agent
    // was asking about — a decision the human did not make.
    return res.status(400).json({
      error: 'text-not-answerable',
      hint: 'This session is showing a dialog — pick one of its options, or press o to open the tab and answer it there.',
    });
  }

  const idx = Number(body.optionIndex);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'bad-option' });

  const entry = ctx.shells.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'session-gone' });
  if (inFlightChoices.has(sessionId)) return res.status(409).json({ error: 'busy' });

  inFlightChoices.add(sessionId);
  try {
    const result = await sendChoice(sessionId, idx, body.expect || '');
    // Whatever happened, the cached screen is stale now.
    scrapeCache.delete(sessionId);

    if (!result.ok) {
      ctx.log(`[workshop] answer blocked:${sessionId} REFUSED reason=${result.reason}`
        + `${result.steps ? ` steps=${result.steps}` : ''} — no Enter sent`);
      return res.status(409).json(result);
    }

    // logRcWrite only logs text matching /(^|\s)\/rc(\s|$)/ — deliberately not a
    // keylogger — and arrow keys plus \r can never match it, so it is a genuine
    // no-op on this path. THIS line is the only record that a human moved a cursor
    // and pressed Enter in someone else's session. Do not delete it as redundant.
    ctx.log(
      `[workshop] answer blocked:${sessionId} via=keys steps=${result.steps} `
      + `dir=${result.direction} option=${idx + 1} ${JSON.stringify(result.optionLabel)} verified=yes`,
    );
    res.json({ ok: true, ...result });
  } finally {
    inFlightChoices.delete(sessionId);
  }
}

module.exports = { init, registerRoutes };

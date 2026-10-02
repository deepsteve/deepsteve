const { z } = require('zod');
const { randomUUID } = require('crypto');

// html | file_path | replacements resolution is shared with Project Mods (#618),
// so it lives at the root rather than here. See html-source.js.
const { resolveHtml } = require('../../html-source.js');
const decision = require('./decision.js');
// The same "is a modal on screen?" gate Inbox's chat endpoint uses, rather than a second one.
const dialogParse = require('../inbox/dialog-parse.js');
const projectScope = require('../../project-scope');

const DIALOG_ROWS = 30;
const DECISION_BAR_SRC = '/mods/display-tab/decision-bar.js';

// How long a choice nobody is waiting for is held for an await_decision call to claim it
// before it is typed instead. Covers an agent between create_display_tab and its
// await_decision, and one re-calling after a dropped transport (2-3s in every measurement).
const CLAIM_GRACE_MS = 10_000;
// How long an answer handed to a waiting call has to show up in the transcript before it is
// typed instead. It is written within ~100ms when it arrives at all.
const CONFIRM_MS = 30_000;
const CONFIRM_POLL_MS = 1_000;
const DELIVERED_KEEP = 200;

// Stashed by init() and shared with registerRoutes(): mcp-server.js always calls init()
// first, and both halves need the same context and store.
let ctx = null;
let store = null;

// #716: an answer is the RESULT of the agent's own await_decision call wherever possible, so
// nothing is typed into a TUI whose composer we would have to read first. Three maps, all
// in-memory — a daemon restart drops every held call anyway, and the agent calls again:
//   waiters   — the call holding for each tab. At most one: a second call for the same tab
//               replaces the first, which Claude Code may have abandoned without telling us.
//   unclaimed — a choice made while no call was holding. Typed after CLAIM_GRACE_MS unless a
//               call claims it first; a call can claim it until the typing actually starts.
//   delivered — where recent answers went, so a late call can say so instead of waiting forever.
const waiters = new Map();    // tabId → { owner, finish(outcome) }
const unclaimed = new Map();  // tabId → { owner, prompt, timer }
const delivered = new Map();  // tabId → 'tool' | 'typed'

const decisionSchema = z.object({
  buttons: z.array(z.object({
    label: z.string().describe('Button text, short (≤60 chars)'),
    sends: z.string().optional().describe('What you receive when this button is clicked, if more than the label'),
    style: z.enum(decision.STYLES).optional().describe('"primary", "danger" or "default"'),
    confirm: z.boolean().optional().describe('Ask "are you sure?" in the page before sending (overrides decision.confirm)'),
  })).describe(`1–${decision.MAX_BUTTONS} buttons, rendered left to right along the bottom of the tab`),
  prompt: z.string().optional().describe('One line shown above the buttons, e.g. the question itself'),
  confirm: z.boolean().optional().describe('Default for every button that does not set its own confirm (default false)'),
  close_on_decision: z.boolean().optional().describe('Close the tab once a choice is sent (default true)'),
  allow_note: z.boolean().optional().describe('Show a free-text note field whose contents arrive with the choice (default false)'),
}).optional();

function sendToClients(msg) {
  const data = JSON.stringify(msg);
  for (const client of ctx.reloadClients) {
    if (client.readyState === 1) client.send(data);
  }
}

/** Decision tabs still waiting on an answer — what the client's Decision Tab mode lists. */
function openDecisionTabs() {
  return store.list()
    .filter(r => r.status === 'open')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(r => ({ id: r.id, name: r.name, ownerSessionId: r.ownerSessionId, createdAt: r.createdAt }));
}

function broadcastDecisionTabs() {
  sendToClients({ type: 'decision-tabs', tabs: openDecisionTabs() });
}

// Also server.js's display-tab delete hook, so a tab the user ✕-closes (DELETE
// /api/display-tab/:id, which this mod does not own) leaves Decision Tab mode everywhere.
function forgetDecision(id) {
  // A tab closed with no choice made releases the call holding for it.
  const w = waiters.get(id);
  if (w) w.finish({ closed: true });
  if (!store.get(id)) return;
  store.remove(id);
  broadcastDecisionTabs();
}

function noteDelivered(id, how) {
  delivered.delete(id);
  delivered.set(id, how);
  while (delivered.size > DELIVERED_KEEP) delivered.delete(delivered.keys().next().value);
}

/** Hold the agent's await_decision call until the tab is answered, closed, replaced or cancelled. */
function holdForChoice(id, owner, signal) {
  const prev = waiters.get(id);
  if (prev) prev.finish({ superseded: true });
  return new Promise((resolve) => {
    const w = {
      owner,
      finish: (outcome) => {
        if (waiters.get(id) === w) waiters.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      },
    };
    // Esc in Claude Code sends notifications/cancelled, which the SDK turns into this abort.
    const onAbort = () => w.finish({ aborted: true });
    waiters.set(id, w);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Type the choice into the owning session after `delayMs`, unless an await_decision call
 * claims it first. The path for an agent that never calls await_decision, and the fallback
 * for an answer that never reached the conversation.
 */
function typeUnlessClaimed(id, owner, prompt, delayMs) {
  const u = { owner, prompt, timer: null };
  unclaimed.set(id, u);
  u.timer = setTimeout(() => {
    // The FIFO, never submitToShell and never e.pendingDelivery. midTurn: typed as soon as the
    // composer is empty, even while the agent works, and Claude Code hands it over at the next
    // tool boundary. A message pushed through a Claude Code channel instead would arrive as
    // untrusted third-party content, which the model declines to act on (measured on 2.1.283).
    ctx.deliverPromptWhenReady(owner, prompt, {
      source: 'decision-tab',
      midTurn: true,
      // Evaluated immediately before typing, so a call that claimed the choice while this
      // waited for an empty composer wins.
      skipIf: (sid) => !ctx.shells.has(sid) || unclaimed.get(id) !== u,
      skipReason: 'session gone, or an await_decision call took the decision-tab choice first',
      onDeliver: (sid) => {
        if (unclaimed.get(id) === u) unclaimed.delete(id);
        noteDelivered(id, 'typed');
        ctx.log(`[decision-tab] delivered ${id} -> ${sid} (typed)`);
      },
    });
  }, delayMs);
  if (u.timer.unref) u.timer.unref();
}

/** The choice waiting in `unclaimed` for this tab, taken so it is never also typed. */
function claimUnclaimed(id) {
  const u = unclaimed.get(id);
  if (!u) return null;
  clearTimeout(u.timer);
  unclaimed.delete(id);
  noteDelivered(id, 'tool');
  return u.prompt;
}

/**
 * Give the choice to the call holding for it, then make sure it reached the conversation:
 * a call Claude Code abandoned can still look alive from here (see answerInTranscript), so
 * an answer not in the transcript within CONFIRM_MS is typed instead.
 */
function answerWaiter(id, owner, prompt) {
  const at = Date.now();
  waiters.get(id).finish({ prompt });
  noteDelivered(id, 'tool');
  const entry = ctx.shells.get(owner);
  const file = entry && typeof ctx.transcriptPath === 'function' ? ctx.transcriptPath(entry) : null;
  if (!file) {
    ctx.log(`[decision-tab] delivered ${id} -> ${owner} (await_decision result; no transcript to confirm it against)`);
    return;
  }
  const poll = () => {
    if (decision.answerInTranscript(file, id, at - 2000)) {
      ctx.log(`[decision-tab] delivered ${id} -> ${owner} (await_decision result, in the transcript after ${Date.now() - at}ms)`);
      return;
    }
    if (!ctx.shells.has(owner)) return;
    if (Date.now() - at >= CONFIRM_MS) {
      ctx.log(`[decision-tab] ${id} -> ${owner}: an await_decision call took the choice but it is not in the transcript after ${CONFIRM_MS / 1000}s — typing it instead`);
      typeUnlessClaimed(id, owner, prompt, 0);
      return;
    }
    const t = setTimeout(poll, CONFIRM_POLL_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(poll, CONFIRM_POLL_MS);
  if (t.unref) t.unref();
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const refuse = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

// Returns whether the tab closed. A locked tab is refused inside deleteDisplayTab (#715), and
// only the exact string counts — a fake deleteDisplayTab in a test returns a boolean.
function closeTab(id) {
  if (ctx.deleteDisplayTab(id) === 'locked') return false;
  forgetDecision(id);
  sendToClients({ type: 'close-display-tab', id });
  return true;
}

function showingDialog(entry) {
  const scr = entry && entry.terminalScreen;
  if (!scr || typeof scr.linesSync !== 'function') return false;
  try { return !!dialogParse.detectDialog(scr.linesSync(DIALOG_ROWS) || []); } catch { return false; }
}

// Served-time injection, so edit_display_tab / update_display_tab can never strip the bar.
/*
 * Ahead of the page's own scripts, so it sees the page read its saved picks on load (#721): every
 * localStorage key the page touches is recorded, and the bar sends their values with the click.
 * The bar itself loads at the end of <body> and would only ever see writes made after it.
 */
const STORAGE_TRACKER = '<script>(function(){try{var S=Storage.prototype,k=window.__dsdKeys=window.__dsdKeys||new Set();'
  + "['getItem','setItem','removeItem'].forEach(function(n){var f=S[n];S[n]=function(key){"
  + 'try{if(this===window.localStorage)k.add(String(key));}catch(e){}return f.apply(this,arguments);};});}catch(e){}})();</script>';

function injectDecisionBar(html, id) {
  if (!store || !store.get(id)) return html;
  const tag = `<script src="${DECISION_BAR_SRC}" defer></script>`;
  const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  html = at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
  // First thing in <head>, or before the first <script> of a page without one.
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head) return html.slice(0, head.index + head[0].length) + STORAGE_TRACKER + html.slice(head.index + head[0].length);
  const script = html.search(/<script[\s>]/i);
  return script >= 0 ? html.slice(0, script) + STORAGE_TRACKER + html.slice(script) : STORAGE_TRACKER + html;
}

function init(context) {
  ctx = context;
  const { shells, reloadClients, pendingOpens, log, displayTabs, setDisplayTab, sessionPaths, isDisplayTabLocked, setDisplayTabLocked } = context;
  // Lazy: nothing is read from disk until a decision tab is asked about.
  store = decision.createDecisionStore({ isLive: (id) => displayTabs.has(id) });
  if (typeof context.registerDisplayTabHooks === 'function') {
    context.registerDisplayTabHooks('decision', {
      inject: injectDecisionBar,
      onDelete: forgetDecision,
      onConnect: () => ({ type: 'decision-tabs', tabs: openDecisionTabs() }),
    });
  }

  return {
    create_display_tab: {
      description: 'Create a new browser tab displaying arbitrary HTML content (charts, dashboards, reports). The HTML is rendered in a sandboxed iframe. Supply the page EITHER inline via html OR — cheaper, preferred when the page already exists on disk — via file_path, which the server reads itself so you do not re-emit the document as output tokens. The page is served from the deepsteve origin, so use window.location.origin or relative /api/... URLs to call back into deepsteve; never hard-code a port. Pass your DEEPSTEVE_SESSION_ID so the tab opens in the same browser window and is scoped to your Project view (it appears only in the project you spawned it from, like a regular session tab). Pass `decision` to add a row of buttons, then call await_decision with the returned id to receive the click. Pass `locked: true` for a page the user wants kept: a locked tab cannot be closed until someone unlocks it.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — targets the correct browser window and scopes the tab to your project'),
        html: z.string().optional().describe('Full HTML content to display (can include inline CSS/JS, e.g. Chart.js visualizations). Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads instead of you passing html. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied to the HTML server-side, e.g. {"%%CHANNEL%%": "slot-ab3f9c12"} — lets a file on disk stay a reusable template'),
        name: z.string().optional().describe('Tab name (defaults to "Display")'),
        decision: decisionSchema.describe('Make this a decision tab: a row of buttons along the bottom. Then call await_decision with the returned id — it returns the choice ("[Decision tab …] The user chose: …").'),
        locked: z.boolean().optional().describe('Lock the tab so it cannot be closed — by the user\'s ✕ or by close_display_tab — until it is unlocked (update_display_tab with locked:false, or the tab\'s right-click menu). Default false'),
      },
      handler: async ({ session_id, html, file_path, replacements, name, decision: rawDecision, locked }) => {
        const resolved = resolveHtml({ html, file_path, replacements });
        if (resolved.error) {
          return { content: [{ type: 'text', text: resolved.error }], isError: true };
        }
        html = resolved.html;

        let config = null;
        if (rawDecision) {
          const norm = decision.normalizeDecision(rawDecision);
          if (norm.error) return { content: [{ type: 'text', text: norm.error }], isError: true };
          // A click on a tab whose owner is not a live session would answer nobody.
          if (!shells.has(session_id)) {
            return { content: [{ type: 'text', text: `A decision tab needs a live owner: "${session_id}" is not a running session. Pass your own DEEPSTEVE_SESSION_ID.` }], isError: true };
          }
          config = norm.config;
        }

        const caller = shells.get(session_id);
        const windowId = caller?.windowId || null;
        // Scope the display tab to the caller's context: the Context Views filter
        // matches a tab's cwd against each context's folders (prefix). Without a cwd
        // a display tab is treated as global and shows in every context (#530).
        const cwd = caller ? sessionPaths(caller).cwd : null;
        const tabName = name || 'Display';
        const id = randomUUID().slice(0, 8);

        setDisplayTab(id, html, { name: tabName, cwd });
        // Before the open goes out: the lock's state broadcast must reach the browser first.
        if (locked) setDisplayTabLocked(id, true);
        if (config) {
          store.set(id, { ownerSessionId: session_id, name: tabName, config, status: 'open', createdAt: Date.now(), decidedAt: null, choice: null });
        }
        log(`[MCP] create_display_tab: id=${id}, name=${tabName}, caller=${session_id}, cwd=${cwd || '(none)'}, source=${file_path ? `file:${file_path}` : 'inline'}${replacements ? `, replacements=${resolved.applied} applied/${resolved.unmatched} unmatched` : ''}${config ? `, decision=${config.buttons.length} buttons` : ''}${locked ? ', locked' : ''}`);

        // The list goes out BEFORE the open, so a browser in Decision Tab mode already knows
        // the tab it is about to create is a decision — otherwise it would read as an
        // unrelated tab being opened and leave the mode.
        if (config) broadcastDecisionTabs();

        // Notify browser to open the display tab (same window-targeting as open_terminal)
        const readyClients = [...reloadClients].filter(c => c.readyState === 1);
        const openMsg = JSON.stringify({ type: 'open-display-tab', id, name: tabName, cwd, windowId });
        const broadcastMsg = JSON.stringify({ type: 'open-display-tab', id, name: tabName, cwd });
        let delivered = false;

        if (windowId) {
          for (const client of readyClients) {
            if (client.windowId === windowId && client.readyState === 1) {
              client.send(openMsg);
              delivered = true;
              break;
            }
          }
          if (!delivered && readyClients.length > 0) {
            for (const client of readyClients) {
              if (client.readyState === 1) client.send(broadcastMsg);
            }
            delivered = true;
          }
          if (!delivered) {
            pendingOpens.push(openMsg);
            delivered = true;
          }
        }
        if (!delivered && readyClients.length > 0) {
          readyClients[0].send(broadcastMsg);
          delivered = true;
        }
        if (!delivered) {
          pendingOpens.push(broadcastMsg);
        }

        const result = { id, name: tabName };
        if (locked) result.locked = true;
        if (config) {
          result.decision = true;
          result.message = `Now call await_decision with tab_id "${id}": it returns the user's choice.`;
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    },

    update_display_tab: {
      description: 'Update the HTML content of an existing display tab. The iframe will reload with the new content. Supply the page EITHER inline via html OR via file_path (read server-side, so you do not re-emit the document). Pass `decision` to replace a decision tab\'s buttons and re-arm it for a new answer. Pass `locked` to lock or unlock the tab — on its own, with no html or file_path, it changes only the lock.',
      schema: {
        tab_id: z.string().describe('The display tab ID returned by create_display_tab'),
        html: z.string().optional().describe('New HTML content to display. Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads instead of you passing html. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied to the HTML server-side, e.g. {"%%CHANNEL%%": "slot-ab3f9c12"}'),
        decision: decisionSchema.describe('Replace the tab\'s buttons and re-arm it for a new answer — how you ask a follow-up in the same decision tab. Omit to keep the current buttons.'),
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID. Required only when adding a decision to a tab that was not created as a decision tab'),
        locked: z.boolean().optional().describe('true locks the tab so nothing can close it; false unlocks it. Unlock a tab only when the user asked for it to be closed — whoever locked it did so to keep it'),
      },
      handler: async ({ tab_id, html, file_path, replacements, decision: rawDecision, session_id, locked }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
        }
        // Lock-only: nothing to resolve and nothing to reload.
        if (locked !== undefined && html === undefined && file_path === undefined && !rawDecision) {
          setDisplayTabLocked(tab_id, locked);
          log(`[MCP] update_display_tab: id=${tab_id}, ${locked ? 'locked' : 'unlocked'}`);
          return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, locked }) }] };
        }
        const resolved = resolveHtml({ html, file_path, replacements });
        if (resolved.error) {
          return { content: [{ type: 'text', text: resolved.error }], isError: true };
        }

        let rearmed = null;
        if (rawDecision) {
          const norm = decision.normalizeDecision(rawDecision);
          if (norm.error) return { content: [{ type: 'text', text: norm.error }], isError: true };
          const prev = store.get(tab_id);
          const owner = prev ? prev.ownerSessionId : session_id;
          if (!owner || !shells.has(owner)) {
            return {
              content: [{ type: 'text', text: prev
                ? `This decision tab's owner "${prev.ownerSessionId}" is no longer a running session.`
                : 'Adding a decision to this tab needs session_id — your DEEPSTEVE_SESSION_ID — so the click has someone to reach.' }],
              isError: true,
            };
          }
          rearmed = {
            ownerSessionId: owner,
            name: prev ? prev.name : 'Display',
            config: norm.config,
            status: 'open',
            createdAt: prev ? prev.createdAt : Date.now(),
            decidedAt: null,
            choice: null,
          };
        }

        setDisplayTab(tab_id, resolved.html);
        if (locked !== undefined) setDisplayTabLocked(tab_id, locked);
        if (rearmed) {
          store.set(tab_id, rearmed);
          broadcastDecisionTabs();
        }
        log(`[MCP] update_display_tab: id=${tab_id}, source=${file_path ? `file:${file_path}` : 'inline'}${replacements ? `, replacements=${resolved.applied} applied/${resolved.unmatched} unmatched` : ''}${rearmed ? `, decision re-armed (${rearmed.config.buttons.length} buttons)` : ''}${locked !== undefined ? (locked ? ', locked' : ', unlocked') : ''}`);

        // Broadcast to all clients so the iframe reloads
        for (const client of reloadClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'update-display-tab', id: tab_id }));
          }
        }

        const result = { id: tab_id, updated: true };
        if (locked !== undefined) result.locked = locked;
        if (rearmed) {
          result.decision = true;
          result.message = `Re-armed. Now call await_decision with tab_id "${tab_id}": it returns the user's choice.`;
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    },

    edit_display_tab: {
      description: 'Edit a display tab by replacing an exact substring (like the Edit tool). Faster than update_display_tab for small changes — no need to resend the whole document. Errors if old_string is not found, or matches more than once unless replace_all is set.',
      schema: {
        tab_id: z.string().describe('The display tab ID returned by create_display_tab'),
        old_string: z.string().describe('Exact substring to find in the current HTML'),
        new_string: z.string().describe('Replacement string'),
        replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
      },
      handler: async ({ tab_id, old_string, new_string, replace_all }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
        }
        if (old_string === '') {
          return { content: [{ type: 'text', text: 'old_string must not be empty.' }] };
        }
        if (old_string === new_string) {
          return { content: [{ type: 'text', text: 'old_string and new_string are identical — no change.' }] };
        }

        const html = displayTabs.get(tab_id);
        // split-count doubles as the uniqueness check and the reported replacement count.
        const count = html.split(old_string).length - 1;
        if (count === 0) {
          return { content: [{ type: 'text', text: `old_string not found in display tab "${tab_id}".` }] };
        }
        if (count > 1 && !replace_all) {
          return { content: [{ type: 'text', text: `old_string is not unique (${count} matches). Set replace_all:true or provide a longer, unique string.` }] };
        }

        // split/join (not String.replace) so $-sequences in new_string are treated literally.
        // When replace_all is false, count===1 here, so this replaces exactly the one match.
        const updated = html.split(old_string).join(new_string);
        setDisplayTab(tab_id, updated);
        log(`[MCP] edit_display_tab: id=${tab_id}, replacements=${count}`);

        // Broadcast to all clients so the iframe reloads
        for (const client of reloadClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'update-display-tab', id: tab_id }));
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, replacements: count }) }] };
      },
    },

    close_display_tab: {
      description: 'Close a display tab. The user can bring it back from the tab bar\'s right-click menu ("Reopen closed tab"). A locked tab refuses to close.',
      schema: {
        tab_id: z.string().describe('The display tab ID to close'),
      },
      handler: async ({ tab_id }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
        }
        if (isDisplayTabLocked(tab_id)) {
          return refuse(`Display tab "${tab_id}" is locked, so it was not closed. It was locked to keep it from being closed by accident. Unlock it with update_display_tab({tab_id: "${tab_id}", locked: false}) only if the user asked for it to be closed.`);
        }

        closeTab(tab_id);
        log(`[MCP] close_display_tab: id=${tab_id}`);

        return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, closed: true }) }] };
      },
    },

    await_decision: {
      description: 'Wait for the user to answer a decision tab you created with create_display_tab (or re-armed with update_display_tab), and return their choice: "[Decision tab …] The user chose: …". Call it right after creating the tab. It can take minutes or hours; if Claude Code moves the call to the background, end your turn and the choice will wake you when it arrives. If the call fails with a connection or transport error, call it again with the same tab_id — nothing is lost. Esc cancels the wait; the tab stays open and a later choice is typed into your session instead.',
      schema: {
        tab_id: z.string().describe('The id create_display_tab (or update_display_tab) returned for the decision tab'),
      },
      handler: async ({ tab_id }, extra) => {
        const caller = projectScope.callerShellId(extra);
        const r = store.get(tab_id);
        const owner = (unclaimed.get(tab_id) || {}).owner || (r && r.ownerSessionId) || null;
        if (owner && caller && caller !== owner) {
          return refuse(`Decision tab ${tab_id} belongs to session ${owner}; only that session can wait on it.`);
        }

        // Answered before this call arrived — between create_display_tab and here, or between a
        // dropped call and its retry — and not yet typed.
        const early = claimUnclaimed(tab_id);
        if (early !== null) {
          log(`[decision-tab] delivered ${tab_id} -> ${owner} (await_decision claimed a choice made before it was called)`);
          return text(early);
        }

        const went = delivered.get(tab_id);
        if (went && (!r || r.status !== 'open')) {
          return text(went === 'typed'
            ? `Decision tab ${tab_id} was already answered, and the choice was typed into this session as a message beginning "[Decision tab". Act on that message; there is nothing left to wait for.`
            : `Decision tab ${tab_id} was already answered, and the choice was returned to an earlier await_decision call. There is nothing left to wait for.`);
        }
        if (!r || !displayTabs.has(tab_id)) return refuse(`No open decision tab "${tab_id}".`);
        if (r.status !== 'open') {
          return text(`Decision tab ${tab_id} was already answered. To ask a follow-up in it, call update_display_tab with a new decision, then await_decision again.`);
        }
        // Held calls are measured on Claude Code only. Anything else keeps the typed delivery.
        const entry = shells.get(r.ownerSessionId);
        const agent = (entry && entry.agentType) || 'claude';
        if (agent !== 'claude') {
          return text(`await_decision is not supported for ${agent} sessions yet. End your turn: the choice will be typed into this session as a new message beginning "[Decision tab".`);
        }

        log(`[decision-tab] ${tab_id} await_decision holding for ${r.ownerSessionId}`);
        const outcome = await holdForChoice(tab_id, r.ownerSessionId, extra && extra.signal);
        if (outcome.prompt) return text(outcome.prompt);
        if (outcome.closed) return text(`Decision tab ${tab_id} was closed without a choice.`);
        if (outcome.superseded) return text(`A newer await_decision call for tab ${tab_id} replaced this one.`);
        return text(`Stopped waiting on decision tab ${tab_id}.`);
      },
    },
  };
}

function registerRoutes(app, context) {
  if (!ctx) ctx = context;
  const guard = context.security && context.security.requireAllowedOrigin
    ? [context.security.requireAllowedOrigin]
    : [];

  // Every decision tab still waiting on an answer. Not under /api/display-tab/ — server.js's
  // GET /api/display-tab/:id is mounted first and would take "decisions" for a tab id.
  app.get('/api/decision-tabs', (req, res) => {
    res.json({ tabs: openDecisionTabs() });
  });

  // Read-only: what decision-bar.js renders on load.
  app.get('/api/display-tab/:id/decision', (req, res) => {
    const r = store.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not-a-decision-tab' });
    res.json({
      id: req.params.id,
      name: r.name,
      config: r.config,
      status: r.status,
      choice: r.choice,
      ownerAlive: ctx.shells.has(r.ownerSessionId),
    });
  });

  app.post('/api/display-tab/:id/decide', ...guard, (req, res) => {
    const id = req.params.id;
    const r = store.get(id);
    if (!r || !ctx.displayTabs.has(id)) return res.status(404).json({ error: 'not-a-decision-tab' });
    const body = req.body || {};
    const button = Number.isInteger(body.index) ? r.config.buttons[body.index] : null;
    if (!button) return res.status(400).json({ error: 'bad-button' });
    const note = r.config.allowNote && typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > decision.MAX_NOTE) return res.status(400).json({ error: 'note-too-long', max: decision.MAX_NOTE });
    // The page's state rides every click, note or no note (#721).
    const state = typeof body.state === 'string' ? body.state.trim() : '';
    if (state.length > decision.MAX_STATE) return res.status(400).json({ error: 'state-too-long', max: decision.MAX_STATE });

    if (r.status !== 'open') return res.status(409).json({ error: 'already-decided', choice: r.choice });

    // Gone. Not defensive: deliverPromptWhenReady is a SILENT no-op on a missing shell.
    const owner = r.ownerSessionId;
    const entry = ctx.shells.get(owner);
    if (!entry) {
      return res.status(409).json({ error: 'session-gone', hint: 'The session that asked has ended. You can close this tab.' });
    }
    // Only the typed path cares: a dialog on screen classifies as 'waiting', so the FIFO would
    // take it for idle and type the choice into the modal — answering a question the person
    // never read. A held await_decision call is answered without touching the terminal.
    const waiting = waiters.has(id);
    if (!waiting && showingDialog(entry)) {
      return res.status(409).json({ error: 'session-blocked', hint: 'The agent is showing a dialog. Answer it in the session tab first, then try again.' });
    }

    // A locked tab outlives its own close_on_decision (#715): the lock is somebody asking to keep it.
    const locked = ctx.isDisplayTabLocked(id);
    const closed = r.config.closeOnDecision && !locked;
    r.status = 'decided';
    r.decidedAt = Date.now();
    r.choice = { index: body.index, label: button.label, note: note || null, state: state || null };
    store.set(id, r);

    const prompt = decision.decidePrompt({ tabId: id, name: r.name, button, note, state, closed, locked });
    // The label and the lengths, never the content.
    ctx.log(`[decision-tab] ${id} decided "${button.label}"${note ? ` note=${note.length}ch` : ''}${state ? ` state=${state.length}ch` : ''} -> ${owner}${closed ? ' (closing)' : ''}${waiting ? '' : ' — no await_decision holding; typing it unless one claims it'}`);
    if (waiting) {
      answerWaiter(id, owner, prompt);
    } else {
      // A Claude session may be about to call await_decision (or calling it again after a
      // dropped transport); anything else has no call coming, so it is typed without the wait.
      const claude = ((entry && entry.agentType) || 'claude') === 'claude';
      typeUnlessClaimed(id, owner, prompt, claude ? CLAIM_GRACE_MS : 0);
    }

    if (closed) closeTab(id);
    else broadcastDecisionTabs();
    res.json({ sent: true, label: button.label, closed });
  });
}

module.exports = { init, registerRoutes };

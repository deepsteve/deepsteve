const { z } = require('zod');
const { randomUUID } = require('crypto');

// html | file_path | replacements resolution is shared with Project Mods (#618),
// so it lives at the root rather than here. See html-source.js.
const { resolveHtml } = require('../../html-source.js');
const decision = require('./decision.js');
// The same "is a modal on screen?" gate Workshop's chat endpoint uses, rather than a second one.
const dialogParse = require('../workshop/dialog-parse.js');

const DIALOG_ROWS = 30;
const DECISION_BAR_SRC = '/mods/display-tab/decision-bar.js';

// Stashed by init() and shared with registerRoutes(): mcp-server.js always calls init()
// first, and both halves need the same context and store.
let ctx = null;
let store = null;

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
  if (!store.get(id)) return;
  store.remove(id);
  broadcastDecisionTabs();
}

function closeTab(id) {
  ctx.deleteDisplayTab(id);
  forgetDecision(id);
  sendToClients({ type: 'close-display-tab', id });
}

function showingDialog(entry) {
  const scr = entry && entry.terminalScreen;
  if (!scr || typeof scr.linesSync !== 'function') return false;
  try { return !!dialogParse.detectDialog(scr.linesSync(DIALOG_ROWS) || []); } catch { return false; }
}

// Served-time injection, so edit_display_tab / update_display_tab can never strip the bar.
function injectDecisionBar(html, id) {
  if (!store || !store.get(id)) return html;
  const tag = `<script src="${DECISION_BAR_SRC}" defer></script>`;
  const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  if (at >= 0) return html.slice(0, at) + tag + html.slice(at);
  return html + tag;
}

function init(context) {
  ctx = context;
  const { shells, reloadClients, pendingOpens, log, displayTabs, setDisplayTab, sessionPaths } = context;
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
      description: 'Create a new browser tab displaying arbitrary HTML content (charts, dashboards, reports). The HTML is rendered in a sandboxed iframe. Supply the page EITHER inline via html OR — cheaper, preferred when the page already exists on disk — via file_path, which the server reads itself so you do not re-emit the document as output tokens. The page is served from the deepsteve origin, so use window.location.origin or relative /api/... URLs to call back into deepsteve; never hard-code a port. Pass your DEEPSTEVE_SESSION_ID so the tab opens in the same browser window and is scoped to your Project view (it appears only in the project you spawned it from, like a regular session tab). Pass `decision` to add a row of buttons whose click comes back to you as a new message.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — targets the correct browser window and scopes the tab to your project'),
        html: z.string().optional().describe('Full HTML content to display (can include inline CSS/JS, e.g. Chart.js visualizations). Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads instead of you passing html. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied to the HTML server-side, e.g. {"%%CHANNEL%%": "slot-ab3f9c12"} — lets a file on disk stay a reusable template'),
        name: z.string().optional().describe('Tab name (defaults to "Display")'),
        decision: decisionSchema.describe('Make this a decision tab: a row of buttons along the bottom whose click is delivered back to YOUR session as a new message ("[Decision tab …] The user chose: …"). After creating one, end your turn rather than polling — the choice arrives on its own.'),
      },
      handler: async ({ session_id, html, file_path, replacements, name, decision: rawDecision }) => {
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

        setDisplayTab(id, html);
        if (config) {
          store.set(id, { ownerSessionId: session_id, name: tabName, config, status: 'open', createdAt: Date.now(), decidedAt: null, choice: null });
        }
        log(`[MCP] create_display_tab: id=${id}, name=${tabName}, caller=${session_id}, cwd=${cwd || '(none)'}, source=${file_path ? `file:${file_path}` : 'inline'}${replacements ? `, replacements=${resolved.applied} applied/${resolved.unmatched} unmatched` : ''}${config ? `, decision=${config.buttons.length} buttons` : ''}`);

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
        if (config) {
          result.decision = true;
          result.message = 'The choice will arrive as a new message beginning "[Decision tab". End your turn now rather than polling.';
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    },

    update_display_tab: {
      description: 'Update the HTML content of an existing display tab. The iframe will reload with the new content. Supply the page EITHER inline via html OR via file_path (read server-side, so you do not re-emit the document). Pass `decision` to replace a decision tab\'s buttons and re-arm it for a new answer.',
      schema: {
        tab_id: z.string().describe('The display tab ID returned by create_display_tab'),
        html: z.string().optional().describe('New HTML content to display. Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads instead of you passing html. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied to the HTML server-side, e.g. {"%%CHANNEL%%": "slot-ab3f9c12"}'),
        decision: decisionSchema.describe('Replace the tab\'s buttons and re-arm it for a new answer — how you ask a follow-up in the same decision tab. Omit to keep the current buttons.'),
        session_id: z.string().optional().describe('Your DEEPSTEVE_SESSION_ID. Required only when adding a decision to a tab that was not created as a decision tab'),
      },
      handler: async ({ tab_id, html, file_path, replacements, decision: rawDecision, session_id }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
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
        if (rearmed) {
          store.set(tab_id, rearmed);
          broadcastDecisionTabs();
        }
        log(`[MCP] update_display_tab: id=${tab_id}, source=${file_path ? `file:${file_path}` : 'inline'}${replacements ? `, replacements=${resolved.applied} applied/${resolved.unmatched} unmatched` : ''}${rearmed ? `, decision re-armed (${rearmed.config.buttons.length} buttons)` : ''}`);

        // Broadcast to all clients so the iframe reloads
        for (const client of reloadClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'update-display-tab', id: tab_id }));
          }
        }

        const result = { id: tab_id, updated: true };
        if (rearmed) {
          result.decision = true;
          result.message = 'Re-armed. The choice will arrive as a new message beginning "[Decision tab". End your turn now rather than polling.';
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
      description: 'Close a display tab.',
      schema: {
        tab_id: z.string().describe('The display tab ID to close'),
      },
      handler: async ({ tab_id }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
        }

        closeTab(tab_id);
        log(`[MCP] close_display_tab: id=${tab_id}`);

        return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, closed: true }) }] };
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

    if (r.status !== 'open') return res.status(409).json({ error: 'already-decided', choice: r.choice });

    // Gone. Not defensive: deliverPromptWhenReady is a SILENT no-op on a missing shell.
    const owner = r.ownerSessionId;
    const entry = ctx.shells.get(owner);
    if (!entry) {
      return res.status(409).json({ error: 'session-gone', hint: 'The session that asked has ended. Close this tab with its ✕.' });
    }
    // A dialog on screen classifies as 'waiting', so the FIFO would take it for idle and type
    // the choice into the modal — answering a question the person never read.
    if (showingDialog(entry)) {
      return res.status(409).json({ error: 'session-blocked', hint: 'The agent is showing a dialog. Answer it in the session tab first, then try again.' });
    }

    const closed = r.config.closeOnDecision;
    r.status = 'decided';
    r.decidedAt = Date.now();
    r.choice = { index: body.index, label: button.label, note: note || null };
    store.set(id, r);

    // The FIFO, never submitToShell and never e.pendingDelivery: it sequences this behind
    // whatever the agent is mid-way through.
    ctx.deliverPromptWhenReady(owner, decision.decidePrompt({ tabId: id, name: r.name, button, note, closed }), {
      source: 'decision-tab',
      skipIf: (sid) => !ctx.shells.has(sid),
      skipReason: 'session gone before the decision-tab choice could be delivered',
      onDeliver: (sid) => ctx.log(`[decision-tab] delivered ${id} -> ${sid}`),
    });
    // The label and the note's length, never its content.
    ctx.log(`[decision-tab] ${id} decided "${button.label}"${note ? ` note=${note.length}ch` : ''} -> ${owner}${closed ? ' (closing)' : ''}`);

    if (closed) closeTab(id);
    else broadcastDecisionTabs();
    res.json({ sent: true, label: button.label, closed });
  });
}

module.exports = { init, registerRoutes };

const { z } = require('zod');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SOURCE_ERR = 'Pass exactly one of html or file_path.';

/**
 * Resolve the HTML for a create/update call from either an inline string or a file on
 * disk, applying the optional literal `replacements` map. Returns { html } or { error };
 * never throws.
 */
function resolveHtml({ html, file_path, replacements }) {
  const hasHtml = typeof html === 'string';
  const hasPath = typeof file_path === 'string' && file_path.trim() !== '';
  if (hasHtml === hasPath) return { error: SOURCE_ERR };

  let source = html;
  if (hasPath) {
    let p = file_path.trim();
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) {
      return { error: `file_path must be an absolute path (got "${file_path}").` };
    }
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return { error: `Cannot read file_path "${p}": ${e.code === 'ENOENT' ? 'no such file' : e.message}.` };
    }
    if (st.isDirectory()) return { error: `file_path "${p}" is a directory, not a file.` };
    if (st.size > MAX_FILE_BYTES) {
      return { error: `file_path "${p}" is ${st.size} bytes, over the ${MAX_FILE_BYTES}-byte limit.` };
    }
    try {
      source = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return { error: `Cannot read file_path "${p}": ${e.message}.` };
    }
  }

  let applied = 0;
  let unmatched = 0;
  if (replacements && typeof replacements === 'object') {
    const keys = Object.keys(replacements);
    if (keys.some(k => k === '')) return { error: 'replacements keys must not be empty.' };
    // Longest key first so overlapping placeholders substitute deterministically.
    // split/join (not String.replace) so $-sequences in values stay literal.
    for (const key of keys.sort((a, b) => b.length - a.length)) {
      const parts = source.split(key);
      if (parts.length > 1) applied++; else unmatched++;
      source = parts.join(String(replacements[key]));
    }
  }

  return { html: source, applied, unmatched };
}

function init(context) {
  const { shells, reloadClients, pendingOpens, log, displayTabs, setDisplayTab, deleteDisplayTab, sessionPaths } = context;

  return {
    create_display_tab: {
      description: 'Create a new browser tab displaying arbitrary HTML content (charts, dashboards, reports). The HTML is rendered in a sandboxed iframe. Supply the page EITHER inline via html OR — cheaper, preferred when the page already exists on disk — via file_path, which the server reads itself so you do not re-emit the document as output tokens. The page is served from the deepsteve origin, so use window.location.origin or relative /api/... URLs to call back into deepsteve; never hard-code a port. Pass your DEEPSTEVE_SESSION_ID so the tab opens in the same browser window and is scoped to your Context View (it appears only in the context/project you spawned it from, like a regular session tab).',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — targets the correct browser window and scopes the tab to your context'),
        html: z.string().optional().describe('Full HTML content to display (can include inline CSS/JS, e.g. Chart.js visualizations). Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads instead of you passing html. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied to the HTML server-side, e.g. {"%%CHANNEL%%": "slot-ab3f9c12"} — lets a file on disk stay a reusable template'),
        name: z.string().optional().describe('Tab name (defaults to "Display")'),
      },
      handler: async ({ session_id, html, file_path, replacements, name }) => {
        const resolved = resolveHtml({ html, file_path, replacements });
        if (resolved.error) {
          return { content: [{ type: 'text', text: resolved.error }], isError: true };
        }
        html = resolved.html;

        const caller = shells.get(session_id);
        const windowId = caller?.windowId || null;
        // Scope the display tab to the caller's context: the Context Views filter
        // matches a tab's cwd against each context's folders (prefix). Without a cwd
        // a display tab is treated as global and shows in every context (#530).
        const cwd = caller ? sessionPaths(caller).cwd : null;
        const tabName = name || 'Display';
        const id = randomUUID().slice(0, 8);

        setDisplayTab(id, html);
        log(`[MCP] create_display_tab: id=${id}, name=${tabName}, caller=${session_id}, cwd=${cwd || '(none)'}, source=${file_path ? `file:${file_path}` : 'inline'}${replacements ? `, replacements=${resolved.applied} applied/${resolved.unmatched} unmatched` : ''}`);

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

        return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName }) }] };
      },
    },

    update_display_tab: {
      description: 'Update the HTML content of an existing display tab. The iframe will reload with the new content. Supply the page EITHER inline via html OR via file_path (read server-side, so you do not re-emit the document).',
      schema: {
        tab_id: z.string().describe('The display tab ID returned by create_display_tab'),
        html: z.string().optional().describe('New HTML content to display. Mutually exclusive with file_path'),
        file_path: z.string().optional().describe('Absolute path to an HTML file the server reads instead of you passing html. Mutually exclusive with html'),
        replacements: z.record(z.string()).optional().describe('Literal find→replace pairs applied to the HTML server-side, e.g. {"%%CHANNEL%%": "slot-ab3f9c12"}'),
      },
      handler: async ({ tab_id, html, file_path, replacements }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
        }
        const resolved = resolveHtml({ html, file_path, replacements });
        if (resolved.error) {
          return { content: [{ type: 'text', text: resolved.error }], isError: true };
        }

        setDisplayTab(tab_id, resolved.html);
        log(`[MCP] update_display_tab: id=${tab_id}, source=${file_path ? `file:${file_path}` : 'inline'}${replacements ? `, replacements=${resolved.applied} applied/${resolved.unmatched} unmatched` : ''}`);

        // Broadcast to all clients so the iframe reloads
        for (const client of reloadClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'update-display-tab', id: tab_id }));
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, updated: true }) }] };
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

        deleteDisplayTab(tab_id);
        log(`[MCP] close_display_tab: id=${tab_id}`);

        // Broadcast to all clients to close the tab
        for (const client of reloadClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'close-display-tab', id: tab_id }));
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, closed: true }) }] };
      },
    },
  };
}

module.exports = { init };

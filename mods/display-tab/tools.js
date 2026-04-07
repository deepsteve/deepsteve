const { z } = require('zod');
const { randomUUID } = require('crypto');

function init(context) {
  const { shells, reloadClients, pendingOpens, log, displayTabs, setDisplayTab, deleteDisplayTab } = context;

  return {
    create_display_tab: {
      description: 'Create a new browser tab displaying arbitrary HTML content (charts, dashboards, reports). The HTML is rendered in a sandboxed iframe. Pass your DEEPSTEVE_SESSION_ID so the tab opens in the same browser window.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — used to target the correct browser window'),
        html: z.string().describe('Full HTML content to display (can include inline CSS/JS, e.g. Chart.js visualizations)'),
        name: z.string().optional().describe('Tab name (defaults to "Display")'),
      },
      handler: async ({ session_id, html, name }) => {
        const caller = shells.get(session_id);
        const windowId = caller?.windowId || null;
        const tabName = name || 'Display';
        const id = randomUUID().slice(0, 8);

        setDisplayTab(id, html);
        log(`[MCP] create_display_tab: id=${id}, name=${tabName}, caller=${session_id}`);

        // Notify browser to open the display tab (same window-targeting as open_terminal)
        const readyClients = [...reloadClients].filter(c => c.readyState === 1);
        const openMsg = JSON.stringify({ type: 'open-display-tab', id, name: tabName, windowId });
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
            const broadcastMsg = JSON.stringify({ type: 'open-display-tab', id, name: tabName });
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
          readyClients[0].send(JSON.stringify({ type: 'open-display-tab', id, name: tabName }));
          delivered = true;
        }
        if (!delivered) {
          pendingOpens.push(JSON.stringify({ type: 'open-display-tab', id, name: tabName }));
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName }) }] };
      },
    },

    update_display_tab: {
      description: 'Update the HTML content of an existing display tab. The iframe will reload with the new content.',
      schema: {
        tab_id: z.string().describe('The display tab ID returned by create_display_tab'),
        html: z.string().describe('New HTML content to display'),
      },
      handler: async ({ tab_id, html }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
        }

        setDisplayTab(tab_id, html);
        log(`[MCP] update_display_tab: id=${tab_id}`);

        // Broadcast to all clients so the iframe reloads
        for (const client of reloadClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'update-display-tab', id: tab_id }));
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, updated: true }) }] };
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

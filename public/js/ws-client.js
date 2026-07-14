/**
 * WebSocket client wrapper with auto-reconnect
 */

import { maybeHealAuth, noteAuthOk } from './auth-heal.js';

export function createWebSocket(options = {}) {
  const params = new URLSearchParams();

  if (options.action) params.set('action', options.action);
  if (options.session) params.set('session', options.session);
  if (options.id) params.set('id', options.id);
  if (options.cwd) params.set('cwd', options.cwd);
  if (options.isNew) params.set('new', '1');
  if (options.worktree) params.set('worktree', options.worktree);
  if (options.cols) params.set('cols', options.cols);
  if (options.rows) params.set('rows', options.rows);
  if (options.name) params.set('name', options.name);
  if (options.planMode) params.set('planMode', '1');
  if (options.agentType && options.agentType !== 'claude') params.set('agentType', options.agentType);
  if (options.configProfile) params.set('configProfile', options.configProfile); // custom Claude config profile (#537)
  if (options.windowId) params.set('windowId', options.windowId);
  if (options.fork) params.set('fork', options.fork);
  if (options.rcParent) params.set('rcParent', options.rcParent);

  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let url = wsProto + location.host + '?' + params;
  let ws;
  let reconnectTimer = null;
  let isReconnecting = false;

  const wrapper = {
    get readyState() { return ws.readyState; },

    send(data) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },

    sendJSON(obj) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    },

    close() {
      clearInterval(reconnectTimer);
      ws.close();
    },

    // Called after server assigns a session ID — updates the reconnect URL
    // so future reconnections request the existing session instead of creating new ones.
    setSessionId(id) {
      const p = new URLSearchParams();
      if (options.action) p.set('action', options.action);
      if (options.session) p.set('session', options.session);
      p.set('id', id);
      if (options.cwd) p.set('cwd', options.cwd);
      if (options.cols) p.set('cols', options.cols);
      if (options.rows) p.set('rows', options.rows);
      if (options.agentType && options.agentType !== 'claude') p.set('agentType', options.agentType);
      if (options.configProfile) p.set('configProfile', options.configProfile); // custom Claude config profile (#537)
      if (options.windowId) p.set('windowId', options.windowId);
      url = wsProto + location.host + '?' + p;
    },

    // Event handlers - set by caller
    onmessage: null,
    onerror: null,
    onclose: null,
    onopen: null,
    onreconnecting: null,  // Called when reconnect starts
    onreconnected: null,   // Called when reconnect succeeds
  };

  function connect() {
    ws = new WebSocket(url);

    ws.onopen = () => {
      noteAuthOk();
      if (isReconnecting) {
        isReconnecting = false;
        clearInterval(reconnectTimer);
        reconnectTimer = null;
        if (wrapper.onreconnected) wrapper.onreconnected();
      }
      if (wrapper.onopen) wrapper.onopen();
    };

    ws.onmessage = (e) => {
      if (wrapper.onmessage) wrapper.onmessage(e);
    };

    ws.onerror = (e) => {
      if (wrapper.onerror) wrapper.onerror(e);
    };

    ws.onclose = (e) => {
      // Start reconnecting if not already
      if (!isReconnecting && !e.wasClean && !window.__deepsteveReloadPending) {
        isReconnecting = true;
        if (wrapper.onreconnecting) wrapper.onreconnecting();

        reconnectTimer = setInterval(() => {
          if (window.__deepsteveReloadPending) return; // stop churn while a heal-reload navigates
          // The browser can't see WHY an upgrade failed (always close code 1006), so probe over
          // HTTP: no-op unless the server is up but rejecting our auth, then one guarded reload.
          maybeHealAuth();
          if (ws.readyState === WebSocket.CLOSED) {
            connect();
          }
        }, 1000);
      }

      if (wrapper.onclose) wrapper.onclose(e);
    };
  }

  connect();

  return wrapper;
}

/**
 * WebSocket client wrapper with auto-reconnect
 */

export function createWebSocket(options = {}) {
  const params = new URLSearchParams();

  if (options.id) params.set('id', options.id);
  if (options.cwd) params.set('cwd', options.cwd);
  if (options.isNew) params.set('new', '1');
  if (options.worktree) params.set('worktree', options.worktree);
  if (options.cols) params.set('cols', options.cols);
  if (options.rows) params.set('rows', options.rows);

  const url = 'ws://' + location.host + '?' + params;
  let ws = new WebSocket(url);
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
      if (!isReconnecting && !e.wasClean) {
        isReconnecting = true;
        if (wrapper.onreconnecting) wrapper.onreconnecting();

        reconnectTimer = setInterval(() => {
          if (ws.readyState === WebSocket.CLOSED) {
            connect();
          }
        }, 1000);
      }

      if (wrapper.onclose) wrapper.onclose(e);
    };
  }

  // Initial connection setup
  ws.onopen = () => { if (wrapper.onopen) wrapper.onopen(); };
  ws.onmessage = (e) => { if (wrapper.onmessage) wrapper.onmessage(e); };
  ws.onerror = (e) => { if (wrapper.onerror) wrapper.onerror(e); };
  ws.onclose = (e) => {
    if (!isReconnecting && !e.wasClean) {
      isReconnecting = true;
      if (wrapper.onreconnecting) wrapper.onreconnecting();

      reconnectTimer = setInterval(() => {
        if (ws.readyState === WebSocket.CLOSED) {
          connect();
        }
      }, 1000);
    }

    if (wrapper.onclose) wrapper.onclose(e);
  };

  return wrapper;
}

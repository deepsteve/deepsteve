/**
 * WebSocket client wrapper for terminal communication
 */

export function createWebSocket(options = {}) {
  const params = new URLSearchParams();

  if (options.id) params.set('id', options.id);
  if (options.cwd) params.set('cwd', options.cwd);
  if (options.isNew) params.set('new', '1');

  const ws = new WebSocket('ws://' + location.host + '?' + params);

  return ws;
}

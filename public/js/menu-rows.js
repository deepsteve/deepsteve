/**
 * Menu rows whose text is a name: a directory, a cwd, a session name.
 *
 * Every one of these is built with textContent / dataset / title, never an HTML
 * template (#747). The values look local, but none of them is ours to vouch for:
 * a directory name is whatever a cloned repo checked out (anything but `/` and NUL,
 * so `<img onerror=…>` is a valid one), a default session name is that directory's
 * leaf, and an issue session's name is a GitHub issue title anyone can write. The UI
 * page sends no CSP, so one raw `${name}` in an innerHTML is a script on our origin,
 * one same-origin fetch away from `run_in_terminal`.
 *
 * test/unit/name-sink-escape.test.js renders each builder with a hostile name and
 * pins that app.js still calls them.
 */

/** One entry in the new-tab menu's recent-dirs list. `label` is the leaf, maybe with its parent. */
export function recentDirItem(path, label) {
  const el = document.createElement('div');
  el.className = 'context-menu-item';
  el.dataset.action = 'recent';
  el.dataset.path = path;
  el.title = path;
  el.textContent = label;
  return el;
}

/**
 * One row of the sessions dropdown. The click and close handlers in app.js read
 * `data-id`, `data-cwd`, `data-name`, `data-other-window` and `data-closed`, so those
 * names are part of this function's contract.
 */
export function sessionRow({
  id, cwd, name, agentLabel = '', statusText, statusClass = '',
  isThisTab = false, isOtherWindow = false, isClosed = false, canClose = false,
}) {
  const row = document.createElement('div');
  row.className = `dropdown-item ${isThisTab ? 'connected' : 'clickable'}${isClosed ? ' closed' : ''}`;
  row.dataset.id = id;
  if (cwd != null) row.dataset.cwd = cwd;
  row.dataset.name = name;
  if (isOtherWindow) row.dataset.otherWindow = 'true';

  const info = document.createElement('div');
  info.className = 'session-info';

  const nameEl = document.createElement('span');
  nameEl.className = 'session-name';
  nameEl.textContent = name;
  if (agentLabel) {
    const badge = document.createElement('span');
    badge.className = 'session-agent-badge';
    badge.textContent = agentLabel;
    nameEl.appendChild(document.createTextNode(' '));
    nameEl.appendChild(badge);
  }

  const status = document.createElement('span');
  status.className = `session-status${statusClass ? ' ' + statusClass : ''}`;
  status.textContent = statusText;

  info.appendChild(nameEl);
  info.appendChild(status);
  row.appendChild(info);

  if (canClose) {
    const close = document.createElement('span');
    close.className = 'session-close';
    close.dataset.id = id;
    if (isClosed) close.dataset.closed = '1';
    close.textContent = '✕';
    row.appendChild(close);
  }
  return row;
}

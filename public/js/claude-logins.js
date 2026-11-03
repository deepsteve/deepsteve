/**
 * Claude logins in the UI (#748). Two surfaces, one list:
 *
 *   - the project editor's "Claude Login" row — push buttons, System plus one per login,
 *     the project's current one pressed (createLoginPicker)
 *   - Settings → General → Enabled Agents → Claude logins — add and remove (mountClaudeLoginsSettings)
 *
 * The list is fetched each time a surface opens and never cached or broadcast. A token
 * is sent exactly once, in the add POST, and the server never sends one back — the
 * rows show `hint`, its last four characters. Every name is rendered as text (#747).
 */

import { fetchJSON } from './api.js';

/** Every login: [{ id, name, hint, addedAt, missing }]. Throws HttpError / TypeError. */
export async function fetchClaudeLogins() {
  const d = await fetchJSON('/api/claude-logins');
  return Array.isArray(d && d.logins) ? d.logins : [];
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * The project editor's Claude Login row. Returns { element, value(), loaded() }:
 * `value()` is the chosen login id or null (System); `loaded()` is false until the list
 * arrived, and the caller must then leave `claudeLoginId` out of its save, so a failed
 * fetch keeps the project's stored login rather than writing System over it.
 */
export function createLoginPicker({ selectedId = null, fetchLogins = fetchClaudeLogins } = {}) {
  const wrap = el('div', 'context-login');
  const label = el('div', 'context-login-label', 'Claude Login');
  const options = el('div', 'context-login-options');
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', 'Claude Login');
  const note = el('div', 'context-login-note');
  wrap.append(label, options, note);

  let selected = selectedId || null;
  let logins = null; // null until loaded

  function button(id, text, title) {
    const b = el('button', 'context-login-btn', text);
    b.type = 'button';
    if (title) b.title = title;
    b.dataset.loginId = id || '';
    const on = (id || null) === selected;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.onclick = () => { selected = id || null; render(); };
    return b;
  }

  function render() {
    options.replaceChildren();
    options.appendChild(button(null, 'System', 'Whatever `claude /login` signed this machine in as'));
    if (logins === null) {
      note.textContent = 'Loading logins…';
      return;
    }
    for (const l of logins) {
      options.appendChild(button(l.id, l.name, l.missing ? 'Its token file is missing — sessions run as System' : `Token ${l.hint}`));
    }
    note.textContent = logins.length
      ? 'Claude sessions in this project sign in as this login. Applies to sessions started or resumed after you save; running ones keep theirs.'
      : 'Only System so far. Add another account in Settings → Enabled Agents → Claude logins.';
  }

  render();
  fetchLogins().then((list) => {
    logins = list;
    // A login removed since the project was saved reads as System, which is what the
    // server already made it when the login was deleted.
    if (selected && !logins.some(l => l.id === selected)) selected = null;
    render();
  }).catch((e) => {
    options.replaceChildren(button(selected, selected ? 'Current login' : 'System'));
    options.firstChild.disabled = true;
    note.textContent = `Could not load logins (${e && e.message ? e.message : e}). Saving keeps the current one.`;
  });

  return {
    element: wrap,
    value: () => selected,
    loaded: () => logins !== null,
  };
}

/**
 * Settings → Claude logins. Adds and removes take effect immediately — they are their
 * own requests, not part of the Settings Save, because a token must not ride along in
 * a form that is re-POSTed on every save.
 */
export function mountClaudeLoginsSettings(container, { fetchLogins = fetchClaudeLogins } = {}) {
  if (!container) return;
  const list = el('div', 'claude-logins-list');
  const status = el('div', 'claude-logins-status');
  const form = el('div', 'claude-logins-add');
  const nameInput = el('input', 'claude-login-name');
  nameInput.type = 'text';
  nameInput.placeholder = 'Name (e.g. Work)';
  nameInput.autocomplete = 'off';
  const tokenInput = el('input', 'claude-login-token');
  tokenInput.type = 'password'; // a bearer credential: never on screen
  tokenInput.placeholder = 'Paste token';
  tokenInput.autocomplete = 'off';
  tokenInput.spellcheck = false;
  const addBtn = el('button', 'claude-login-add-btn', 'Add login');
  addBtn.type = 'button';
  form.append(nameInput, tokenInput, addBtn);
  container.replaceChildren(list, form, status);

  function say(text, isError = false) {
    status.textContent = text || '';
    status.classList.toggle('error', !!isError);
  }

  function renderList(logins) {
    list.replaceChildren();
    if (!logins.length) {
      list.appendChild(el('div', 'claude-logins-empty', 'No logins yet — every project uses System.'));
      return;
    }
    for (const l of logins) {
      const row = el('div', 'claude-login-row');
      row.dataset.loginId = l.id;
      row.appendChild(el('span', 'claude-login-row-name', l.name));
      row.appendChild(el('span', 'claude-login-row-hint', l.missing ? 'token file missing' : l.hint));
      const rm = el('button', 'claude-login-remove', 'Remove');
      rm.type = 'button';
      rm.onclick = async () => {
        if (!confirm(`Remove the Claude login "${l.name}"? Projects on it move to System. Sessions already running keep it until they are reopened.`)) return;
        rm.disabled = true;
        try {
          const d = await fetchJSON('/api/claude-logins/' + encodeURIComponent(l.id), { method: 'DELETE' });
          renderList(d.logins || []);
          const moved = Array.isArray(d.movedToSystem) ? d.movedToSystem : [];
          say(moved.length ? `Removed. Moved to System: ${moved.join(', ')}.` : 'Removed.');
        } catch (e) {
          rm.disabled = false;
          say(`Could not remove: ${e.message}`, true);
        }
      };
      row.appendChild(rm);
      list.appendChild(row);
    }
  }

  addBtn.onclick = async () => {
    const name = nameInput.value.trim();
    const token = tokenInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    if (!token) { tokenInput.focus(); return; }
    addBtn.disabled = true;
    try {
      const d = await fetchJSON('/api/claude-logins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token }),
      });
      nameInput.value = '';
      tokenInput.value = '';
      renderList(d.logins || []);
      say(`Added "${d.login ? d.login.name : name}". Pick it for a project in that project's Edit dialog.`);
    } catch (e) {
      say(e.message, true);
    } finally {
      addBtn.disabled = false;
    }
  };
  // Enter adds the login and goes no further — not to a Save handler on the modal.
  tokenInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addBtn.click(); } };

  list.appendChild(el('div', 'claude-logins-empty', 'Loading…'));
  fetchLogins().then(renderList).catch((e) => {
    list.replaceChildren();
    say(`Could not load logins: ${e.message}`, true);
  });
}

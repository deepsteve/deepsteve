// Decision tabs (#716) — the button bar along the bottom of a decision display tab.
//
// Injected by the server at serve time (mods/display-tab/tools.js injectDecisionBar), so the
// agent's page never has to include it and an edit can never strip it. A plain script, not a
// module, and no window.deepsteve: display tabs get no bridge. It talks to the server over the
// same-origin routes the page's auth cookie already covers.
//
// alert()/confirm() are inert in the display-tab sandbox (no allow-modals), so the confirm
// step is an in-page overlay.
(function () {
  var m = location.pathname.match(/\/api\/display-tab\/([^/?#]+)/);
  if (!m) return;
  var TAB_ID = decodeURIComponent(m[1]);
  var BASE = '/api/display-tab/' + encodeURIComponent(TAB_ID);

  var CSS = [
    '#ds-decision-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;box-sizing:border-box;',
    'padding:10px 14px;background:rgba(22,24,29,.97);color:#e8e8ea;border-top:1px solid rgba(255,255,255,.14);',
    'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 -6px 18px rgba(0,0,0,.25)}',
    '#ds-decision-bar *{box-sizing:border-box;font:inherit}',
    '#ds-decision-bar .dsd-prompt{margin:0 0 8px;font-weight:600}',
    '#ds-decision-bar .dsd-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '#ds-decision-bar .dsd-note{flex:1 1 220px;min-width:160px;padding:7px 9px;border-radius:6px;',
    'border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:inherit}',
    '#ds-decision-bar button{cursor:pointer;padding:7px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.22);',
    'background:rgba(255,255,255,.08);color:inherit;font-weight:500}',
    '#ds-decision-bar button:hover:not(:disabled){background:rgba(255,255,255,.16)}',
    '#ds-decision-bar button.dsd-primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
    '#ds-decision-bar button.dsd-primary:hover:not(:disabled){background:#4580f5}',
    '#ds-decision-bar button.dsd-danger{background:#c9372c;border-color:#c9372c;color:#fff}',
    '#ds-decision-bar button.dsd-danger:hover:not(:disabled){background:#dc4b40}',
    '#ds-decision-bar button:disabled{opacity:.45;cursor:default}',
    '#ds-decision-bar .dsd-status{margin-left:auto;opacity:.85}',
    '#ds-decision-bar .dsd-status.dsd-warn{color:#f5b85a;opacity:1}',
    '#ds-decision-bar .dsd-status.dsd-ok{color:#7fd48b;opacity:1}',
    '#ds-decision-confirm{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;',
    'background:rgba(0,0,0,.45);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '#ds-decision-confirm .dsd-card{background:#1d2026;color:#e8e8ea;border:1px solid rgba(255,255,255,.16);',
    'border-radius:10px;padding:18px 20px;max-width:420px;box-shadow:0 12px 40px rgba(0,0,0,.4)}',
    '#ds-decision-confirm .dsd-card p{margin:0 0 14px}',
    '#ds-decision-confirm .dsd-actions{display:flex;gap:8px;justify-content:flex-end}',
    '#ds-decision-confirm button{cursor:pointer;padding:7px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.22);',
    'background:rgba(255,255,255,.08);color:inherit;font:inherit}',
    '#ds-decision-confirm button.dsd-send{background:#2f6fed;border-color:#2f6fed;color:#fff}',
  ].join('');

  var bar, statusEl, noteEl, buttons = [], sending = false;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'dsd-status' + (kind ? ' dsd-' + kind : '');
  }

  function setEnabled(on) {
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !on;
    if (noteEl) noteEl.disabled = !on;
  }

  // Keep the page's own content clear of the bar.
  function reserveSpace() {
    if (!bar) return;
    document.body.style.paddingBottom = (bar.offsetHeight + 12) + 'px';
  }

  function confirmThen(label, go) {
    var overlay = el('div');
    overlay.id = 'ds-decision-confirm';
    var card = el('div', 'dsd-card');
    card.appendChild(el('p', null, 'Send “' + label + '”?'));
    var actions = el('div', 'dsd-actions');
    var cancel = el('button', null, 'Cancel');
    var send = el('button', 'dsd-send', 'Send');
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Enter') { e.preventDefault(); close(); go(); }
    }
    cancel.onclick = close;
    send.onclick = function () { close(); go(); };
    overlay.onclick = function (e) { if (e.target === overlay) close(); };
    actions.appendChild(cancel);
    actions.appendChild(send);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    send.focus();
  }

  function showDecided(choice) {
    setEnabled(false);
    setStatus(choice ? 'Sent: ' + choice.label : 'Already answered', 'ok');
  }

  function showGone() {
    setEnabled(false);
    setStatus('The session that asked has ended — you can close this tab.', 'warn');
  }

  var MAX_STATE = 64000;

  // A control's name as a person would say it: its name, id, aria-label, <label> or placeholder.
  function nameOf(c) {
    var lab = c.labels && c.labels[0] && c.labels[0].textContent.trim();
    return c.name || c.id || c.getAttribute('aria-label') || lab || c.placeholder || c.tagName.toLowerCase();
  }

  /*
   * What the page holds, sent with EVERY button (#721) — a click must never arrive as a bare label
   * while the picks sit in the page. The page's own answer wins: `window.decisionState()` may
   * return a string or anything JSON can carry. A page without one is read for what it keeps:
   * each localStorage key it read or wrote (recorded by the tracker the server puts at the top of
   * <head>) and each filled form control outside this bar.
   */
  function pageState() {
    if (typeof window.decisionState === 'function') {
      try {
        var v = window.decisionState();
        if (v != null && v !== '') return typeof v === 'string' ? v : JSON.stringify(v);
      } catch (e) {
        return 'window.decisionState() threw: ' + (e && e.message);
      }
    }
    var parts = [];
    if (window.__dsdKeys) {
      window.__dsdKeys.forEach(function (k) {
        try {
          var val = window.localStorage.getItem(k);
          if (val != null && val !== '') parts.push('localStorage["' + k + '"] = ' + val);
        } catch (e) {}
      });
    }
    var controls = document.querySelectorAll('input, select, textarea');
    for (var i = 0; i < controls.length; i++) {
      var c = controls[i];
      if (bar && bar.contains(c)) continue;
      var t = (c.type || '').toLowerCase();
      if (t === 'hidden' || t === 'password' || t === 'file' || t === 'submit' || t === 'button' || t === 'reset') continue;
      if (t === 'checkbox' || t === 'radio') {
        if (c.checked) parts.push(nameOf(c) + (t === 'radio' || (c.value && c.value !== 'on') ? ' = ' + c.value : ' ✓'));
      } else if (c.value && String(c.value).trim()) {
        parts.push(nameOf(c) + ' = ' + String(c.value).trim());
      }
    }
    return parts.join('\n');
  }

  function decide(index) {
    if (sending) return;
    sending = true;
    setEnabled(false);
    setStatus('Sending…');
    var body = { index: index };
    if (noteEl && noteEl.value.trim()) body.note = noteEl.value.trim();
    var state = pageState();
    if (state) body.state = state.length > MAX_STATE ? state.slice(0, MAX_STATE - 40) + '\n… (cut at ' + MAX_STATE + ' chars)' : state;
    fetch(BASE + '/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
    }).then(function (r) {
      sending = false;
      if (r.res.ok) {
        showDecided({ label: r.data.label });
        if (r.data.closed) setStatus('Sent: ' + r.data.label + ' — closing…', 'ok');
        return;
      }
      var err = r.data && r.data.error;
      if (err === 'already-decided') return showDecided(r.data.choice);
      if (err === 'session-gone') return showGone();
      if (err === 'session-blocked') {
        setEnabled(true);
        return setStatus(r.data.hint || 'The agent is showing a dialog — answer it first, then try again.', 'warn');
      }
      setEnabled(true);
      setStatus('Could not send (' + (err || r.res.status) + ') — try again.', 'warn');
    }).catch(function () {
      sending = false;
      setEnabled(true);
      setStatus('Could not reach Deep Steve — try again.', 'warn');
    });
  }

  function render(data) {
    var cfg = data.config;
    var style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    bar = el('div');
    bar.id = 'ds-decision-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Decision');
    if (cfg.prompt) bar.appendChild(el('div', 'dsd-prompt', cfg.prompt));
    var row = el('div', 'dsd-row');
    if (cfg.allowNote) {
      noteEl = el('input', 'dsd-note');
      noteEl.type = 'text';
      noteEl.placeholder = 'Optional note';
      noteEl.maxLength = 4000;
      row.appendChild(noteEl);
    }
    cfg.buttons.forEach(function (b, i) {
      var btn = el('button', b.style && b.style !== 'default' ? 'dsd-' + b.style : null, b.label);
      btn.type = 'button';
      btn.onclick = function () {
        if (b.confirm) confirmThen(b.label, function () { decide(i); });
        else decide(i);
      };
      buttons.push(btn);
      row.appendChild(btn);
    });
    statusEl = el('span', 'dsd-status');
    row.appendChild(statusEl);
    bar.appendChild(row);
    document.body.appendChild(bar);
    reserveSpace();
    window.addEventListener('resize', reserveSpace);

    if (data.status !== 'open') showDecided(data.choice);
    else if (!data.ownerAlive) showGone();
  }

  function start() {
    fetch(BASE + '/decision').then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      if (data && data.config && Array.isArray(data.config.buttons)) render(data);
    }).catch(function () {});
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();

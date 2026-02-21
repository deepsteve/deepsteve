#!/bin/bash
set -e

INSTALL_DIR="$HOME/.deepsteve"
PLIST_PATH="$HOME/Library/LaunchAgents/com.deepsteve.plist"
NODE_PATH=$(which node)

mkdir -p "$INSTALL_DIR/public"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$INSTALL_DIR/package.json" << 'PKGEOF'
{
  "name": "deepsteve",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "node-pty": "^1.0.0",
    "ws": "^8.14.2"
  }
}
PKGEOF

cat > "$INSTALL_DIR/server.js" << 'SERVEREOF'
const express = require('express');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static('public'));

app.get('/api/home', (req, res) => res.json({ home: os.homedir() }));

app.post('/api/mkdir', require('express').json(), (req, res) => {
  let dir = req.body.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  dir = path.resolve(dir);
  try { fs.mkdirSync(dir, { recursive: true }); res.json({ created: dir }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dirs', (req, res) => {
  let input = req.query.path || '~';
  if (input.startsWith('~')) input = path.join(os.homedir(), input.slice(1));
  const absPath = path.resolve(input);
  let dirToList = absPath, prefix = '';
  try {
    if (!fs.statSync(absPath).isDirectory()) { dirToList = path.dirname(absPath); prefix = path.basename(absPath); }
  } catch { dirToList = path.dirname(absPath); prefix = path.basename(absPath); }
  try {
    const entries = fs.readdirSync(dirToList, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).filter(e => !prefix || e.name.toLowerCase().startsWith(prefix.toLowerCase())).sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map(e => path.join(dirToList, e.name)).slice(0, 20);
    res.json({ dirs });
  } catch { res.json({ dirs: [] }); }
});

const server = app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
const shells = new Map();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action');
  if (action === 'list') { ws.send(JSON.stringify({ type: 'list', ids: [...shells.keys()] })); ws.close(); return; }

  let id = url.searchParams.get('id');
  let cwd = url.searchParams.get('cwd') || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));

  if (!id || !shells.has(id)) {
    id = randomUUID().slice(0, 8);
    const shell = pty.spawn('claude', [], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: process.env });
    shells.set(id, { shell, clients: new Set() });
    shell.onData((data) => { const entry = shells.get(id); if (entry) entry.clients.forEach((c) => c.send(data)); });
    shell.onExit(() => shells.delete(id));
  }

  const entry = shells.get(id);
  if (entry.killTimer) {
    clearTimeout(entry.killTimer);
    entry.killTimer = null;
  }
  entry.clients.add(ws);
  ws.send(JSON.stringify({ type: 'session', id }));

  ws.on('message', (msg) => {
    const str = msg.toString();
    try { const parsed = JSON.parse(str); if (parsed.type === 'resize') { entry.shell.resize(parsed.cols, parsed.rows); return; } } catch {}
    entry.shell.write(str);
  });

  ws.on('close', () => {
    entry.clients.delete(ws);
    if (entry.clients.size === 0) {
      entry.killTimer = setTimeout(() => {
        if (entry.clients.size === 0) {
          entry.shell.kill();
          shells.delete(id);
        }
      }, 30000);
    }
  });
});
SERVEREOF

cat > "$INSTALL_DIR/public/index.html" << 'HTMLEOF'
<!DOCTYPE html>
<html>
<head>
  <title>deepsteve</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #c9d1d9; font-family: system-ui; display: flex; flex-direction: column; height: 100vh; }
    #tabs { display: flex; gap: 2px; padding: 4px 8px; background: #161b22; align-items: center; flex-shrink: 0; }
    .tab { padding: 6px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 6px 6px 0 0; cursor: pointer; color: #8b949e; font-size: 13px; display: flex; align-items: center; gap: 6px; }
    .tab.active { background: #0d1117; color: #f0f6fc; border-bottom-color: #0d1117; }
    .tab .close { opacity: 0.5; cursor: pointer; font-size: 11px; }
    .tab .close:hover { opacity: 1; color: #f85149; }
    #new-btn { padding: 4px 10px; background: #238636; border: none; color: white; border-radius: 4px; cursor: pointer; font-size: 13px; margin-left: 4px; }
    #new-btn:hover { background: #2ea043; }
    .terminal-container { flex: 1; display: none; }
    .terminal-container.active { display: block; }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .modal { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; width: 420px; }
    .modal h2 { font-size: 16px; margin-bottom: 16px; color: #f0f6fc; }
    .path-wrap { display: flex; gap: 8px; margin-bottom: 8px; }
    .modal input[type="text"] { flex: 1; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 13px; font-family: monospace; }
    .modal input[type="text"]:focus { outline: none; border-color: #238636; }
    .path-up, .new-folder { padding: 8px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; cursor: pointer; color: #8b949e; }
    .path-up:hover, .new-folder:hover { background: #30363d; color: #c9d1d9; }
    .dir-tree { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; max-height: 240px; overflow-y: auto; margin-bottom: 12px; }
    .dir-item { padding: 8px 12px; cursor: pointer; font-size: 13px; font-family: monospace; color: #c9d1d9; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #21262d; }
    .dir-item:last-child { border-bottom: none; }
    .dir-item:hover { background: #21262d; }
    .dir-icon { opacity: 0.6; }
    .dir-empty { padding: 16px; text-align: center; color: #8b949e; font-size: 13px; }
    .modal label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #8b949e; margin-bottom: 16px; cursor: pointer; }
    .modal input[type="checkbox"] { accent-color: #238636; }
    .modal-buttons { display: flex; gap: 8px; justify-content: flex-end; }
    .modal button { padding: 6px 14px; border-radius: 4px; border: 1px solid #30363d; cursor: pointer; font-size: 13px; }
    .modal .btn-primary { background: #238636; color: white; border-color: #238636; }
    .modal .btn-primary:hover { background: #2ea043; }
    .modal .btn-secondary { background: #21262d; color: #c9d1d9; }
    .modal .btn-secondary:hover { background: #30363d; }
  </style>
</head>
<body>
  <div id="tabs"><button id="new-btn">+ New</button></div>
  <div id="terminals"></div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script>
    const sessions = new Map();
    let activeId = null;
    const STORAGE_KEY = 'deepsteve';
    function getStorage() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; } }
    function setStorage(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...getStorage(), ...data })); }
    async function fetchDirs(p) { try { const r = await fetch('/api/dirs?path=' + encodeURIComponent(p)); return await r.json(); } catch { return { dirs: [] }; } }
    async function fetchHome() { try { const r = await fetch('/api/home'); return (await r.json()).home; } catch { return '/Users'; } }
    function showDirectoryPicker() {
      return new Promise(async (resolve) => {
        const storage = getStorage();
        const home = await fetchHome();
        const defaultPath = storage.lastCwd || home;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = '<div class="modal"><h2>Select working directory</h2><div class="path-wrap"><input type="text" id="cwd-input" value="' + defaultPath + '"><button class="path-up" id="up-btn">↑</button><button class="new-folder" id="new-btn">+</button></div><div class="dir-tree" id="dir-tree"></div><label><input type="checkbox" id="always-use" ' + (storage.alwaysUse ? 'checked' : '') + '>Always use this directory</label><div class="modal-buttons"><button class="btn-secondary" id="cancel-btn">Cancel</button><button class="btn-primary" id="start-btn">Start</button></div></div>';
        document.body.appendChild(overlay);
        const input = overlay.querySelector('#cwd-input'), checkbox = overlay.querySelector('#always-use'), tree = overlay.querySelector('#dir-tree'), upBtn = overlay.querySelector('#up-btn'), newBtn = overlay.querySelector('#new-btn');
        async function refreshTree() {
          const r = await fetchDirs(input.value + '/');
          if (!r.dirs.length) { tree.innerHTML = '<div class="dir-empty">No subdirectories</div>'; }
          else {
            tree.innerHTML = r.dirs.map(d => '<div class="dir-item" data-path="' + d + '"><span class="dir-icon">📁</span>' + d.split('/').pop() + '</div>').join('');
            tree.querySelectorAll('.dir-item').forEach(el => {
              el.onclick = () => { input.value = el.dataset.path; refreshTree(); };
              el.ondblclick = () => { input.value = el.dataset.path; submit(); };
            });
          }
        }
        function goUp() { const p = input.value.split('/'); if (p.length > 1) { p.pop(); input.value = p.join('/') || '/'; refreshTree(); } }
        upBtn.onclick = goUp;
        newBtn.onclick = async () => {
          const name = prompt('New folder name:');
          if (!name) return;
          const newPath = input.value + '/' + name;
          try {
            const res = await fetch('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: newPath }) });
            if (res.ok) { input.value = newPath; refreshTree(); }
            else { const err = await res.json(); alert('Failed: ' + err.error); }
          } catch (e) { alert('Failed: ' + e.message); }
        };
        let debounce; input.oninput = () => { clearTimeout(debounce); debounce = setTimeout(refreshTree, 300); };
        input.onkeydown = (e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') cancel(); };
        function submit() { const cwd = input.value.trim() || home; setStorage({ lastCwd: cwd, alwaysUse: checkbox.checked }); overlay.remove(); resolve(cwd); }
        function cancel() { overlay.remove(); resolve(null); }
        overlay.querySelector('#start-btn').onclick = submit;
        overlay.querySelector('#cancel-btn').onclick = cancel;
        overlay.onclick = (e) => { if (e.target === overlay) cancel(); };
        refreshTree();
      });
    }
    async function promptAndCreateSession() {
      const storage = getStorage();
      let cwd;
      if (storage.alwaysUse && storage.lastCwd) { cwd = storage.lastCwd; }
      else { cwd = await showDirectoryPicker(); if (cwd === null) return; }
      createSession(cwd);
    }
    document.getElementById('new-btn').addEventListener('click', () => promptAndCreateSession());
    function createSession(cwd, existingId = null) {
      const params = new URLSearchParams();
      if (existingId) params.set('id', existingId);
      if (cwd) params.set('cwd', cwd);
      const ws = new WebSocket('ws://' + location.host + '?' + params);
      ws.onmessage = (e) => {
        try { const msg = JSON.parse(e.data); if (msg.type === 'session') { initTerminal(msg.id, ws, cwd); return; } } catch {}
        const session = [...sessions.values()].find(s => s.ws === ws);
        if (session) session.term.write(e.data);
      };
      ws.onerror = () => { if (existingId) { const storage = getStorage(); setStorage({ sessions: (storage.sessions || []).filter(s => s.id !== existingId) }); } };
    }
    function initTerminal(id, ws, cwd) {
      const container = document.createElement('div');
      container.className = 'terminal-container';
      container.id = 'term-' + id;
      document.getElementById('terminals').appendChild(container);
      const term = new Terminal({ fontSize: 14, theme: { background: '#0d1117' } });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(container);
      ws.onmessage = (e) => term.write(e.data);
      term.onData((data) => ws.send(data));
      sessions.set(id, { term, fit, ws, container, cwd });
      addTab(id);
      switchTo(id);
      const storage = getStorage();
      const saved = storage.sessions || [];
      if (!saved.find(s => s.id === id)) { saved.push({ id, cwd }); setStorage({ sessions: saved }); }
      requestAnimationFrame(() => { fit.fit(); ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); });
      window.addEventListener('resize', () => { if (activeId === id) { fit.fit(); ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } });
    }
    function addTab(id) {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.id = 'tab-' + id;
      tab.innerHTML = '<span>' + id + '</span><span class="close">✕</span>';
      tab.querySelector('span').addEventListener('click', () => switchTo(id));
      tab.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); killSession(id); });
      document.getElementById('new-btn').before(tab);
    }
    function switchTo(id) {
      if (activeId) { sessions.get(activeId)?.container.classList.remove('active'); document.getElementById('tab-' + activeId)?.classList.remove('active'); }
      activeId = id;
      const s = sessions.get(id);
      s.container.classList.add('active');
      document.getElementById('tab-' + id).classList.add('active');
      requestAnimationFrame(() => { s.fit.fit(); s.term.focus(); });
    }
    function killSession(id) {
      const s = sessions.get(id);
      if (!s) return;
      s.ws.close(); s.term.dispose(); s.container.remove();
      document.getElementById('tab-' + id).remove();
      sessions.delete(id);
      const storage = getStorage();
      setStorage({ sessions: (storage.sessions || []).filter(x => x.id !== id) });
      if (activeId === id) { const next = sessions.keys().next().value; if (next) switchTo(next); else activeId = null; }
    }
    (async function init() {
      const storage = getStorage();
      const saved = storage.sessions || [];
      if (saved.length > 0) { for (const { id, cwd } of saved) { createSession(cwd, id); } }
      else { await promptAndCreateSession(); }
    })();
  </script>
</body>
</html>
HTMLEOF

cat > "$INSTALL_DIR/uninstall.sh" << 'UNINSTALLEOF'
#!/bin/bash
launchctl unload "$HOME/Library/LaunchAgents/com.deepsteve.plist" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/com.deepsteve.plist"
rm -rf "$HOME/.deepsteve"
rm -f "$HOME/Library/Logs/deepsteve.log" "$HOME/Library/Logs/deepsteve.error.log"
echo "deepsteve uninstalled"
UNINSTALLEOF
chmod +x "$INSTALL_DIR/uninstall.sh"

cat > "$PLIST_PATH" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.deepsteve</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$INSTALL_DIR/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>3000</string>
        <key>PATH</key>
        <string>$HOME/.local/bin:$(dirname $NODE_PATH):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/deepsteve.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/deepsteve.error.log</string>
</dict>
</plist>
PLISTEOF

cd "$INSTALL_DIR"
npm install

# Fix node-pty spawn-helper permissions
find "$INSTALL_DIR/node_modules/node-pty" -name "spawn-helper" -exec chmod +x {} \;

launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo "deepsteve installed and running at http://localhost:3000"
echo "To uninstall: ~/.deepsteve/uninstall.sh"

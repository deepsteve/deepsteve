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

app.get('/api/shells', (req, res) => {
  const list = [...shells.entries()].map(([id, entry]) => ({ id, pid: entry.shell.pid }));
  res.json({ shells: list });
});

app.post('/api/shells/killall', (req, res) => {
  const killed = [];
  for (const [id, entry] of shells) {
    killed.push({ id, pid: entry.shell.pid });
    entry.shell.kill();
    shells.delete(id);
  }
  res.json({ killed });
});

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
  const createNew = url.searchParams.get('new') === '1';

  // If client requested a specific ID that doesn't exist, tell them it's gone
  if (id && !shells.has(id) && !createNew) {
    ws.send(JSON.stringify({ type: 'gone', id }));
    ws.close();
    return;
  }

  if (!id || !shells.has(id)) {
    id = randomUUID().slice(0, 8);
    const shell = pty.spawn('claude', [], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: process.env });
    shells.set(id, { shell, clients: new Set() });
    shell.onData((data) => { const entry = shells.get(id); if (entry) entry.clients.forEach((c) => c.send(data)); });
    shell.onExit(() => shells.delete(id));
  }

  const entry = shells.get(id);
  // Cancel any pending kill timer on reconnect
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
      // Grace period to allow reconnect on refresh
      entry.killTimer = setTimeout(() => {
        if (entry.clients.size === 0) {
          entry.shell.kill();
          shells.delete(id);
        }
      }, 30000);
    }
  });
});

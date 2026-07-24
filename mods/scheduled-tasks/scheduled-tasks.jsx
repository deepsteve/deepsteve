import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
const { useState, useEffect, useMemo } = React;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const AGENTS = ['claude', 'hermes', 'opencode', 'pi'];

const C = {
  border: 'var(--ds-border, #30363d)',
  bg2: 'var(--ds-bg-secondary, #161b22)',
  text: 'var(--ds-text-primary, #c9d1d9)',
  dim: 'var(--ds-text-secondary, #8b949e)',
  accent: 'var(--ds-accent, #58a6ff)',
  green: '#3fb950',
  red: '#f85149',
  amber: '#d29922',
};

// --- small time + cron helpers (display + form preview only) ---
function relTime(ms) {
  if (!ms) return 'n/a';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  let s;
  if (mins < 1) s = 'now';
  else if (mins < 60) s = `${mins}m`;
  else if (hrs < 24) s = `${hrs}h`;
  else s = `${days}d`;
  if (s === 'now') return 'now';
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}
function absTime(ms) { return ms ? new Date(ms).toLocaleString() : 'n/a'; }
const pad = (n) => String(n).padStart(2, '0');

// Minimal client describe for the live form preview. The saved task carries the
// authoritative `schedule` from the server; this only powers the editor preview.
function describeCron(str) {
  const f = String(str || '').trim().split(/\s+/);
  if (f.length !== 5) return str || '';
  const [m, h, dom, mon, dow] = f;
  const isNum = (x) => /^\d+$/.test(x);
  if (str.trim() === '* * * * *') return 'Every minute';
  if (isNum(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${pad(+m)}`;
  if (isNum(m) && isNum(h) && mon === '*') {
    const time = `${pad(+h)}:${pad(+m)}`;
    if (dom === '*' && dow === '*') return `Every day at ${time}`;
    if (dom === '*' && dow !== '*') {
      const days = dow.split(',').filter(isNum).map((d) => DAY_FULL[+d % 7]);
      return days.length ? `Every ${days.join(', ')} at ${time}` : str;
    }
    if (dom !== '*' && dow === '*' && isNum(dom)) return `Monthly on day ${+dom} at ${time}`;
  }
  return str;
}

// --- cron builder <-> form fields ---
function buildCron(mode, fld) {
  const [h, m] = (fld.time || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
  switch (mode) {
    case 'hourly': return `${fld.minute || 0} * * * *`;
    case 'daily': return `${m} ${h} * * *`;
    case 'weekly': {
      const days = (fld.days && fld.days.length ? fld.days : [1]).slice().sort((a, b) => a - b);
      return `${m} ${h} * * ${days.join(',')}`;
    }
    case 'monthly': return `${m} ${h} ${fld.dom || 1} * *`;
    case 'custom': default: return fld.raw || '0 9 * * *';
  }
}
// Best-effort: detect which builder mode a cron string fits, to prefill on edit.
function cronToForm(cron) {
  const f = String(cron || '0 9 * * *').trim().split(/\s+/);
  const base = { time: '09:00', minute: 0, days: [1], dom: 1, raw: cron || '0 9 * * *' };
  if (f.length !== 5) return { mode: 'custom', fld: base };
  const [m, h, dom, mon, dow] = f;
  const isNum = (x) => /^\d+$/.test(x);
  if (isNum(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return { mode: 'hourly', fld: { ...base, minute: +m } };
  if (isNum(m) && isNum(h) && mon === '*') {
    const time = `${pad(+h)}:${pad(+m)}`;
    if (dom === '*' && dow === '*') return { mode: 'daily', fld: { ...base, time } };
    if (dom === '*' && dow.split(',').every(isNum)) return { mode: 'weekly', fld: { ...base, time, days: dow.split(',').map(Number) } };
    if (isNum(dom) && dow === '*') return { mode: 'monthly', fld: { ...base, time, dom: +dom } };
  }
  return { mode: 'custom', fld: base };
}

function api(method, url, body) {
  return fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}

// Match the 8-char ids the Context View / server mint for contexts (#526).
function genId() {
  try { return crypto.randomUUID().slice(0, 8); }
  catch { return Math.random().toString(36).slice(2, 10); }
}

// A task's repo root belongs to a context folder when it equals or nests inside
// it — the same folder-prefix rule the server and Context View use (#526).
function inside(p, dir) {
  if (!p || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  return p === base || p.startsWith(base + '/');
}

// ------------------------------------------------------------------ Task card
function StatusBadge({ status }) {
  // Self-reported run lifecycle (#525): queued → running → done/failed, plus
  // 'ended' when a session closed without self-reporting. Legacy started/completed
  // rows (pre-#525) still map so old history renders.
  const map = {
    queued: C.amber, running: C.accent, succeeded: C.green, failed: C.red, ended: C.dim,
    'timed-out': C.red, started: C.accent, completed: C.green, error: C.red,
  };
  const label = {
    queued: 'queued', running: 'running', succeeded: 'done', failed: 'failed', ended: 'ended',
    'timed-out': 'timed out', started: 'running', completed: 'done', error: 'error',
  }[status] || status;
  if (!status) return null;
  return <span style={{ color: map[status] || C.dim, fontSize: 11, border: `1px solid ${map[status] || C.dim}`, borderRadius: 4, padding: '0 5px' }}>{label}</span>;
}

function TaskCard({ task, onEdit }) {
  const [open, setOpen] = useState(false);
  const last = task.runs && task.runs[0];
  // A one-shot that has fired is retired ("done"): keep the row + history, but it will
  // never run again, so hide the schedule/run controls and just offer Delete (#528).
  const done = !!(task.once && task.firedAt);
  const runNow = () => api('POST', `/api/scheduled-tasks/${task.id}/run`).catch((e) => alert(e.message));
  const toggle = () => api('POST', `/api/scheduled-tasks/${task.id}/enabled`, { enabled: !task.enabled }).catch((e) => alert(e.message));
  const del = () => { if (confirm(`Delete "${task.title}"?`)) api('DELETE', `/api/scheduled-tasks/${task.id}`).catch((e) => alert(e.message)); };

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, marginBottom: 8, background: C.bg2, opacity: done ? 0.7 : task.enabled ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <div style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.title}</div>
        {task.once ? <span style={{ fontSize: 10, color: done ? C.green : C.dim, border: `1px solid ${done ? C.green : C.border}`, borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap' }}>{done ? 'one-shot ✓' : 'one-shot'}</span> : null}
        <StatusBadge status={last && last.status} />
      </div>
      <div style={{ fontSize: 12, color: C.dim, marginTop: 3 }}>{task.schedule || task.cron}</div>
      <div style={{ fontSize: 12, marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {!done ? <span title={absTime(task.nextRun)}>next: <b>{task.enabled ? relTime(task.nextRun) : 'paused'}</b></span> : null}
        {task.lastRun ? <span title={absTime(task.lastRun)}>last: {relTime(task.lastRun)}</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {!done ? <button onClick={runNow} style={btn()}>Run now</button> : null}
        {!done ? <button onClick={toggle} style={btn()}>{task.enabled ? 'Pause' : 'Resume'}</button> : null}
        {!done ? <button onClick={() => onEdit(task)} style={btn()}>Edit</button> : null}
        <button onClick={del} style={btn(C.red)}>Delete</button>
        {task.runs && task.runs.length ? <button onClick={() => setOpen(!open)} style={btn()}>{open ? 'Hide' : 'History'}</button> : null}
      </div>
      {open && task.runs && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          {task.runs.map((r, i) => (
            <div key={i} style={{ padding: '1px 0' }}>
              <div style={{ fontSize: 11, color: C.dim, display: 'flex', gap: 8 }}>
                <span>{absTime(r.startedAt)}</span>
                <StatusBadge status={r.status} />
                <span style={{ opacity: 0.6 }}>{r.sessionId}</span>
                {r.worktree ? <span style={{ opacity: 0.5 }}>{r.worktree}{r.worktreeRemoved ? '' : ' (kept)'}</span> : null}
              </div>
              {r.summary ? <div style={{ fontSize: 11, color: C.dim, opacity: 0.85, marginLeft: 2 }}>{r.summary}</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function btn(color) {
  return { background: 'transparent', color: color || C.text, border: `1px solid ${color || C.border}`, borderRadius: 4, padding: '3px 8px', fontSize: 12, cursor: 'pointer' };
}
function input() {
  return { width: '100%', background: 'var(--ds-bg-primary, #0d1117)', color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: '6px 8px', fontSize: 13, marginTop: 2 };
}
function label() { return { fontSize: 12, color: C.dim, marginTop: 10, display: 'block' }; }

// ------------------------------------------------------------------ Task form
function TaskForm({ task, projects, onClose }) {
  const initial = task || {};
  const initForm = cronToForm(initial.cron || '0 9 * * 1');
  const [title, setTitle] = useState(initial.title || '');
  const [prompt, setPrompt] = useState(initial.prompt || '');
  const [project, setProject] = useState(initial.project || (projects[0] && projects[0].root) || '');
  const [customPath, setCustomPath] = useState('');
  const [agentType, setAgentType] = useState(initial.agentType || 'claude');
  const [planMode, setPlanMode] = useState(!!initial.planMode);
  const [keepOpen, setKeepOpen] = useState(!!initial.keepOpen);
  const [keepOpenOnFailure, setKeepOpenOnFailure] = useState(!!initial.keepOpenOnFailure);
  const [isolateWorktree, setIsolateWorktree] = useState(initial.isolateWorktree !== false); // default on (#565)
  const [maxRuntime, setMaxRuntime] = useState(initial.maxRuntimeMinutes != null ? String(initial.maxRuntimeMinutes) : '60'); // #596
  const [once, setOnce] = useState(!!initial.once);
  const [mode, setMode] = useState(initForm.mode);
  const [fld, setFld] = useState(initForm.fld);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const cronStr = useMemo(() => buildCron(mode, fld), [mode, fld]);
  const setF = (patch) => setFld((p) => ({ ...p, ...patch }));

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Title is required');
    if (!prompt.trim()) return setErr('Prompt is required');
    const proj = project === '__custom__' ? customPath.trim() : project;
    const body = { title: title.trim(), prompt: prompt.trim(), cron: cronStr, once, project: proj, agentType, planMode, keepOpen, keepOpenOnFailure, isolateWorktree, maxRuntimeMinutes: Number(maxRuntime) || 0 };
    setSaving(true);
    try {
      if (task && task.id) await api('PUT', `/api/scheduled-tasks/${task.id}`, body);
      else await api('POST', '/api/scheduled-tasks', body);
      onClose();
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  return (
    <div style={{ border: `1px solid ${C.accent}`, borderRadius: 6, padding: 12, marginBottom: 10, background: C.bg2 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{task && task.id ? 'Edit task' : 'New scheduled task'}</div>

      <label style={label()}>Title</label>
      <input style={input()} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly analytics report" />

      <label style={label()}>Prompt (runs each time)</label>
      <textarea style={{ ...input(), minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Generate the weekly GA report using the analytics MCP and post it to…" />

      <label style={label()}>Project</label>
      <select style={input()} value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">No project (home)</option>
        {projects.map((p) => <option key={p.root} value={p.root}>{p.name}</option>)}
        <option value="__custom__">Custom path…</option>
      </select>
      {project === '__custom__' && (
        <input style={{ ...input(), marginTop: 6 }} value={customPath} onChange={(e) => setCustomPath(e.target.value)} placeholder="/Users/me/github/my-repo" />
      )}

      <label style={label()}>Schedule</label>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {['hourly', 'daily', 'weekly', 'monthly', 'custom'].map((mo) => (
          <button key={mo} onClick={() => setMode(mo)} style={{ ...btn(mode === mo ? C.accent : undefined), textTransform: 'capitalize' }}>{mo}</button>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        {mode === 'hourly' && (
          <div>At minute <input type="number" min="0" max="59" style={{ ...input(), width: 70, display: 'inline-block' }} value={fld.minute} onChange={(e) => setF({ minute: Math.max(0, Math.min(59, +e.target.value)) })} /></div>
        )}
        {(mode === 'daily' || mode === 'weekly' || mode === 'monthly') && (
          <div>At time <input type="time" style={{ ...input(), width: 120, display: 'inline-block' }} value={fld.time} onChange={(e) => setF({ time: e.target.value })} /></div>
        )}
        {mode === 'weekly' && (
          <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {DAY_NAMES.map((d, i) => {
              const on = fld.days.includes(i);
              return <button key={i} onClick={() => setF({ days: on ? fld.days.filter((x) => x !== i) : [...fld.days, i] })} style={btn(on ? C.accent : undefined)}>{d}</button>;
            })}
          </div>
        )}
        {mode === 'monthly' && (
          <div style={{ marginTop: 6 }}>On day <input type="number" min="1" max="31" style={{ ...input(), width: 70, display: 'inline-block' }} value={fld.dom} onChange={(e) => setF({ dom: Math.max(1, Math.min(31, +e.target.value)) })} /></div>
        )}
        {mode === 'custom' && (
          <input style={input()} value={fld.raw} onChange={(e) => setF({ raw: e.target.value })} placeholder="0 9 * * 1  (min hour dom mon dow)" />
        )}
      </div>
      <div style={{ fontSize: 12, color: C.accent, marginTop: 6 }}>{describeCron(cronStr)} — <span style={{ color: C.dim }}>cron: {cronStr} (local time)</span></div>

      <label style={{ fontSize: 12, color: C.dim, marginTop: 8, display: 'block' }}>
        <input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} /> run once (retire after it fires)
      </label>
      {once && <div style={{ fontSize: 11, color: C.amber, marginTop: 2 }}>Runs a single time, at the next moment this schedule matches, then marks itself done.</div>}

      <div style={{ display: 'flex', gap: 12, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: C.dim }}>Agent{' '}
          <select style={{ ...input(), width: 120, display: 'inline-block', marginTop: 0 }} value={agentType} onChange={(e) => setAgentType(e.target.value)}>
            {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: C.dim }}><input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} /> plan mode</label>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: C.dim }}><input type="checkbox" checked={keepOpen} onChange={(e) => setKeepOpen(e.target.checked)} /> keep tab open when finished</label>
        <label style={{ fontSize: 12, color: C.dim, opacity: keepOpen ? 0.5 : 1 }} title={keepOpen ? 'Redundant while “keep tab open when finished” is on.' : 'Keep the tab open only when the run fails.'}>
          <input type="checkbox" checked={keepOpen || keepOpenOnFailure} disabled={keepOpen} onChange={(e) => setKeepOpenOnFailure(e.target.checked)} /> keep open on failure
        </label>
      </div>
      <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>By default the tab auto-closes when the agent reports finished.</div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: C.dim, opacity: agentType !== 'claude' ? 0.5 : 1 }} title={agentType !== 'claude' ? 'Worktree isolation only applies to claude (native --worktree support).' : ''}>
          <input type="checkbox" checked={isolateWorktree} disabled={agentType !== 'claude'} onChange={(e) => setIsolateWorktree(e.target.checked)} /> run in a disposable worktree
        </label>
        <label style={{ fontSize: 12, color: C.dim }} title="A run that never reports finished is closed after this long, so it can't block future fires. 0 = no limit.">
          time limit
          <input type="number" min="0" step="5" value={maxRuntime} onChange={(e) => setMaxRuntime(e.target.value)}
            style={{ ...input(), width: 60, marginLeft: 6, marginTop: 0, padding: '2px 4px' }} /> min
        </label>
      </div>
      <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>Each run gets its own git worktree/branch, removed after the run unless there is uncommitted or unmerged work. Skipped when the project is not a git repo.</div>
      {agentType !== 'claude' && <div style={{ fontSize: 11, color: C.amber, marginTop: 4 }}>Note: only claude is wired for deepsteve MCP tools (self-report + auto-close).</div>}

      {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={save} disabled={saving} style={{ ...btn(C.accent), fontWeight: 600 }}>{saving ? 'Saving…' : 'Save'}</button>
        <button onClick={onClose} style={btn()}>Cancel</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Groups
// Groups here are the shared "contexts" (#526): the same entity the Context View
// rail manages. This editor picks members from the known-repo list; the rail can
// also add arbitrary folders. Saving a name that already exists merges the picked
// repos into that context (never wipes its other folders).
function GroupsManager({ contexts, projects, onClose }) {
  const [name, setName] = useState('');
  const [sel, setSel] = useState([]);
  const create = async () => {
    const nm = name.trim();
    if (!nm) return;
    const existing = contexts.find((c) => c.name === nm);
    const id = existing ? existing.id : genId();
    const dirs = existing ? [...new Set([...(existing.dirs || []), ...sel])] : sel;
    await api('POST', '/api/contexts', { id, name: nm, dirs }).catch((e) => alert(e.message));
    setName(''); setSel([]);
  };
  const toggle = (root) => setSel((s) => (s.includes(root) ? s.filter((x) => x !== root) : [...s, root]));
  const del = (id) => api('DELETE', `/api/contexts/${encodeURIComponent(id)}`).catch((e) => alert(e.message));
  const nameOf = (root) => { const p = projects.find((x) => x.root === root); return p ? p.name : root; };

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, marginBottom: 10, background: C.bg2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 600 }}>Groups (contexts)</div>
        <button onClick={onClose} style={btn()}>Close</button>
      </div>
      {contexts.map((g) => (
        <div key={g.id} style={{ marginTop: 8, fontSize: 12 }}>
          <b>{g.name}</b> <button onClick={() => del(g.id)} style={{ ...btn(C.red), padding: '0 6px', marginLeft: 6 }}>×</button>
          <div style={{ color: C.dim, marginTop: 2 }}>{(g.dirs || []).map(nameOf).join(', ') || '(no folders)'}</div>
        </div>
      ))}
      <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 8 }}>
        <label style={label()}>Group name</label>
        <input style={input()} value={name} onChange={(e) => setName(e.target.value)} placeholder="acme" />
        <label style={label()}>Repos in group</label>
        <div style={{ maxHeight: 160, overflow: 'auto' }}>
          {projects.map((p) => (
            <label key={p.root} style={{ display: 'block', fontSize: 12, padding: '2px 0' }}>
              <input type="checkbox" checked={sel.includes(p.root)} onChange={() => toggle(p.root)} /> {p.name}
            </label>
          ))}
          {projects.length === 0 && <div style={{ fontSize: 12, color: C.dim }}>No known projects yet.</div>}
        </div>
        <button onClick={create} style={{ ...btn(C.accent), marginTop: 8 }}>Save group</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Root
function App() {
  const [data, setData] = useState({ tasks: [], projects: [], enabled: true });
  const [contexts, setContexts] = useState([]); // the shared groups (#526)
  const [filter, setFilter] = useState({ type: 'all', value: '' });
  const [editing, setEditing] = useState(null); // null | 'new' | task
  const [showGroups, setShowGroups] = useState(false);

  useEffect(() => {
    const unsubs = [];
    function setup() {
      const ds = window.deepsteve;
      unsubs.push(ds.onScheduledTasksChanged((d) => setData(d || { tasks: [], projects: [], enabled: true })));
      // Groups the panel scopes by ARE the Context View's contexts (#526).
      if (ds.onContextsChanged) unsubs.push(ds.onContextsChanged((list) => setContexts(list || [])));
      // Follow the context selected in the rail (context → panel filter).
      if (ds.onActiveContextChanged) unsubs.push(ds.onActiveContextChanged((id) =>
        setFilter(id ? { type: 'group', value: id } : { type: 'all', value: '' })));
    }
    if (window.deepsteve) setup();
    else {
      let n = 0;
      const t = setInterval(() => { if (window.deepsteve) { clearInterval(t); setup(); } else if (++n > 100) clearInterval(t); }, 100);
    }
    return () => { for (const u of unsubs) { try { u(); } catch {} } };
  }, []);

  const visible = useMemo(() => {
    if (filter.type === 'project') return data.tasks.filter((t) => (t.project || '') === filter.value);
    if (filter.type === 'group') {
      const c = contexts.find((x) => x.id === filter.value);
      const dirs = c ? (c.dirs || []) : [];
      return data.tasks.filter((t) => dirs.some((d) => inside(t.project, d)));
    }
    return data.tasks;
  }, [data, contexts, filter]);

  // group visible tasks by project for display
  const sections = useMemo(() => {
    const byProj = new Map();
    for (const t of visible) {
      const key = t.project || '';
      if (!byProj.has(key)) byProj.set(key, []);
      byProj.get(key).push(t);
    }
    const nameOf = (root) => { const p = data.projects.find((x) => x.root === root); return p ? p.name : (root ? root.split('/').pop() : 'No project'); };
    return [...byProj.entries()].sort((a, b) => nameOf(a[0]).localeCompare(nameOf(b[0]))).map(([root, ts]) => ({ root, name: nameOf(root), tasks: ts }));
  }, [visible, data.projects]);

  return (
    <div style={{ padding: 12, color: C.text, fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>⏰ Scheduled</div>
        <button onClick={() => { setEditing('new'); setShowGroups(false); }} style={btn(C.accent)}>+ New</button>
        <button onClick={() => { setShowGroups(!showGroups); setEditing(null); }} style={btn()}>Groups</button>
      </div>

      {!data.enabled && (
        <div style={{ fontSize: 12, color: C.amber, border: `1px solid ${C.amber}`, borderRadius: 4, padding: '6px 8px', marginBottom: 8 }}>
          Scheduler is off. Enable “Run scheduled tasks” in Settings.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: C.dim }}>Show</span>
        <select
          style={{ ...input(), marginTop: 0, flex: 1 }}
          value={`${filter.type}:${filter.value}`}
          onChange={(e) => {
            const [type, ...rest] = e.target.value.split(':');
            const value = rest.join(':');
            setFilter({ type, value });
            // Bidirectional (#526): group / all selections also drive the rail's
            // active context; a per-project selection stays panel-local.
            if (type === 'group') window.deepsteve.setActiveContext?.(value);
            else if (type === 'all') window.deepsteve.setActiveContext?.(null);
          }}
        >
          <option value="all:">All projects</option>
          {contexts.length > 0 && <optgroup label="Groups">{contexts.map((g) => <option key={g.id} value={`group:${g.id}`}>Group: {g.name}</option>)}</optgroup>}
          {data.projects.length > 0 && <optgroup label="Projects">{data.projects.map((p) => <option key={p.root} value={`project:${p.root}`}>{p.name}</option>)}</optgroup>}
        </select>
      </div>

      {showGroups && <GroupsManager contexts={contexts} projects={data.projects} onClose={() => setShowGroups(false)} />}
      {editing && <TaskForm task={editing === 'new' ? null : editing} projects={data.projects} onClose={() => setEditing(null)} />}

      {sections.length === 0 && !editing && (
        <div style={{ color: C.dim, fontSize: 13, marginTop: 20, textAlign: 'center' }}>No scheduled tasks yet.<br />Click <b>+ New</b> to create one.</div>
      )}

      {sections.map((sec) => (
        <div key={sec.root} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: C.dim, marginBottom: 6, borderBottom: `1px solid ${C.border}`, paddingBottom: 3 }}>{sec.name}</div>
          {sec.tasks.map((t) => <TaskCard key={t.id} task={t} onEdit={(task) => { setEditing(task); setShowGroups(false); }} />)}
        </div>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('sched-root')).render(<App />);

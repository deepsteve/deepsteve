/**
 * GitHub Webhooks' settings page — what the gear on its row in the Mods modal opens
 * (`"settingsModule": "settings.js"` in mod.json; mod-manager imports this file and calls
 * render()). Everything the mod can be told lives here: the issue watch, the Work master
 * switch, and each project's Work config (its triggers, worker model, cap).
 *
 * The mod runs in the daemon, so the two global switches are real server settings
 * (`githubIssueWatch`, `githubWorkEnabled`) rather than the per-browser values a mod's
 * `settings` array stores; a project's Work config is saved on the mod's own route. Every
 * control saves when it changes, like every other mod's settings.
 */

const STATUS_URL = '/api/github-webhooks/status';
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
const ON_NEW_LABELS = {
  hold: 'Wait for the merge — show it only when the agent tries to merge',
  notify: 'Tell the agent when its current turn ends',
  interrupt: 'Tell the agent mid-turn, at its next tool call',
};
const DESC_STYLE = 'font-size: 12px; color: var(--ds-text-secondary); margin: 4px 0 8px;';
const INPUT_STYLE = 'padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary); font-size: 12px;';

// Where saves and failures are reported: the status line at the foot of the page.
let notify = () => {};

async function fetchStatus() {
  const r = await fetch(STATUS_URL);
  if (!r.ok) throw new Error(r.status === 404 ? 'the GitHub Webhooks mod is not loaded' : `HTTP ${r.status}`);
  return r.json();
}

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') n.style.cssText = v;
    else if (k === 'text') n.textContent = v;
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function msText(ms) {
  if (ms == null) return '';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function checkRow(label, checked, desc) {
  const box = el('input', { type: 'checkbox', checked, style: 'accent-color: var(--ds-accent-green);' });
  const wrap = el('div', { style: 'margin: 6px 0;' }, [
    el('label', { style: 'font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;' }, [box, label]),
    desc ? el('p', { style: 'font-size: 11px; color: var(--ds-text-secondary); margin: 2px 0 0 24px;', text: desc }) : null,
  ]);
  return { wrap, box };
}

function projectSummary(p) {
  const c = p.config;
  if (!c.enabled) return 'Off';
  const parts = ['On', c.workerModel === 'direct' ? 'one session per issue' : 'project agent coordinates'];
  parts.push(`${p.running}/${c.maxConcurrent} running`);
  if (p.lastError) parts.push(`⚠ ${p.lastError}`);
  else if (p.note) parts.push(p.note);
  else parts.push(`checked ${ago(p.lastCheckAt)}`);
  return parts.join(' · ');
}

async function saveSettings(patch) {
  try {
    const r = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    notify(j.warnings && j.warnings.length ? `Not saved: ${j.warnings.join('; ')}` : 'Saved');
  } catch (e) {
    notify(`Couldn’t save — ${e.message}`);
  }
}

/** Fill the mod's settings modal. */
export async function render(container) {
  container.innerHTML = '';
  const status = el('div', { style: 'font-size: 11px; color: var(--ds-text-secondary); min-height: 14px; margin-top: 10px;' });
  let statusTimer = null;
  notify = (text) => {
    status.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; }, 4000);
  };
  container.appendChild(el('p', { style: DESC_STYLE, text:
    'Keeps agents in step with their GitHub issues. There is no webhook server: Deep Steve re-reads issues now and then, '
    + 'with conditional requests that cost nothing against GitHub\'s rate limit when nothing changed. Only comments '
    + 'from the repo\'s owners, members and collaborators ever reach an agent.' }));
  const body = el('div', { text: 'Loading…', style: 'font-size: 12px; color: var(--ds-text-secondary);' });
  container.appendChild(body);
  container.appendChild(status);
  try {
    const [statusData, settingsData] = await Promise.all([
      fetchStatus(),
      fetch('/api/settings').then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    ]);
    body.textContent = '';
    body.style.cssText = '';
    build(body, statusData, settingsData);
  } catch (e) {
    body.textContent = `Unavailable — ${e.message}.`;
  }
}

function build(body, status, settingsData) {
  // ── Issue watch ──
  const setting = settingsData.githubIssueWatch || { preset: status.watch.policy.preset, custom: null };
  let storedCustom = setting.custom || null;
  const presets = status.watch.presets;
  body.appendChild(el('h4', { text: 'Issue watch', style: 'margin: 10px 0 2px; font-size: 13px; color: var(--ds-text-primary);' }));
  body.appendChild(el('p', { style: DESC_STYLE, text:
    'What an issue session hears about comments and edits posted after it started. An agent builds what it saw when it '
    + 'started; this makes sure nothing posted later is silently missed before it merges.' }));
  const select = el('select', { style: INPUT_STYLE });
  for (const p of presets) select.appendChild(el('option', { value: p.id, text: p.label }));
  select.appendChild(el('option', { value: 'custom', text: 'Custom' }));
  select.value = setting.preset === 'custom' || presets.some(p => p.id === setting.preset) ? setting.preset : 'safety-net';
  const presetDesc = el('p', { style: DESC_STYLE });
  body.appendChild(select);
  body.appendChild(presetDesc);

  // Custom fields start from the stored custom policy, else from whichever preset is resolved now.
  const base = storedCustom || {};
  const live = status.watch.policy;
  const schedule = el('input', { type: 'text', style: `${INPUT_STYLE} width: 220px; flex: none;`,
    value: Array.isArray(base.schedule) ? base.schedule.join(', ') : live.schedule.map(msText).join(', ') });
  const working = el('input', { type: 'text', style: `${INPUT_STYLE} width: 70px; flex: none;`, value: base.working ?? msText(live.working) ?? '' });
  const idle = el('input', { type: 'text', style: `${INPUT_STYLE} width: 70px; flex: none;`, value: base.idle ?? msText(live.idle) ?? '' });
  const onNew = el('select', { style: INPUT_STYLE });
  for (const [id, label] of Object.entries(ON_NEW_LABELS)) onNew.appendChild(el('option', { value: id, text: label }));
  onNew.value = base.onNew || live.onNew;
  const gate = checkRow('Hold the merge until new context has been shown', base.mergeGate ?? live.mergeGate,
    'A fresh read right before an agent merges; anything it has not seen holds the merge once. Merges you press are never held.');
  const after = checkRow('One last read after the issue closes', base.afterClose ?? live.afterClose,
    'Catches a comment that raced the merge, if the session is still open.');
  const row = (label, input, hint) => el('div', { style: 'display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; color: var(--ds-text-primary);' },
    [el('span', { text: label, style: 'width: 110px; flex-shrink: 0;' }), input, hint ? el('span', { text: hint, style: 'color: var(--ds-text-secondary); font-size: 11px;' }) : null]);
  const custom = el('div', { style: 'margin: 0 0 8px 0; padding: 8px 10px; border: 1px solid var(--ds-border); border-radius: 6px;' }, [
    row('First reads', schedule, 'delays between reads after the session starts'),
    row('Then, working', working, 'blank = stop'),
    row('Then, idle', idle, 'blank = stop'),
    row('New context', onNew),
    gate.wrap, after.wrap,
    el('p', { style: 'font-size: 11px; color: var(--ds-text-secondary); margin: 6px 0 0;', text:
      `Durations like 30s, 2m, 1h. Nothing is read more often than every ${msText(status.watch.minDelayMs)}, and finding something restarts the first reads.` }),
  ]);
  body.appendChild(custom);
  const readCustom = () => ({
    schedule: schedule.value.split(',').map(x => x.trim()).filter(Boolean),
    working: working.value.trim() || null,
    idle: idle.value.trim() || null,
    onNew: onNew.value,
    mergeGate: gate.box.checked,
    afterClose: after.box.checked,
  });
  const saveWatch = () => {
    if (select.value === 'custom') storedCustom = readCustom();
    // A preset keeps the custom policy stored, so switching back to Custom finds it again.
    saveSettings({ githubIssueWatch: { preset: select.value, custom: storedCustom } });
  };
  const syncPreset = () => {
    const p = presets.find(x => x.id === select.value);
    presetDesc.textContent = p ? p.description : 'Your own schedule and behaviour.';
    custom.style.display = select.value === 'custom' ? '' : 'none';
  };
  select.addEventListener('change', () => { syncPreset(); saveWatch(); });
  for (const input of [schedule, working, idle, onNew, gate.box, after.box]) input.addEventListener('change', saveWatch);
  syncPreset();

  // ── Work ──
  body.appendChild(el('h4', { text: 'Work', style: 'margin: 14px 0 2px; font-size: 13px; color: var(--ds-text-primary);' }));
  const work = checkRow('Let projects pick up GitHub issues on their own', status.work.enabled,
    'Each project below opts in on its own: a longstanding agent receives the open issues that match the project\'s '
    + 'triggers and starts an issue session for each one it takes. Turning this off stops every project\'s Work.');
  work.box.addEventListener('change', () => saveSettings({ githubWorkEnabled: work.box.checked }));
  body.appendChild(work.wrap);
  const list = el('div', { style: 'margin: 6px 0 0 24px;' });
  body.appendChild(list);
  const drawProjects = (projects) => {
    list.innerHTML = '';
    if (!projects.length) {
      list.appendChild(el('p', { style: 'font-size: 11px; color: var(--ds-text-secondary);', text: 'No projects yet.' }));
      return;
    }
    for (const p of projects) {
      const btn = el('button', { className: 'btn-secondary', text: 'Configure…', style: 'padding: 2px 8px; font-size: 11px; flex-shrink: 0;' });
      btn.onclick = () => openWorkEditor({ id: p.id, name: p.name }, {
        masterOn: () => work.box.checked,
        onSaved: () => fetchStatus().then(s => drawProjects(s.work.projects)).catch(() => {}),
      });
      list.appendChild(el('div', { style: 'display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px;' }, [
        el('span', { text: p.name, style: 'color: var(--ds-text-primary); min-width: 100px;' }),
        el('span', { text: projectSummary(p), style: 'color: var(--ds-text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }),
        btn,
      ]));
    }
  };
  drawProjects(status.work.projects);
}

// ── a project's Work editor ─────────────────────────────────────────────────

function triggerEditor(t, onRemove) {
  const enabled = el('input', { type: 'checkbox', checked: !!t.enabled, style: 'accent-color: var(--ds-accent-green);' });
  const name = el('input', { type: 'text', value: t.name, style: `${INPUT_STYLE} flex: 1; font-weight: 600;` });
  const labelsAll = el('input', { type: 'text', value: t.labelsAll.join(', '), placeholder: 'e.g. agent-ready', style: `${INPUT_STYLE} flex: 1;` });
  const labelsAny = el('input', { type: 'text', value: t.labelsAny.join(', '), placeholder: 'e.g. build, ci', style: `${INPUT_STYLE} flex: 1;` });
  const pattern = el('input', { type: 'text', value: t.labelPattern, placeholder: 'e.g. ^build-\\d', style: `${INPUT_STYLE} flex: 1;` });
  const authors = el('select', { style: INPUT_STYLE });
  authors.appendChild(el('option', { value: 'collaborators', text: 'Filed by a collaborator' }));
  authors.appendChild(el('option', { value: 'anyone', text: 'Filed by anyone (a label is required)' }));
  authors.value = t.authors;
  const instructions = el('textarea', { rows: 2, value: t.instructions, placeholder: 'Extra instructions for the session — {{label}} is the label the pattern matched',
    style: `${INPUT_STYLE} width: 100%; box-sizing: border-box; font-family: inherit; resize: vertical;` });
  const remove = el('button', { className: 'btn-secondary', text: '✕', title: 'Remove this trigger', style: 'padding: 2px 8px; font-size: 11px;' });
  remove.onclick = onRemove;
  const line = (label, input) => el('div', { style: 'display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px;' },
    [el('span', { text: label, style: 'width: 120px; flex-shrink: 0; color: var(--ds-text-secondary);' }), input]);
  const box = el('div', { style: 'border: 1px solid var(--ds-border); border-radius: 6px; padding: 8px 10px; margin: 6px 0;' }, [
    el('div', { style: 'display: flex; align-items: center; gap: 8px;' }, [enabled, name, remove]),
    line('Has all labels', labelsAll),
    line('Has any label', labelsAny),
    line('A label matching', pattern),
    line('Who', authors),
    instructions,
  ]);
  return {
    el: box,
    read: () => ({
      id: t.id, enabled: enabled.checked, name: name.value.trim() || t.id,
      labelsAll: labelsAll.value, labelsAny: labelsAny.value, labelPattern: pattern.value.trim(),
      authors: authors.value, instructions: instructions.value.trim(),
    }),
  };
}

/** A project's Work modal, over the settings page. `ctx` is { id, name }. */
function openWorkEditor(ctx, { masterOn = () => true, onSaved = () => {} } = {}) {
  return openWorkEditorAsync(ctx, { masterOn, onSaved });
}

async function openWorkEditorAsync(ctx, { masterOn, onSaved }) {
  const showToast = (text) => notify(text);
  let status;
  try {
    status = await fetchStatus();
  } catch (e) {
    showToast(`Couldn’t load GitHub Work — ${e.message}`);
    return;
  }
  const project = status.work.projects.find(p => p.id === ctx.id);
  if (!project) { showToast('That project is archived or gone.'); return; }
  const cfg = project.config;

  const overlay = el('div', { className: 'modal-overlay' });
  const modal = el('div', { className: 'modal pipeline-modal' });
  overlay.appendChild(modal);
  modal.appendChild(el('h2', { text: `GitHub Work — ${ctx.name}` }));
  modal.appendChild(el('p', { className: 'pipeline-modal-note', text:
    `Open issues in ${project.slug || 'this project\'s GitHub repo'} that match a trigger below are picked up by Deep Steve. `
    + 'A trigger is satisfied by who filed the issue or by a label on it — and on a public repo only people with triage access '
    + 'can apply labels, so a label is how you vouch for an issue from a stranger. Don\'t use a label an issue template applies on its own.' }));
  if (!masterOn()) {
    modal.appendChild(el('p', { className: 'pipeline-modal-note', style: 'color: var(--ds-accent-orange);', text:
      'Work is switched off for every project on the settings page, so nothing runs until it is on there too.' }));
  }

  const on = checkRow('Work is on for this project', cfg.enabled, null);
  modal.appendChild(on.wrap);

  const modeSel = el('select', { style: INPUT_STYLE });
  for (const [id, m] of Object.entries(status.work.workerModels)) modeSel.appendChild(el('option', { value: id, text: m.label }));
  modeSel.value = cfg.workerModel;
  const modeDesc = el('p', { style: 'font-size: 11px; color: var(--ds-text-secondary); margin: 2px 0 6px 128px;' });
  const syncMode = () => { modeDesc.textContent = status.work.workerModels[modeSel.value]?.description || ''; };
  modeSel.addEventListener('change', syncMode);
  syncMode();

  const modelSel = el('select', { style: INPUT_STYLE });
  modelSel.appendChild(el('option', { value: '', text: 'Agent default' }));
  for (const m of MODEL_ALIASES) modelSel.appendChild(el('option', { value: m, text: m }));
  modelSel.appendChild(el('option', { value: '__custom__', text: 'Custom…' }));
  const modelCustom = el('input', { type: 'text', placeholder: 'model id', style: `${INPUT_STYLE} width: 160px; flex: none;` });
  const isCustomModel = cfg.model && !MODEL_ALIASES.includes(cfg.model);
  modelSel.value = isCustomModel ? '__custom__' : cfg.model;
  modelCustom.value = isCustomModel ? cfg.model : '';
  const syncModel = () => { modelCustom.style.display = modelSel.value === '__custom__' ? '' : 'none'; };
  modelSel.addEventListener('change', syncModel);
  syncModel();

  const cap = el('input', { type: 'number', min: 1, max: 8, value: cfg.maxConcurrent, style: `${INPUT_STYLE} width: 60px;` });
  const every = el('input', { type: 'number', min: 2, max: 240, value: cfg.checkMinutes, style: `${INPUT_STYLE} width: 60px;` });
  const line = (label, ...inputs) => el('div', { style: 'display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; color: var(--ds-text-primary);' },
    [el('span', { text: label, style: 'width: 120px; flex-shrink: 0;' }), ...inputs]);
  modal.appendChild(line('Workers', modeSel));
  modal.appendChild(modeDesc);
  modal.appendChild(line('Model', modelSel, modelCustom));
  modal.appendChild(line('At most', cap, el('span', { text: 'issue sessions at once', style: 'color: var(--ds-text-secondary);' })));
  modal.appendChild(line('Check every', every, el('span', { text: 'minutes, and only while there is room', style: 'color: var(--ds-text-secondary);' })));

  modal.appendChild(el('h4', { text: 'Triggers', style: 'margin: 12px 0 2px; font-size: 13px;' }));
  modal.appendChild(el('p', { style: 'font-size: 11px; color: var(--ds-text-secondary); margin: 0 0 4px;', text:
    'The first enabled trigger that matches an issue takes it. A trigger with no label condition only takes issues filed after Work was turned on.' }));
  const triggerList = el('div');
  modal.appendChild(triggerList);
  const editors = [];
  const addEditor = (t) => {
    const ed = triggerEditor(t, () => { ed.el.remove(); editors.splice(editors.indexOf(ed), 1); });
    editors.push(ed);
    triggerList.appendChild(ed.el);
  };
  for (const t of cfg.triggers) addEditor(t);
  const addBtn = el('button', { className: 'btn-secondary', text: '+ Trigger', style: 'padding: 2px 10px; font-size: 12px;' });
  addBtn.onclick = () => {
    let n = editors.length + 1;
    while (editors.some(e => e.read().id === `trigger-${n}`)) n++;
    addEditor({ id: `trigger-${n}`, name: 'New trigger', enabled: true, labelsAll: [], labelsAny: [], labelPattern: '', authors: 'collaborators', instructions: '' });
  };
  modal.appendChild(addBtn);

  // What Work has done here, so the modal is also where you look.
  const recent = [...project.started.map(i => ({ ...i, what: i.live ? 'running' : 'started' })),
    ...project.offered.map(i => ({ ...i, what: 'offered' })),
    ...project.declined.map(i => ({ ...i, what: `declined: ${i.reason || ''}` })),
    ...project.failed.map(i => ({ ...i, what: `failed: ${i.reason || ''}` }))]
    .sort((a, b) => b.at - a.at).slice(0, 8);
  modal.appendChild(el('h4', { text: 'Activity', style: 'margin: 12px 0 2px; font-size: 13px;' }));
  modal.appendChild(el('p', { style: 'font-size: 11px; color: var(--ds-text-secondary); margin: 0 0 4px;', text:
    `Last checked ${ago(project.lastCheckAt)}${project.lastError ? ` — ⚠ ${project.lastError}` : project.note ? ` — ${project.note}` : ''}.`
    + (project.agent ? ' Project agent running.' : '') }));
  if (recent.length) {
    const ul = el('ul', { style: 'margin: 0; padding-left: 18px; font-size: 12px;' });
    for (const i of recent) ul.appendChild(el('li', { text: `#${i.number} ${i.title || ''} — ${i.what}` }));
    modal.appendChild(ul);
  }

  const btns = el('div', { className: 'modal-buttons', style: 'margin-top: 14px;' });
  const checkNow = el('button', { className: 'btn-secondary', text: 'Check now', style: 'margin-right: auto;' });
  checkNow.onclick = () => fetch(`/api/github-webhooks/work/${encodeURIComponent(ctx.id)}/check`, { method: 'POST' })
    .then(() => showToast('Checking GitHub…')).catch(() => {});
  const cancel = el('button', { className: 'btn-secondary', text: 'Cancel' });
  cancel.onclick = () => overlay.remove();
  const save = el('button', { className: 'btn-primary', text: 'Save' });
  save.onclick = async () => {
    const body = {
      enabled: on.box.checked,
      workerModel: modeSel.value,
      model: modelSel.value === '__custom__' ? modelCustom.value.trim() : modelSel.value,
      maxConcurrent: Number(cap.value),
      checkMinutes: Number(every.value),
      triggers: editors.map(e => e.read()),
    };
    try {
      const r = await fetch(`/api/github-webhooks/work/${encodeURIComponent(ctx.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      overlay.remove();
      showToast(body.enabled ? `Work is on for ${ctx.name}` : `Work is off for ${ctx.name}`);
      onSaved();
    } catch (e) {
      showToast(`Couldn’t save GitHub Work — ${e.message}`);
    }
  };
  btns.appendChild(checkNow);
  btns.appendChild(cancel);
  btns.appendChild(save);
  modal.appendChild(btns);

  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); overlay.remove(); }
  }, true);
  document.body.appendChild(overlay);
}

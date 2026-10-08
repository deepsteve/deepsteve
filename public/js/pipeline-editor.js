/**
 * The issue-pipeline stage editor (#717), shared by Settings → GitHub → Magic Wand (the
 * global level) and the projects rail's "Issue pipeline…" item (the project level). The
 * repo level is a committed `.deepsteve/pipeline.json` and has no editor on purpose.
 *
 * The stage model is the server's (issue-pipeline.js): built-in stages are fixed anchors
 * in a fixed order, and only custom stages move — up and down across the anchors, never
 * above `issue` or below `merge`. So nothing this editor can produce reorders anything
 * around the review gate, and the server would put it back if it did. The built-in list
 * and the text limits come from GET /api/issue-pipeline, so the browser keeps no copy.
 *
 *   mode 'global':  switches are booleans, drawn as checkboxes; they are saved to the
 *                   three settings keys the caller owns (wandPlanMode, issueStagesEnabled,
 *                   issueAutopilot), never into the layout.
 *   mode 'project': switches are true / false / null, drawn as Inherit / On / Off; null
 *                   leaves the stage's switch to the global level.
 */

// UI copy per built-in. The labels themselves come from the server.
const BUILTIN_HINTS = {
  issue: 'The issue, rendered with the prompt template.',
  plan: 'Start the agent in plan mode (Claude Code and OpenCode have one).',
  implement: 'The agent does the work.',
  review: 'Report to the Inbox as it works, and get a human to approve a share_result before merging.',
  merge: 'Autopilot: issue_complete merges, closes the issue and closes the tab. Runs server-side, so it takes no instructions.',
};

const SWITCH_NAMES = { plan: 'plan mode', review: 'review gate', merge: 'Autopilot merge' };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') node.style.cssText = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/**
 * Build an editor. Returns `{ el, read }`; `read()` gives
 * `{ stages, switches, isDefault }` where `stages` is a layout ready to POST (built-ins
 * carry `enabled` only in project mode, and only when not inheriting) and `isDefault` is
 * true when the layout says nothing the built-in default does not.
 */
export function createPipelineEditor({ mode = 'global', builtins, limits = {}, stages, switches, inherited = {} }) {
  const meta = new Map(builtins.map(b => [b.id, b]));
  const rows = stages.map(s => ({ ...s }));
  const sw = { ...switches };
  let seq = 0;
  const root = el('div', { className: 'pipeline-editor' });

  function nextCustomId(label) {
    const base = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'step';
    const taken = new Set(rows.map(r => r.id));
    let id = base;
    while (taken.has(id) || meta.has(id)) id = `${base}-${++seq}`;
    return id;
  }

  function switchControl(id) {
    if (mode === 'project') {
      const sel = el('select', { className: 'pipeline-switch' });
      const inh = inherited[id] ? 'on' : 'off';
      for (const [value, text] of [['', `Inherit (${inh})`], ['on', 'On'], ['off', 'Off']]) {
        sel.append(el('option', { value, textContent: text }));
      }
      sel.value = sw[id] == null ? '' : (sw[id] ? 'on' : 'off');
      sel.title = `This project's ${SWITCH_NAMES[id]}`;
      sel.onchange = () => { sw[id] = sel.value === '' ? null : sel.value === 'on'; };
      return sel;
    }
    const box = el('input', { type: 'checkbox', className: 'pipeline-switch', checked: !!sw[id] });
    box.title = `Turn ${SWITCH_NAMES[id]} on or off`;
    box.onchange = () => { sw[id] = box.checked; };
    return box;
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 1 || j > rows.length - 2) return; // never above `issue`, never below `merge`
    [rows[i], rows[j]] = [rows[j], rows[i]];
    render();
  }

  function render() {
    root.textContent = '';
    const customs = rows.filter(r => !meta.has(r.id)).length;
    rows.forEach((row, i) => {
      const b = meta.get(row.id);
      const card = el('div', { className: `pipeline-stage ${b ? 'builtin' : 'custom'}` });
      const head = el('div', { className: 'pipeline-stage-head' });
      if (b) {
        head.append(b.switchable ? switchControl(row.id) : el('span', { className: 'pipeline-always', textContent: '•', title: 'Always part of an issue session' }));
        head.append(el('span', { className: 'pipeline-stage-name', textContent: b.label }));
        head.append(el('span', { className: 'pipeline-stage-hint', textContent: BUILTIN_HINTS[row.id] || '', title: BUILTIN_HINTS[row.id] || '' }));
      } else {
        const on = el('input', { type: 'checkbox', className: 'pipeline-switch', checked: row.enabled !== false, title: 'Include this stage' });
        on.onchange = () => { row.enabled = on.checked; };
        const label = el('input', { type: 'text', className: 'pipeline-stage-label', value: row.label || '', placeholder: 'Stage name' });
        if (limits.label) label.maxLength = limits.label;
        label.oninput = () => { row.label = label.value; };
        const up = el('button', { className: 'pipeline-stage-btn', textContent: '↑', title: 'Move up', disabled: i <= 1 });
        up.onclick = () => move(i, -1);
        const down = el('button', { className: 'pipeline-stage-btn', textContent: '↓', title: 'Move down', disabled: i >= rows.length - 2 });
        down.onclick = () => move(i, 1);
        const rm = el('button', { className: 'pipeline-stage-btn', textContent: '✕', title: 'Remove this stage' });
        rm.onclick = () => { rows.splice(i, 1); render(); };
        head.append(on, label, up, down, rm);
      }
      card.append(head);
      if (!b || b.instructions) {
        const text = el('textarea', {
          className: 'pipeline-stage-instructions', rows: 2, value: row.instructions || '',
          placeholder: b ? `Instructions for ${b.label.toLowerCase()} (optional)` : 'What the agent should do in this stage',
        });
        if (limits.instructions) text.maxLength = limits.instructions;
        text.oninput = () => { row.instructions = text.value; };
        card.append(text);
      }
      root.append(card);
    });
    const add = el('button', { className: 'btn-secondary pipeline-add', textContent: '+ Add stage' });
    if (limits.maxCustomStages && customs >= limits.maxCustomStages) {
      add.disabled = true;
      add.title = `At most ${limits.maxCustomStages} custom stages`;
    }
    add.onclick = () => {
      // New stages land just before `merge`, the last place anything can run.
      rows.splice(rows.length - 1, 0, { id: nextCustomId(''), label: '', instructions: '' });
      render();
      root.querySelectorAll('.pipeline-stage-label')[rows.filter(r => !meta.has(r.id)).length - 1]?.focus();
    };
    root.append(add);
  }

  function read() {
    const out = [];
    for (const row of rows) {
      const b = meta.get(row.id);
      const instructions = (row.instructions || '').trim();
      if (b) {
        const s = { id: row.id };
        if (mode === 'project' && b.switchable && sw[row.id] != null) s.enabled = !!sw[row.id];
        if (b.instructions && instructions) s.instructions = instructions;
        out.push(s);
      } else if (instructions) {
        // A custom stage IS its instructions; an empty one would be dropped server-side.
        // Its id follows its label, so the committed shape stays readable.
        const label = (row.label || '').trim();
        const s = { id: label ? nextCustomIdFor(row, label) : row.id };
        if (label) s.label = label;
        s.instructions = instructions;
        if (row.enabled === false) s.enabled = false;
        out.push(s);
      }
    }
    const isDefault = out.every(s => meta.has(s.id) && !s.instructions && s.enabled === undefined);
    return { stages: out, switches: { ...sw }, isDefault };
  }

  // Keep an existing id when its label still slugs to it; mint one otherwise.
  function nextCustomIdFor(row, label) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (slug && (row.id === slug || row.id.startsWith(`${slug}-`))) return row.id;
    row.id = nextCustomId(label);
    return row.id;
  }

  render();
  return { el: root, read };
}

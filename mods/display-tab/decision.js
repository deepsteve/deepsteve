// Decision tabs (#716): a display tab with a row of buttons whose click is delivered back
// to the session that opened it, as a new prompt.
//
// This file is the pure half — config normalization, the prompt text, and a small
// persisted store keyed by display-tab id. tools.js owns the MCP tools and routes; the
// browser half is decision-bar.js, which the server injects into the page at serve time.
//
// Why a store of our own rather than fields on the tab: server.js keeps display tabs as a
// bare id → html map, and the owner has to survive a daemon restart, or every decision tab
// open across a ./restart.sh would answer nobody.

const fs = require('fs');
const path = require('path');
const { statePath } = require('../../paths.js');

const MAX_BUTTONS = 6;
const MAX_LABEL = 60;
const MAX_SENDS = 4000;
const MAX_PROMPT = 300;
const MAX_NOTE = 4000;
const STYLES = ['default', 'primary', 'danger'];

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validate and fill defaults. Returns `{ config }` or `{ error }` — never throws, so the
 * tool can hand the error straight back to the agent.
 */
function normalizeDecision(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'decision must be an object with a buttons array.' };
  const buttons = Array.isArray(raw.buttons) ? raw.buttons : [];
  if (buttons.length === 0) return { error: 'decision.buttons needs at least one button.' };
  if (buttons.length > MAX_BUTTONS) return { error: `decision.buttons has ${buttons.length} buttons; the most is ${MAX_BUTTONS}.` };
  const defaultConfirm = raw.confirm === true;
  const out = [];
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i] || {};
    const label = str(b.label);
    if (!label) return { error: `decision.buttons[${i}] needs a non-empty label.` };
    if (label.length > MAX_LABEL) return { error: `decision.buttons[${i}].label is longer than ${MAX_LABEL} characters — put the detail in "sends" or in the page.` };
    const sends = str(b.sends) || label;
    if (sends.length > MAX_SENDS) return { error: `decision.buttons[${i}].sends is longer than ${MAX_SENDS} characters.` };
    const style = b.style == null ? 'default' : b.style;
    if (!STYLES.includes(style)) return { error: `decision.buttons[${i}].style must be one of ${STYLES.join(', ')}.` };
    out.push({ label, sends, style, confirm: typeof b.confirm === 'boolean' ? b.confirm : defaultConfirm });
  }
  const prompt = str(raw.prompt);
  if (prompt.length > MAX_PROMPT) return { error: `decision.prompt is longer than ${MAX_PROMPT} characters — put it in the page instead.` };
  return {
    config: {
      buttons: out,
      closeOnDecision: raw.close_on_decision !== false,
      allowNote: raw.allow_note === true,
      prompt,
    },
  };
}

/** The text typed into the owning session when the user clicks. */
function decidePrompt({ tabId, name, button, note, closed }) {
  const lines = [`[Decision tab "${name}" (${tabId})] The user chose: ${button.label}`];
  if (button.sends !== button.label) lines.push('', button.sends);
  if (note) lines.push('', `Their note: ${note}`);
  lines.push('', closed
    ? 'The tab has closed itself.'
    : `The tab is still open. To ask a follow-up in it, call update_display_tab on ${tabId} with a new decision; otherwise close it with close_display_tab.`);
  return lines.join('\n');
}

/**
 * Persisted store. `isLive(id)` is the display-tab map's membership test: list() drops any
 * record whose tab is gone — swept as stale at boot, or deleted while the daemon was down —
 * so Decision Tab mode never offers a tab that cannot open. Deletions while the daemon is up
 * reach tools.js through server.js's display-tab delete hook and are removed there.
 */
function createDecisionStore({ file = () => statePath('display-tab-decisions.json'), isLive = () => true } = {}) {
  let records = null;

  function load() {
    records = {};
    try {
      const f = file();
      if (!fs.existsSync(f)) return;
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (data && data.records && typeof data.records === 'object') records = data.records;
    } catch {
      // A corrupt file is no decisions, never a throw: a throw at init drops the whole mod.
      records = {};
    }
  }

  function save() {
    try {
      const f = file();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, records }, null, 2));
      fs.renameSync(tmp, f);
    } catch {}
  }

  function ensure() {
    if (!records) load();
    return records;
  }

  function prune() {
    let dropped = 0;
    for (const id of Object.keys(ensure())) {
      if (!isLive(id)) { delete records[id]; dropped++; }
    }
    if (dropped) save();
    return dropped;
  }

  function get(id) {
    return ensure()[id] || null;
  }

  function set(id, record) {
    ensure()[id] = record;
    save();
    return record;
  }

  function remove(id) {
    if (ensure()[id]) { delete records[id]; save(); }
  }

  function list() {
    prune();
    return Object.entries(records).map(([id, r]) => ({ id, ...r }));
  }

  return { get, set, remove, prune, list, save, reload: load };
}

module.exports = { normalizeDecision, decidePrompt, createDecisionStore, MAX_BUTTONS, MAX_NOTE, STYLES };

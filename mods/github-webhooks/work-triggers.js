/**
 * Work: which newly filed (or newly labelled) issues a project's worker picks up.
 *
 * Pure. tools.js reads the issue list and hands each issue here; this answers "does any
 * enabled trigger want it, and with what extra instructions".
 *
 * The one rule this module exists to keep: **on a public repo anyone can file an issue, so
 * nothing a stranger can do alone may start an agent.** A trigger is satisfied either by
 * WHO filed the issue (a collaborator, per GitHub's author_association) or by a LABEL on it,
 * and GitHub only lets people with triage access apply labels. A trigger that names no label
 * is therefore forced to `authors: 'collaborators'` by the normalizer — there is no way to
 * write "any issue from anyone". (The one hole GitHub leaves is an issue template that
 * auto-applies a label; the settings text says not to use such a label as a trigger.)
 */
const { isTrustedAuthor } = require('./issue-context');

const AUTHORS = ['collaborators', 'anyone'];
const WORKER_MODELS = {
  coordinator: {
    label: 'Project agent coordinates',
    description: 'A long-lived project agent receives each matching issue, decides whether it is in scope, and starts an issue session for it.',
  },
  direct: {
    label: 'One session per issue',
    description: 'Deep Steve starts an issue session for each matching issue itself. No project agent runs, so no model turns are spent on routing — and nothing decides whether an issue is in scope.',
  },
};
const DEFAULT_WORKER_MODEL = 'coordinator';
const MAX_TRIGGERS = 12;
const MAX_LABELS = 12;
const LABEL_LIMIT = 50;
const INSTRUCTIONS_LIMIT = 400;
const TRIGGER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// The same shape server.js's validateModel accepts: an alias (`sonnet`) or a full model id.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const TRIGGER_PRESETS = [
  {
    id: 'trust-label', name: 'Trust label', enabled: true,
    labelsAll: ['agent-ready'], labelsAny: [], labelPattern: '', authors: 'anyone',
    instructions: '',
    description: 'Any open issue carrying the label, old or new. Only people with triage access can apply labels.',
  },
  {
    id: 'collaborator', name: 'Filed by a collaborator', enabled: false,
    labelsAll: [], labelsAny: [], labelPattern: '', authors: 'collaborators',
    instructions: '',
    description: 'Every issue a collaborator files after Work is turned on.',
  },
  {
    id: 'build-fixes', name: 'Quick build fixes', enabled: false,
    labelsAll: [], labelsAny: ['build', 'ci'], labelPattern: '', authors: 'collaborators',
    instructions: 'This is a build fix: keep the change minimal and get the build green.',
    description: 'Collaborator issues labelled build or ci.',
  },
  {
    id: 'infra', name: 'Infra', enabled: false,
    labelsAll: [], labelsAny: ['infra'], labelPattern: '', authors: 'collaborators',
    instructions: 'This is infrastructure work: prefer reversible changes and say what you touched.',
    description: 'Collaborator issues labelled infra.',
  },
  {
    id: 'targeted-build', name: 'Feature work for a build', enabled: false,
    labelsAll: ['feature'], labelsAny: [], labelPattern: '^build[-: ]?\\d', authors: 'anyone',
    instructions: 'This feature targets {{label}}. Keep it scoped to what that build needs.',
    description: 'Issues labelled feature plus a build label (e.g. build-142); the build label is passed to the worker.',
  },
];

function cleanLabels(v) {
  const out = [];
  for (const l of Array.isArray(v) ? v : String(v || '').split(',')) {
    const s = String(l || '').trim().slice(0, LABEL_LIMIT);
    if (s && !out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

function safePattern(p) {
  const s = String(p || '').trim().slice(0, 200);
  if (!s) return '';
  try { new RegExp(s, 'i'); return s; } catch { return ''; }
}

/** Any stored or posted trigger → a valid one, or null when it has no usable id. */
function normalizeTrigger(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase();
  if (!TRIGGER_ID_RE.test(id)) return null;
  const labelsAll = cleanLabels(raw.labelsAll);
  const labelsAny = cleanLabels(raw.labelsAny);
  const labelPattern = safePattern(raw.labelPattern);
  const hasLabelCondition = labelsAll.length > 0 || labelsAny.length > 0 || !!labelPattern;
  let authors = AUTHORS.includes(raw.authors) ? raw.authors : 'collaborators';
  // The rule in the header: no label, no strangers.
  if (!hasLabelCondition) authors = 'collaborators';
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 60) || id,
    enabled: !!raw.enabled,
    labelsAll, labelsAny, labelPattern, authors,
    instructions: String(raw.instructions || '').trim().slice(0, INSTRUCTIONS_LIMIT),
  };
}

function presetTriggers() {
  return TRIGGER_PRESETS.map(({ description, ...t }) => normalizeTrigger(t));
}

/** A project's stored Work config → a complete, valid one. */
function normalizeWorkConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const triggers = [];
  const seenIds = new Set();
  for (const t of Array.isArray(src.triggers) ? src.triggers : presetTriggers()) {
    const n = normalizeTrigger(t);
    if (!n || seenIds.has(n.id)) continue;
    seenIds.add(n.id);
    triggers.push(n);
    if (triggers.length >= MAX_TRIGGERS) break;
  }
  const maxConcurrent = Math.round(Number(src.maxConcurrent));
  return {
    enabled: !!src.enabled,
    workerModel: WORKER_MODELS[src.workerModel] ? src.workerModel : DEFAULT_WORKER_MODEL,
    maxConcurrent: Number.isFinite(maxConcurrent) ? Math.min(8, Math.max(1, maxConcurrent)) : 2,
    checkMinutes: Math.min(240, Math.max(2, Math.round(Number(src.checkMinutes)) || 10)),
    // The model Work's agents run — the project agent and every session it starts. '' is the
    // agent's own default.
    model: typeof src.model === 'string' && MODEL_RE.test(src.model.trim()) ? src.model.trim() : '',
    triggers,
    // When Work was last switched on. Label-less triggers only take issues filed after it,
    // so turning Work on never sweeps a project's whole history into agents.
    enabledAt: typeof src.enabledAt === 'string' ? src.enabledAt : null,
  };
}

function labelNames(issue) {
  return (issue && Array.isArray(issue.labels) ? issue.labels : [])
    .map(l => (typeof l === 'string' ? l : l && l.name) || '')
    .filter(Boolean);
}

/**
 * Does `trigger` want `issue`? → { trigger, matchedLabel } or null.
 * `enabledAt` (ISO) bounds the label-less triggers; see normalizeWorkConfig.
 */
function matchTrigger(issue, trigger, { enabledAt = null } = {}) {
  if (!issue || !trigger || !trigger.enabled) return null;
  if (issue.pull_request) return null;
  if (issue.state && issue.state !== 'open') return null;
  if (!issue.user || issue.user.type === 'Bot') return null;
  const names = labelNames(issue);
  const lower = names.map(n => n.toLowerCase());
  const hasLabelCondition = trigger.labelsAll.length > 0 || trigger.labelsAny.length > 0 || !!trigger.labelPattern;

  if (trigger.authors === 'collaborators' && !isTrustedAuthor(issue)) return null;
  if (!trigger.labelsAll.every(l => lower.includes(l.toLowerCase()))) return null;
  if (trigger.labelsAny.length && !trigger.labelsAny.some(l => lower.includes(l.toLowerCase()))) return null;
  let matchedLabel = null;
  if (trigger.labelPattern) {
    const re = new RegExp(trigger.labelPattern, 'i');
    matchedLabel = names.find(n => re.test(n)) || null;
    if (!matchedLabel) return null;
  }
  if (!hasLabelCondition && enabledAt && String(issue.created_at || '') < enabledAt) return null;
  return { trigger, matchedLabel };
}

/** The first enabled trigger that wants the issue, in the order the user listed them. */
function matchIssue(issue, config) {
  for (const t of (config && config.triggers) || []) {
    const m = matchTrigger(issue, t, { enabledAt: config.enabledAt });
    if (m) return m;
  }
  return null;
}

/** A trigger's extra instructions with {{label}} filled in. */
function triggerInstructions(match) {
  if (!match || !match.trigger.instructions) return '';
  return match.trigger.instructions.replace(/\{\{\s*label\s*\}\}/g, match.matchedLabel || 'the targeted build');
}

module.exports = {
  AUTHORS, WORKER_MODELS, DEFAULT_WORKER_MODEL, TRIGGER_PRESETS,
  normalizeTrigger, presetTriggers, normalizeWorkConfig, matchTrigger, matchIssue, triggerInstructions, labelNames,
};

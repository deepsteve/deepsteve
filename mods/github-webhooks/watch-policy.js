/**
 * When an issue session re-reads its GitHub issue, and what a finding does.
 *
 * A watch is a safety net, not a conversation. An agent builds what it saw at start; the
 * daemon re-reads the issue now and then so a comment or a body edit posted mid-work is not
 * silently missed; and the merge gate refuses to land the branch while anything new is
 * unaccounted for. So every preset tapers toward barely using GitHub at all — a session that
 * polled every 30s for a day would make ~2,900 requests to learn nothing.
 *
 * Pure: no timers, no network, no settings. tools.js owns the clock and hands in the step.
 *
 * A policy is { schedule, working, idle, onNew, mergeGate, afterClose }:
 *
 *   schedule    delays between consecutive checks right after the session starts (and again
 *               after a check that found something) — the taper. ['30s','2m'] means check 30s
 *               in, then 2m after that.
 *   working     steady delay once the taper is spent, while the agent is busy. null = stop.
 *   idle        steady delay once the taper is spent, while it sits at its prompt. null = stop.
 *   onNew       what new context does before the merge: 'hold' (record it; the merge gate is
 *               where the agent meets it), 'notify' (typed when the agent's turn ends) or
 *               'interrupt' (typed mid-turn, absorbed at its next tool boundary).
 *   mergeGate   a fresh read right before issue_complete merges; unseen context refuses it.
 *   afterClose  one last read after the issue is closed, so a comment that raced the close
 *               still reaches the session if it is open.
 */

// The floor every delay is clamped to. A preset or a hand-edited policy can be slow; it
// cannot be faster than this, because "a spam farm" is the failure this whole module exists
// to avoid — and because 304s being free does not make thousands of them polite.
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 24 * 60 * 60_000;
const MAX_SCHEDULE_STEPS = 12;
const ON_NEW = ['hold', 'notify', 'interrupt'];

const PRESETS = {
  off: {
    label: 'Off',
    description: 'Never read the issue again after the session starts.',
    schedule: [], working: null, idle: null, onNew: 'hold', mergeGate: false, afterClose: false,
  },
  'merge-gate': {
    label: 'Merge gate only',
    description: 'No background reads. One fresh read right before the merge, which waits while anything new is unaccounted for.',
    schedule: [], working: null, idle: null, onNew: 'hold', mergeGate: true, afterClose: true,
  },
  'safety-net': {
    label: 'Safety net',
    description: 'Reads at 30s, 2m, 5m, 10m and 15m, then every 15m while the agent works and hourly while it is idle. New context reaches the agent when its turn ends, and the merge waits for it.',
    schedule: ['30s', '2m', '5m', '10m', '15m'], working: '15m', idle: '60m', onNew: 'notify', mergeGate: true, afterClose: true,
  },
  monitor: {
    label: 'Monitor',
    description: 'A steady read every minute, delivered mid-turn. For watching something live, not for building features.',
    schedule: [], working: '1m', idle: '1m', onNew: 'interrupt', mergeGate: true, afterClose: true,
  },
};
const DEFAULT_PRESET = 'safety-net';
const PRESET_IDS = [...Object.keys(PRESETS), 'custom'];

/** '30s' | '2m' | '1h' | a bare number of ms → ms, or null when unreadable. */
function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v);
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(v == null ? '' : v));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  const ms = unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
  return ms > 0 ? Math.round(ms) : null;
}

function clampDelay(ms) {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, ms));
}

/** 90000 → '1.5m', 3600000 → '1h'. For logs and the settings description. */
function formatDuration(ms) {
  if (ms == null) return 'never';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Any stored or hand-edited policy → a complete one with every delay in ms and clamped.
 * Unknown fields are dropped and a bad field falls back to the safety-net value for that
 * field, so a typo degrades one knob instead of switching the watch off.
 */
function normalizePolicy(raw) {
  const base = PRESETS[DEFAULT_PRESET];
  const src = raw && typeof raw === 'object' ? raw : {};
  const steady = (v, fallback) => {
    if (v === null || v === 'never' || v === false) return null;
    const ms = parseDuration(v === undefined ? fallback : v);
    if (ms == null) return fallback == null ? null : clampDelay(parseDuration(fallback));
    return clampDelay(ms);
  };
  const schedule = (Array.isArray(src.schedule) ? src.schedule : base.schedule)
    .map(parseDuration).filter(ms => ms != null).slice(0, MAX_SCHEDULE_STEPS).map(clampDelay);
  return {
    schedule,
    working: steady(src.working, base.working),
    idle: steady(src.idle, base.idle),
    onNew: ON_NEW.includes(src.onNew) ? src.onNew : base.onNew,
    mergeGate: typeof src.mergeGate === 'boolean' ? src.mergeGate : base.mergeGate,
    afterClose: typeof src.afterClose === 'boolean' ? src.afterClose : base.afterClose,
  };
}

/** The setting's value ({ preset, custom }) → the policy a session runs. */
function resolvePolicy(setting) {
  const s = setting && typeof setting === 'object' ? setting : {};
  const preset = PRESET_IDS.includes(s.preset) ? s.preset : DEFAULT_PRESET;
  if (preset === 'custom') return { preset, ...normalizePolicy(s.custom) };
  return { preset, ...normalizePolicy(PRESETS[preset]) };
}

/** True when the policy never reads GitHub on a timer. */
function isTimerless(policy) {
  return policy.schedule.length === 0 && policy.working == null && policy.idle == null;
}

/**
 * The delay before the next background read, or null for "no more reads on a timer".
 * `step` counts the reads done since the taper last (re)started.
 */
function nextDelay(policy, { step = 0, idle = false } = {}) {
  if (step < policy.schedule.length) return policy.schedule[step];
  return idle ? policy.idle : policy.working;
}

module.exports = {
  PRESETS, PRESET_IDS, DEFAULT_PRESET, ON_NEW, MIN_DELAY_MS, MAX_DELAY_MS,
  parseDuration, formatDuration, normalizePolicy, resolvePolicy, nextDelay, isTimerless,
};

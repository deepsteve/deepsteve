/**
 * The issue pipeline (#717): an issue session as an ordered list of stages, configurable
 * globally, per registered project and per repo.
 *
 * Before this, an issue session was four unrelated knobs with a hard-coded order —
 * `wandPromptTemplate` (the issue), `wandPlanMode` (plan), `issueStagesEnabled` (the
 * workflow text and the Inbox review gate) and `issueAutopilot` (the merge). Those keys
 * still exist and still hold the GLOBAL switches; this module is what combines them with
 * the two narrower levels and with the stages' own instructions. The default pipeline is
 * exactly the old behavior, so there is no second code path to keep in step.
 *
 * Pure, like issue-prompt.js beside it: no settings, no daemon state. The daemon reads the
 * three levels and hands them in; the one fs function here (readRepoPipeline) takes its
 * logger as an argument.
 *
 * Three rules the shape below exists to keep:
 *
 * 1. **Built-in stages are anchors, in a fixed order.** `issue → plan → implement →
 *    review → merge`. Each one maps onto a mechanism that runs at a fixed point — plan is
 *    a spawn flag, review is a gate `issue_complete` checks before it merges — so their
 *    relative order is not configurable, and nothing can be moved around the gate. Custom
 *    stages (prompt text) go anywhere between them. "Removing" a built-in is turning it
 *    off; the normalizer re-inserts a missing one at its anchor.
 *
 * 2. **A committed repo file may only tighten** review and merge. Anyone who can push —
 *    and any agent working in the repo — can write `.deepsteve/pipeline.json`, so it may
 *    turn review ON and merge OFF, never the reverse; an entry that tries is clamped to the
 *    level below and reported in `clamped`. Plan mode is a preference, not a safety gate,
 *    so the file may switch it either way. The clamp lives in resolvePipeline(), not in
 *    the normalizer, so a tampered snapshot in state.json cannot loosen anything either.
 *
 * 3. **Replace, not patch.** The most specific level that defines a pipeline supplies the
 *    stage order, the instructions and the custom stages, and the start log names that
 *    level. The on/off switches still resolve level by level: project over global, repo
 *    combined under rule 2.
 */
const fs = require('fs');
const { projectPipelinePath } = require('./paths');

const BUILTIN_STAGES = ['issue', 'plan', 'implement', 'review', 'merge'];
// The built-ins that can be switched off. `issue` IS the prompt and `implement` is the
// agent doing the work, so neither has an off.
const SWITCHABLE = ['plan', 'review', 'merge'];
const BUILTIN_LABELS = { issue: 'Issue', plan: 'Plan', implement: 'Implement', review: 'Review', merge: 'Merge' };

// Same shape as a project view's slug: lowercase, starts alphanumeric, short.
const STAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_CUSTOM_STAGES = 8;
const LABEL_LIMIT = 40;
// Typed into a TUI composer on every issue start, on top of a body already clipped at
// ISSUE_BODY_LIMIT — the same argument as WORKFLOW_STAGES's budget.
const INSTRUCTIONS_LIMIT = 400;
const STEPS_TEXT_LIMIT = 2000;
const PIPELINE_FILE_MAX_BYTES = 16 * 1024;

const LIMITS = { maxCustomStages: MAX_CUSTOM_STAGES, label: LABEL_LIMIT, instructions: INSTRUCTIONS_LIMIT };

// What the editors need to draw a built-in row. Served by GET /api/issue-pipeline so the
// browser never keeps its own copy of the stage list.
const BUILTIN_META = BUILTIN_STAGES.map(id => ({
  id,
  label: BUILTIN_LABELS[id],
  switchable: SWITCHABLE.includes(id),
  // The merge runs server-side inside issue_complete and takes no model turns (#688), so
  // there is no turn for instructions to land in. Anything that should happen before the
  // merge belongs on `review` or a custom stage placed before it.
  instructions: id !== 'merge',
}));

const DEFAULT_LAYOUT = Object.freeze({ stages: Object.freeze(BUILTIN_STAGES.map(id => Object.freeze({ id }))) });

// Drop control characters by code point rather than with a regex character class. A `\r`
// matters most: typed into the composer it is Enter, which would submit half a prompt.
// Tabs become spaces; `singleLine` also folds newlines, for labels.
function cleanText(raw, limit, { singleLine = false } = {}) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0);
    if (c === 9) out += ' ';
    else if (c === 10) out += singleLine ? ' ' : '\n';
    else if (c >= 32 && c !== 127) out += ch;
  }
  return out.trim().slice(0, limit).trim();
}

function cleanBuiltin(id, raw, level) {
  const out = { id };
  // At the global level the three switches live in their own settings keys
  // (wandPlanMode / issueStagesEnabled / issueAutopilot), so a layout never carries one.
  if (level !== 'global' && SWITCHABLE.includes(id) && typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (id !== 'merge') {
    const instructions = cleanText(raw.instructions, INSTRUCTIONS_LIMIT);
    if (instructions) out.instructions = instructions;
  }
  return out;
}

// A custom stage IS its instructions — one without any has nothing to deliver.
function cleanCustom(id, raw) {
  const instructions = cleanText(raw.instructions, INSTRUCTIONS_LIMIT);
  if (!instructions) return null;
  const out = { id };
  const label = cleanText(raw.label, LABEL_LIMIT, { singleLine: true });
  if (label) out.label = label;
  out.instructions = instructions;
  if (raw.enabled === false) out.enabled = false;
  return out;
}

/**
 * `{ stages: [...] }` in canonical form, or null when `raw` does not define a pipeline.
 *
 * `level` is 'global' | 'project' | 'repo'. It only decides whether built-ins may carry
 * `enabled`; trust (what a repo may switch) is resolvePipeline()'s job.
 *
 * Every built-in is present in the result, in canonical order. A custom stage stays after
 * the latest built-in listed before it; one listed after `merge` moves to just before it,
 * since nothing runs after the merge. Unknown fields are dropped, ids are deduplicated
 * (first wins), and anything malformed is skipped rather than failing the whole file.
 */
function normalizePipeline(raw, { level = 'repo' } = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.stages)) return null;
  const seen = new Set();
  const builtins = new Map();
  const slots = new Map(BUILTIN_STAGES.map(id => [id, []]));
  let anchor = 'issue';
  let customs = 0;
  for (const s of raw.stages.slice(0, 64)) {
    if (!s || typeof s !== 'object') continue;
    const id = typeof s.id === 'string' ? s.id.trim().toLowerCase() : '';
    if (!STAGE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    if (BUILTIN_STAGES.includes(id)) {
      builtins.set(id, cleanBuiltin(id, s, level));
      // Only ever move forward: a built-in listed out of order is put back at its anchor,
      // and must not drag the customs after it backwards with it.
      if (BUILTIN_STAGES.indexOf(id) > BUILTIN_STAGES.indexOf(anchor)) anchor = id;
      continue;
    }
    if (customs >= MAX_CUSTOM_STAGES) continue;
    const custom = cleanCustom(id, s);
    if (!custom) continue;
    customs++;
    slots.get(anchor === 'merge' ? 'review' : anchor).push(custom);
  }
  const stages = [];
  for (const id of BUILTIN_STAGES) {
    stages.push(builtins.get(id) || { id });
    stages.push(...slots.get(id));
  }
  return { stages };
}

/** True when a normalized layout says nothing the default does not. */
function isDefaultLayout(layout) {
  return !!layout && JSON.stringify(layout) === JSON.stringify(DEFAULT_LAYOUT);
}

// What a repo file may set for a switch it names (rule 2 above).
function repoMayWrite(id, enabled) {
  if (id === 'plan') return true;
  if (id === 'review') return enabled === true;
  if (id === 'merge') return enabled === false;
  return false;
}

/**
 * Combine the three levels.
 *
 *   global:  { plan, review, merge, layout }   — layout is a normalized global layout or null
 *   project: { id, name, pipeline } | null      — pipeline normalized at 'project', or null
 *   repo:    { path, pipeline } | null          — pipeline normalized at 'repo', or null
 *   planFlag: whether the agent has a plan-mode spawn flag (only Claude Code and OpenCode)
 *
 * Returns `{ level, stages, plan, review, merge, sources, clamped, planApplicable, repoPath }`.
 * `level` names whose layout won; `sources[x]` names the level that decided switch `x`
 * ('setting' for the global level, matching the #653 log wording). Every stage in
 * `stages` carries a resolved boolean `enabled`.
 */
function resolvePipeline({ global = {}, project = null, repo = null, planFlag = true } = {}) {
  const on = { plan: !!global.plan, review: !!global.review, merge: !!global.merge };
  const sources = { plan: 'setting', review: 'setting', merge: 'setting' };
  const clamped = [];
  for (const s of (project && project.pipeline && project.pipeline.stages) || []) {
    if (!SWITCHABLE.includes(s.id) || typeof s.enabled !== 'boolean') continue;
    on[s.id] = s.enabled;
    sources[s.id] = 'project';
  }
  for (const s of (repo && repo.pipeline && repo.pipeline.stages) || []) {
    if (!SWITCHABLE.includes(s.id) || typeof s.enabled !== 'boolean') continue;
    if (repoMayWrite(s.id, s.enabled)) {
      on[s.id] = s.enabled;
      sources[s.id] = 'repo';
    } else if (on[s.id] !== s.enabled) {
      clamped.push(s.id);
    }
  }

  let level = 'default';
  let layout = DEFAULT_LAYOUT;
  if (repo && repo.pipeline) { level = 'repo'; layout = repo.pipeline; }
  else if (project && project.pipeline) { level = 'project'; layout = project.pipeline; }
  else if (global.layout) { level = 'global'; layout = global.layout; }

  const stages = layout.stages.map(s => {
    if (SWITCHABLE.includes(s.id)) return { ...s, enabled: on[s.id] };
    if (BUILTIN_STAGES.includes(s.id)) return { ...s, enabled: true };
    return { ...s, enabled: s.enabled !== false };
  });
  return {
    level, stages, plan: on.plan, review: on.review, merge: on.merge, sources, clamped,
    planApplicable: !!planFlag, repoPath: (repo && repo.pipeline && repo.path) || null,
  };
}

/**
 * The same resolution with plan mode as it was actually spawned. The picker's WebSocket
 * create decides plan mode before the `issue` message arrives; a client that predates
 * `issue=1` decided it in the browser, and the log must describe the session it got.
 */
function withSpawnedPlan(resolved, plan) {
  if (!!resolved.plan === !!plan) return resolved;
  return {
    ...resolved,
    plan: !!plan,
    sources: { ...resolved.sources, plan: 'explicit' },
    stages: resolved.stages.map(s => (s.id === 'plan' ? { ...s, enabled: !!plan } : s)),
  };
}

function stageLabel(s) {
  return s.label || BUILTIN_LABELS[s.id] || s.id;
}

/**
 * The prompt text for the stages' instructions, or null when no enabled stage has any —
 * which is what keeps the default pipeline's prompt byte-for-byte what it was before.
 *
 * Lists only the stages that carry text, in pipeline order. renderIssuePrompt() places it
 * after the issue (and any resume block) and before the completion instruction: these are
 * the steps between reading the issue and finishing it.
 */
function pipelineStepsText(resolved) {
  const steps = ((resolved && resolved.stages) || []).filter(s => s.enabled && s.instructions);
  if (!steps.length) return null;
  const lines = ['Steps for this issue, in order:'];
  let used = lines[0].length;
  for (let i = 0; i < steps.length; i++) {
    const line = `${i + 1}. ${stageLabel(steps[i])}: ${steps[i].instructions}`;
    if (used + line.length + 1 > STEPS_TEXT_LIMIT) {
      lines.push(`[${steps.length - i} more step(s) omitted: over the ${STEPS_TEXT_LIMIT}-character limit.]`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * `<level>:<enabled stage ids in order>` for the `[issue] #N:` start line, e.g.
 * `repo:issue>implement>run-tests>review`. Plan reads `plan(n/a)` for an agent with no
 * plan-mode flag (Codex, Hermes, Pi): the switch was on, but nothing was passed.
 */
function pipelineLogLabel(resolved) {
  const ids = resolved.stages
    .filter(s => s.enabled)
    .map(s => (s.id === 'plan' && !resolved.planApplicable ? 'plan(n/a)' : s.id));
  const clamped = resolved.clamped && resolved.clamped.length ? `, clamped=${resolved.clamped.join('+')}` : '';
  return `${resolved.level}:${ids.join('>')}${clamped}`;
}

/**
 * Read and normalize a repo's committed pipeline file. Null when there is none or it is
 * unusable; never throws. Same shape as the scheduled-tasks CONTEXT.md reader: lstat, so
 * a symlink is refused rather than followed out of the repo; a size cap that skips rather
 * than truncates; one log line per unusable case, and silence for the common "absent".
 *
 * The caller passes the MAIN checkout: an issue session works in a worktree and could
 * otherwise edit the file that gates it. The result is snapshotted on the shell entry at
 * spawn and never re-read for that session.
 */
function readRepoPipeline(repoRoot, { log = () => {} } = {}) {
  if (!repoRoot) return null;
  const file = projectPipelinePath(repoRoot);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') log(`[issue] pipeline file skipped — unreadable (${e.code}): ${file}`);
    return null;
  }
  if (!st.isFile()) { log(`[issue] pipeline file skipped — not a regular file: ${file}`); return null; }
  if (st.size > PIPELINE_FILE_MAX_BYTES) {
    log(`[issue] pipeline file skipped — ${st.size} bytes, over the ${PIPELINE_FILE_MAX_BYTES}-byte cap: ${file}`);
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log(`[issue] pipeline file skipped — ${e.message}: ${file}`);
    return null;
  }
  const pipeline = normalizePipeline(raw, { level: 'repo' });
  if (!pipeline) { log(`[issue] pipeline file skipped — no "stages" array: ${file}`); return null; }
  return { path: file, pipeline };
}

module.exports = {
  BUILTIN_STAGES, SWITCHABLE, BUILTIN_META, DEFAULT_LAYOUT, LIMITS, STAGE_ID_RE,
  MAX_CUSTOM_STAGES, INSTRUCTIONS_LIMIT, LABEL_LIMIT, STEPS_TEXT_LIMIT, PIPELINE_FILE_MAX_BYTES,
  normalizePipeline, isDefaultLayout, resolvePipeline, withSpawnedPlan, pipelineStepsText,
  pipelineLogLabel, readRepoPipeline,
};

// Unit tests for issue-pipeline.js (#717): an issue session as an ordered list of stages,
// configured globally, per project and per repo.
//
// The two properties that matter most are pinned first: the DEFAULT pipeline is exactly
// the four settings that existed before (so there is no second code path to drift), and a
// committed repo file can only tighten review and merge.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BUILTIN_STAGES, DEFAULT_LAYOUT, MAX_CUSTOM_STAGES, INSTRUCTIONS_LIMIT, STEPS_TEXT_LIMIT,
  PIPELINE_FILE_MAX_BYTES, normalizePipeline, isDefaultLayout, resolvePipeline, withSpawnedPlan,
  pipelineStepsText, pipelineLogLabel, readRepoPipeline,
} = require('../../issue-pipeline.js');
const { renderIssuePrompt } = require('../../issue-prompt.js');

const ids = (layout) => layout.stages.map(s => s.id);
const repo = (stages) => ({ path: '/r/.deepsteve/pipeline.json', pipeline: normalizePipeline({ stages }, { level: 'repo' }) });
const project = (stages) => ({ id: 'p1', name: 'P', pipeline: normalizePipeline({ stages }, { level: 'project' }) });

// --- the default pipeline is the old behavior ----------------------------------------

test('with no project and no repo file, every switch is the global setting, in all 8 combinations', () => {
  for (const plan of [false, true]) for (const review of [false, true]) for (const merge of [false, true]) {
    const r = resolvePipeline({ global: { plan, review, merge } });
    assert.deepStrictEqual({ plan: r.plan, review: r.review, merge: r.merge }, { plan, review, merge });
    assert.deepStrictEqual(r.sources, { plan: 'setting', review: 'setting', merge: 'setting' });
    assert.equal(r.level, 'default');
    assert.deepStrictEqual(r.clamped, []);
    assert.deepStrictEqual(r.stages.map(s => s.id), BUILTIN_STAGES);
  }
});

test('the default pipeline adds nothing to the prompt — byte-for-byte the old one', () => {
  const r = resolvePipeline({ global: { plan: true, review: true, merge: true } });
  assert.equal(pipelineStepsText(r), null);
  const fields = { number: 717, title: 't', body: 'b', labels: 'x', url: 'u' };
  assert.equal(renderIssuePrompt('T {{body}}', fields, { steps: pipelineStepsText(r) }),
    renderIssuePrompt('T {{body}}', fields));
});

test('an empty global layout is the default layout, so it is never materialized', () => {
  assert.ok(isDefaultLayout(normalizePipeline({ stages: [] }, { level: 'global' })));
  assert.ok(isDefaultLayout(normalizePipeline({ stages: BUILTIN_STAGES.map(id => ({ id })) }, { level: 'global' })));
  assert.ok(!isDefaultLayout(normalizePipeline({ stages: [{ id: 'implement', instructions: 'x' }] }, { level: 'global' })));
  assert.deepStrictEqual(ids(DEFAULT_LAYOUT), BUILTIN_STAGES);
});

// --- normalization ---------------------------------------------------------------------

test('a file that is not { stages: [...] } defines no pipeline', () => {
  for (const raw of [null, undefined, 'x', 42, [], {}, { stages: 'no' }]) {
    assert.equal(normalizePipeline(raw), null, JSON.stringify(raw));
  }
});

test('every built-in is present, in canonical order, whatever the file lists', () => {
  const out = normalizePipeline({ stages: [{ id: 'merge' }, { id: 'review' }, { id: 'plan' }] });
  assert.deepStrictEqual(ids(out), BUILTIN_STAGES);
});

test('custom stages stay after the latest built-in listed before them, and never after merge', () => {
  const out = normalizePipeline({ stages: [
    { id: 'brief', instructions: 'Post a summary to the Inbox before planning.' },
    { id: 'plan' },
    { id: 'tests', instructions: 'Run npm run test:unit.' },
    { id: 'merge' },
    { id: 'after', instructions: 'Too late to run.' },
  ] });
  assert.deepStrictEqual(ids(out), ['issue', 'brief', 'plan', 'tests', 'implement', 'review', 'after', 'merge']);
});

test('a built-in listed out of order does not drag the customs after it backwards', () => {
  const out = normalizePipeline({ stages: [{ id: 'review' }, { id: 'x', instructions: 'i' }, { id: 'plan' }, { id: 'y', instructions: 'j' }] });
  assert.deepStrictEqual(ids(out), ['issue', 'plan', 'implement', 'review', 'x', 'y', 'merge']);
});

test('merge takes no instructions; issue and implement cannot be switched off', () => {
  const out = normalizePipeline({ stages: [
    { id: 'merge', instructions: 'open a PR', enabled: false },
    { id: 'issue', enabled: false }, { id: 'implement', enabled: false, instructions: 'go' },
  ] }, { level: 'project' });
  const by = Object.fromEntries(out.stages.map(s => [s.id, s]));
  assert.deepStrictEqual(by.merge, { id: 'merge', enabled: false });
  assert.deepStrictEqual(by.issue, { id: 'issue' });
  assert.deepStrictEqual(by.implement, { id: 'implement', instructions: 'go' });
});

test('the global level never carries a switch — those live in the settings keys', () => {
  const out = normalizePipeline({ stages: [{ id: 'plan', enabled: false }, { id: 'merge', enabled: true }] }, { level: 'global' });
  assert.ok(out.stages.every(s => !('enabled' in s)));
});

test('bad ids, duplicates, empty customs and unknown fields are dropped; caps hold', () => {
  const many = Array.from({ length: MAX_CUSTOM_STAGES + 3 }, (_, i) => ({ id: `s${i}`, instructions: 'x' }));
  const out = normalizePipeline({ stages: [
    { id: 'Bad Id!', instructions: 'x' }, { id: 'dup', instructions: 'a' }, { id: 'dup', instructions: 'b' },
    { id: 'empty', instructions: '   ' }, { id: 'extra', instructions: 'y'.repeat(INSTRUCTIONS_LIMIT + 50), evil: 1 },
    ...many,
  ] });
  const customs = out.stages.filter(s => !BUILTIN_STAGES.includes(s.id));
  assert.equal(customs.length, MAX_CUSTOM_STAGES);
  assert.deepStrictEqual(customs[0], { id: 'dup', instructions: 'a' });
  assert.ok(!customs.some(s => s.id === 'empty' || s.id === 'bad id!'));
  assert.equal(customs[1].instructions.length, INSTRUCTIONS_LIMIT);
  assert.ok(!('evil' in customs[1]));
});

test('a carriage return never reaches the composer — it would submit half a prompt', () => {
  const out = normalizePipeline({ stages: [{ id: 'x', label: 'a\nb', instructions: 'one\r\ntwo\u0007\tthree' }] });
  const s = out.stages.find(st => st.id === 'x');
  assert.equal(s.instructions, 'one\ntwo three');
  assert.equal(s.label, 'a b');
});

// --- levels ----------------------------------------------------------------------------

test('Replace: the most specific level with a pipeline supplies the layout', () => {
  const g = { plan: true, review: false, merge: false, layout: normalizePipeline({ stages: [{ id: 'g', instructions: 'global' }] }, { level: 'global' }) };
  assert.equal(resolvePipeline({ global: g }).level, 'global');
  const p = project([{ id: 'p', instructions: 'project' }]);
  const r1 = resolvePipeline({ global: g, project: p });
  assert.equal(r1.level, 'project');
  assert.ok(r1.stages.some(s => s.id === 'p') && !r1.stages.some(s => s.id === 'g'));
  const r2 = resolvePipeline({ global: g, project: p, repo: repo([{ id: 'r', instructions: 'repo' }]) });
  assert.equal(r2.level, 'repo');
  assert.deepStrictEqual(r2.stages.filter(s => !BUILTIN_STAGES.includes(s.id)).map(s => s.id), ['r']);
  // A project with no pipeline of its own is not a level that "defines" one.
  assert.equal(resolvePipeline({ global: g, project: { id: 'p2', name: 'Q', pipeline: null } }).level, 'global');
});

test('the project level may switch anything either way', () => {
  const r = resolvePipeline({
    global: { plan: true, review: true, merge: false },
    project: project([{ id: 'plan', enabled: false }, { id: 'review', enabled: false }, { id: 'merge', enabled: true }]),
  });
  assert.deepStrictEqual({ plan: r.plan, review: r.review, merge: r.merge }, { plan: false, review: false, merge: true });
  assert.deepStrictEqual(r.sources, { plan: 'project', review: 'project', merge: 'project' });
});

test('a repo file may only tighten: review on, merge off — the reverse is clamped and reported', () => {
  const loose = resolvePipeline({
    global: { plan: true, review: true, merge: false },
    repo: repo([{ id: 'review', enabled: false }, { id: 'merge', enabled: true }]),
  });
  assert.equal(loose.review, true, 'a repo file must never switch an enabled review gate off');
  assert.equal(loose.merge, false, 'a repo file must never switch the merge on');
  assert.deepStrictEqual(loose.clamped, ['review', 'merge']);
  assert.deepStrictEqual(loose.sources, { plan: 'setting', review: 'setting', merge: 'setting' });

  const tight = resolvePipeline({
    global: { plan: false, review: false, merge: true },
    repo: repo([{ id: 'review', enabled: true }, { id: 'merge', enabled: false }]),
  });
  assert.deepStrictEqual({ review: tight.review, merge: tight.merge }, { review: true, merge: false });
  assert.deepStrictEqual(tight.clamped, []);
  assert.deepStrictEqual({ review: tight.sources.review, merge: tight.sources.merge }, { review: 'repo', merge: 'repo' });
});

test('the repo clamp applies against the project level too, not only the global one', () => {
  const r = resolvePipeline({
    global: { plan: true, review: false, merge: false },
    project: project([{ id: 'merge', enabled: true }, { id: 'review', enabled: true }]),
    repo: repo([{ id: 'review', enabled: false }]),
  });
  assert.equal(r.review, true);
  assert.equal(r.merge, true, 'a repo file that says nothing about merge leaves the project\'s choice alone');
  assert.deepStrictEqual(r.clamped, ['review']);
});

test('plan mode is a preference: a repo file may switch it either way (#717)', () => {
  const off = resolvePipeline({ global: { plan: true }, repo: repo([{ id: 'plan', enabled: false }]) });
  assert.equal(off.plan, false);
  assert.equal(off.sources.plan, 'repo');
  const on = resolvePipeline({ global: { plan: false }, repo: repo([{ id: 'plan', enabled: true }]) });
  assert.equal(on.plan, true);
  assert.deepStrictEqual(off.clamped.concat(on.clamped), []);
});

test("this repo's own committed pipeline turns plan mode off and nothing else", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.deepsteve', 'pipeline.json'), 'utf8'));
  for (const merge of [false, true]) for (const review of [false, true]) {
    const r = resolvePipeline({ global: { plan: true, review, merge }, repo: { path: 'x', pipeline: normalizePipeline(raw, { level: 'repo' }) } });
    assert.deepStrictEqual({ plan: r.plan, review: r.review, merge: r.merge }, { plan: false, review, merge });
    assert.equal(pipelineStepsText(r), null, 'it adds no prompt text');
  }
});

test('withSpawnedPlan reports the plan mode a session actually got', () => {
  const r = resolvePipeline({ global: { plan: true } });
  assert.equal(withSpawnedPlan(r, true), r);
  const off = withSpawnedPlan(r, false);
  assert.equal(off.plan, false);
  assert.ok(!off.stages.find(s => s.id === 'plan').enabled);
});

// --- prompt text and the log line -------------------------------------------------------

test('steps list only enabled stages that carry text, in pipeline order', () => {
  const r = resolvePipeline({
    global: { plan: false, review: false, merge: false },
    project: project([
      { id: 'brief', label: 'Brief', instructions: 'Post a summary.' },
      { id: 'plan', instructions: 'Plan text — dropped, plan is off.' },
      { id: 'implement', instructions: 'Run npm run test:unit before completing.' },
      { id: 'skipped', instructions: 'Off.', enabled: false },
    ]),
  });
  assert.equal(pipelineStepsText(r),
    'Steps for this issue, in order:\n1. Brief: Post a summary.\n2. Implement: Run npm run test:unit before completing.');
});

test('the steps text has a budget', () => {
  const stages = Array.from({ length: MAX_CUSTOM_STAGES }, (_, i) => ({ id: `s${i}`, instructions: 'z'.repeat(INSTRUCTIONS_LIMIT) }));
  const text = pipelineStepsText(resolvePipeline({ global: {}, project: project(stages) }));
  assert.ok(text.length <= STEPS_TEXT_LIMIT + 120, `steps text is ${text.length} characters`);
  assert.match(text, /more step\(s\) omitted/);
});

test('steps land after the issue (and resume) and before the completion instruction', () => {
  const out = renderIssuePrompt('BODY', { number: 1, title: 't' }, { resume: 'RESUME', steps: 'STEPS', stages: 'STAGES' });
  assert.ok(out.startsWith('BODY\n\nRESUME\n\nSTEPS\n\n'), out);
  assert.ok(out.endsWith('\n\nSTAGES'));
});

test('the log label names the level and the enabled stages; plan is n/a without a flag', () => {
  const r = resolvePipeline({ global: { plan: true, review: false, merge: true }, planFlag: false });
  assert.equal(pipelineLogLabel(r), 'default:issue>plan(n/a)>implement>merge');
  const clamped = resolvePipeline({ global: { plan: false, review: true }, repo: repo([{ id: 'review', enabled: false }]) });
  assert.equal(pipelineLogLabel(clamped), 'repo:issue>implement>review, clamped=review');
});

// --- the repo file ----------------------------------------------------------------------

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-pipeline-'));
  fs.mkdirSync(path.join(dir, '.deepsteve'));
  return dir;
}

test('readRepoPipeline: absent is silent, a good file is normalized', () => {
  const dir = scratchRepo();
  const lines = [];
  assert.equal(readRepoPipeline(dir, { log: l => lines.push(l) }), null);
  assert.deepStrictEqual(lines, []);
  fs.writeFileSync(path.join(dir, '.deepsteve', 'pipeline.json'), JSON.stringify({ stages: [{ id: 'plan', enabled: false }] }));
  const got = readRepoPipeline(dir, { log: l => lines.push(l) });
  assert.equal(got.path, path.join(dir, '.deepsteve', 'pipeline.json'));
  assert.deepStrictEqual(ids(got.pipeline), BUILTIN_STAGES);
});

test('readRepoPipeline refuses a symlink, an oversized file and bad JSON — with one log line each', () => {
  const dir = scratchRepo();
  const file = path.join(dir, '.deepsteve', 'pipeline.json');
  const target = path.join(dir, 'elsewhere.json');
  fs.writeFileSync(target, JSON.stringify({ stages: [] }));
  fs.symlinkSync(target, file);
  const lines = [];
  assert.equal(readRepoPipeline(dir, { log: l => lines.push(l) }), null);
  fs.unlinkSync(file);
  fs.writeFileSync(file, ' '.repeat(PIPELINE_FILE_MAX_BYTES + 1));
  assert.equal(readRepoPipeline(dir, { log: l => lines.push(l) }), null);
  fs.writeFileSync(file, '{ not json');
  assert.equal(readRepoPipeline(dir, { log: l => lines.push(l) }), null);
  fs.writeFileSync(file, '{"nope": true}');
  assert.equal(readRepoPipeline(dir, { log: l => lines.push(l) }), null);
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.ok(lines.every(l => l.startsWith('[issue] pipeline file skipped')));
});

// Budget guard for the scheduled-run prefix (#708).
//
// Everything Deep Steve injects in front of a scheduled task's prompt — prefix.md, and on an
// isolated run worktree.md + worktree-mcp.md — is typed into the agent's composer on EVERY
// fire of EVERY task. It is the scheduled-run counterpart of CLAUDE.md
// (test/unit/claude-md-budget.test.js), and it grows the same way: one more line of
// guidance at a time, each of which looked cheap on its own.
//
// When this fails, the fix is to MOVE something, not to tighten wording until it fits:
//   - guidance that belongs to one project goes in that repo's .deepsteve/scheduled/CONTEXT.md;
//   - how a tool behaves belongs in the tool's own description, which costs no prompt text.
//
// Tokens are estimated, not counted: the unit job has no tokenizer, and adding one for a
// budget check is not worth a dependency. Anthropic's rule of thumb is ~3.5 English
// characters per token; prose like this usually runs longer than that per token, so the
// estimate errs high and a pass is a conservative one.
//
// Pure — requires the mod with a scratch HOME, no daemon. Runs in the bare `unit` CI job.
//
// Run: node --test test/unit/scheduled-prefix-budget.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-budget-home-'));

const { scheduledRunPrompt, FRAGMENTS } = require('../../mods/scheduled-tasks/tools.js');

const BUDGET_TOKENS = 1000;
const CHARS_PER_TOKEN = 3.5;
const estimateTokens = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);

// The worst case: an MCP agent in a per-run worktree, with placeholder values as long as a
// real install produces. The task prompt is empty and there is no CONTEXT.md, so what is
// measured is exactly Deep Steve's share.
const task = { id: 'ab12cd34', title: 'Weekly analytics report for every property in the account', prompt: '' };
const repoRoot = '/Users/someone/github/an-organisation/a-fairly-long-repository-name';
const iso = {
  path: `${repoRoot}/.claude/worktrees/scheduled-ab12cd34`,
  branch: 'worktree-scheduled-ab12cd34',
  repoRoot,
};

test('the scheduled-run prefix stays under 1000 tokens (#708)', () => {
  const prefix = scheduledRunPrompt(task, { mcpWired: true, iso });
  const tokens = estimateTokens(prefix);
  const byFragment = Object.entries(FRAGMENTS)
    .map(([k, t]) => `    ~${String(estimateTokens(t)).padStart(4)} tokens  ${k}`)
    .join('\n');

  assert.ok(tokens <= BUDGET_TOKENS,
    `The scheduled-run prefix is ~${tokens} tokens (${prefix.length} chars), over the ${BUDGET_TOKENS}-token budget.\n`
    + '  It is typed into every scheduled run. Move project-specific guidance to that repo\'s\n'
    + '  .deepsteve/scheduled/CONTEXT.md, and tool behavior into the tool\'s description — do NOT\n'
    + '  just tighten the wording. By fragment:\n' + byFragment);
});

test('the budget measures real text, not an empty render', () => {
  // Without this, a fragment that failed to load (or a renderer that returned '') would
  // pass the budget trivially.
  const prefix = scheduledRunPrompt(task, { mcpWired: true, iso });
  assert.ok(estimateTokens(prefix) > 150, `suspiciously small prefix: ${JSON.stringify(prefix)}`);
  for (const [k, t] of Object.entries(FRAGMENTS)) assert.ok(t.length > 0, `${k} is empty`);
});

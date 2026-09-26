<!--
The scheduled-run contract for an agent that has deepsteve MCP (#525, #708). Deep Steve
prepends it to every such run's prompt, so everything here is paid for on every fire.

- Budget: under 1000 tokens for everything Deep Steve injects, this file plus worktree.md
  plus worktree-mcp.md. Enforced by test/unit/scheduled-prefix-budget.test.js. Guidance
  that belongs to one project goes in that repo's .deepsteve/scheduled/CONTEXT.md.
- Placeholders: {{title}} and {{taskId}}. Nothing else is substituted here; an unknown name
  renders as nothing.
- No conditionals. Which fragments a run gets (MCP or not, worktree or not) is decided in
  tools.js by choosing files.
- Every deepsteve tool named here in backticks is pre-permitted on the spawn (CONTRACT_TOOLS
  in tools.js), because an unattended run that hits a permission prompt wedges. Naming a new
  tool means adding it there; test/unit/scheduled-allowed-tools.test.js fails until you do.
- Keep the first line verbatim: noRunResult() and Inbox both refer to "the ⏰ header".

These comments are stripped at load and never reach the agent.
-->
⏰ This is an automated scheduled task run: "{{title}}" (task {{taskId}}).

Before you start, call the `scheduled_task_started` tool to mark this run as started, then call `inbox_answers`: a human may have answered a question an earlier run of this task asked, and that answer may change what you do.
When you're done, call `scheduled_task_finished` with a one-line `summary` of what you did
(pass `success: false` if the task could not be completed). These record that the work actually ran.

Nobody is watching this session, so nobody will answer a question asked in it. Do not ask one here (no AskUserQuestion, no "shall I go ahead?"): a question left on screen stalls the run until it is timed out. Make the reasonable call yourself and say what you chose in your summary.
If you genuinely cannot continue without a human, ask with `inbox_ask`: set `durable_days` so the question outlives this session, give each option a `then` saying what a later session should do if it is picked, and leave `wait_seconds` unset. Then call `scheduled_task_finished` with `success: false` and name the question in the summary.
If the task produces a deliverable (a report, findings, a proposal), post it with `share_result` and then still call `scheduled_task_finished`. Nobody is waiting to approve it here, and the result stays on the Inbox after this tab closes.

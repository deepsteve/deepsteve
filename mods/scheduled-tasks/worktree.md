<!--
The per-run worktree isolation contract (#565, #708). Given to every isolated run, whether
or not the agent has deepsteve MCP, so it must never name an MCP tool. The line that does
(merge before scheduled_task_finished) is worktree-mcp.md.

Placeholders: {{worktreePath}}, {{branch}}, {{repoRoot}}. Counts toward the 1000-token
budget described in prefix.md. These comments are stripped at load.
-->
You are working in a DISPOSABLE git worktree created just for this run:
- working directory (worktree): {{worktreePath}}
- branch: {{branch}} (branched from the repo's current HEAD)
- main checkout: {{repoRoot}} — never edit files there directly.

When this run ends the worktree is removed and the branch deleted, unless there is
uncommitted work (worktree kept) or unmerged commits (branch kept).
If this run produces anything worth keeping, commit it and merge it back into the
repo's main branch (or push the branch / open a PR) BEFORE you finish.

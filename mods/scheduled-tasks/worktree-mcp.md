<!--
Added after worktree.md only when the run is isolated AND the agent has deepsteve MCP
(#565, #708): it names scheduled_task_finished, which a non-MCP agent must never be told to
call. Counts toward the 1000-token budget described in prefix.md. Stripped at load.
-->
Merge/push anything worth keeping BEFORE calling `scheduled_task_finished` — the tab may auto-close and the worktree is reclaimed right after.

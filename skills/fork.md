---
name: fork
description: Fork this conversation into a new parallel tab
argument-hint: [tab name]
---

Fork your current Claude conversation into a new deepsteve tab. Both tabs continue independently from the same conversation history.

## Procedure

1. **Get your session ID**: Call `mcp__deepsteve__get_my_session_id` (no parameters needed).

2. **Open a forked tab**: Call `mcp__deepsteve__open_terminal` with:
   - `session_id`: the session ID from step 1
   - `fork`: true
   - `name`: use `$ARGUMENTS` if provided, otherwise omit

3. **Report**: Briefly confirm the fork succeeded with the new tab's ID and name.

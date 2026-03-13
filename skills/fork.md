---
name: fork
description: Fork this conversation into a new parallel tab
argument-hint: [tab name]
---

Fork your current Claude conversation into a new deepsteve tab. Both tabs continue independently from the same conversation history.

## Procedure

1. **Get your session ID**: Read your `DEEPSTEVE_SESSION_ID` environment variable.

2. **Open a forked tab**: Call `mcp__deepsteve__open_terminal` with:
   - `session_id`: your DEEPSTEVE_SESSION_ID
   - `fork`: true
   - `name`: use `$ARGUMENTS` if provided, otherwise omit

3. **Report**: Briefly confirm the fork succeeded with the new tab's ID and name.

---
name: terminal
description: Open a plain terminal tab in the current working directory
argument-hint: [tab name]
---

Open a new plain shell tab (not a Claude session) in your current working directory. Useful for running builds, watching logs, or executing interactive commands without leaving your current session.

## Procedure

1. **Get your session ID**: Read your `DEEPSTEVE_SESSION_ID` environment variable.

2. **Open a terminal tab**: Call `mcp__deepsteve__open_terminal` with:
   - `session_id`: your DEEPSTEVE_SESSION_ID
   - `name`: use `$ARGUMENTS` if provided, otherwise omit

3. **Report**: Briefly confirm the terminal tab was opened with its name and working directory.

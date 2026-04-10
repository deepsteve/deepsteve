---
name: terminal
description: Open a plain terminal tab in the current working directory
argument-hint: [tab name]
---

Open a new plain shell tab (not a Claude session) in your current working directory. Useful for running builds, watching logs, or executing interactive commands without leaving your current session.

## Procedure

1. **Open a terminal tab**: Call `mcp__deepsteve__open_terminal` with:
   - `name`: use `$ARGUMENTS` if provided, otherwise omit

2. **Report**: Briefly confirm the terminal tab was opened with its name and working directory.

---
name: terminal
description: Open a plain terminal tab, optionally auto-running a command on startup
argument-hint: [command]
---

Open a new plain shell tab (not a Claude session) in your current working directory. Useful for running builds, watching logs, or kicking off background tasks (dev servers, watchers, long-running processes) without leaving your current session.

## Procedure

1. **Open a terminal tab**: Call `mcp__deepsteve__open_terminal` with:
   - `command`: use `$ARGUMENTS` if provided — the command to auto-run on startup. The tab is auto-named from the command unless you pass an explicit `name`.
   - `name`: optional explicit tab name (overrides the auto-derived name).

2. **Report**: Briefly confirm the terminal tab was opened — its name, working directory, and the command it is running (if any).

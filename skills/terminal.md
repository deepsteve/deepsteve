---
name: terminal
description: Open a plain terminal tab, optionally auto-running a command on startup
argument-hint: [command]
---

Open a new plain shell tab (not a Claude session) in your current working directory. Useful for kicking off something **long-lived** — a dev server, a watcher, a log tail — without leaving your current session.

**If the user just wants one command run and its output back, use `mcp__deepsteve__run_in_terminal` instead** and skip the rest of this skill. It runs the command in a visible tab, returns what it printed and its exit code, and closes its own tab. That is the right tool for `git`/`gh`/build/test commands, including ones this session's worktree isolation refuses to run in the main checkout.

## Procedure

1. **Open a terminal tab**: Call `mcp__deepsteve__open_terminal` with:
   - `command`: use `$ARGUMENTS` if provided — the command to auto-run on startup. The tab is auto-named from the command unless you pass an explicit `name`.
   - `name`: optional explicit tab name (overrides the auto-derived name).

2. **Report**: Briefly confirm the terminal tab was opened — its name, working directory, and the command it is running (if any).

3. **Say who closes it.** This tab stays open until someone closes it, and the user asked for it, so leave it running and tell them it is theirs: it closes from the tab's ✕, or you can close it later with `mcp__deepsteve__close_session` and the id from step 1. (Terminals an agent opens for *its own* purposes are the agent's to close — 0 of the first 102 ever were.)

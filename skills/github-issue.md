---
name: github-issue
description: Create a GitHub issue from a natural language description
argument-hint: [--auto] <description of the issue>
---

The user wants to create a GitHub issue. Their arguments: $ARGUMENTS

**First, decide the mode.** If the arguments contain the literal flag `--auto` (typically passed by an autonomous agent that is tasked with both creating *and* solving issues), strip the `--auto` token out and use the remaining text as the issue description, then follow **Auto mode** below. Otherwise the whole of `$ARGUMENTS` is the description and you follow **Interactive mode**. Only treat the flag as present when it literally appears in the arguments.

Shared steps (both modes):
1. Draft a concise issue title (under 80 chars) and a clear markdown body from the description. The body should include a summary and any relevant details the user provided.
2. Create the issue using `gh issue create --title "..." --body "..."` — do not ask for confirmation. Extract the issue number from the returned URL.
3. Return the issue URL.

## Interactive mode (default — no `--auto`)
4. **You MUST call `AskUserQuestion`** before ending this turn, with the question "Want to start working on this issue in a new deepsteve tab?" and options "Yes" and "No". This step is mandatory and unconditional — do **not** stop, summarize, or return control to the user between step 3 and this call. Even if the user seems satisfied with the URL, you still call `AskUserQuestion`. Skipping this step is a bug.
5. If the user says yes, call the `mcp__deepsteve__start_issue` MCP tool with the issue number and title (no session_id needed — it auto-detects the caller). The server fetches the issue body from GitHub automatically. Tell the user the tab has been opened.
6. If the user says no, just confirm the issue was created and stop.

## Auto mode (`--auto` present)
4. Do **not** call `AskUserQuestion` — the `--auto` flag is the caller's explicit opt-in to skip confirmation. Immediately call the `mcp__deepsteve__start_issue` MCP tool with the issue number and title (no session_id needed — it auto-detects the caller). The server fetches the issue body from GitHub automatically.
5. Report the issue URL and that the working tab has been opened.

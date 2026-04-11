---
name: github-issue
description: Create a GitHub issue from a natural language description
argument-hint: <description of the issue>
---

The user wants to create a GitHub issue. Their description: $ARGUMENTS

Steps:
1. Draft a concise issue title (under 80 chars) and a clear markdown body from the user's description. The body should include a summary and any relevant details the user provided.
2. Create the issue using `gh issue create --title "..." --body "..."` — do not ask for confirmation. Extract the issue number from the returned URL.
3. Return the issue URL.
4. **You MUST call `AskUserQuestion`** before ending this turn, with the question "Want to start working on this issue in a new deepsteve tab?" and options "Yes" and "No". This step is mandatory and unconditional — do **not** stop, summarize, or return control to the user between step 3 and this call. Even if the user seems satisfied with the URL, you still call `AskUserQuestion`. Skipping this step is a bug.
5. If the user says yes, call the `mcp__deepsteve__start_issue` MCP tool with the issue number and title (no session_id needed — it auto-detects the caller). The server fetches the issue body from GitHub automatically. Tell the user the tab has been opened.
6. If the user says no, just confirm the issue was created and stop.

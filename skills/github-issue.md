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
4. Ask the user: "Want to start working on this issue in a new deepsteve tab?" using AskUserQuestion with options "Yes" and "No".
5. If the user says yes, use the `mcp__deepsteve__start_issue` MCP tool with your `DEEPSTEVE_SESSION_ID`, the issue number, and the title. The server fetches the issue body from GitHub automatically. Tell the user the tab has been opened.
6. If the user says no, just confirm the issue was created and stop.

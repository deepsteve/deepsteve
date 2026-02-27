---
description: Create a GitHub issue from a natural language description
argument-hint: <description of the issue>
---

The user wants to create a GitHub issue. Their description: $ARGUMENTS

Steps:
1. Draft a concise issue title (under 80 chars) and a clear markdown body from the user's description. The body should include a summary and any relevant details the user provided.
2. Show the user the draft title and body, then create the issue immediately using `gh issue create --title "..." --body "..." --json number,title,body,labels,url` — do not ask for confirmation.
3. Return the issue URL from the `gh` output.
4. Ask the user: "Want to start working on this issue in a new deepsteve tab?" using AskUserQuestion with options "Yes" and "No".
5. If the user says yes, call the deepsteve API to open a new tab for the issue:
   ```
   curl -s -X POST http://localhost:3000/api/start-issue \
     -H 'Content-Type: application/json' \
     -d '{"number": <number>, "title": "<title>", "body": "<body>", "labels": "<labels>", "url": "<url>", "cwd": "<git root>"}'
   ```
   Use the issue data from step 2. For `cwd`, use the git root of the current repo (from `git rev-parse --show-toplevel`). Tell the user the tab has been opened.
6. If the user says no, just confirm the issue was created and stop.

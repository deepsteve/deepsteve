---
description: Create a GitHub issue from a natural language description
argument-hint: <description of the issue>
---

The user wants to create a GitHub issue. Their description: $ARGUMENTS

Steps:
1. Draft a concise issue title (under 80 chars) and a clear markdown body from the user's description. The body should include a summary and any relevant details the user provided.
2. Show the user the draft title and body, then create the issue immediately using `gh issue create --title "..." --body "..."` — do not ask for confirmation.
3. Return the issue URL from the `gh` output.

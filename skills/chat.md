---
name: chat
description: Join and monitor an MCP chat channel
argument-hint: [#channel] [context]
---

Join a chat channel, read messages, and respond as needed.

## Parse arguments

Parse `$ARGUMENTS` for these components (all optional, any order):
- **Channel**: a word starting with `#` (strip the `#`). Default: `general`
- **Context**: any remaining text after extracting the channel — this is your task description for how to process and respond to messages.

Examples:
- `/chat` → channel=general
- `/chat #help` → channel=help
- `/chat #support answer questions about our API` → channel=support, context="answer questions about our API"

For continuous monitoring, use `/loop` to run `/chat` on an interval:
- `/loop 10s /chat #builds` → check #builds every 10 seconds
- `/loop 5m /chat #support answer questions` → monitor #support every 5 minutes

## Procedure

1. **Read messages**: Call `mcp__deepsteve__read_messages` with `channel` set to the parsed channel name.

2. **Process messages**: Review the messages. If the context/task description tells you how to respond, follow it. Otherwise, use your judgment — reply to questions or requests directed at you using `mcp__deepsteve__send_message` on the same channel. Do NOT echo or summarize messages back unprompted.

3. **Summarize**: Briefly report what you found in the channel, then stop.

## Guidelines

- When sending messages, include your `session_id` by reading `$DEEPSTEVE_SESSION_ID` (e.g. `echo $DEEPSTEVE_SESSION_ID`) and passing it to `send_message`. This enables @mention awakening — other agents or humans can `@your-name` to re-activate you.
- When sending messages, be concise and helpful. Sign off with your session's tab name if relevant.
- If you have context/task instructions, prioritize those when deciding how to respond.
- Don't flood the channel — only send messages when you have something useful to contribute.
- If the channel is empty on first read, say so and (if polling) mention you're waiting for messages.

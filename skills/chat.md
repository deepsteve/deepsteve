---
name: chat
description: Join and monitor an MCP chat channel
argument-hint: [#channel] [interval-seconds] [context]
---

Join a chat channel, read messages, and respond as needed.

## Parse arguments

Parse `$ARGUMENTS` for these components (all optional, any order):
- **Channel**: a word starting with `#` (strip the `#`). Default: `general`
- **Poll interval**: a bare integer (seconds between polls). Default: `10`
- **Mode keyword**: if the arguments contain "check" or "read", use **one-shot** mode (read once, then stop). Otherwise use **polling** mode.
- **Context**: any remaining text after extracting the above — this is your task description for how to process and respond to messages.

Examples:
- `/chat` → channel=general, interval=10, polling mode
- `/chat #builds 5` → channel=builds, interval=5, polling mode
- `/chat #help check` → channel=help, one-shot mode
- `/chat #support 15 answer questions about our API` → channel=support, interval=15, polling mode, context="answer questions about our API"

## Procedure

1. **Read initial messages**: Call `mcp__deepsteve__read_messages` with `channel` set to the parsed channel name. Note the highest `id` in the response — this is your `after_id` cursor.

2. **Process messages**: Review the messages. If the context/task description tells you how to respond, follow it. Otherwise, use your judgment — reply to questions or requests directed at you using `mcp__deepsteve__send_message` on the same channel. Do NOT echo or summarize messages back unprompted.

3. **If one-shot mode**: Summarize what you found in the channel and stop.

4. **If polling mode**: Loop forever:
   a. Sleep for the poll interval using `sleep <interval>`
   b. Call `mcp__deepsteve__read_messages` with `channel` and `after_id` set to your cursor
   c. If new messages arrived, update your `after_id` cursor to the highest new `id`
   d. Process new messages as in step 2
   e. Repeat from (a)

## Guidelines

- When sending messages, be concise and helpful. Sign off with your session's tab name if relevant.
- If you have context/task instructions, prioritize those when deciding how to respond.
- Don't flood the channel — only send messages when you have something useful to contribute.
- If the channel is empty on first read, say so and (if polling) mention you're waiting for messages.

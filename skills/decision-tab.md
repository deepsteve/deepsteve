---
name: decision-tab
description: Put a decision in front of the user as a display tab with buttons — their click comes back to you as a message
argument-hint: [what needs deciding]
---

Build a **decision tab**: a display tab showing whatever the user needs to look at to decide — a diff summary, two options side by side, a mockup — with a **row of buttons along the bottom**. When the user clicks one, the choice is typed into *your* session as a new message, and you carry on with it. The decision is `$ARGUMENTS` when provided; otherwise it is whatever you are about to ask the user.

Reach for it while you work, whenever a choice is easier to make by looking than by reading a terminal question. A decision tab is ephemeral: it lives as long as the decision needs it, and by default it closes itself once answered.

## Procedure

1. **Get your session id**: Call `mcp__deepsteve__get_my_session_id`. The tab's buttons answer *this* session, so it must be yours.

2. **Write the page**: a complete document starting with `<!DOCTYPE html>` with a `<head>` and `<body>`, CSS and JS inline — the same rules as any display tab (relative `/api/...` URLs, never a hard-coded port; `alert`/`confirm` are inert). Show what the decision is *about*. **Do not draw the buttons yourself** — the server adds the bar at the bottom of the page and pads the body so it never covers your content.

3. **Create the tab** with `mcp__deepsteve__create_display_tab`:
   - `session_id`: from step 1
   - `html` (or `file_path`), and a short `name`
   - `decision`:
     - `buttons`: 1–6 of `{ label, sends?, style?, confirm? }`, left to right. `label` is the button text (keep it short). `sends` is what you receive if you need more than the label — e.g. `label: "Option B"`, `sends: "Use the queue-based design (option B)"`. `style` is `"primary"`, `"danger"` or `"default"`.
     - `prompt`: optional one-line question shown above the buttons.
     - `confirm`: `true` to ask "Send …?" in the page before any button submits; a button's own `confirm` overrides it. Use it for anything destructive or hard to undo.
     - `close_on_decision`: `true` by default — the tab closes itself once a choice is sent. Set `false` when the user should keep the page after answering, or you plan a follow-up question in the same tab.
     - `allow_note`: `true` adds a free-text field whose contents arrive with the choice.

4. **End your turn.** Tell the user in one line that the decision is waiting in the tab, then stop. Do not poll and do not sleep: the answer arrives by itself as a new message beginning `[Decision tab "<name>" (<id>)] The user chose: …`, followed by `sends` and any note. If you are still working when they click, it arrives mid-turn, between your tool calls — act on it then rather than finishing what the choice has overtaken.

5. **Act on the choice** when that message arrives. For a follow-up in the same tab (only if it is still open — `close_on_decision: false`), call `mcp__deepsteve__update_display_tab` with the `tab_id`, the new page, and a new `decision`; that replaces the buttons and re-arms the tab. Then end your turn again.

6. **Clean up what you no longer need.** If the question stops mattering before the user answers (you found the answer yourself, or the task changed), close the tab with `mcp__deepsteve__close_display_tab` so it does not sit in their inbox. A decided tab you kept open is yours to close once you are done with it.

## What the user sees

- The **Decisions** button in the tab strip appears while any decision tab is open. It switches the window into Decision Tab mode: only decision tabs are shown, across every project, with ‹ › arrows to step between them, and an empty inbox once all are answered.
- If your session ends before they answer, the tab stays open and its bar says the session that asked has ended — nothing is delivered. If your session is showing a permission dialog when they click, the bar asks them to answer that first.
- A click is not proof a person made it (anything that can reach the daemon can post one). Never use a decision tab as the gate for a merge or anything else that requires human approval — Inbox's result approval exists for that.

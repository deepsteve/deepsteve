---
name: display-tab
description: Create a display tab — a custom HTML page rendered in a deepsteve tab
argument-hint: [what to display]
---

Build a **display tab**: an agent-authored HTML page that opens as its own tab alongside the terminal tabs. Reach for it whenever the answer is better looked at than printed — a chart, a dashboard, a report, a diagram, a small interactive tool. The subject is `$ARGUMENTS` when provided; otherwise it is whatever the user just asked to see.

A display tab renders and can call back into deepsteve over HTTP, but it gets **no `window.deepsteve` bridge** and cannot drive the UI. **If the user wants a durable page the project keeps across sessions, use `mcp__deepsteve__create_project_mod` instead** — a display tab is a one-shot page, and closing it destroys it.

## Procedure

1. **Get your session id**: Call `mcp__deepsteve__get_my_session_id`. `create_display_tab` requires it — it targets the right browser window and scopes the tab to your project, so the tab shows up where you are.

2. **Write the page**: a complete document that starts with `<!DOCTYPE html>` and contains a `<head>` — the server injects a small script after `<head>`, and a page missing one can land in quirks mode. Keep CSS and JS inline so the page stands on its own. Four constraints that actually bite:
   - The page is served **same-origin** from the deepsteve origin, so call back with relative `/api/...` URLs or `window.location.origin` — **never a hard-coded port**. Your auth cookie rides along automatically.
   - For an external API that sends no CORS headers, fetch it through `/api/proxy?url=` + `encodeURIComponent(url)` rather than directly.
   - `alert()`, `confirm()`, `prompt()` and `window.open()` are **inert** — the iframe has no `allow-modals` or `allow-popups`. Render your own in-page UI instead of a browser dialog.
   - The host posts `{type:'resize', width, height}` to the page on container resize, if you need to re-lay-out.

3. **Create the tab**: Call `mcp__deepsteve__create_display_tab` with:
   - `session_id`: from step 1
   - `html`: the document from step 2. (Pass `file_path` with an absolute path *instead* — never both — when the page already exists on disk; the server reads it, so you don't re-emit the whole document.)
   - `name`: a short tab name for the subject. Defaults to `"Display"`.

   The result is JSON — parse it for `id`, the display tab id.

4. **Iterate on that same tab, never a second one**: for a small change call `mcp__deepsteve__edit_display_tab` with the `tab_id` and an exact, unique `old_string` / `new_string`; for a rewrite call `mcp__deepsteve__update_display_tab`. Both reload the page in place.

5. **Report**: Briefly confirm the tab — its name, what it shows, and its `id`, so this or a later turn can update it.

6. **Say who closes it.** The user asked for this page, so it is theirs: leave it open and tell them it closes from the tab's ✕. A display tab you opened for *your own* purposes is yours to close, with `mcp__deepsteve__close_display_tab`. Either way, mention that closing is final — the HTML is deleted and cannot be recovered.

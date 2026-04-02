# AGENTS.md - Agent Guidelines for deepsteve

## Project Overview

deepsteve is a macOS web UI for running multiple Claude Code instances in browser tabs using real PTYs. It's a plain Node.js application (no build step) with an Express + WebSocket backend and vanilla JS frontend.

## Running the Application

### Development
```bash
./restart.sh            # Silent restart — browser reconnects via WebSocket
./restart.sh --refresh  # Restart + force browser page reload
```

### Production
Installed as a macOS LaunchAgent. Check if running:
```bash
launchctl list | grep deepsteve
```

### Logs
```bash
tail -f ~/Library/Logs/deepsteve.log
tail -f ~/Library/Logs/deepsteve.error.log
```

### Stop/Restart
```bash
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist
# Then restart via the LaunchAgent or manually
```

## Code Style

### JavaScript (Node.js Backend)
- **No ES modules** — use CommonJS `require()` / `module.exports`
- **No TypeScript** — plain JavaScript
- **Indentation**: 2 spaces
- **No semicolons** at statement ends
- **const** by default, **let** when mutation needed, never var
- Use descriptive names: `shellMap` not `shells`, `pendingOpens` not `po`
- One `const`/let per declaration
- Early returns preferred for guard clauses
- Use template literals for string interpolation

### Frontend (Vanilla JS in public/js/)
- ES modules with `<script type="module">`
- Use `const` and arrow functions
- DOM queries: `const el = document.querySelector('.selector')`
- Event listeners: `el.addEventListener('event', (e) => { ... })`
- No frameworks — vanilla DOM manipulation

### HTML/CSS
- Minimal CSS, primarily in `<style>` tags or theme files
- Use CSS custom properties for theming
- Semantic HTML where possible

## File Organization

### Backend
- `server.js` — Main entry point, Express app, WebSocket server
- `mcp-server.js` — MCP tools implementation
- `public/` — Static files served by Express
- `public/js/*.js` — Frontend modules (ES modules)

### Configuration
- `CLAUDE.md` — Detailed project documentation for Claude agents
- `opencode.json` — OpenCode config (MCP servers, commands)
- `.claude/commands/` — Claude slash command definitions

## Key Conventions

### Error Handling
- Use try/catch for async operations
- Return JSON errors with appropriate HTTP status codes
- Log errors with timestamps: `log('ERROR:', error.message)`

### PTY/Shell Management
- Use `node-pty` for pseudo-terminals
- Always remove listeners with `.removeListener()`, never `.off()`
- Delete `env.CLAUDECODE` when spawning nested Claude instances
- Detect BEL character (`\x07`) to know Claude is waiting for input

### WebSocket Messages
- JSON format for structured messages
- Plain text for terminal I/O
- Use descriptive message types

### Session State
- State persisted to `~/.deepsteve/state.json`
- Use `stateFrozen` flag during shutdown to prevent overwrites

### HTTPS
- Opt-in via `--https` flag or `DEEPSTEVE_HTTPS=1`
- Certs auto-generated to `~/.deepsteve/certs/`

## Testing

There is no formal test framework. Manual testing via browser.

## Security Notes

- No authentication, no CORS, no WebSocket origin checking
- Designed for localhost only
- Server binds to `127.0.0.1` by default

## MCP Tools

deepsteve provides MCP tools available to all sessions:
- **Agent Chat**: `send_message`, `read_messages`, `list_channels`
- **Tasks**: `add_task`, `update_task`, `complete_task`, `list_tasks`
- **Activity**: `post_activity`
- **Browser Console**: `browser_eval`, `browser_console`
- **Screenshots**: `screenshot_capture`
- **Session Info**: `get_my_session_id`, `get_session_info`, `close_session`

## OpenCode Commands

Custom commands available via `/`:
- `/github-issue` — Create a GitHub issue and optionally start working on it
- `/merge` — Merge current worktree branch into main

## Common Tasks

### Add a new endpoint
1. Add route in `server.js`: `app.get('/api/endpoint', (req, res) => { ... })`
2. Test via `curl http://localhost:3000/api/endpoint`
3. Run `./restart.sh --refresh` to deploy

### Add a new frontend module
1. Create `public/js/new-module.js` with ES module exports
2. Import in relevant HTML or JS file
3. Test in browser
4. Run `./restart.sh --refresh` to deploy

### Worktree workflow
1. Create worktree: `git worktree add ../deepsteve-feature -b feature-name`
2. Make changes in worktree
3. Commit changes
4. Run `/merge` from worktree to merge into main
5. Run `./restart.sh --refresh` from main repo to deploy

# AGENTS.md - Agent Guidelines for deepsteve

## Project Overview

deepsteve is a web UI for running multiple agent sessions in browser tabs using real PTYs, on macOS or Linux. It's a plain Node.js application (no build step) with an Express + WebSocket backend and vanilla JS frontend.

Claude Code and Codex are the supported agents; OpenCode, Pi, and Hermes run as experimental integrations with no deepsteve MCP tools and no skills. `docs/agents.md` is the per-agent capability matrix — read it before assuming a feature works for the agent you're in.

## Running the Application

### Development
```bash
./restart.sh            # Silent restart — browser reconnects via WebSocket
./restart.sh --refresh  # Restart + force browser page reload
```

### Production
Installed as a macOS LaunchAgent or a Linux systemd user unit, both driven through
`service.sh` (#621). Check if running:
```bash
./status.sh   # read-only; safe to allowlist. ./restart.sh is not.
```

### Logs
`./status.sh` prints the right directory for this machine:
```bash
tail -f ~/Library/Logs/deepsteve.log                    # macOS
tail -f ~/.local/share/deepsteve/logs/deepsteve.log     # Linux
```

### Stop/Restart
Restart with `./restart.sh` (it handles both platforms). Stopping has no wrapper on
purpose — doing it without the deploy/confirm machinery is a manual act:
```bash
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist   # macOS
systemctl --user stop deepsteve                               # Linux
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
- `CLAUDE.md` — the map and the invariant list. Mechanism lives in `docs/`, one page per area;
  `CLAUDE.md`'s table says which page to read before doing what
- `opencode.json` — OpenCode config (MCP servers, commands)
- `.claude/commands/` — Claude slash command definitions

## Key Conventions

### Error Handling
- Use try/catch for async operations
- Return JSON errors with appropriate HTTP status codes
- Log errors with timestamps: `log('ERROR:', error.message)`

### PTY/Shell Management
- Sessions run in **tmux** panes by default, with `node-pty` as the fallback engine — both
  always exist. See `docs/terminal-engines.md`
- Always remove listeners with `.removeListener()`, never `.off()`
- Delete `env.CLAUDECODE` when spawning nested Claude instances
- Whether a session is waiting is decided by the screen classifier plus BEL (`\x07`), not by
  silence alone — see `docs/sessions.md`

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

`node --test` throughout — `npm run test:unit` (bare, no daemon), `npm run test:standalone`,
`npm test` (auto-provisions an isolated daemon; safe alongside the live one), plus three
docker suites. See `docs/testing.md` before writing one — it carries the rules that keep a
suite off the production daemon and off the developer's tmux socket.

## Security Notes

- **Auth is always on**, with no off switch (#536): host allowlist, origin allowlist, and a
  per-install bearer token, all checked before application code runs. Agents read the token
  from `DEEPSTEVE_API_TOKEN`.
- Server binds to `127.0.0.1` by default; the canonical browser URL is
  `http://deepsteve.localhost:3000`. See `docs/platform.md`.

## MCP Tools

deepsteve provides MCP tools available to all sessions:
- **Agent Chat**: `send_message`, `read_messages`, `list_channels`
- **Tasks**: `add_task`, `update_task`, `complete_task`, `list_tasks`
- **Activity**: `post_activity`
- **Browser Console**: `browser_eval`, `browser_console`
- **Screenshots**: `screenshot_capture`
- **Session Info**: `get_my_session_id`, `get_session_info`, `close_session`

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

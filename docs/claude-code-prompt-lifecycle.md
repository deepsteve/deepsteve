# Claude Code Prompt Lifecycle

Reference for understanding how Claude Code sessions work within DeepSteve — what prompts are sent, when, and what causes Claude to stop.

## Prompt Composition

Claude Code's context is assembled from multiple layers at session start:

| Layer | Source | When Loaded |
|-------|--------|-------------|
| Base system prompt | Anthropic internal (unpublished) | Session start |
| CLAUDE.md (project) | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Session start, re-injected on compaction |
| CLAUDE.md (user) | `~/.claude/CLAUDE.md` | Session start |
| Auto memory | `~/.claude/projects/<project>/memory/MEMORY.md` (first 200 lines) | Session start |
| Tool definitions | Built-in tools (Read, Edit, Bash, Glob, Grep, etc.) | Session start |
| MCP tool definitions | Each configured MCP server adds tool schemas | Session start |
| Skills (descriptions) | Installed slash commands — descriptions only | Session start |
| Skills (full content) | Full `.md` body loaded on demand | On `/skill-name` invocation |
| Git/environment metadata | Current branch, git status, platform, shell | Session start + refreshed per-turn |

### Customization flags

- `--system-prompt "..."` / `--system-prompt-file` — replace base system prompt entirely
- `--append-system-prompt "..."` / `--append-system-prompt-file` — append to base prompt
- `--permission-mode plan` — restricts to read-only tools (no Edit, Write, Bash mutations)

## Session Start Flow

1. Load base system prompt + CLAUDE.md + auto memory + tool definitions + MCP tools
2. Spawn PTY: `claude --session-id <uuid>` (new) or `claude --resume <uuid>` (restore)
3. Claude renders its Ink-based terminal UI
4. Claude emits BEL (`\x07`) when ready for input
5. DeepSteve detects BEL and submits `initialPrompt` via `submitToShell()`

### DeepSteve session spawning

New and restored sessions use different CLI arguments (`server.js:486–521`):

- **New:** `claude --session-id <uuid> [--permission-mode plan] [--worktree <name>]`
- **Resume:** `claude --resume <saved-uuid> [--worktree <name>]`
- **Resume fallback** (if `--resume` exits within 5s): `claude -c --fork-session --session-id <new-uuid>`

The resume fallback (`server.js:2044–2068`) detects fast exits as `--resume` failures and falls back to forking from the last conversation.

## Per-Turn Agentic Loop

Each user prompt triggers an agentic loop:

1. User prompt arrives (via PTY stdin)
2. Claude sends conversation history + latest user message to Anthropic API
3. API returns response — either text, tool calls, or both
4. If tool calls: Claude executes tools locally, feeds results back to API, loops
5. If `stop_reason: "end_turn"`: Claude stops and emits BEL (waiting for input)
6. Context compaction happens automatically when approaching token limits

### Prompt submission (`server.js:650–653`)

```javascript
function submitToShell(shell, text) {
  shell.write(text);
  setTimeout(() => shell.write('\r'), 1000);
}
```

Text and `\r` must be sent separately with a 1-second delay. Ink's input parser only recognizes Enter when `\r` arrives as its own stdin read — sending `"text\r"` together is treated as pasted text.

## Stop Conditions

### API-level stop reasons

| Stop Reason | Meaning | What Happens |
|-------------|---------|--------------|
| `end_turn` | Model naturally completed its response | Claude stops, emits BEL |
| `tool_use` | Model wants to call tools | Claude executes tools, continues loop |
| `max_tokens` | Context limit reached | Rare — compaction usually prevents this |

### User-initiated stops

- `/exit` — graceful exit command
- `Ctrl+C` — SIGINT interrupts current generation
- New prompt typed while generating — interrupts and redirects

### Configuration limits

- `--max-turns N` — hard limit on agentic loop iterations
- `--max-budget-usd N` — spending cap

### Context management

- Auto-compaction when approaching token limit
- Clears older tool outputs first, preserves recent messages and CLAUDE.md
- Can be triggered manually with `/compact`

## BEL-Based State Detection (`server.js:706–733`)

BEL (`\x07`) in PTY output is the primary signal for Claude's state:

- **BEL detected** while not already waiting → `waitingForInput = true`
  - Broadcasts state to all connected clients
  - Triggers `initialPrompt` submission or pending chat awakening
- **Non-BEL output** while `waitingForInput` is true → `waitingForInput = false`
  - ANSI escape sequences are stripped before checking for substantive content
  - Indicates Claude auto-approved a tool or continued on its own

This state drives: browser notifications, auto-submission of queued prompts, and `@mention` chat awakening.

## Session Resume

On `--resume <uuid>`:
- Full conversation history restored from `~/.claude/projects/<project>/<uuid>.jsonl`
- CLAUDE.md and auto memory reloaded fresh
- Agentic loop continues from where it left off
- Session-scoped permissions must be re-approved

## Session Fork Detection (`server.js:572–632`)

DeepSteve watches `~/.claude/projects/<cwd>/` for new `.jsonl` files to detect session forks (e.g., exiting plan mode creates a new session):

1. `fs.watch()` monitors the project directory for new `.jsonl` files
2. When a new file appears, reads the first 32KB to check if it references the current session ID
3. If it does, updates `claudeSessionId` so the next restart resumes the correct fork
4. Includes a 200ms retry for cases where the file isn't fully written yet

## Shutdown Sequence (`server.js:740–798`)

DeepSteve's kill sequence for each session:

```
1. If waitingForInput:  submit /exit directly
   If Claude is busy:   send Ctrl+C → wait for BEL → submit /exit
2. Wait 8 seconds for graceful exit
3. Escalate to SIGTERM (process group kill with -pid)
4. Wait 2 more seconds
5. Escalate to SIGKILL if still alive
```

### State preservation (`server.js:812–834`)

- `saveState()` writes shell IDs, cwds, `claudeSessionId`, and metadata to `state.json`
- `stateFrozen` flag (set during shutdown) prevents `onExit` handlers from overwriting state
- Periodic saves every 30s survive crashes
- On startup, `state.json` is loaded and matched against reconnecting clients

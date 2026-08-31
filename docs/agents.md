# Agent Support

deepsteve runs five agent CLIs plus a plain terminal. They are **not** at the same level
of support, and until #622 nothing said so: `AGENT_CONFIGS` in `server.js` was the only
real source of truth, the landing page called three of them experimental in a footer
clause, and the rest was scattered through `CLAUDE.md` as individual gotchas. This page
is the one place that answers "what actually works with Codex?".

Two things back it up in code, so this page can't quietly go stale:

- **`AGENT_CATALOG`** (`server.js`) carries each agent's `tier` as data. `GET /api/agents`
  ships it, and `agentLabel()` in `public/js/app.js` is the single place it becomes the
  "(experimental)" suffix a user sees.
- **`test/unit/agents-doc.test.js`** fails the build when this page and that table
  disagree — a new agent cannot ship undocumented.

Runtime capabilities live in **`AGENT_CONFIGS`** (`server.js`), a separate table:
`AGENT_CATALOG` is the support promise, `AGENT_CONFIGS` is the mechanics.

## Support tiers

### Supported

- `claude` — Claude Code
- `codex` — Codex

deepsteve MCP tools and skills are wired, prompt delivery waits on a real readiness
signal rather than a timer, and there is positive test coverage. A gap here is a bug;
report it.

### Experimental

- `hermes` — Hermes
- `opencode` — OpenCode
- `pi` — Pi

These spawn, resume, and persist across a daemon restart. They get **no deepsteve MCP
tools** and **no skills**, so an agent running in one of these tabs cannot open sessions,
message other agents, self-close, or use anything under `mods/`. Prompt delivery is a
fixed 3-second timer with no readiness check, and the idle/waiting classifier never
moves — so notifications, the Action Required mod, and the waiting dot do not work for
them. Their entire automated test coverage is *negative* assertions (`for (const agent of
['codex','hermes','opencode','pi'])` in `test/unit/codex-lifecycle.test.js`, asserting
they do **not** get model/effort flags). They are not deleted and they are not going
away; they are simply not a promise.

Enabling: every agent honours the `enabledAgents` setting (Settings → Agents), and the
three experimental ones additionally need their binary on `PATH` — or a path set in the
"Binary path" field next to the checkbox (`hermesBinary` / `opencodeBinary` / `piBinary`).
Claude is the one agent never probed, because it is the default and the fallback in
`getAgentConfig()`.

## Capability matrix

| | Claude Code | Codex | Hermes | OpenCode | Pi | plain terminal |
|---|---|---|---|---|---|---|
| **Tier** | supported | supported | experimental | experimental | experimental | n/a |
| deepsteve MCP tools | yes | yes | — | — | — | — |
| Skills (`skills/*.md`) | yes | yes, adapted | — | — | — | — |
| Native `--worktree` | yes | — | — | — | — | — |
| Worktree via `git worktree add` | n/a | yes | yes | yes | yes | yes |
| Scheduled-task worktree isolation | yes | — | — | — | — | — |
| Model / thinking effort | yes | — | — | — | — | — |
| Config profiles (`CLAUDE_CONFIG_DIR`) | yes | — | — | — | — | env only |
| Scheduled self-report contract | yes | yes | — | — | — | — |
| Contract tools pre-permitted | yes | **no** ⚠️ | — | — | — | — |
| `/rc` inheritance | yes | — | — | — | — | — |
| Fork a session | yes | — | — | — | — | — |
| Plan mode | yes | — | — | yes | — | — |
| Idle / waiting classification | yes | — | — | — | — | — |
| Workshop dialog answering | yes | — | — | — | — | — |
| Prompt readiness | screen state | rendered MCP boot | 3s timer | 3s timer | 3s timer | 30s deadline |
| Echo-confirmed submit | yes | own Enter retry | — | — | — | — |
| Session pinned by | `--session-id` | per-tab `CODEX_HOME` | nothing | `--session` | `--session-dir` | nothing |
| Resume retry → fresh fallback | yes | — | — | — | — | — |
| Transcript-derived tab label | yes | — | — | — | — | — |
| History view (JSONL transcript) | yes | — | — | — | — | — |
| Listed in Recent Sessions | yes | yes | yes | yes | yes | — |
| Graceful exit | `/exit` | SIGTERM | Ctrl+C | Ctrl+C | SIGTERM | SIGHUP |
| Test coverage | deep | moderate | negative only | negative only | negative only | incidental |

Every agent is launched through a login shell — `resolveLoginShell()` picks it (`$SHELL`,
then the passwd entry, then zsh/bash/sh; see [platform.md](platform.md)) — so they all
inherit the `PATH` your login profile builds, under **both** terminal engines. That last
part was not true between #621 and #630, where agent panes under tmux ran a *non-login*
shell and lost anything `~/.zprofile` exported. All of them also get the
`DEEPSTEVE_*` environment variables (`DEEPSTEVE_SESSION_ID`, `DEEPSTEVE_API_URL`,
`DEEPSTEVE_API_TOKEN`, …). An experimental agent with no MCP can still reach the REST API
through those, if it has a shell tool.

## Claude Code (`claude`)

**Tier: supported.** The reference integration. Every feature listed above exists here
first, and several exist *only* here.

**Spawn.** `claude --session-id <uuid> [--permission-mode plan] [--model M] [--effort E]
[--allowedTools a,b] [--worktree NAME] --mcp-config <file>`. The session UUID is minted by
deepsteve, so the conversation is addressable from the first turn.

**Resume, and what survives a restart.** `serializeShellEntry` persists `claudeSessionId`,
`configDir`, `worktree`, `planMode`, `model`, `effort`, `allowedTools` and `forkParent`,
and resume re-applies all of them — Claude's `--resume` does not carry session flags
forward, so a plan-mode or model-pinned tab would silently regress otherwise. Claude is
also the only agent with a **failure ladder**: if `--resume` exits within 5s it retries
once, then falls back to a fresh session with a new UUID (`resume-retry` →
`fresh-fallback`, gated on `supportsSessionWatch`). It never falls back to `claude -c`,
which is cwd-scoped and would adopt a sibling tab's conversation (#542). The live session
id is tracked by an `fs.watch` on the transcript directory plus a PTY-output matcher, so
a fork or a `/clear` re-points the saved id rather than orphaning it.

**History (#672).** That same transcript is what the tab's `⧗` reads. It is the only
history an agent tab has: Claude Code repaints inside its own alternate screen, so no
line ever reaches tmux's history or xterm's scrollback (see
[terminal-engines.md](terminal-engines.md)). The pane is Claude-only for a structural
reason rather than a missing port — the other agents have no `claudeSessionId` and write
no `.jsonl`, so `supportsSessionWatch` gates it and everything else gets a stated empty
state. See [frontend.md](frontend.md) for the pane and `GET /api/shells/:id/transcript`.

**MCP.** Full. A per-shell config file is written to `~/.deepsteve/mcp-configs/<id>.json`
mode `0600` and passed as a *path* — never inline, or the bearer token would be visible
in `ps` to every local user.

**Skills.** Enabled skills are copied to `~/.claude/commands/deepsteve/<id>.md` and
invoked as `/deepsteve:<id>`. Custom config profiles get the same directory symlinked in.

**Worktree.** Native. deepsteve passes `--worktree <name>` and Claude Code itself moves
into `.claude/worktrees/<name>`; the PTY stays in the repo root, which is why
`sessionPaths()` exists to report the *actual* cwd. Scheduled tasks additionally get a
disposable per-run worktree (`isolateWorktree`, default on).

**Model / effort / config profile.** All three, per session and per scheduled task.
Values are re-validated at the argv boundary (`validateModel` / `validateEffort`), so a
hand-edited `state.json` or `scheduled-tasks.json` can't inject arguments.

**Readiness and submission.** The only screen-classified agent: `CLAUDE_SCREEN_MARKERS`
in `screen-classifier.js` drives `waitingForInput`, which in turn drives notifications,
the waiting dot, the Action Required mod, and prompt delivery. Submission is
echo-confirmed and then verified (#607) rather than assumed.

**Known gaps.** None that are specific to the integration.

## Codex (`codex`)

**Tier: supported.** MCP and skills are wired and it has a real readiness signal, but
several Claude-only features have no Codex equivalent yet — they are listed below rather
than hidden.

**Spawn.** `codex -c mcp_servers.deepsteve.url="…" -c
mcp_servers.deepsteve.bearer_token_env_var="DEEPSTEVE_API_TOKEN"`. That is the whole
argv: Codex generates its own session UUID, so there is no `--session-id`, no plan mode,
and no model/effort flag.

**Resume, and what survives a restart.** Isolation is by **home directory**, not session
id. Each tab gets `CODEX_HOME=~/.deepsteve/codex-sessions/<8-hex>`, with `auth.json`,
`config.toml`, `AGENTS.md`, `skills/` and friends symlinked in from `~/.codex` — shared
config and credentials, private history. Resume is therefore `codex resume --last` inside
that home, and `codexHomeId` is what `serializeShellEntry` persists. Before resuming,
deepsteve checks the home actually contains a rollout `.jsonl`; if not it spawns fresh
rather than resuming into nothing. Restoring from Recent Sessions deliberately reuses the
`codexHomeId` as the new shell id, so repeated restores converge on one home instead of
forking a new one each time.

**MCP.** Full, via two `-c` overrides. The token comes from the `DEEPSTEVE_API_TOKEN`
environment variable rather than argv, for the same `ps` reason as Claude's config file.

**Skills.** Yes, but *adapted* — Codex does not expand Claude's literal `$ARGUMENTS`.
`renderCodexSkill` generates `~/.deepsteve/codex-skills/deepsteve-<id>/SKILL.md` from the
canonical `skills/<id>.md`: it rewrites the frontmatter `name` to `deepsteve-<id>`, drops
the Claude-only `argument-hint`, replaces `$ARGUMENTS` with prose describing where the
arguments are, and rewrites `/deepsteve:foo` cross-references to `$deepsteve-foo`. The
generated directory is symlinked from `~/.agents/skills/deepsteve-<id>`; a pre-existing
*non-symlink* there is logged and never overwritten. Invoke with `$deepsteve-<id>`. Never
edit the generated files — `skills/*.md` is canonical.

**Worktree.** No native support, so deepsteve creates one itself with `git worktree add`
(`ensureWorktree`) and spawns Codex inside it. Note the failure mode: if that fails, the
session falls back to the **repo root**, not to an error.

**Model / effort / config profile.** None. `AGENT_CONFIGS.codex` has no `modelFlag`,
`effortFlag` or `allowedToolsFlag`, and config profiles are a `CLAUDE_CONFIG_DIR`
mechanism that means nothing to Codex — `splitAgentSelection` drops a profile if a
scheduled task is switched to Codex.

**Readiness and submission.** Codex has a real signal, just not a screen classifier:
`observeCodexReadiness` watches for Ratatui's "Starting MCP servers" row being cleared,
falling back to a settled, fully-loaded welcome frame. Submission uses an
output-acknowledged Enter retry (`writeCodexEnterWithRetry`) rather than the Claude echo
path. What Codex does *not* have is ongoing idle/busy classification: `state` from
`read_session_screen` and `get_session_info` is always `unknown`, so `meta_type`'s
`wait_for_idle` is inert and the waiting dot never lights.

**Known gaps.**

- ⚠️ **Scheduled-run contract tools are not pre-permitted.** A scheduled Codex run *is*
  given the self-report contract (the `mcpWired` probe is true for Codex), but the
  `--allowedTools` pre-permit from #612 is a no-op, because that flag lives only on
  `AGENT_CONFIGS.claude`. So an unattended Codex run can block on a permission prompt,
  never call `scheduled_task_finished`, and leave its run stuck at `running` — which
  makes the overlap guard skip **every subsequent fire of that task** until
  `maxRuntimeMinutes` reaps it. This is the single sharpest gap in the matrix.
- No per-run worktree isolation for scheduled tasks (`isolateWorktree` requires
  `supportsWorktree`), so scheduled Codex runs execute directly in the project checkout.
- No fork. Per-tab `CODEX_HOME` is the closest thing.
- No `/rc` inheritance — that is a Claude Code feature and `maybeInheritRemoteControl`
  returns immediately for anything else.
- No transcript-derived tab label, and no History pane (#672): both read a Claude
  `.jsonl`, and Codex tabs have `claudeSessionId: null` by construction. The label falls
  back to the directory name; the History affordance is simply absent from the tab, and
  the endpoint answers `{ supported: false }` rather than an error.
- Not registered as a global MCP server by `install.sh` / `restart.sh` the way Claude and
  OpenCode are; Codex is wired per session instead.

## Hermes (`hermes`)

**Tier: experimental.**

**Spawn.** No arguments at all. The binary is `hermesBinary` (default `hermes`).

**Resume, and what survives a restart.** The tab, its `cwd`, its name and its worktree
survive; the conversation's continuity is Hermes' own business. deepsteve mints a UUID
and persists it as `claudeSessionId`, but `supportsSessionId` is false so that UUID is
**never passed at spawn** — yet resume still sends `--resume <uuid>`. Treat resume as
best-effort. There is no retry-then-fresh ladder; one failed resume ends the session.

**MCP.** None. `mcpConfigArgs` returns `[]` for anything that isn't claude or codex.

**Skills.** None. `installSkill` writes a Claude copy and a Codex `SKILL.md`, and nothing
else.

**Worktree.** Via `ensureWorktree`, not natively — Hermes' own `--worktree` is a boolean
flag with no name argument, so deepsteve creates the worktree and spawns inside it.

**Model / effort / config profile.** None.

**Readiness and submission.** A fixed 3-second `initialPromptDelay` — no check that the
agent is actually ready. Submission is the fixed 1-second text-then-Enter gap, not the
echo-confirmed path. `waitingForInput` never moves off `false`.

**Known gaps.** Everything in the experimental tier description, plus: Hermes has no
positive test coverage anywhere in the suite, and its `emitsBel: false` means even the
legacy silence heuristic never classifies it.

## OpenCode (`opencode`)

**Tier: experimental.**

**Spawn.** `opencode --session <uuid> [--agent plan]`. The binary is `opencodeBinary`
(default `opencode`).

**Resume, and what survives a restart.** Better than the other two experimental agents:
the UUID deepsteve mints really is passed at spawn via `--session`, so resume
(`--session <uuid> --continue`) refers to a session OpenCode actually knows about. No
retry-then-fresh ladder.

**MCP.** None from deepsteve's per-session wiring. Note that `install.sh` / `restart.sh`
*do* register deepsteve as a **global** MCP server in `~/.config/opencode/opencode.json`
— that is a separate, install-time integration, and it is not what the rest of this page
means by "MCP wired" (it is not per-session, so tools that identify the caller by
`?shellId=` cannot).

**Skills.** None from the skills system. The repo-local `.opencode/commands/` directory
is unrelated hand-maintained copy and is not kept in sync with `skills/*.md`.

**Worktree.** Via `ensureWorktree`.

**Model / effort / config profile.** None, though OpenCode is the one non-Claude agent
with **plan mode**: `--agent plan`.

**Readiness and submission.** Fixed 3-second delay; fixed 1-second submit gap; no idle
classification.

**Known gaps.** Everything in the experimental tier description. Despite having both a
`sessionIdFlag` and a `planModeFlag`, neither is exercised by any test.

## Pi (`pi`)

**Tier: experimental.** Pi has no MCP support by design (upstream), so this is not a gap
deepsteve can close by wiring more plumbing.

**Spawn.** `pi --session-dir ~/.deepsteve/pi-sessions/<shellId>`. The binary is
`piBinary` (default `pi`); upstream is `@mariozechner/pi-coding-agent`.

**Resume, and what survives a restart.** Storage isolation is by directory, and the
directory is keyed on the **shell id** — which is stable across a restart, so resume
(`pi -c <uuid> --session-dir <same dir>`) lands in the right place without any UUID
tracking. The `<uuid>` there is a `claudeSessionId` deepsteve minted and never gave Pi at
spawn (`supportsSessionId` is false); `--session-dir` is what actually carries
continuity.

**MCP.** None, by design upstream. The `DEEPSTEVE_*` environment variables are still set,
so Pi can reach the REST API through its `bash` tool if you want it to.

**Skills.** None.

**Worktree.** Via `ensureWorktree`.

**Model / effort / config profile.** None.

**Readiness and submission.** Fixed 3-second delay; fixed 1-second submit gap; no idle
classification. Pi emits OSC 133 sequences, but those are shell-integration framing
rather than an idle signal, so the 2-second silence timer is what's left.

**Known gaps.** Everything in the experimental tier description. `piSessionDirArgs` — the
one piece of Pi-specific plumbing — has no test coverage at all.

**Shutdown note.** Pi exits on SIGTERM, not Ctrl+C: `^C` cancels the current turn rather
than the process.

## Plain terminal (`terminal`)

Not a selectable agent — it is absent from `AGENT_CATALOG` and `AGENT_TYPES`, so it never
appears in the picker and cannot be a default. You get one from the `+` menu, the
`#terminal` hash command, the `deepsteve:terminal` skill, or `open_terminal` **without**
`agent_type` — that last one is a common surprise: `open_terminal` defaults to a plain
`zsh`, does not inherit the caller's agent type, and silently ignores `prompt` unless you
pass `agent_type` or `fork: true`. The resolution is
`effectiveAgentType = agent_type || (fork ? caller.agentType : null)`
(`mods/deepsteve-core/tools.js`), and the symptom of getting it wrong is a new tab reporting
`agentType: "terminal"` in `GET /api/shells` while your `prompt` went nowhere.

It runs `zsh -l` and takes no arguments. On restart the tab, its name and its `cwd` come
back; running processes, scrollback and any environment set during the session do not.
Use the tmux engine if you need processes to outlive the daemon. `recordRecentSession`
skips terminals (and `tmux-attach` panes), so they never appear in Recent Sessions, and a
terminal is the only session where `get_session_info` reports `runningCommand` — the
foreground process, computed on demand from the tty's process group. Config profiles pass
through as `CLAUDE_CONFIG_DIR`, so typing `claude` yourself picks up the profile.

Exit is SIGHUP, not SIGTERM: an interactive login zsh traps SIGINT in ZLE and often
ignores SIGTERM.

### Disposable runs — `run_in_terminal` (#631)

**A terminal tab you open is yours to close.** Agents did not: of the first 102 terminal
sessions this install ever had, **zero** were closed by an agent — 95 by the user and the
rest still sitting open. Nothing had ever asked them to, and `open_terminal`'s own
description said the opposite ("the tab stays open afterward"). It now names the id and
asks, in the tool description and in a `cleanupReminder` on the result.

For anything one-shot, `run_in_terminal` removes the question entirely. It is a different
kind of tab: the pane's process **is** the command rather than a shell you type into, so

- the tool call blocks until the command exits, and returns its **output and exit code**
  (`timeout_seconds`, default 120, returns what it has so far — the run continues, is
  still recorded, and still tears its own tab down);
- the exit code comes from a nonce-tagged marker line the wrapper prints, not from the
  PTY's exit status, because under tmux the PTY we own is an *attach client* and its
  status belongs to tmux. The nonce stops a command that echoes the marker text from
  faking another run's completion;
- the command runs in a `( … )` subshell, so `… ; exit 3` is a run that exited 3 rather
  than a run that vanished — under tmux a shell that exits outright takes its pane down
  before the attach client has painted it, and since deepsteve never reads tmux's own
  history the entire transcript came back as tmux's literal `[exited]`;
- after the command finishes the pane execs a login shell, so the tab lingers
  (`terminalRunLingerSeconds`, default 20) and stays usable — **typing in it cancels the
  close** and the tab is yours, exactly as after a merge (#627). That reuses
  `session-auto-close.js` wholesale, including its entry-identity re-check;
- **the terminal answering a program is not a person typing** (#635, `terminal-input.js`).
  The browser forwards everything xterm's `onData` emits, which includes its replies to
  the capability probes tmux fires at every attaching client — so until the daemon
  learned to tell the two apart, *every* run took the "the user typed in it" branch
  within ~200 ms of the tab opening and no tab was ever closed. The classifier recognizes
  a closed set of report sequences (DA1/DA2, DSR, CPR, DECRPM, DCS and OSC replies),
  passes them to the PTY without stamping `lastInputTime`, and treats everything else as
  a keystroke — the safe direction, since a missed report only leaves a tab open;
- otherwise the daemon closes it with `closeReason: 'terminal-run-finished'`, which is
  what makes "did an agent clean up after itself?" answerable from `state.json` at all.
  The result's `auto_close` names which of those happened — `armed` (with
  `auto_close_in_seconds`), `closed_immediately`, `user_typed`, `shell_gone`, or `pending`
  on a timed-out call — and is stored on the run record too. It exists because collapsing
  all of them to a bare `null` is what hid #635 for as long as it did;
- capture polls the *interpreted* screen (`readTerminalScreen`), which resolves tmux's
  repaints where raw scrollback does not. When the shell dies without reaching the marker
  the tool's `onExit` hook snapshots `entry.scrollback` synchronously first, because
  `handleShellGone` disposes the screen — that path reports `exit_code: null`, unknown
  rather than guessed;
- every run is appended to `~/.deepsteve/terminal-runs.jsonl` (`GET /api/terminal-runs`)
  — once when it launches and once when it ends, so a command survives in the record even
  if the daemon dies mid-run. Deliberately not behind `sessionLogEnabled`, which defaults
  to off: an audit trail for the escape hatch to the un-isolated main checkout cannot.

Why agents reach for a terminal in the first place, and why this is the fix: Claude Code's
worktree isolation guard (#617) refuses any Bash command that reaches the shared checkout,
so a worktree session cannot run `git status` or `gh` there. `merge_worktree` covers the
merge; `run_in_terminal` covers the rest, running in the daemon's shell rather than the
agent's. The other half of the pull was `$PATH` — until #630 an agent pane under tmux ran
a *non-login* shell and could not see `gh` at all, while a terminal tab could. #630 fixed
that for agent sessions; a run gets the same login shell, for the same reason and by the
same mechanism (no `opts.shellCommand`, so the engine execs the argv verbatim).

`open_terminal` is still the right tool for something long-lived that you then own: a dev
server, a log tail, a watcher.

## MCP tools a wired session gets

These come from `mods/deepsteve-core` and exist for every agent whose tier says MCP is
wired — in practice `claude` and `codex`. Mods add more; see [mods.md](mods.md).

- **Session self-discovery**: `get_my_session_id` (no parameters) returns the 8-char shell ID without needing Bash permissions — the ID is embedded in the MCP URL via `--mcp-config` at spawn time. Each PTY also gets env vars at spawn: `DEEPSTEVE_SESSION_ID`, `DEEPSTEVE_TAB_NAME` (initial tab name), `DEEPSTEVE_WORKTREE` (worktree **name** or empty), `DEEPSTEVE_CWD` (the agent's actual working directory — the `.claude/worktrees/<name>` path for worktree sessions, otherwise the session cwd), `DEEPSTEVE_WINDOW_ID` (browser window ID or empty), `DEEPSTEVE_API_URL` (e.g. `http://localhost:3000`), and `DEEPSTEVE_API_TOKEN` (bearer token for REST calls to that URL, #536). For live metadata (e.g. after a tab rename), use the `get_session_info` MCP tool or `GET $DEEPSTEVE_API_URL/api/shells/$DEEPSTEVE_SESSION_ID/info` (REST endpoints require `-H "Authorization: Bearer $DEEPSTEVE_API_TOKEN"`) — both return `cwd` (actual working directory, i.e. the worktree path for worktree sessions), `repoRoot` (the main repo checkout), `worktree` (the worktree name or null), and `runningCommand` (for a plain `terminal` session, the command running in its foreground right now, or null when idle at the prompt — computed on demand from the shell's tty foreground process group via `getForegroundCommand()`; always null for agent sessions). **Worktree gotcha:** for Claude (which has native `--worktree` support), the PTY is spawned in the main repo and Claude Code itself moves into `.claude/worktrees/<name>`; `entry.cwd` therefore holds the main repo path, so `cwd`/`DEEPSTEVE_CWD` are resolved to the worktree subdir via `sessionPaths()` rather than reported raw.
- **Session roster (`list_sessions`, #659)**: the plural of `get_session_info`, and **project-scoped by default** — it lists the LIVE sessions in the caller's own project rather than every tab on the machine, with `scope: "group"` for sibling repos in the same context (#526) and `scope: "all"` for everything. `project` overrides the project and `session_id` supplies the caller when the MCP request carries no `shellId`; a call that cannot be scoped returns an empty list with a note, not an error. Rows reuse `get_session_info`'s field names and add two: `project`, the canonical repo root the row was scoped by, and `self`, the calling session (which also sorts first). **What "project" means here is a repo root, resolved on both sides of the comparison.** `sessionPaths()` only strips a worktree suffix — it never asks git — so a session opened in `<repo>/src` reports `<repo>/src` as its `repoRoot`; both the caller's project and every row's are put through `findGitRoot` so `===` means "the same directory" rather than "the same string". A worktree session scopes to its **parent** repo, and that comes from `sessionPaths()`, not from canonicalizing its cwd: a worktree has a `.git` *file*, which `git-root.js` treats as a root of its own. Closed and saved sessions are never listed (`GET /api/shells` and `/api/recoverable-sessions` remain the surfaces for those), `tmux-attach` entries are skipped the way `buildWindowsView` skips them, and `runningCommand` is deliberately absent because it costs a process lookup per row — ask `get_session_info` for one session. The scope helpers live in root-level **`project-scope.js`** and are shared with `list_scheduled_tasks` and `list_project_mods`, so "project" means the same thing in all three.
- **Session self-close**: `close_session` closes a session from within the agent. The MCP response is sent synchronously before the PTY teardown begins (`killShell` uses `setTimeout` for escalation), so the agent always receives the acknowledgment. A session can close itself or any other session.
- **Meta Controls (`meta_type`, #519)**: lets an agent type into its own or another session's PTY — a **server-side write**, so it works regardless of browser tab focus. Params: `text`, `keys` (control keys sent before text: `Escape`, `Enter`, arrows, `C-c`… — one engine-write each with 250ms gaps, since Ink needs separate stdin reads), `clear_first` (ONE Escape to clear staged composer text — deliberately not two; double-Esc opens Claude Code's history menu), `wait_for_idle` (poll up to 30s for the BEL classifier's idle before typing), `session_id` (defaults to caller), `submit` (default `true`; builds on `submitToShell()`; `submit:false` stages via `engine.write`). The return is **truthful**: `state_before` (`idle`/`busy`/`unknown` via `sessionInputState()`), `landed` (readback heuristic — the ANSI-stripped scrollback tail must contain the typed text), and `screen_tail`. Self-typing enables recursive/self-driving loops, so it is gated behind the `metaControlsEnabled` setting (default **off**) — but instead of failing, a call while disabled triggers an **in-browser consent dialog** (`requestMetaControlsConsent()` in server.js, modeled on the restart confirm: `confirm-meta-controls` over the reload WS, decision via `POST /api/meta-controls-consent`, first response wins, all windows dismissed via `confirm-meta-controls-resolved`). Approval flips the persistent setting; decline starts a 60s cooldown against modal-nagging; **zero connected browsers never auto-confirms**. The handler reads `settings.metaControlsEnabled` live; the tool is always registered (like all mod tools).
- **`read_session_screen`**: ungated read-only companion to `meta_type` — returns the last N lines (default 40, max 200) of a session's server-side interpreted terminal buffer plus `state` (`idle`/`busy`/`unknown`) and `seconds_since_output`. Cursor movement, erase operations, alternate-screen redraws, reflow, and CSI intermediate bytes are resolved before lines are returned. Use it to check what a session is doing or to verify typed input landed — no more `browser_eval` poking at `window.__deepsteve` internals.
- **`issue_complete`**: an issue session calls this when it believes the work is done — every issue prompt ends with an instruction to, in both autopilot states. It resolves the caller the way `merge_worktree` does (`session_id`, else `shellId` from the MCP request URL), reads `autopilot` off that session's entry, and answers with what to do next: merge this session (`next: 'merge'`) or stop and leave the tab for review (`next: 'stop'`). It does **not** perform the merge — `skills/merge.md` is a nine-step procedure with a conflict→rebase→retry loop and an auto-commit that a server-side handler has no business running, so the tool hands the agent the instruction and the agent runs the skill. The merge form is agent-aware (`$deepsteve-merge` for Codex) and degrades to explicit `merge_worktree` + `close_session` steps when the `merge` skill is disabled. See [sessions.md](sessions.md) for why the flag is read at call time rather than injected when it is switched on.
- **Browser Console / Screenshots**: these operate on the deepsteve UI tab only — they do NOT access your project's website or any other browser tab. `screenshot_capture` and `scene_snapshot` save PNGs to disk and return the file path; use the `Read` tool on that path to view the image. Do NOT try to base64-decode or re-save — the bytes are already on disk at the returned path. All three return an immediate `isError` when no browser window is connected, rather than broadcasting into the void.

## Adding an agent

1. Add a row to **`AGENT_CATALOG`** (`server.js`) with `id`, `name`, `shortName`, `tier`,
   and `binarySetting` if the path should be user-overridable. `AGENT_TYPES`, the
   `enabledAgents` default, `GET /api/agents`, the Settings checkbox, and the new-tab
   picker all follow from that one row.
2. Add a row to **`AGENT_CONFIGS`** (`server.js`) describing the mechanics: `exitMethod`,
   `initialPromptDelay`, the resume flags, and whichever of `supportsSessionId` /
   `supportsWorktree` / `supportsSessionWatch` / `planModeFlag` apply.
3. Teach **`spawnSession`** which binary to run.
4. Add the agent to this page — the matrix, a section, and the right tier list. The unit
   test fails until you do.

Four things a new agent does **not** get for free, each a hardcoded `agentType` check
rather than a capability flag:

- **MCP** — `mcpConfigArgs` returns `[]` for anything but claude and codex.
- **Skills** — `installSkill` writes a Claude copy and a Codex `SKILL.md`, nothing else.
- **Idle classification** — needs a `screenMarkers` set in `screen-classifier.js`;
  without one, `classifyScreenState` returns `unknown` forever and prompt delivery falls
  back to `initialPromptDelay`.
- **`/rc` inheritance, fork, model/effort, config profiles** — all gated on
  `agentType === 'claude'`.

One sharp edge: **`getAgentConfig` falls back to Claude's config for any unknown
agentType**, and `spawnSession`'s binary lookup falls back to the literal `claude`
binary. A typo in an agent id does not throw — it launches Claude Code.

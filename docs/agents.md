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
| Prompt readiness | screen state | rendered MCP boot | 3s timer | 3s timer | 3s timer | 30s deadline |
| Echo-confirmed submit | yes | own Enter retry | — | — | — | — |
| Session pinned by | `--session-id` | per-tab `CODEX_HOME` | nothing | `--session` | `--session-dir` | nothing |
| Resume retry → fresh fallback | yes | — | — | — | — | — |
| Transcript-derived tab label | yes | — | — | — | — | — |
| Listed in Recent Sessions | yes | yes | yes | yes | yes | — |
| Graceful exit | `/exit` | SIGTERM | Ctrl+C | Ctrl+C | SIGTERM | SIGHUP |
| Test coverage | deep | moderate | negative only | negative only | negative only | incidental |

Every agent is launched through a login shell — `zsh -l -c '<binary> <args>'`
(`spawnSession`) — so they all inherit your `PATH`, and all of them get the
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
- No transcript-derived tab label: `deriveSessionLabel` reads a Claude `.jsonl`, and
  Codex tabs have `claudeSessionId: null` by construction, so they fall back to the
  directory name.
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
`piBinary` (default `pi`).

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
pass `agent_type` or `fork: true`.

It runs `zsh -l` and takes no arguments. On restart the tab, its name and its `cwd` come
back; running processes, scrollback and any environment set during the session do not.
Use the tmux engine if you need processes to outlive the daemon. `recordRecentSession`
skips terminals (and `tmux-attach` panes), so they never appear in Recent Sessions, and a
terminal is the only session where `get_session_info` reports `runningCommand` — the
foreground process, computed on demand from the tty's process group. Config profiles pass
through as `CLAUDE_CONFIG_DIR`, so typing `claude` yourself picks up the profile.

Exit is SIGHUP, not SIGTERM: an interactive login zsh traps SIGINT in ZLE and often
ignores SIGTERM.

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

# deepsteve

DeepSteve is a node server that manages Agent (Claude Code, etc) instances and a Web UI that lets you connect to them in the browser and automate the Agents. Agents running inside of DeepSteve can interact with the DeepSteve system itself, writing custom browser-based UIs as well as interact with each other.

It runs as a **macOS LaunchAgent** or a **Linux systemd user unit** serving a web UI over
WebSocket. Each browser tab is a PTY-backed agent session, and since #620 those PTYs live in
**tmux panes**, so an agent survives a daemon crash, a `./restart.sh`, and closing the browser.
Plain Node, no build step: Express + `ws` backend, vanilla ES modules on the frontend.

## Development workflow

### Restart the daemon after making changes

```bash
./restart.sh            # silent restart — browser reconnects via WebSocket
./restart.sh --refresh  # restart + force browser page reload
```

Use `--refresh` when changes affect anything the browser loads (frontend JS/CSS/HTML, server endpoints, settings). Plain `./restart.sh` only restarts the server process — open browser tabs just silently reconnect their WebSocket, so they keep running old frontend code and won't see new server-side behavior until the page is reloaded. It re-execs itself with `nohup`, so the terminal returns immediately.

**`Restart cancelled.` has two causes.** `./restart.sh` first POSTs to `/api/request-restart`, which shows a confirm dialog in the browser. The script prints `Restart cancelled.` and exits if either (a) the user actively dismissed the dialog, or (b) nobody responded within the 60s timeout. Don't assume it was an explicit rejection — the user may have been away from the screen. Ask them to retry or confirm when they're ready rather than silently giving up.

**`--force` skips the in-app modal (#504).** When you can't (or don't want to) confirm in the browser, `--force` moves acceptance to **Claude Code's own permission prompt** for the command instead. It is a deliberate two-step so the user sees the blast radius before accepting:

```bash
./restart.sh --force                       # step 1: prints "Restarting - N active sessions will be interrupted" + the exact confirm command. No restart.
./restart.sh --force --prompt "Restarting - 3 active sessions will be interrupted"   # step 2: restarts after re-checking the text
```

The server owns the wording (`GET /api/restart-prompt`, derived from the live session count); step 2 re-validates the echoed `--prompt` text against the server and aborts if it's stale or forged, so the number you approve is always the real one. The forced path still does a full graceful deploy + restart (it just skips the `/api/request-restart` POST). **Do not allowlist `./restart.sh` (especially the `--force --prompt` form)** — the guarantee that a restart can never happen unilaterally (e.g. by an agent) rests entirely on that command staying behind Claude Code's permission prompt.

**Worktree sessions:** `./restart.sh` deploys from the directory it lives in — it sets `SCRIPT_DIR="$(dirname "$0")"` and copies that directory's `server.js`, `mods/*`, `public/*`, etc. into `~/.deepsteve/`. So running the **worktree's own** `./restart.sh --refresh` *does* deploy that worktree's edits without merging first — handy for testing a change in place. Caveat: it also stamps `.install-source.json` with the worktree path as `sourcePath`, and the in-app auto-update (git-pull) runs against that path. Since worktrees are temporary and sit on feature branches, prefer running `./restart.sh` from the **main repo checkout** for a durable install, and re-run it there after merging.

### Check if running, and read logs

```bash
./status.sh                                               # service state, port, health, node path, log dir
tail -f ~/Library/Logs/deepsteve.log                      # macOS
tail -f ~/.local/share/deepsteve/logs/deepsteve.log       # Linux
```

`./status.sh` is read-only and **safe to allowlist** — it calls no mutating verb, and a unit test greps to keep it that way. It also prints the correct log dir for this machine. `./restart.sh` is NOT safe to allowlist; see above.

### Stop the daemon

There is no wrapper for this on purpose — stopping without the deploy/confirm machinery is a manual act:

```bash
launchctl unload ~/Library/LaunchAgents/com.deepsteve.plist   # macOS
systemctl --user stop deepsteve                               # Linux
```

### Full reinstall

```bash
~/.deepsteve/uninstall.sh
./release.sh   # generates install.sh from source — install.sh is NOT checked in
./install.sh
```

### Run tests

```bash
npm run test:unit         # bare Node, no daemon, no shell — the fast one
npm run test:standalone   # one throwaway daemon per suite file
npm test                  # integration; auto-provisions an isolated daemon, safe alongside the live one
```

`npm test` provisions its own daemon (scratch `HOME`, random port, `DEEPSTEVE_TEST_MODE=1`) when `DEEPSTEVE_URL` is unset, so it can never touch the production daemon. **Never set `DEEPSTEVE_TEST_MODE=1` on a real install.** Suite topology, the safety layers behind that guarantee, and the tmux sandbox rules are in [docs/testing.md](docs/testing.md) — read it before writing a test that starts a daemon or touches tmux.

## Where things are documented

`CLAUDE.md` is the map and the rule list. Mechanism lives in `docs/`, one page per area. Each
line below is a trigger: if you are about to do that thing, read that page first.

| Read this | Before |
|---|---|
| [docs/terminal-engines.md](docs/terminal-engines.md) | changing anything about tmux, node-pty, engine selection, session durability, socket ownership, or startup reattach |
| [docs/sessions.md](docs/sessions.md) | changing session persistence, tombstones, the restore surface, prompt delivery/submission, the waiting classifier, sleep handling, or worktree/merge behavior |
| [docs/scheduled-tasks.md](docs/scheduled-tasks.md) | touching `mods/scheduled-tasks/`, or assuming an unattended run behaves like an interactive tab |
| [docs/testing.md](docs/testing.md) | adding a suite, a daemon fixture, or anything that runs tmux from a test |
| [docs/platform.md](docs/platform.md) | touching `service.sh`, the launchd plist / systemd unit, `paths.js`, `bin-path.js`, auth, HTTPS, or the npm package (`bin/deepsteve.js`, `package.json`'s `files`) |
| [docs/frontend.md](docs/frontend.md) | adding a keyboard shortcut, a palette command, or touching client-side session storage |
| [docs/agents.md](docs/agents.md) | assuming a feature works for a given agent, adding an agent, or using a core MCP session tool |
| [docs/mods.md](docs/mods.md) | writing or changing a DeepSteve Mod, a Project Mod, or a display tab |
| [docs/themes.md](docs/themes.md) | adding or changing a theme |
| [docs/claude-code-prompt-lifecycle.md](docs/claude-code-prompt-lifecycle.md) | reasoning about what Claude Code sees, when, and what a compaction does to it |

`AGENTS.md` is the sibling of this file for Codex sessions; it carries the code-style rules.

## Keeping this file small

**This file is a budget, not a log.** It is injected at the start of every session *and
re-injected on every compaction*, so every byte here is paid on every turn of every session in
this repo, forever. It reached 117 KB / ~21k tokens by accretion before #629 cut it back.

The rules, in order of how often they are broken:

1. **Per-issue rationale goes in the issue and the commit message, not here.** Keep the
   invariant — "never write `delete savedState[id]` in a close path" — and drop the story of
   how it was discovered, what the failed mitigation was, and which commit fixed it. An agent
   that needs the story can `git log` or open the issue.
2. **Mechanism goes in `docs/`**, with a one-line trigger in the table above. If a fact is
   stated in a `docs/` page it must not also be stated here; one of the two is a pointer.
3. **Adding a section means removing or relocating one.** There is a **30 KB hard cap**,
   enforced by `test/unit/claude-md-budget.test.js`. When it fails, the fix is to move
   something to `docs/` — not to tighten wording until it fits.
4. **Never add a rule of the form "when X happens, write it down here."** A conditional trigger
   is not safer than an unconditional one; it just needs a trigger that fires often. A prior
   project took a `CLAUDE.md` from 10 KB to 100 KB in seven days on "document every build
   failure". Any such rule is unbounded unless paired with a removal rule, and a removal rule
   that depends on an agent's judgement will not fire.

What belongs here: things true in *every* session — how to restart and test, where the docs
are, and the invariants below.

## Invariants

Rules a change anywhere in the tree could violate. Each one has a page that explains why.

**Sessions and state** ([docs/sessions.md](docs/sessions.md))

- **Never write `delete savedState[id]` in a close path.** Every close/kill/wipe writes a `closed: true` tombstone instead, so a conversation can always be resurrected via `--resume`. Use `tombstoneSession()` (explicit closes) or `handleShellGone()` (engine `onExit` epilogue). The only sanctioned purges are `DELETE /api/shells/:id?forget=1` and the retention sweep `pruneClosedSessions()`.
- **A session's spawn cwd must exist.** `spawnSession` refuses a missing or non-directory cwd instead of letting tmux silently relocate the pane to `$HOME`, and a refused restore keeps its record. Validate the *spawn* cwd only — a Claude `--worktree` subdir legitimately does not exist yet.
- **The first writer of a close reason wins.** A server-initiated close makes the browser echo a `close-session` back; that echo must not overwrite `closeReason`, or every unattended auto-close reads as user-closed. Any new close path preserves the rule.
- **Ink only sees Enter as its own stdin read** — `shell.write("text\r")` does not submit. Use `submitToShell()`, which writes the text and the `\r` separately and echo-confirms the gap.
- **A terminal report is not user input.** xterm's replies to tmux's capability probes arrive on the session WebSocket looking exactly like keystrokes; `isTerminalReport()` filters them before `lastInputTime` and the auto-close cancel, or every disposable tab claims itself (#635).
- **Queue prompts through `deliverPromptWhenReady`. Never arm `e.pendingDelivery` directly.** The per-shell FIFO is what sequences an inherited `/rc` ahead of the issue prompt.
- **node-pty**: use `.removeListener()`, never `.off()`. Delete `env.CLAUDECODE` when spawning nested Claude instances.

**Engines and tmux** ([docs/terminal-engines.md](docs/terminal-engines.md))

- **Use `spawnSession`'s return value** to record `engineType`. A tmux spawn can fail at runtime and fall back to node-pty; recording what was *requested* makes the entry lie.
- **Every tmux invocation carries `-S <stateDir()>/tmux.sock`** and runs via `execFileSync` on a resolved absolute path — never through a shell, never on tmux's default per-UID socket.
- **Destroy only what this daemon can positively identify as its own and finished.** A `ds-*` session absent from our state.json is logged and left strictly alone.
- **Artifacts the daemon installs and removes outside its state dir hang off `agentHomeDir()`, never `os.homedir()`** — `~/.claude/commands`, `~/.agents`. Otherwise a second instance isolated with `DEEPSTEVE_HOME` prunes the real user's home. `os.homedir()` stays right for paths naming where a *spawned agent* reads (`~/.claude/projects`, `~/.codex`); ownership is the line, not the dotdir.

**Tests** ([docs/testing.md](docs/testing.md))

- **Never set `DEEPSTEVE_TEST_MODE=1` on a real install**, and do not weaken any of the three safety layers that keep a suite off the production daemon (`DEEPSTEVE_URL` required, `testMode` verified, `killall` refused outside test mode).
- **An integration test's filesystem is not the daemon's.** Under every docker suite they are two containers, so `test/integration/**` gets scratch cwds from `test/helpers/server-dir.js`, never `os.tmpdir()`. Guard tests enforce both halves — the helper's use, and the shared mount every compose must give its two containers; local runs share a filesystem and will not catch a violation.
- **Only `test/helpers/tmux-sandbox.js` may run `tmux`.** `TMUX_TMPDIR` and `kill-server` are banned under `test/**` — an unaimed `kill-server` once destroyed every live agent on the machine, three times in twenty minutes.
- **Nothing under `test/unit/` may import `engines/node-pty`** — the CI unit job runs `--ignore-scripts`, so the native binding does not exist there.
- **Don't add a `node-pty` engine pin to make a red test green** without confirming it's the same "this path is structurally absent under tmux" reason the existing pins have.
- **A suite cannot skip a test file, and the three installed-server composes share one definition.** `run-integration.sh` takes no arguments and `test/docker-compose.{install,npm,public}.yml` extend `docker-compose.base.yml`; don't reintroduce either as per-file copies.

**Platform and security** ([docs/platform.md](docs/platform.md))

- **`service.sh` is a sourced library, never an entry point.** Mode 644, no exec bit, no `main`, no `case "$1"`. That is a security property: an executable `service.sh` with argument dispatch would be a second, unguarded way to restart the daemon.
- **The systemd unit must keep `KillMode=process`**, or the tmux server dies inside the daemon's cgroup and every `restart.sh` destroys every session.
- **Auth is always on**, with no off switch — the only escape hatches *widen* the allowlists. The canonical browser URL is `http://deepsteve.localhost:3000`; agent/CLI traffic deliberately stays on plain `localhost`.
- **The deploy that first turns auth on must use `./restart.sh --refresh`**, so already-open tabs reload and acquire the cookie.

**Worktrees and merging** ([docs/sessions.md](docs/sessions.md))

- **A worktree-isolated session's Bash cannot reach the shared checkout.** Claude Code 2.1.222+ statically refuses `git -C <main checkout>`, `cd <main checkout> && git …`, and any command naming `git` more than once. Merge through the `merge_worktree` MCP tool, which runs server-side, outside the guard.
- **Never work around a guard refusal with `git push origin <branch>:main`** — it moves the remote and leaves the local checkout behind.

**Frontend** ([docs/frontend.md](docs/frontend.md))

- **Every global key binding is declared in the `shortcuts.js` registry**, at *module scope*, and uses the matcher `register()` hands back — so a binding cannot be changed without editing its entry. The ⌘? overlay renders the registry; the list is never hand-maintained. Adding or renaming a binding means updating the exact-id set in `test/unit/shortcuts-registry.test.js`, which is the drift guard.
- **Strict modifier equality** in that matcher is what keeps Ctrl+F reaching the PTY for vim's `<C-f>` while ⌘F opens search. A test pins it; don't loosen it.
- **Every mutation of the client session stores goes through `public/js/session-stores.js`.** `app.js` never writes `TabSessions` or `SessionStore` session lists by hand — that facade is what keeps the two from drifting.

**Agents and mods** ([docs/agents.md](docs/agents.md), [docs/mods.md](docs/mods.md))

- **`open_terminal` opens a plain shell by default.** It does not inherit the caller's agent type, and it silently ignores `prompt` unless you pass `agent_type` (or `fork: true`).
- **A terminal tab an agent opens is a terminal tab an agent leaks** — 0 of the first 102 were ever closed by one (#631). One-shot work belongs in `run_in_terminal`, which returns the command's output and tears its own tab down; `open_terminal` is for something long-lived that the opener then owns, and now says so in its description and in a `cleanupReminder` on its result. Two things that read as arbitrary but aren't: the run's exit code comes off the *stream* (a nonce-tagged marker the wrapper prints), because under tmux the PTY we own is an attach client whose status belongs to tmux; and the command runs in a `( … )` subshell, because a shell that exits outright takes its pane down before tmux has painted it and the whole transcript is lost. Details in [docs/agents.md](docs/agents.md).
- **`docs/agents.md` is the capability matrix** — check it before assuming a feature works for the agent you're in. Much of this repo's machinery is Claude-only in practice.
- **A project mod lives in its own repo**, at `.deepsteve/mods/<name>/`, marked `scope: "project"` in `mod.json` — so it is committed and travels with the checkout. **Never gitignore `.deepsteve/`** (not here, not in a template, not from an install script); a guard test enforces it. Discovery only scans the repos of *registered projects*, which is why `create_project_mod` refuses any other repo.
- **Display tabs and project mods are same-origin and trusted.** Their iframes carry `allow-same-origin` because the `window.deepsteve` bridge requires it, so an agent-authored page has the authority the agent already had. Document that; don't imply the sandbox isolates it.
- **Skill sources are `skills/*.md`.** Never edit an installed copy under `~/.claude/commands/deepsteve/` or a generated Codex `SKILL.md`.

## Adding a new setting

Settings are declared once in the `SETTINGS_SCHEMA` array in `server.js`. Defaults, POST `/api/settings` validation, and `broadcastSettings()` all flow from that single entry — you do **not** hand-write a branch in the POST handler or an explicit field in the broadcast payload.

To add a setting, append one entry to `SETTINGS_SCHEMA`:

```js
{ name: 'myNewSetting', type: 'boolean', default: false }
```

Supported `type` values: `string` (opt-in `fallbackOnEmpty` restores the default when an empty string is POSTed), `boolean`, `number` (opt-in `clamp: [lo, hi]`, `round: true`, `fallback` for the NaN/0 case), `enum` (`values: [...]` or `values: () => [...]` for runtime-dependent enums like `engine`), `array` (`itemEnum` filters, `nonEmpty: true` rejects empty writes), and `custom` (provide a `sanitize(raw)` that returns `null` to reject or a cleaned value to accept — for a setting whose shape none of the built-in types cover).

Optional per-entry hooks:

- `broadcast: false` — omit from the WebSocket `settings` message (use for server-internal fields like `wandPlanMode` or binary paths).
- `sideEffect: (val, s) => { ... }` — mutate other settings on accept (e.g. `enabledAgents` re-points `defaultAgent`). Schema declaration order matters: a field later in the array can override a side-effect earlier in the same POST.
- `logValue: v => '...'` — customize the `Settings updated: ...` log line (used by `wandPromptTemplate` and `enabledAgents`).

The client sends fields by name in the POST body and applies them locally on save (`app.js`). Always verify that a second open browser window picks up the change via WebSocket.

`applySettingsFromBody` returns warnings for invalid fields and for `itemEnum` array items it dropped (e.g. a stale agent id in `enabledAgents`); the POST response includes them as a `warnings` array when non-empty. The settings modal preserves `enabledAgents` entries that have no rendered checkbox instead of rebuilding the list from the rendered ones.

**Out-of-schema exceptions:** `activeTheme` and `enabledSkills` intentionally bypass this pipeline — they use dedicated endpoints (`POST /api/themes/active`, `POST /api/skills/{enable,disable}`) and dedicated broadcasts (`broadcastTheme`, `broadcastSkills`) because they ship side payloads (theme CSS) or perform file I/O (copying skill `.md` files). Their defaults live in `NON_SCHEMA_DEFAULTS` next to the schema.

A mod's own enable/disable is **per-browser localStorage and never reaches the server**, so any server-side mod behavior that needs an off switch needs a `SETTINGS_SCHEMA` entry of its own (`scheduledTasksEnabled`, `projectModsEnabled`, `metaControlsEnabled` all exist for this reason).

## Skills

Enabled skills are reusable agent workflows. Their canonical sources are `skills/*.md`, each with YAML frontmatter (`name`, `description`, optional `argument-hint`).

- **Discovery is automatic**: the server reads `skills/*.md` and exposes them in `GET /api/mods` with `type: 'skill'`, so a new file appears in the mods UI with no registration step.
- **Enabling installs both formats together** — a Claude copy at `~/.claude/commands/deepsteve/<id>.md` (invoked `/deepsteve:<id>`) and a generated Codex `SKILL.md` symlinked from `~/.agents/skills/deepsteve-<id>` (invoked `$deepsteve-<id>`). The Codex adaptation is not a copy; see [docs/agents.md](docs/agents.md) for what it rewrites and why.
- **Startup reconciles**: enabled artifacts are restored, disabled known artifacts removed, correct links left alone, stale managed links repaired, and a non-symlink at a managed path is logged and never overwritten.
- **`maintainer: true` in the frontmatter withholds a skill from the build.** `release.sh` leaves it out of `install.sh` and deletes it on upgrade, so it exists only in a git clone — disabled there like every skill until someone enables it. `skills/release.md` is the only one; see [RELEASING.md](RELEASING.md).
- Focused test: `node --test --test-timeout=180000 test/integration-standalone/codex-skills.test.js`.

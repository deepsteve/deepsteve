# Platform, service, and security

How deepsteve is installed, supervised and secured on a machine — the launchd/systemd split,
the one shell library both arms go through, the JS modules that own everything platform-shaped,
and the auth model that guards every surface.

## macOS and Linux (#621)

deepsteve runs under a **launchd LaunchAgent** on macOS and a **systemd user unit** on Linux. Both are driven through one shell library, and the JS side has three small modules that own everything platform-shaped.

- **`service.sh` is a SOURCED LIBRARY, never an entry point.** Mode 644, no exec bit, no `main`, no `case "$1"`, no `set -e`, POSIX `sh` only. That is a *security property*: CLAUDE.md's rule is that a restart can never happen unilaterally because the only trigger is `./restart.sh`, which stays behind Claude Code's permission prompt. An executable `service.sh` with an argument dispatcher would be a second, unguarded path to the same thing — so it is made unrepresentable, and `test/unit/service-lib.test.js` asserts the exec bit and the absence of a dispatcher. **Do not chmod +x it and do not give it argument dispatch.** `./status.sh` is the read-only companion and *is* safe to allowlist.
- **Verbs**: `ds_platform` (honors a test-only `DEEPSTEVE_PLATFORM` override — this is what lets one Linux CI runner exercise *both* arms), `ds_install_dir` / `ds_log_dir` / `ds_service_path` / `ds_node_path` / `ds_port` / `ds_url`, the predicates `ds_is_running` / `ds_port_in_use` / `ds_is_responding` / `ds_linger_enabled`, and the mutators `ds_service_write` / `ds_service_start` / `ds_service_stop` / `ds_service_uninstall` / `ds_wait_stopped` / `ds_service_status`. Accessors print one line; predicates exit 0 = true; **`ds_service_stop` always returns 0** because `install.sh` runs under `set -e` and `systemctl --user stop` on a nonexistent unit is not as forgiving as `launchctl unload`.
- **Three consumers, one definition**: `restart.sh` sources it from the checkout, `uninstall.sh` from either its own dir or `$INSTALL_DIR`, and the generated `install.sh` from the copy `release.sh` embedded. `restart.sh` also deploys `service.sh`/`uninstall.sh`/`status.sh` into `~/.deepsteve` — deliberately a hand-maintained list, not `cp *.sh`, since restart.sh must never land inside its own deploy target. `test/unit/shell-deploy.test.js` pins that the copied set and the embedded set agree.
- **The unit sets `KillMode=process`, and that line is load-bearing.** systemd's default is `control-group`: on stop it SIGKILLs the whole cgroup, and cgroup membership is inherited across `fork()` — so the **tmux server dies with the daemon** and every `restart.sh` destroys every session. macOS has no equivalent problem (`launchctl unload` leaves the daemonized tmux server alone). Also set: `TimeoutStopSec=30` (graceful shutdown is ~12s worst case), a `reset-failed` before start (a unit that latched `failed` in a crash loop refuses every later `start`), quoted `ExecStart`, and `DEEPSTEVE_LOG_DIR`.
- **Golden fixtures** for both definitions live in `test/unit/fixtures/`; `service-definition.test.js` diffs against them, cross-checks `ds_log_dir`/`ds_install_dir` against `paths.js`, and validates with the **real parsers** — `plutil -lint` (runs on a Mac) and `systemd-analyze --user verify` (runs on CI's systemd runners). Each arm is finally checked by something that understands the format.
- **`loginctl enable-linger` is advised, never run.** Without it a systemd user instance dies at logout, so ssh in → install → log out → daemon gone. But it writes outside `$HOME` and its polkit action typically prompts on a remote session, so a `curl | bash` must not run it. `ds_linger_note` prints the fix, `status.sh` repeats it forever, and `DEEPSTEVE_ENABLE_LINGER=1` is the opt-in.
- **JS side**: `paths.js` owns `stateDir()`/`logDir()`/`expandTilde()` — the state dir stays `~/.deepsteve` on **both** platforms (it *is* the install dir; mods resolve core modules as `../../<mod>`, so XDG would add a second location rather than remove the dotdir), while the log dir is platform-split because launchd/systemd name it absolutely. `bin-path.js` resolves binaries with a `$PATH`-then-fallback-dirs scan (generalized from #619's `tmux-path.js`) and owns `resolveLoginShell()` and `resolveUrlOpener()`. All three take injectable `{platform, env, homedir}` so the bare ubuntu unit job can assert the darwin answers.
- **No `zsh -l -c` remains in `server.js`.** The seven PATH-only sites (git, gh, agent-binary probes) call `execFileSync(resolveBinary(x), argv)`; the two that genuinely want a login shell (session spawn, custom palette commands) use `resolveLoginShell()`, which prefers `$SHELL` (a LaunchAgent's env really does carry `SHELL=/bin/zsh`, so macOS is a no-op), then the passwd entry, then zsh/bash/sh. It **rejects fish** — the caller builds `-c "<bin> '<arg>'"` with POSIX escaping that fish cannot parse — and **rejects nologin**, which would make every tab exit instantly with no output. `sh` is the floor and gets no `-l`. Those are the only two PATH channels, and they are separate: the daemon finds binaries with `resolveBinary()`, while an **agent's own** PATH comes from that login shell and from nothing else (#630). The daemon's PATH is not a way to reach an agent — a login shell *rewrites* it (Debian's `/etc/profile` assigns `PATH=` outright; macOS's `path_helper` demotes inherited entries).
- **`engines/tmux.js` takes `opts.shellCommand`, two-way since #630** (`null` = no command at all, so tmux forks `default-shell` as its own login shell; `undefined` = exec `[cmd, ...args]` directly. A **string throws** — that arm ran the command through a *non-login* shell and is what dropped the login flag; see [terminal-engines.md](terminal-engines.md).) It replaced a `cmd === 'zsh'` shape match that silently stopped matching the moment the spawn passed an absolute path or bash, nesting a shell inside every session — which would still mostly *work*, hence `test/unit/tmux-spawn-args.test.js` pinning the exact `tmux new-session` argv.
- **`test/Dockerfile` installs no zsh, on purpose.** Root's passwd shell in `node:22-bookworm` is `/bin/bash`, so the whole integration suite is the regression test for the login-shell resolver. Re-adding zsh would make it blind to a zsh dependency creeping back — the same trick #619 used with the bare unit runner.
- **`sleep-watch.js` is deliberately NOT gated to darwin**, despite #621 asking. It spawns nothing and calls no platform API (two `Date.now()` calls on an unref'd 5s timer), while Linux laptops suspend, hypervisors pause guests for live migration, and containers get cgroup-frozen — all producing the same discontinuity, and without it `armDetachReap()` reaps live sessions whose browsers froze at the same moment. It takes a `platform` param for API symmetry and reports `isPlatformRelevant()`, but three tests assert the tick still runs on Linux so a future gate has to argue with them. Contrast `power-assertion.js`, which *is* gated because `caffeinate` is a macOS binary.
- **Still macOS-only, deliberately**: `getForegroundCommand()` returns null off darwin (procps' `-g` selects by *session*, not process group, so it is a semantics difference and needs a `/proc` walk, not a path swap), and there is no Linux sleep inhibitor to match `caffeinate`.
## The npm channel (#636)

`npm install -g deepsteve` puts the runtime tree in npm's global `node_modules`, and `bin/deepsteve.js` is the CLI that turns that into a running install: `start`, `stop`, `restart`, `status`, `uninstall`. It is `install.sh` minus the heredocs — same deploy target, same `service.sh` verbs, same MCP registration, same `.install-source.json` stamp.

- **`start` deploy-copies into `~/.deepsteve`; it does not run the package in place.** Three independent reasons, any one of which is sufficient: `server.js` mounts `express.static('public')` and `express.static('mods')` **cwd-relative**; `MODS_DIR`/`SKILLS_DIR` are `__dirname`-relative and are *written* at runtime (mod install extracts a tarball into `MODS_DIR/<id>`); and a global prefix is often root-owned and is wiped by `npm update`. Mods also resolve core modules as `../../<mod>`, so the tree has to stay shaped the way `~/.deepsteve` is shaped. Upgrading is `npm install -g deepsteve@latest && deepsteve start`, and that second command is what re-deploys.
- **`node_modules` is copied from the package, not reinstalled.** `npm install -g` already resolved and built the graph, so `deepsteve start` needs no network and no compiler — which matters on Linux, where node-pty has no prebuilds and would otherwise want node-gyp. The copy prefers a CoW clone (`cp -Rc` / `--reflink=auto`) and is skipped when the deployed `package.json.prev` is unchanged, the same short-circuit `restart.sh` uses.
- **`restart` is not a second unguarded restart path.** It runs the same handshake `./restart.sh` does — `POST /api/request-restart` and the in-browser confirm, or the two-step `--force` / `--prompt` echo that re-validates the server-owned session count. A CLI verb that just called `ds_service_stop`/`ds_service_start` would work perfectly and silently delete the guarantee that a restart is never unilateral. `test/unit/npm-package.test.js` pins it, along with the rule that the CLI never names `launchctl`, `systemctl`, or any plist/unit key — the service definition belongs to `service.sh` alone.
- **`ds_service_write` runs only when no definition exists.** It emits `DS_DEFAULT_PORT` rather than reading `ds_port` (`service.sh:293`), so rewriting an existing definition would silently reset a custom port. The deployed node is `ds_node_path`'s answer, which still prefers a node already recorded in the definition; the CLI only prepends its own `process.execPath` dir to `PATH` so the fresh-install fallback resolves.
- **npm installs have no in-app auto-update, deliberately.** `.install-source.json` carries `type: "npm"`, and `INSTALL_SOURCE_TYPES` in `server.js` is what makes that a recognized value rather than `unknown`. Both apply paths refuse a mismatched type, so the stamp is protective: without it `applyCurlReinstall` would overwrite an npm install with a curl payload and rewrite the marker to `curl`. Settings → Updates shows "npm (global)" and a disabled button carrying the command.
- **The tarball is an allowlist, and the allowlist is tested.** `package.json`'s `files` ships the root `*.js` glob plus `engines/`, `public/`, `mods/`, `skills/`, `themes/`, `bin/`, and the three shell files — with `!skills/release.md`, because `release.sh`'s `maintainer: true` filter governs only `install.sh`. `test/unit/npm-package.test.js` checks coverage against the tree; `test/Dockerfile.npm` and `.github/workflows/npm-package.yml` check the real `npm pack` output. Publishing is a maintainer step in [RELEASING.md](../RELEASING.md) — `"private": true` stays in `package.json` between releases because an npm version, once published, can never be corrected in place.

## Logs

`./status.sh` prints the right directory for this machine; `~/Library/Logs/deepsteve.log` on
macOS, `~/.local/share/deepsteve/logs/deepsteve.log` on Linux. Lines are timestamped in local
time (ISO-8601 with offset), and the daemon rotates both files itself at 10MB — the previous
generation is kept next to them as `deepsteve.log.1` / `deepsteve.error.log.1` (`logging.js`,
#557; it works through the O_APPEND fd launchd or systemd's `append:` handed us, so no
service-definition change is involved). Since #621 the service definition passes
`DEEPSTEVE_LOG_DIR` explicitly, so the platform table in `paths.js` is only a fallback for
installs that predate it.

## Cold start: boot marks and browser auto-open (#665)

Three `[startup]` lines, each stamped with `process.uptime()`, split a slow boot into legs
you can attribute without reconstructing it from `ps -o lstart` afterwards: **first log
line** (everything before it is exec + dyld + cold page-ins, ~11s on a post-reboot start,
against a ~30ms warm require graph), **HTTP listening** (deepsteve's own startup), and
**first browser window connected**. A measured reboot broke down as 39s of launchd
scheduling at login, 11.4s of page-ins, 3.0s of our startup, and 5.3s of the last leg.

That last leg is the daemon's own doing. When nothing is connected shortly after
`app.listen`, the daemon opens the UI itself (`openBrowserUrl`), and it holds off first so
that a browser which *already* has a page loaded can reconnect on its own instead of being
buried under a phantom second tab. Three things decide how long it waits:

- The wait is skipped entirely on a `./restart.sh` (the `.restarting` flag) and in test mode.
- `AUTO_OPEN_GRACE_MS` (3s; `DEEPSTEVE_AUTO_OPEN_GRACE_MS`) is the hold-off for the case it
  actually protects — a crash respawn under `KeepAlive` / `Restart=always`, where a live
  browser is sitting in `public/js/server-probe.js`'s `/healthz` loop. It must out-wait that
  loop's worst-case gap between probes (`MAX_DELAY_MS` plus jitter), or the guard loses its
  own race; when both constants were 5s it did exactly that, by ~300ms. `test/unit/server-probe.test.js`
  pins the relationship, so raising either one alone fails the build.
- `AUTO_OPEN_BOOT_WINDOW_S` (300s; `DEEPSTEVE_AUTO_OPEN_BOOT_WINDOW_S`) drops the hold-off to
  zero when `os.uptime()` says the machine only just booted. No earlier daemon was listening,
  so the restored tab's navigation was refused and there is no page of ours running to
  reconnect — the wait is pure dead time on the slowest path we have. A daemon crash inside
  that window costs at worst one extra tab.

### The restart leg, and why the page has to report it

`AUTO_OPEN_GRACE_MS` covers a crash respawn. A `./restart.sh` skips auto-open entirely, so on
that path a browser reconnecting on its own is the *only* way the UI comes back. On 2026-08-31
a restart had **HTTP listening at +0.4s and the first browser window at +59.4s** — a gap the
marks could bound but not explain, because the only page that could explain it was replaced by
the reload it had been waiting for. Two things close that:

- **The probe is time-bounded.** `serverUp()` gives its `/healthz` fetch an
  `AbortSignal.timeout` (`PROBE_TIMEOUT_MS`, 5s). `fetch` has no default timeout and `inFlight`
  is shared by every reconnect loop in the window, so a single request that never settled used
  to park all of them on the same dead promise — and `kickProbes()` could not dig them out,
  because it resolves the sleep and the next call hands back that very promise. The timeout has
  to stay *above* `MAX_DELAY_MS` (pinned by the same unit test): `/healthz` shares the WS
  server's event loop, and a boot that blocks it for a moment should make the page wait, not
  abort every probe and never pass the gate.
- **The page reports its own wait.** `live-reload.js` stashes a trace in `sessionStorage` just
  before it navigates; the page that navigation produces beacons it over the client-log socket,
  where it lands in the daemon log next to the marks:

  ```
  [client win-a9vqzn5b] reload-timing: gate 1300ms (4 probe(s), slowest 2ms) + nav 421ms + boot 12ms
  ```

  The split is the diagnosis. A large **gate** reached in few probes is throttled timers — a
  hidden tab ticks roughly once a minute, which is why `hidden` is recorded at all. A large gate
  with a large **slowest** is a probe that hung. A large **nav** is the navigation itself, and
  exonerates the loop entirely.

## Security

DeepSteve is **localhost-first with token authentication** (#536). The server binds to `127.0.0.1` by default (overridable with `--bind`). Every surface — the web UI WebSocket, the MCP HTTP endpoint, and all REST/control endpoints — is guarded *before* application code runs by three checks that live in `security.js`:

- **Host allowlist** — rejects any request/WS upgrade whose `Host` hostname isn't `localhost`/`127.0.0.1`/`[::1]`/`deepsteve.localhost` (or a `--allow-host` you add). This is what actually stops DNS rebinding (the rebind domain shows up in `Host`).
- **Origin allowlist** — rejects WS upgrades (and cross-origin cookie-authed HTTP) from any origin but our own (or a `--allow-origin` you add), and rejects a **missing** `Origin` on the WS upgrade. CORS is *not* a substitute — it doesn't protect WebSockets at all.
- **Per-install token** — auto-generated at `~/.deepsteve/auth-token` (mode `0600`). The browser receives it as an HttpOnly, SameSite=Strict cookie set on the page it loads (persistent, 30-day rolling `Max-Age`, re-issued on every page load — #545), so there's no login screen. Non-browser clients (agents, MCP, `restart.sh`) send it as `Authorization: Bearer <token>`; agents read it from `DEEPSTEVE_API_TOKEN`, and the per-session MCP config carries it in a header (written to a `0600` file, never inline in argv). Failed auth attempts are rate-limited; valid credentials never throttle.

**The canonical browser URL is `http://deepsteve.localhost:3000`** (`UI_HOST`/`UI_URL`, #544/#545). Plain `localhost` shares one browser cookie jar with every other local dev app (cookies key on host, not port), and Firefox's per-host cap evicts the auth cookie when that jar fills — the #544 intermittent-401 bug. `deepsteve.localhost` is still loopback (RFC 6761) but gets its own jar, and makes other localhost apps cross-site so SameSite=Strict excludes them. `canonicalHostRedirect` (`security.js`) 302s browser navigations (`GET` + `Accept: text/html`, no `Authorization` header) on `localhost`/`127.0.0.1`/`::1` to `deepsteve.localhost`, preserving the original port (SSH tunnels) and never touching `--allow-host`/LAN hosts; disable with `--no-canonical-redirect` or `DEEPSTEVE_NO_CANONICAL_REDIRECT=1`. Agent/CLI traffic (`DEEPSTEVE_API_URL`, MCP config, `restart.sh` curls) deliberately stays on plain `localhost` — bearer-authed, no cookies, and must not depend on `*.localhost` resolving for non-browser resolvers. Migrating an existing install moves the UI to a new origin, so open windows lose per-origin localStorage/sessionStorage (window layout, window→session maps) once — server-side sessions are unaffected; recover tabs via recent-sessions restore.

**The cookie's name carries our listen port** — `ds_auth_3000`, computed per instance in `createSecurity` (#675). The `deepsteve.localhost` jar is per-host, and cookies ignore ports, so a *second* DeepSteve on the same machine — an isolated test daemon on 3999 with its own `auth-token` — used to overwrite the real install's cookie the moment anything in the browser visited it. `canonicalHostRedirect` preserves the original port, so the stray daemon lands on `deepsteve.localhost` too. Every open tab then 401s on every fetch, holding a cookie no page load of its own will refresh: 1,643 rejections over 25+ minutes, through a restart and a reload. Qualified names let the two coexist. The unqualified `ds_auth` is still *read* as a fallback so tabs open across the upgrade keep working; drop that a release later. Never `clearCookie('ds_auth')` as a migration — it would delete the sibling daemon's cookie, which is the bug inverted.

**A 401 heals from the fetch path, not just from a dropped socket.** `maybeHealAuth()` (`public/js/auth-heal.js`) used to be reachable only from the two WebSocket reconnect loops, so a realm whose socket was fine — or which holds none — polled 401s forever. The `window.fetch` wrapper in `public/js/client-log.js` now calls it on any 401/429 from `/api/*`, keeping the 2s probe cooldown and the 60s sessionStorage one-shot so a genuinely unauthorized page cannot reload-loop. `/api/proxy` is excluded (it passes an upstream status through, which says nothing about our cookie) and so is `/api/client-log` (a beacon that reports its own failures feeds itself).

**Every same-origin realm gets that wrapper, not just the shell.** Mod iframes, display tabs and project-mod pages each have their own `window.fetch`; the shell wraps them from the parent at the same `load`-time reach that injects the `window.deepsteve` bridge (`mod-manager.js`'s `_injectBridgeAPI`, plus `createDisplayTab` in `app.js`). Beacon entries carry a realm tag, so the daemon log reads `[client <windowId> mod:workshop] fetch-401: …`. This is what #675 lacked — the workshop iframe made 660 rejected requests and left no client-side trace at all.

**The beacon has an HTTP fallback: `POST /api/client-log`.** Its primary transport is still the live-reload WebSocket, but a realm can be in exactly the state worth reporting with no socket at all. It is mounted **above** `authGate` — it reports "our cookie is broken", so it cannot require the cookie — and is gated instead by `hostGuard` plus a **mandatory** allowlisted `Origin` (`requireAllowedOrigin`), an 8 KB body, ≤25 entries, control characters stripped, and its own rate limiter. Origin is not authentication; it is what keeps other origins and other local ports out. `test/unit/auth-exempt-routes.test.js` pins the exempt set to exactly this route plus `GET /healthz` and the static handlers.

**Repeated rejections collapse by cause.** `logAuthReject` keys on method + path + reason, with query strings and id-shaped path segments folded away, logs a cause's first sighting immediately, and emits one `… ×N in 60s` rollup per key per window off an `unref()`d timer. The previous throttle spent a single global budget of 5 lines per 10s, which a 2s poller never exhausted — hence 541 identical lines. Host and Origin rejections, and WebSocket upgrade rejections, all share the `Auth: rejected` prefix now: they used to read `Rejected WS upgrade: …`, so a grep for `Auth: rejected` found every HTTP rejection and no WS one, which is how #675 read the log as having zero rejected upgrades when one is what ended the storm.

Auth is **always on** with no off switch — the only escape hatches *widen* the allowlists (`--allow-origin`, `--allow-host`, or `DEEPSTEVE_ALLOW_ORIGIN`/`DEEPSTEVE_ALLOW_HOST`). Binding to a non-loopback address (`--bind`) no longer hands the token out: `setAuthCookie` issues the cookie on **loopback page loads only**, so a LAN browser cannot just open the UI and must send `Authorization: Bearer` itself (before that scope existed, any unauthenticated client on an allowlisted non-loopback host was given the real token and could drive the whole API). The token is still one shared per-install secret rather than a per-user credential, so anyone who obtains it has full control. **The deploy that first turns auth on must use `./restart.sh --refresh`** so already-open tabs reload and acquire the cookie (a silent WebSocket reconnect has none yet). Tabs running post-#540 frontend also **self-heal**: when a WS upgrade is rejected for auth, the reconnect loops probe `/api/version` (`public/js/auth-heal.js`) and, on a 401/429, force one guarded page reload to re-acquire the cookie — but tabs still running pre-#540 JS can't, so that first deploy still needs `--refresh`.

## HTTPS

Opt-in via `--https` flag or `DEEPSTEVE_HTTPS=1`. Runs a second server on port 3443 (configurable via `--https-port` or `DEEPSTEVE_HTTPS_PORT`). HTTP and HTTPS run simultaneously — HTTP for localhost, HTTPS for LAN/Quest. Certs auto-generated at startup using `mkcert` (if available) or `selfsigned` package. Certs regenerate when LAN IPs change. MCP stays HTTP-only (localhost, avoids self-signed cert issues with SDK).

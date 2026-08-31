# Remote instances — reaching a deepsteve on another machine

**Status: this page documents the manual sanity check, not the intended way to use remotes.**

The direction is federation: sessions from every machine appear in **one** browser tab, served by
your local daemon, which owns the transport to each remote and proxies to it. Under that design a
remote's port is an internal detail the daemon picks and nobody ever types. The direct-connect
recipe below exists to prove the unglamorous half works — agent credentials on a box you don't
own, linger, a tab that spawns and survives — before any proxy code is written. Expect to do it
once and throw it away. See the tracking issue for the staged plan.

The transport is deliberately provider-agnostic: a remote is an SSH target. DigitalOcean is where
this was first exercised, and nothing here depends on it.

## Why a tunnel, and not `--bind`

`--bind 0.0.0.0` does not give you a usable remote UI, and no combination of `--allow-host` /
`--allow-origin` changes that. `setAuthCookie` (security.js) issues the auth token **only on a
loopback Host**, and the WebSocket upgrade guard accepts the cookie and nothing else — bearer
auth is for MCP/CLI clients, which is why a LAN browser loads the static page and then 401s on
every fetch forever. That handout restriction is not incidental: it runs ahead of `authGate`, so
without it any client that could reach an allowlisted non-loopback host would be *given* the
per-install token in a `Set-Cookie`.

So the browser must reach the remote daemon over **loopback on the machine the browser is on**.
Every reasonable transport already ends that way — `ssh -L`, Tailscale + ssh, `cloudflared
access tcp`, WireGuard. Pick on operational grounds; deepsteve cannot tell them apart.

## The port rule

**The forwarded local port must equal the remote daemon's `PORT`, and must differ from the port
of any deepsteve already installed on your laptop.**

This rule is an artifact of connecting the browser **directly** to the remote daemon, and it is the
main reason that shape is a dead end rather than a product: it makes the user hold a constraint the
system should hold. Federation removes it — the browser only ever talks to the local daemon, so the
two mechanisms below never see a second origin. Two of them require it here:

- **The Origin allowlist is port-qualified** (`http://${host}:${port}`, security.js). The browser
  sends `Origin: http://deepsteve.localhost:<local forwarded port>`; the remote compares it against
  its own listen port. A mismatch fails the WS upgrade with `Origin not allowed` — the page loads,
  no terminal ever appears.
- **The auth cookie's name is port-qualified** (`ds_auth_3001`). Cookies key on host, not port, so
  both installs share the one `deepsteve.localhost` jar. Equal ports on the two machines means one
  name, and the second install silently overwrites the first install's cookie — every open tab then
  401s with a cookie it can never refresh (#675). Distinct ports is what lets them coexist.

`canonicalHostRedirect` preserves the **original** port on the bounce to `deepsteve.localhost`
(security.js), and `*.localhost` resolves on the browser's machine — so the redirect, the cookie
and the WS handshake all work through a tunnel with no configuration.

## Setting up the remote

Assuming your laptop's install owns 3000, give the remote 3001.

```bash
# on the remote box
sudo apt-get install -y tmux            # the default engine; without it sessions are perishable
npm install -g deepsteve
deepsteve start                          # deploys to ~/.deepsteve, writes the systemd user unit
```

`ds_service_write` emits `DS_DEFAULT_PORT` and runs **only when no definition exists**
(service.sh), so a custom port is a one-time edit of the unit it just wrote:

```bash
sed -i 's/^Environment=PORT=.*/Environment=PORT=3001/' ~/.config/systemd/user/deepsteve.service
systemctl --user daemon-reload && systemctl --user restart deepsteve
loginctl enable-linger "$USER"           # or DEEPSTEVE_ENABLE_LINGER=1 before `deepsteve start`
deepsteve status
```

**`enable-linger` is not optional here.** The installer advises it and never runs it (its polkit
action prompts on a remote session), but without it the systemd *user* instance dies the moment
your provisioning SSH disconnects — install, log out, daemon gone.

Two harmless log lines to expect on a headless box: `No URL opener found (open/xdg-open) — open
… yourself` at every boot, and the fallback-engine badge if tmux is missing.

The agent itself is a separate concern — nothing in deepsteve authenticates one. `getSpawnArgs`
execs `codex`/`claude` and inherits whatever credentials that user has, so install the agent and
log it in over SSH before expecting a tab to work, and give the box its own git credentials for
any private clone. Enable it in Settings → Agents on the remote (`enabledAgents`).

## The tunnel

```bash
ssh -N -L 3001:localhost:3001 <host>
open http://deepsteve.localhost:3001
```

Put Tailscale on the box and `<host>` becomes a stable name with no inbound port open and no IP
churn. SSH key auth is then the outer layer, and deepsteve's per-install token the inner one —
neither is exposed to the network.

For something long-lived, run the forward under a supervisor with `ServerAliveInterval` set
rather than leaving a terminal open; the browser's own reconnect handles the gaps.

## Keep the projects disjoint

Two Tier-0 daemons share **no** state — `state.json`, the `shells` map, tmux, recent-sessions
and the coordination locks are all per-daemon, and nothing links them. The only state both can
see is a git host, so that is the only place a collision can happen: two agents filing the same
issue, or both starting work on one.

The cheap answer is partition. `skills/github-issue.md` goes straight to `gh issue create` with
no lookup, and the repo it lands in is whatever the agent's cwd resolves to — so keeping the two
machines' checkouts disjoint (Contexts on each side; `project-scope.js` is the one resolver for
"which project is this") makes the collision unrepresentable rather than unlikely. Only if the
same repo is genuinely worked from both boxes does it need a real guard, and that guard belongs
at the `gh` boundary: search-before-file in the skill, and a claim label checked in
`startIssueSession` — the single funnel all three start-issue surfaces go through (#642).

## When it doesn't work

| Symptom | Cause |
|---|---|
| Page loads, terminal never appears, remote log says `Origin not allowed` | Forwarded port ≠ remote `PORT` |
| Every tab 401s on the *laptop's own* install after opening the remote | Both installs on the same port — one cookie name, mutually overwritten |
| `Forbidden: Host not allowed` | Reached the daemon by an address that isn't loopback or an `--allow-host`; the tunnel isn't in the path |
| Works until the SSH session ends, then nothing | Linger not enabled on the remote |
| UI works, agent tab exits ~1s after spawning | The agent binary or its credentials are missing on the remote |

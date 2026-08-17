# Versions

## Installing

```bash
npm install -g deepsteve
deepsteve start
```

Or, without npm:

```bash
curl -fsSL deepsteve.com/install.sh | bash
```

## Updating

The settings modal shows when a new version is available — it checks the latest GitHub release, which both channels are cut from. **Settings → Updates also says which channel this install came from**, because updating differs between them:

| Installed via | Update with |
|---|---|
| npm | `npm install -g deepsteve@latest && deepsteve start` |
| curl | re-run the one-liner above — it overwrites `~/.deepsteve/` and restarts the daemon |
| git checkout | the Updates panel's **Pull and restart** button, or `git pull && ./restart.sh` |

An npm install deliberately gets no in-app update button: the package lives in a prefix deepsteve may not own, so the panel shows you the command instead of offering an action it cannot complete. Either way your sessions survive — they live in tmux, not in the daemon.

## Cutting a Release (maintainers)

See [RELEASING.md](RELEASING.md). It is the authoritative list — bump, push, generate the installer, tag, publish to npm, revendor the demo — and the `/deepsteve:release` skill executes it step for step. Don't work from a summary; the steps have guards in them (the `package-lock.json` version check, the npm immutability bracket) that a summary loses.

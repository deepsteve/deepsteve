# Versions

## Installing

```bash
curl -fsSL https://github.com/deepsteve/deepsteve/releases/latest/download/install.sh | bash
```

## Updating

The settings modal shows when a new version is available (checks `deepsteve.com/versions/stable`). To update, re-run the install one-liner — it overwrites `~/.deepsteve/` and restarts the daemon.

## Cutting a Release (maintainers)

1. Bump the version in `package.json` and `install.sh`
2. Update `deepsteve.com/versions/stable` to the new version string
3. Create a GitHub release with tag `vX.Y.Z`, attaching `install.sh` as a release asset
4. Push `deepsteve.com` changes so the update check serves the new version

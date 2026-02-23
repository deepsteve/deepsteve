# Versions

## Installing

```bash
curl -fsSL https://github.com/deepsteve/deepsteve/releases/latest/download/install.sh | bash
```

## Updating

The settings modal shows when a new version is available (checks `deepsteve.com/versions/stable`). To update, re-run the install one-liner — it overwrites `~/.deepsteve/` and restarts the daemon.

## Cutting a Release (maintainers)

1. Bump the version in `package.json`
2. Run `./release.sh` to generate `install.sh` from the current source files
3. Update `deepsteve.com/versions/stable` to the new version string
4. Create a GitHub release with tag `vX.Y.Z`, attaching the generated `install.sh` as a release asset
5. Push `deepsteve.com` changes so the update check serves the new version

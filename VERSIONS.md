# Versions

## Installing

```bash
curl -fsSL deepsteve.com/install.sh | bash
```

## Updating

The settings modal shows when a new version is available (checks `deepsteve.com/versions/stable`). To update, re-run the install one-liner — it overwrites `~/.deepsteve/` and restarts the daemon.

## Cutting a Release (maintainers)

1. Bump the version in `package.json`
2. Run `./release.sh` to generate `install.sh` from the current source files
3. Verify the generated installer: diff the embedded `package.json` against the source to confirm dependencies match (`install.sh` is gitignored and goes stale if you forget to regenerate it after changing source files)
4. Update `deepsteve.com/versions/stable` to the new version string
5. Create a GitHub release with tag `vX.Y.Z`, attaching the generated `install.sh` as a release asset
6. Push `deepsteve.com` changes so the update check serves the new version

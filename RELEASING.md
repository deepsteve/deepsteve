# Releasing DeepSteve

1. **Bump the version** in `package.json` (minor bump for features, patch for bugfix-only)
2. **Commit the version bump** — e.g. `git commit -m "Bump version to X.Y.Z"`
3. **Push to main** — `git push`
4. **Generate the installer** — `./release.sh` (validates mods, embeds all source into `install.sh`)
5. **Gather the changelog** — `git log <last-tag>..HEAD --oneline`
6. **Create the GitHub release** — `gh release create vX.Y.Z install.sh --title "vX.Y.Z" --notes "..."` with sections for "What's new", "Bug fixes", "Other"

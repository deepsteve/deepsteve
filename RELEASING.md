# Releasing DeepSteve

The `/deepsteve:release` skill runs all of this for you, but it is **maintainer-only** and
you have to turn it on first. `skills/release.md` carries `maintainer: true` in its
frontmatter, so `release.sh` leaves it out of the generated `install.sh` — nobody who
installed DeepSteve normally has it, and an upgrade deletes it if an older build put it
there. It exists only in a git clone of this repo, and even there it ships disabled like
every other skill: enable it once in **Mods → Skills** before invoking it.

1. **Bump the version** in `package.json` (minor bump for features, patch for bugfix-only)
2. **Commit the version bump** — e.g. `git commit -m "Bump version to X.Y.Z"`
3. **Push to main** — `git push`
4. **Generate the installer** — `./release.sh` (validates mods, embeds all source into `install.sh`)
5. **Gather the changelog** — `git log <last-tag>..HEAD --oneline`
6. **Create the GitHub release** — `gh release create vX.Y.Z install.sh --title "vX.Y.Z" --notes "..."` with sections for "What's new", "Bug fixes", "Other"
7. **Update the public demo** (#584) — in the site repo (`deepsteve.com`): run `tools/revendor-demo.sh vX.Y.Z`, review `git diff demo/`, commit, then `npx wrangler deploy`. The demo is the real frontend vendored at the release tag (`demo/VERSION`); `release.sh` warns on the next release if this step was skipped. Re-generate recordings (`node tools/make-recordings.js`) only if the WS protocol changed.

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
7. **Publish to npm** (#636) — optional, and only ever *after* the tag exists, because
   **npm versions are immutable**: a version cannot be republished even after an unpublish, and
   whatever is uploaded is what `npm install -g deepsteve` serves until a later version supersedes
   it. `"private": true` in `package.json` is the guard that makes this a deliberate act, so the
   publish is a bracket around one command and the guard goes straight back:
   ```bash
   npm pack --dry-run          # sanity-check the file list: no test/, no skills/release.md
   npm run test:npm            # installs the packed tarball globally in a container and boots it
   npm pkg delete private
   npm publish
   git checkout -- package.json         # restore the guard, byte-for-byte
   git diff --exit-code package.json    # must be clean
   ```
   Restore with `git checkout`, not `npm pkg set private=true`: `npm pkg set` appends the key at
   the end of the object instead of putting it back where it was, so the guard returns but the
   file is reformatted.
   Publish only a version that matches the git tag from step 6. If the tarball turns out to be
   broken, the fix is a new patch version, never a re-push.
8. **Update the public demo** (#584) — in the site repo (`deepsteve.com`): run `tools/revendor-demo.sh vX.Y.Z`, review `git diff demo/`, commit, then `npx wrangler deploy`. The demo is the real frontend vendored at the release tag (`demo/VERSION`); `release.sh` warns on the next release if this step was skipped. Re-generate recordings (`node tools/make-recordings.js`) only if the WS protocol changed.

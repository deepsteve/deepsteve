---
name: release
description: Bump the version, run the integration suites on GitHub, and publish a DeepSteve release
argument-hint: [version | major|minor|patch]
---

Cut a DeepSteve release end to end. The argument is either an explicit version (`0.18.2`)
or a bump keyword (`patch`). If the user said something like "a .1 increment", that means
the **minor** digit: `0.17.2` → `0.18.0`. Confirm the resolved number with the user before
tagging if there is any ambiguity — a published tag is annoying to retract.

Convention: **minor** bump for a release containing features, **patch** for bugfix-only.

Do not skip steps. Each one exists because it caught something.

## 1. Preflight

```bash
git fetch origin --tags
git status --short                      # must be clean
git rev-list --left-right --count origin/main...main
git log $(git tag --sort=-v:refname | head -1)..HEAD --oneline --no-merges
```

- Working tree must be clean and you must be on `main`.
- **Local main is often ahead of origin** — merges land locally and go unpushed. Those
  commits ship in this release, so read the full list; the release is not just your bump.
- If anything is still unmerged that the user expects to ship, stop and ask.

## 2. Bump the version

**Always use `npm version` — never hand-edit `package.json`.** It writes `package.json`
*and* both version fields in `package-lock.json` atomically. Hand-editing leaves the lock
behind; `npm ci` tolerates the mismatch, so nothing catches it until the stale lock lands
as noise in an unrelated PR.

```bash
npm version <X.Y.Z> --no-git-tag-version --allow-same-version
git diff --stat        # expect exactly package.json + package-lock.json, 2 lines each
```

`release.sh` hard-fails if the lock has drifted, and `check-installer.yml` runs
`release.sh` on every push to main — so drift breaks CI. Don't work around it; fix the lock.

Commit (match repo convention, including the trailer):

```
Bump version to X.Y.Z

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## 3. Push — this is what triggers the tests

```bash
git push origin main
```

**Ordering is forced:** `integration-tests.yml` and `check-installer.yml` trigger on
*push to main only* — they have no `workflow_dispatch`. So the bump commit must land
before the tests can run. Only the public-install suite can be dispatched by hand:

```bash
gh workflow run install-integration-tests.yml --ref main
```

Pushing to main may report `Bypassed rule violations — Changes must be made through a
pull request`. That is expected for version bumps on this repo (admin bypass); mention it,
don't panic.

## 4. Wait for green — and read the logs, don't trust the checkmark

All three must pass on the bump commit's SHA:

| Workflow | Trigger |
|---|---|
| Check installer | push (runs `./release.sh`, diffs embedded `package.json` vs source) |
| Integration Tests | push (Docker, `npm ci` + node test runner) |
| Public Install Integration Tests | manual dispatch |

```bash
SHA=$(git rev-parse HEAD)
gh run list --limit 4 --json databaseId,name,status,conclusion,headSha,event
gh run view <id> --log | grep -oE "# (pass|fail) [0-9]+" | sort | uniq -c
```

The suites finish in ~2 minutes with warm caches, which looks suspiciously like a no-op.
**Verify every suite reports `# fail 0` and real `ok N -` lines** rather than just reading
the green conclusion. A run that silently skipped its tests also reports success.

Note: the public-install suite installs the **already-published** `install.sh`, so it
validates the *previous* release, not the artifact you are about to build. It is still a
useful signal — just don't describe it as a check on the new build.

## 5. Generate the installer

```bash
./release.sh
```

Validates all mods, then embeds every source file (heredocs; images base64). Confirm:
- `Version: X.Y.Z (latest tag: ..., lock in sync)`
- `All N mods validated successfully.`
- the embedded version matches:

```bash
LC_ALL=C sed -n '/cat > "\$INSTALL_DIR\/package.json"/,/^DEEPSTEVE_FILE_EOF$/{/cat >/d;/^DEEPSTEVE_FILE_EOF$/d;p;}' install.sh | grep '"version"'
```

`install.sh` is **generated, not tracked** — it exists only as the release asset, so the
working tree stays clean after this step.

## 6. Write the notes from the diff

```bash
git log <last-tag>..HEAD --oneline --no-merges
git diff --stat <last-tag>..HEAD
```

Read the actual diff. **Commit and issue titles usually describe the bug symptom, not the
fix** — write what changed for a user. Sections: **What's new** (features), **Bug fixes**,
**Other** (tests/cleanup/themes). Reference issue numbers.

Add an **Upgrade note** for anything that changes a user's environment: a new origin, a
migration, lost local state, or a deploy that needs `./restart.sh --refresh`. Check
`CLAUDE.md` for the documented consequences rather than inferring them.

## 7. Publish and verify

```bash
gh release create vX.Y.Z install.sh --title "vX.Y.Z" --target $(git rev-parse HEAD) --notes "..."
```

Pass `--target` explicitly so the tag lands on the reviewed commit. Then verify — a
release is public the moment it exists:

```bash
gh release view vX.Y.Z --json tagName,isDraft,targetCommitish,assets
curl -fsSL -o /tmp/dl.sh https://github.com/deepsteve/deepsteve/releases/download/vX.Y.Z/install.sh
shasum -a 256 /tmp/dl.sh install.sh    # both hashes must match
```

Confirm `isDraft=false`, the tag points at the bump commit, and the published asset's
SHA-256 matches the local build. Report the release URL to the user.

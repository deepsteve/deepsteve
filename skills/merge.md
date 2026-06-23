---
name: merge
description: Merge the current worktree branch into the main checkout's branch (or a branch you name)
argument-hint: [target-branch]
---

The user wants to merge their current worktree's branch into a **target branch**.

By default the target is the branch currently checked out in the **main worktree** (the primary checkout) — so if you work on a feature branch there, merges follow it automatically instead of always going to `main`. If the user passed a branch name as an argument to `/merge`, that argument is the target instead.

Steps:

1. **Gather state in one shot**: Run this single bash invocation and parse the `key=value` lines from its output. Use the resulting `branch`, `main_path`, `in_worktree`, `detected_target`, and `dirty` values for the rest of the steps.

   ```sh
   common=$(git rev-parse --git-common-dir)
   gitdir=$(git rev-parse --git-dir)
   [ "$(cd "$gitdir" && pwd)" = "$(cd "$common" && pwd)" ] && echo "in_worktree=false" || echo "in_worktree=true"
   echo "branch=$(git branch --show-current)"
   main_path=$(dirname "$(cd "$common" && pwd)")
   echo "main_path=$main_path"
   echo "detected_target=$(git -C "$main_path" branch --show-current)"
   echo "dirty=$(git status --porcelain | wc -l | tr -d ' ')"
   ```

2. **Resolve the target branch**:
   - If the user passed a branch-name argument to `/merge`, `target` = that argument.
   - Otherwise `target` = `detected_target`.
   - If `target` is empty (e.g. the main worktree is on a detached HEAD and no argument was given), ask the user which branch to merge into before continuing.
   - If `target` equals `branch`, you're already on the target — there is nothing to merge. Tell the user and STOP.

3. **Derive the commit subject** (used in steps 4 and 5):
   - If `branch` matches `*github-issue-<n>*`: run `gh issue view <n> --json title -q .title` to fetch the current title. Subject is `<title> (#<n>)`. If `gh` fails, fall back to the next bullet.
   - Otherwise: subject is `Merge <branch> into <target>`.
   - Do NOT include a `Co-Authored-By` trailer.

4. **If `in_worktree=false`**: This is not a worktree session — you're already on the branch in the main checkout, so the worktree merge flow doesn't apply. If `dirty>0`, run `git add -A && git commit -m "<subject>" && git push` in a single bash invocation. If `dirty=0`, run `git push`. Then stop (skip all remaining steps).

5. **Auto-commit dirty changes (worktree path)**: If `dirty>0`, run `git add -A && git commit -m "<subject>"`.

6. **Locate the merge directory** (`merge_dir` — the worktree where `target` is checked out; merges always run against the worktree that has the branch checked out):
   - If `target` equals `detected_target`: `merge_dir` = `main_path` (the common case).
   - Otherwise, find which worktree holds `target`:
     ```sh
     git worktree list --porcelain | awk -v t="refs/heads/<target>" '/^worktree /{wt=$2} /^branch /{if($2==t){print wt; exit}}'
     ```
     - If it prints a path, that's `merge_dir`.
     - If it prints nothing, `target` isn't checked out in any worktree. Verify it exists with `git rev-parse --verify <target>`:
       - If it exists, check it out in the main worktree: `git -C <main_path> checkout <target>` (this fails if the main worktree is dirty — if so, show the error and STOP), then set `merge_dir` = `main_path`. Tell the user you switched the main worktree to `<target>` to perform the merge.
       - If it doesn't exist, tell the user the branch `<target>` wasn't found and STOP.

7. **Check the target checkout, then merge**:
   - First confirm the target checkout isn't dirty: run `git -C <merge_dir> status --porcelain`. If it prints any lines, the **target** checkout at `<merge_dir>` has uncommitted changes that `git merge` will refuse to overwrite (it aborts pre-flight, leaving `<target>` untouched). STOP and tell the user: the target checkout — `<merge_dir>`, **not** the current worktree — has uncommitted changes; they should commit or stash them *in that checkout*, then re-run `/merge`. Do NOT auto-commit, stash, or rebase their changes yourself — that WIP is separate work in the main checkout.
   - Otherwise, run `git -C <merge_dir> merge <branch> --no-edit` to merge the worktree branch into `<target>` from the directory that has it checked out. Do NOT use `git checkout <target>` in the current worktree — it is checked out in `<merge_dir>`.

8. **Handle the result**:
   - **Success**: Tell the user the branch was successfully merged into `<target>`. Show the merge output. Then continue to steps 9 and 10.
   - **Conflict**: Run `git -C <merge_dir> merge --abort` to leave `<target>` clean. Then rebase the worktree branch onto the target (`git rebase <target>`), resolve any conflicts, and retry the merge from step 7. If the rebase itself fails with conflicts you cannot resolve, abort the rebase (`git rebase --abort`), tell the user, and STOP.
   - **Local changes in the target** (`error: Your local changes ... would be overwritten by merge`, with no merge actually started — no `MERGE_HEAD`): the step-7 guard should have caught this, but if it slips through, handle it the same way — STOP and tell the user to commit or stash WIP in `<merge_dir>`, then re-run `/merge`. Do NOT run `git merge --abort` (there is no merge in progress) or rebase — this is **not** a Conflict, and rebasing the branch can't fix a dirty target.
   - **Other failure**: Show the error output to the user. STOP here — do not proceed to steps 9 or 10.

9. **Close the GitHub issue** (success only): If `branch` matches `*github-issue-<n>*`, run `gh issue close <n> --comment "Merged into <target>."`. Otherwise skip silently.

10. **Close this terminal** (success only): Call `mcp__deepsteve__close_session` with no arguments — it auto-detects the calling session.

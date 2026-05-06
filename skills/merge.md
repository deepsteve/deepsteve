---
name: merge
description: Merge the current worktree branch into main
---

The user wants to merge their current worktree's branch into the `main` branch.

Steps:

1. **Gather state in one shot**: Run this single bash invocation and parse the four `key=value` lines from its output. Use the resulting `branch`, `main_path`, `in_worktree`, and `dirty` values for the rest of the steps.

   ```sh
   common=$(git rev-parse --git-common-dir)
   gitdir=$(git rev-parse --git-dir)
   [ "$(cd "$gitdir" && pwd)" = "$(cd "$common" && pwd)" ] && echo "in_worktree=false" || echo "in_worktree=true"
   echo "branch=$(git branch --show-current)"
   echo "main_path=$(dirname "$(cd "$common" && pwd)")"
   echo "dirty=$(git status --porcelain | wc -l | tr -d ' ')"
   ```

2. **Derive the commit subject** (used in steps 3 and 4):
   - If `branch` matches `*github-issue-<n>*`: run `gh issue view <n> --json title -q .title` to fetch the current title. Subject is `<title> (#<n>)`. If `gh` fails, fall back to the next bullet.
   - Otherwise: subject is `Merge <branch> into main`.
   - Do NOT include a `Co-Authored-By` trailer.

3. **If `in_worktree=false`**: This is not a worktree session. If `dirty>0`, run `git add -A && git commit -m "<subject>" && git push` in a single bash invocation. If `dirty=0`, run `git push`. Then stop (skip all remaining steps).

4. **Auto-commit dirty changes (worktree path)**: If `dirty>0`, run `git add -A && git commit -m "<subject>"`.

5. **Merge**: Run `git -C <main_path> merge <branch> --no-edit` to merge the worktree branch into main from the main worktree's directory. Do NOT use `git checkout main` — main is checked out in a different worktree.

6. **Handle the result**:
   - **Success**: Tell the user the branch was successfully merged into main. Show the merge output. Then continue to steps 7 and 8.
   - **Conflict**: Run `git -C <main_path> merge --abort` to leave main clean. Then rebase the worktree branch onto main (`git rebase main`), resolve any conflicts, and retry the merge from step 5. If the rebase itself fails with conflicts you cannot resolve, abort the rebase (`git rebase --abort`), tell the user, and STOP.
   - **Other failure**: Show the error output to the user. STOP here — do not proceed to steps 7 or 8.

7. **Close the GitHub issue** (success only): If `branch` matches `*github-issue-<n>*`, run `gh issue close <n> --comment "Merged into main."`. Otherwise skip silently.

8. **Close this terminal** (success only): Call `mcp__deepsteve__close_session` with no arguments — it auto-detects the calling session.

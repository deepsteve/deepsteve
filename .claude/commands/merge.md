---
description: Merge the current worktree branch into main
---

The user wants to merge their current worktree's branch into the `main` branch.

Steps:

1. **Detect if in a worktree**: Run `git rev-parse --git-common-dir` and `git rev-parse --git-dir` and compare their resolved absolute paths. If they resolve to the same directory, you are NOT in a worktree — tell the user: "Not in a worktree — /merge only works from a worktree session." and stop.

2. **Get the current branch name**: Run `git branch --show-current`.

3. **Find the main worktree path**: Run `git worktree list --porcelain` and parse the output to find the worktree entry whose `branch` line is `branch refs/heads/main`. Extract its `worktree` path. If no worktree has `main` checked out, tell the user and stop.

4. **Check for uncommitted changes**: Run `git status --porcelain` in the current worktree. If there are uncommitted changes, warn the user and stop — ask them to commit or stash first.

5. **Merge**: Run `git -C <main-worktree-path> merge <branch-name> --no-edit` to merge the worktree branch into main from the main worktree's directory. Do NOT use `git checkout main` — main is checked out in a different worktree.

6. **Handle the result**:
   - **Success**: Tell the user the branch was successfully merged into main. Show the merge output.
   - **Conflict**: Show the user the conflict output. Run `git -C <main-worktree-path> merge --abort` to abort and leave main clean. Tell the user the merge was aborted due to conflicts and they need to resolve them manually.
   - **Other failure**: Show the error output to the user.

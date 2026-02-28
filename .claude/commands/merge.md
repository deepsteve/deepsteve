---
description: Merge the current worktree branch into main
---

The user wants to merge their current worktree's branch into the `main` branch.

Steps:

1. **Detect if in a worktree**: Run `git rev-parse --git-common-dir` and `git rev-parse --git-dir` and compare their resolved absolute paths. If they resolve to the same directory, you are NOT in a worktree — tell the user: "Not in a worktree — /merge only works from a worktree session." and stop.

2. **Get the current branch name**: Run `git branch --show-current`.

3. **Find the main worktree path**: Run `git worktree list --porcelain | awk '/^worktree /{path=substr($0,10)} /^branch refs\/heads\/main$/{print path}'` — this outputs exactly one line: the path of the worktree with `main` checked out. If the output is empty, tell the user no worktree has `main` checked out and stop.

4. **Commit uncommitted changes**: Run `git status --porcelain` in the current worktree. If there are uncommitted changes, commit them using `/commit` before proceeding.

5. **Merge**: Run `git -C <main-worktree-path> merge <branch-name> --no-edit` to merge the worktree branch into main from the main worktree's directory. Do NOT use `git checkout main` — main is checked out in a different worktree.

6. **Handle the result**:
   - **Success**: Tell the user the branch was successfully merged into main. Show the merge output.
   - **Conflict**: Show the user the conflict output. Run `git -C <main-worktree-path> merge --abort` to abort and leave main clean. Tell the user the merge was aborted due to conflicts and they need to resolve them manually.
   - **Other failure**: Show the error output to the user.

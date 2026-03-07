---
description: Merge the current worktree branch into main
---

The user wants to merge their current worktree's branch into the `main` branch.

Steps:

1. **Detect if in a worktree**: Run `git rev-parse --git-common-dir` and `git rev-parse --git-dir` and compare their resolved absolute paths. If they resolve to the same directory, you are NOT in a worktree — tell the user: "Not in a worktree — /merge only works from a worktree session." and stop.

2. **Get the current branch name**: Run `git branch --show-current`.

3. **Find the main worktree path**: Run `git worktree list --porcelain | awk '/^worktree /{path=substr($0,10)} /^branch refs\/heads\/main$/{print path}'` — this outputs exactly one line: the path of the worktree with `main` checked out. If the output is empty, tell the user no worktree has `main` checked out and stop.

4. **Commit any uncommitted changes**: Run `git status --porcelain` in the current worktree. If there are uncommitted changes, stage them with `git add -A` and commit with a message derived from the branch name (e.g. for branch `worktree-github-issue-230`, use "Fix restart prompt only shows in active window (#230)"). Use the GitHub issue title if the branch contains an issue number. Include the `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` trailer.

5. **Merge**: Run `git -C <main-worktree-path> merge <branch-name> --no-edit` to merge the worktree branch into main from the main worktree's directory. Do NOT use `git checkout main` — main is checked out in a different worktree.

6. **Handle the result**:
   - **Success**: Tell the user the branch was successfully merged into main. Show the merge output. Then continue to steps 7 and 8.
   - **Conflict**: Run `git -C <main-worktree-path> merge --abort` to leave main clean. Then rebase the worktree branch onto main (`git rebase main`), resolve any conflicts, and retry the merge from step 5. If the rebase itself fails with conflicts you cannot resolve, abort the rebase (`git rebase --abort`), tell the user, and STOP.
   - **Other failure**: Show the error output to the user. STOP here — do not proceed to steps 7 or 8.

7. **Close the GitHub issue** (success only): Extract the issue number from the branch name obtained in step 2. If the branch name matches the pattern `*github-issue-<number>*`, run `gh issue close <number> --comment "Merged into main."`. If the branch name doesn't match this pattern, skip this step silently.

8. **Add a testing task** (success only): Use the `mcp__deepsteve__add_task` tool to create a task for the human to manually test the change. The title should be short, e.g. "Test: <feature/fix summary>". The description should contain clear, actionable steps to verify the change works, written as a numbered list. Set priority to "medium" (or "high" if the change is risky or touches core functionality). Set `session_tag` to the branch name from step 2. Example description format:
   ```
   1. Open deepsteve and do X
   2. Verify Y happens
   3. Try edge case Z
   ```

9. **Close this terminal** (success only): Run `curl -s -X POST http://localhost:3000/api/shells/$DEEPSTEVE_SESSION_ID/close`. This must be the absolute last step — the session terminates after this.

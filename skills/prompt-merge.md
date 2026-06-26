---
name: prompt-merge
description: Signal that worktree work is finished and offer to merge
---

The user (or you, the agent) has decided this worktree's work is complete. Surface a clean
handoff: summarize what was accomplished and ask whether to merge. **On "yes"**, hand off to
the `/deepsteve:merge` skill. **On "no"**, stop cleanly and leave the worktree intact.

## Procedure

1. **Confirm this is a worktree session.** Run this single bash invocation and parse the
   `key=value` lines:

   ```sh
   common=$(git rev-parse --git-common-dir)
   gitdir=$(git rev-parse --git-dir)
   [ "$(cd "$gitdir" && pwd)" = "$(cd "$common" && pwd)" ] && echo "in_worktree=false" || echo "in_worktree=true"
   echo "branch=$(git branch --show-current)"
   main_path=$(dirname "$(cd "$common" && pwd)")
   echo "detected_target=$(git -C "$main_path" branch --show-current)"
   echo "dirty=$(git status --porcelain | wc -l | tr -d ' ')"
   ```

   The `DEEPSTEVE_WORKTREE` env var is a quick hint, but this git block is authoritative and
   also yields the target branch. If `in_worktree=false`, tell the user this isn't a worktree
   session so there's nothing to merge, and STOP.

2. **Summarize the finished work.** Keep it short and scannable:
   - Commits on this branch since the target: `git log <detected_target>..<branch> --oneline`
   - Any uncommitted changes: `git status --short`

3. **Present the handoff and ask.** End your message with:

   > I've finished this work. Would you like to merge `<branch>` into `<detected_target>`?

4. **STOP and wait** for the user's reply. End your turn here — do not merge automatically.

5. **On an affirmative reply** ("yes", "merge", etc.): invoke the `/deepsteve:merge` skill.
   It already handles committing dirty changes, merging into the target checkout, closing the
   GitHub issue (for `*github-issue-<n>*` branches), and closing the session. Do not duplicate
   that logic here.

6. **On a negative reply** ("no", "not yet", etc.): stop cleanly. Leave the worktree, branch,
   and any uncommitted changes intact — do not commit, merge, or close the session.

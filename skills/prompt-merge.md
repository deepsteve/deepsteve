---
name: prompt-merge
description: Signal that worktree work is finished and offer to merge
---

The user (or you, the agent) has decided this worktree's work is complete. Surface a clean
handoff: summarize what was accomplished and ask whether to merge. **On "yes"**, hand off to
the `/deepsteve:merge` skill. **On "no"**, stop cleanly and leave the worktree intact.

## Procedure

1. **Confirm this is a worktree session.** Call `mcp__deepsteve__get_session_info` with no
   arguments — it describes the calling session. `worktree` is non-null on a worktree
   session, and `repoRoot` is the main checkout. If `worktree` is null, tell the user this
   isn't a worktree session so there's nothing to merge, and STOP.

   Do **not** try to work this out in Bash. Claude Code 2.1.222+ isolates worktree sessions
   and refuses any command naming `git` more than once, or pointing `git -C` at the shared
   checkout — which is what this step used to do, and it has not run since.

2. **Summarize the finished work.** Keep it short and scannable, using single-`git`
   commands inside this worktree (each its own Bash call):
   - The branch you are on: `git branch --show-current`
   - Commits on it: `git log main..HEAD --oneline` (name the branch the user expects to
     merge into, if it isn't `main`)
   - Any uncommitted changes: `git status --short`

3. **Present the handoff and ask.** End your message with:

   > I've finished this work. Would you like to merge `<branch>`?

4. **STOP and wait** for the user's reply. End your turn here — do not merge automatically.

5. **On an affirmative reply** ("yes", "merge", etc.): invoke the `/deepsteve:merge` skill.
   It already handles committing dirty changes, merging into the target checkout, closing the
   GitHub issue (for `*github-issue-<n>*` branches), and closing the session. Do not duplicate
   that logic here.

6. **On a negative reply** ("no", "not yet", etc.): stop cleanly. Leave the worktree, branch,
   and any uncommitted changes intact — do not commit, merge, or close the session.

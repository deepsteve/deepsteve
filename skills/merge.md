---
name: merge
description: Merge the current worktree branch into the main checkout's branch (or a branch you name)
argument-hint: [target-branch]
---

The user wants to merge their current worktree's branch into a **target branch**.

By default the target is the branch currently checked out in the **main worktree** (the primary checkout) — so if you work on a feature branch there, merges follow it automatically instead of always going to `main`. If the user passed a branch name as an argument to `/merge`, that argument is the target instead.

**Definition of done**: a successful merge ends with this session closed — and since #627 the daemon guarantees that half: `merge_worktree` arms the close itself on success. Step 9 is about closing it *promptly*, not about whether it happens at all. Never close the session on any STOP path, or when `in_worktree=false` — nothing is armed on those paths either, because they never reach `merge_worktree`.

**Two rules about Bash in this skill.** Claude Code 2.1.222+ isolates worktree sessions and statically inspects every Bash command, refusing any it can't prove stays inside the worktree:

- **Never run `git -C <other dir>`, `cd <other dir> && git …`, or any command naming `git` more than once.** All three are refused outright. That is why the merge itself goes through the `mcp__deepsteve__merge_worktree` tool (step 6) — the daemon runs it outside the guard — and why every `git` step below is its own separate Bash call.
- Plain single-`git` commands **inside** this worktree are fine.

Steps:

1. **Gather state.** Call `mcp__deepsteve__get_my_session_id`, then `mcp__deepsteve__get_session_info` with that id. From the result take `repoRoot` (the main checkout) and `worktree`; `in_worktree` is true when `worktree` is not null. Then run these as **two separate** bash invocations:

   ```sh
   git branch --show-current
   ```
   ```sh
   git status --porcelain
   ```

   Call the first `branch` and the line count of the second `dirty`.

2. **Resolve the target branch**:
   - If the user passed a branch-name argument to `/merge`, `target` = that argument.
   - Otherwise leave `target` unset — step 6 defaults it to whatever the main checkout has checked out, and reports back which branch that was.
   - If `target` equals `branch`, you're already on the target — there is nothing to merge. Tell the user and STOP.

3. **Derive the commit subject** (used in steps 4 and 5):
   - If `branch` matches `*github-issue-<n>*`: run `gh issue view <n> --json title -q .title` to fetch the current title. Subject is `<title> (#<n>)`. If `gh` fails, fall back to the next bullet.
   - Otherwise: subject is `Merge <branch> into <target>` if the user named a target, and just `Merge <branch>` if they didn't (the target isn't resolved until step 6 — do not run a command to find it out).
   - Do NOT include a `Co-Authored-By` trailer.

4. **If `in_worktree=false`**: This is not a worktree session — you're already on the branch in the main checkout, so the worktree merge flow doesn't apply. If `dirty>0`, run `git add -A`, then `git commit -m "<subject>"`, then `git push` as three separate bash invocations. If `dirty=0`, just run `git push`. Then STOP — skip all remaining steps, and do NOT close the session. Nothing auto-closes on this path either: `merge_worktree` is never called, so nothing was ever armed.

5. **Auto-commit dirty changes (worktree path)**: If `dirty>0`, run these as **two separate** bash invocations (never `git add -A && git commit` — two `git`s in one command is refused):

   ```sh
   git add -A
   ```
   ```sh
   git commit -m "<subject>"
   ```

6. **Merge**: Call `mcp__deepsteve__merge_worktree`, passing `target` only if the user named one. It resolves the target, finds the checkout that has it checked out, refuses if that checkout is dirty, and merges — all server-side. Do NOT attempt the merge in Bash; it cannot work from a worktree session.

7. **Handle the result** — branch on the `status` field it returns:
   - **`merged`**: Success. The result carries `autoCloseAt` / `autoCloseInSeconds` — the daemon has already armed the close of this session, and that is how long you have to finish. Do not write the summary yet — it goes in step 9, in the same message as the close. Continue to steps 8 and 9.
   - **`conflict`**: The merge was already aborted for you, so the target is untouched. Rebase this worktree's branch onto the target — `git rebase <target>` (a single `git`, inside this worktree, so it is allowed) — resolve any conflicts, then retry from step 6. If the rebase itself fails with conflicts you cannot resolve, run `git rebase --abort`, tell the user, and STOP.
   - **`target-dirty`**: The **target** checkout (`mergeDir` in the result — **not** this worktree) has uncommitted changes. STOP and tell the user to commit or stash them *in that checkout*, then re-run `/merge`. Do NOT auto-commit, stash, or rebase their changes yourself — that WIP is separate work in the main checkout.
   - **`target-not-checked-out`**: The branch exists but no worktree has it checked out, and this session may not check it out for them. Tell the user to check it out in `repoRoot` first, then STOP.
   - **`no-such-branch`** / **`no-target`** / **`detached`** / **`same-branch`**: Report the tool's `message` to the user and STOP.
   - **`failed`** or any other status: Show the tool's `output`/`message` to the user. STOP here — do not proceed to steps 8 or 9.

8. **Close the GitHub issue** (success only): If `branch` matches `*github-issue-<n>*`, run `gh issue close <n> --comment "Merged into <target>."`. Otherwise skip silently. If it fails, say so and continue to step 9 anyway.

9. **Report and close this session — in ONE message** (success only): After step 8 returns, write your one- or two-line success summary (with the merge output from step 6) and call `mcp__deepsteve__close_session` (no arguments — it auto-detects the calling session) in that same assistant message; text written after that call is cut off when the session terminates.

   Step 6 already armed the close, so if you skip this the daemon closes the session at `autoCloseAt` anyway — the merge is finished either way. Calling it is still the right ending: it closes now instead of leaving a finished tab sitting there. So don't stall, don't poll, and don't wait for the auto-close — make the call and end your turn. If the user types anything in this tab first, the auto-close is cancelled and the tab is theirs.

---
name: merge
description: Merge the current worktree branch into the main checkout's branch (or a branch you name)
argument-hint: [target-branch]
---

The user wants to merge their current worktree's branch into a **target branch**.

By default the target is the branch currently checked out in the **main worktree** (the primary checkout) — so if you work on a feature branch there, merges follow it automatically instead of always going to `main`. If the user passed a branch name as an argument to `/merge`, that argument is the target instead.

**`mcp__deepsteve__merge_session` does the whole thing in one call.** It reads the branch, commits anything uncommitted, resolves the target, merges in the checkout that holds it, closes the GitHub issue the branch names, and arms this tab to close. The daemon already knows every one of those facts, so **do not go and find any of them out**. In particular do not run `git status`, `git branch`, `git add`, `git commit`, `gh issue view`, `gh issue close`, `get_my_session_id` or `get_session_info` before calling it — each one costs a full replay of this conversation's context, which is the entire reason this skill was cut down.

**Definition of done**: a successful merge ends with this session closed, and the daemon guarantees that half — `merge_session` arms the close itself on success. Step 4 is about closing it *promptly*, not about whether it happens at all. Never close the session on any STOP path, or when the status is `pushed` — nothing is armed on those paths.

**One rule about Bash in this skill.** Claude Code 2.1.222+ isolates worktree sessions and statically inspects every Bash command, refusing any it can't prove stays inside the worktree: `git -C <other dir>`, `cd <other dir> && git …`, and **any command naming `git` more than once** are all refused outright. That is why the merge goes through the MCP tool — the daemon runs it outside the guard. Plain single-`git` commands **inside** this worktree are fine, which is what makes the rebase in step 2 allowed.

Steps:

1. **Merge.** Call `mcp__deepsteve__merge_session`. Pass `target` only if the user named one as an argument to `/merge`. Optionally pass `subject` if you want the commit for any uncommitted work to say something better than the issue title — but only from what you already know, never from a command you run to find out; leave it off and the server derives it.

2. **Handle the result** — branch on the `status` field it returns:
   - **`merged`**: Success. The result carries `autoCloseAt` / `autoCloseInSeconds` — the daemon has already armed the close of this session, and that is how long you have to finish. It also carries `issue`, saying whether the GitHub issue was closed. Continue to steps 3 and 4.
   - **`conflict`**: The merge was already aborted for you, so the target is untouched. Rebase this worktree's branch onto the target — `git rebase <target>` (a single `git`, inside this worktree, so it is allowed) — resolve any conflicts, then retry with `mcp__deepsteve__merge_worktree` (your work is already committed by now, so the plain merge is what you want). If the rebase itself fails with conflicts you cannot resolve, run `git rebase --abort`, tell the user, and STOP.
   - **`target-dirty`**: The **target** checkout (`mergeDir` in the result — **not** this worktree) has uncommitted changes. STOP and tell the user to commit or stash them *in that checkout*, then re-run `/merge`. Do NOT auto-commit, stash, or rebase their changes yourself — that WIP is separate work in the main checkout.
   - **`target-not-checked-out`**: The branch exists but no worktree has it checked out, and this session may not check it out for them. Tell the user to check it out in the main checkout first, then STOP.
   - **`pushed`** / **`push-failed`**: This is not a worktree session, so there was no merge to do — your work was committed on the branch you are already on and pushed (or the push failed, in which case show the output). Report and STOP. Do **not** close the session; nothing was armed on this path.
   - **`no-such-branch`** / **`no-target`** / **`detached`** / **`same-branch`** / **`commit-failed`**: Report the tool's `message` to the user and STOP.
   - **`failed`** or any other status: Show the tool's `output`/`message` to the user. STOP here — do not proceed to steps 3 or 4.

   Never work around a refusal with `git push origin <branch>:<target>`. That moves the remote and leaves the local checkout behind.

3. **Close any tab you opened** (success only, and before step 4 — text after `close_session` is cut off, so this cannot go last): if you called `open_terminal` at any point in this session, call `mcp__deepsteve__close_session` with each id it returned. Runs you did through `run_in_terminal` need nothing; those tabs close themselves.

4. **Report and close this session — in ONE message** (success only): After step 3 is done, write your one- or two-line success summary (with the merge output from step 1) and call `mcp__deepsteve__close_session` (no arguments — it auto-detects the calling session) in that same assistant message; text written after that call is cut off when the session terminates.

   Step 1 already armed the close, so if you skip this the daemon closes the session at `autoCloseAt` anyway — the merge is finished either way. Calling it is still the right ending: it closes now instead of leaving a finished tab sitting there. So don't stall, don't poll, and don't wait for the auto-close — make the call and end your turn. If the user types anything in this tab first, the auto-close is cancelled and the tab is theirs.

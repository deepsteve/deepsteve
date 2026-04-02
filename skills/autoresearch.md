---
name: autoresearch
description: Start an autonomous research loop for optimization/algorithm design problems
argument-hint: <research problem description>
---

The user wants to start an autonomous research loop. Their description: $ARGUMENTS

Steps:

1. **Analyze the research problem.** From the user's description, identify:
   - The core optimization or algorithm design problem
   - What the "editable file" should be (the thing being iterated on — e.g., a compression algorithm, a prompt template, a scoring function)
   - What the "evaluate harness" should be (how to measure quality — e.g., compression ratio, accuracy, latency)
   - What metrics to track in results.tsv

2. **Draft the GitHub issue.** Create a concise issue body with:
   - Summary (1-2 sentences)
   - Objectives (specific, measurable goals)
   - Constraints (anything the user mentioned)
   - Success Criteria (target metrics, baselines to beat)

   Keep it short — the research protocol details go in a file, not the issue.

3. **Create the issue.** Run `gh issue create --title "<concise research objective>" --body "<the body above>" --label "autoresearch"`. If the `autoresearch` label doesn't exist, omit the `--label` flag and create without it. Extract the issue number from the returned URL.

4. **Start the research session.** Call the `mcp__deepsteve__start_issue` MCP tool with:
   - `session_id`: your session ID (call `mcp__deepsteve__get_my_session_id` to get it)
   - `number`: the issue number
   - `title`: the issue title
   - `body`: the issue body, PLUS the full research protocol below appended to the end

   The `body` field is what gets delivered as the initial prompt. Include the issue body you drafted, then append the following research protocol instructions. The agent's first action will be to write this protocol to `CLAUDE.md` in the worktree so it persists across context clears.

   Append this to the body:

   ---

   ## FIRST ACTION — Write Research Protocol to CLAUDE.md

   Before doing anything else, write a `CLAUDE.md` file in the repo root containing the full research protocol below, customized for this specific problem. This file persists across context clears and ensures you never lose your instructions.

   Write this to `CLAUDE.md`:

   ```
   # Autoresearch Protocol

   ## Problem
   [1-2 sentence summary of the research problem from the issue]

   ## Three-File Structure

   ### 1. `program.md` — Research Program
   The research plan. Document your current hypothesis, what you're trying next, and why. Update this before each iteration. Read this file at the start of every iteration to re-orient.

   ### 2. `[evaluate harness file]` — Evaluation Harness
   [Describe what the harness does, adapted to this domain]
   - Must be runnable as a single command (e.g., `python evaluate.py`, `node evaluate.js`)
   - Must print a single-line TSV row to stdout with metrics
   - Must exit 0 on success, non-zero on failure

   ### 3. `[editable file]` — The Thing Being Optimized
   [Describe what this file contains, adapted to this domain]

   ### 4. `results.tsv` — Results Log
   TSV file tracking all experiments. Header: `iteration\ttimestamp\t[metric columns]\tnotes`
   Append one row per iteration. Never delete rows.

   ## Research Loop

   **NEVER STOP. NEVER ask "should I continue?" — keep iterating until interrupted.**

   Each iteration:
   1. Read `program.md` for current state and next hypothesis
   2. Update `program.md` with what you're about to try and why
   3. Modify the editable file to test your hypothesis
   4. Run the evaluate harness
   5. Append results to `results.tsv`
   6. Analyze: did it improve? Update `program.md` with findings
   7. Commit with a message summarizing the iteration and result
   8. If improvement: build on it. If regression: revert the editable file, try different approach
   9. Every 5-10 iterations, write/update `findings.md` with key discoveries
   10. Go to step 1

   ## Rules
   - Each iteration must produce a commit and a results.tsv row
   - Never skip the evaluation step — no untested changes
   - If the harness fails, fix it before continuing
   - Keep iterations small and focused — one hypothesis per iteration
   - `findings.md` is your cumulative knowledge document — update it regularly

   ## Success Criteria
   [Fill in from issue]
   ```

   Customize the template: name the harness and editable files appropriately for the domain (e.g., `evaluate.py` + `compress.py`), fill in domain-specific metrics, and adapt descriptions.

   After writing `CLAUDE.md`, create the initial three-file structure, then begin the research loop.

   ---

   Do NOT ask the user for confirmation before starting — the whole point of autoresearch is autonomous operation.

5. **Report back.** Tell the user: the issue URL, that the research session has been started, and that the agent will iterate autonomously until interrupted.

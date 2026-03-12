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

2. **Draft the GitHub issue.** Create a well-structured issue body using this template (adapt field names to the specific domain):

   ```
   ## Summary
   [1-2 sentence description of the research problem]

   ## Objectives
   - [Specific, measurable goals]

   ## Constraints
   - [Any constraints the user mentioned — time, memory, dependencies, etc.]

   ## Three-File Research Structure

   This issue uses the autonomous research loop pattern. Set up these files in the repo root:

   ### 1. `program.md` — Research Program
   The research plan. Document your current hypothesis, what you're trying next, and why. Update this before each iteration.

   ### 2. `[evaluate harness file]` — Evaluation Harness
   [Description of what the harness does — runs the editable file, measures metrics, outputs results]
   - Must be runnable as a single command (e.g., `python evaluate.py`, `node evaluate.js`, `bash evaluate.sh`)
   - Must print a single-line TSV row to stdout: `[timestamp]\t[metric1]\t[metric2]\t...`
   - Must exit 0 on success, non-zero on failure

   ### 3. `[editable file]` — The Thing Being Optimized
   [Description of what this file contains and what gets changed each iteration]

   ### 4. `results.tsv` — Results Log
   TSV file tracking all experiments. Header row: `iteration\ttimestamp\t[metric columns]\tnotes`
   Append one row per iteration. Never delete rows — this is your experiment history.

   ## Research Loop Protocol

   **NEVER STOP. NEVER ask "should I continue?" — just keep iterating until interrupted.**

   Each iteration:
   1. Read `program.md` to understand current state and next hypothesis
   2. Update `program.md` with what you're about to try and why
   3. Modify the editable file to test your hypothesis
   4. Run the evaluate harness
   5. Append results to `results.tsv`
   6. Analyze: did it improve? Update `program.md` with findings
   7. Commit with a message summarizing the iteration and result
   8. If improvement: build on it. If regression: revert the editable file and try a different approach
   9. Every 5-10 iterations, write/update `findings.md` summarizing key discoveries and the current best approach
   10. Go to step 1

   **Important rules:**
   - Each iteration must produce a commit and a results.tsv row
   - Never skip the evaluation step — no untested changes
   - If the harness fails, fix it before continuing
   - Keep iterations small and focused — one hypothesis per iteration
   - `findings.md` is your cumulative knowledge document — update it regularly

   ## Success Criteria
   - [What "good enough" looks like — target metrics, baselines to beat]
   ```

   Adapt the template to the specific domain: name the harness and editable files appropriately (e.g., `evaluate.py` + `compress.py`, or `benchmark.sh` + `algorithm.rs`), and fill in domain-specific metrics.

3. **Create the issue.** Run `gh issue create --title "<concise research objective>" --body "<the body above>" --label "autoresearch"`. If the `autoresearch` label doesn't exist, omit the `--label` flag and create without it. Extract the issue number from the returned URL.

4. **Start the research session.** Call the `mcp__deepsteve__start_issue` MCP tool with:
   - `session_id`: your `DEEPSTEVE_SESSION_ID` (read it via `echo $DEEPSTEVE_SESSION_ID`)
   - `number`: the issue number
   - `title`: the issue title

   Do NOT ask the user for confirmation — the whole point of autoresearch is autonomous operation. Start it immediately.

5. **Report back.** Tell the user: the issue URL, that the research session has been started, and that the agent will iterate autonomously until interrupted.

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
   - What metrics to track in results.tsv (primary metric and any secondary metrics)
   - The baseline state (what exists before optimization — the unmodified starting point)
   - The primary metric vs quality constraints (what you're optimizing vs what must not degrade)
   - The quality budget (acceptable degradation threshold for quality constraints, if any)
   - Termination criteria (specific measurable targets that define "done")

2. **Draft the GitHub issue.** Create a concise issue body with:
   - Summary (1-2 sentences)
   - Objectives (specific, measurable goals)
   - Targets (primary metric + target value, quality budget / constraints)
   - Constraints (anything the user mentioned)
   - Termination Criteria (specific metric targets that define success, or iteration budget for open-ended exploration)

   Keep it short — the research protocol details go in a file, not the issue.

3. **Create the issue.** Run `gh issue create --title "<concise research objective>" --body "<the body above>" --label "autoresearch"`. If the `autoresearch` label doesn't exist, omit the `--label` flag and create without it. Extract the issue number from the returned URL.

4. **Start the research session.** Call the `mcp__deepsteve__start_issue` MCP tool with:
   - `session_id`: your `DEEPSTEVE_SESSION_ID` (read it via `echo $DEEPSTEVE_SESSION_ID`)
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

   ## Targets
   - Primary metric: [name] — target: [value], baseline: TBD (measured in Phase 0)
   - Quality constraint: [metric] must not degrade below [threshold] (or: no quality constraint)
   - Termination: stop when [primary target met AND quality within budget], OR after [N] iterations without improvement
   - If no concrete target exists: iterate for [N] iterations, then produce final findings.md and stop

   ## File Structure

   ### 1. `program.md` — Research Program & Decision State
   Updated every iteration. Three sections:

   **Experiment Phases** — Ordered list of optimization strategies, from highest expected impact to lowest. Cross off phases as completed or abandoned. Add new phases as discovered. Adapt these to your domain:
     - Phase 1: Remove unnecessary work (eliminate dead code, unused computation, redundant steps)
     - Phase 2: Reduce input scope (downsample, truncate, filter to essential signal)
     - Phase 3: Substitute simpler methods (replace expensive operations with cheaper approximations)
     - Phase 4: Prune internals (profile, identify low-contribution components, remove them)
     - Phase 5: Optimize execution (caching, batching, parallelism, algorithmic improvements)
     - Phase 6: Domain-specific optimizations (discovered during research)

   **Decision State** — Updated after every iteration:
     - Current best: [iteration N, metric values]
     - Current phase: [which phase you're in]
     - Remaining experiments in this phase: [list]
     - Branch logic: [what would cause you to move to next phase or abandon current approach]

   **Next Experiment** — What you're about to try and why (hypothesis + expected effect)

   ### 2. `[evaluate harness file]` — Evaluation Harness
   [Describe what the harness does, adapted to this domain]
   - Must be runnable as a single command (e.g., `python evaluate.py`, `node evaluate.js`)
   - Must print a single-line TSV row to stdout with metrics
   - Must exit 0 on success, non-zero on failure
   - Should be deterministic, or run multiple trials and report mean

   ### 3. `[editable file]` — The Artifact Being Optimized
   [Describe what this file contains, adapted to this domain]

   ### 4. `results.tsv` — Experiment Log
   Columns: `iteration	timestamp	phase	hypothesis	[metric columns]	quality_delta	vs_baseline	vs_best	pass_fail	notes`
   - `quality_delta`: change in quality constraint metric vs previous iteration (or "N/A" if no constraint)
   - `vs_baseline`: improvement factor vs Phase 0 baseline (e.g., "1.3x" or "+15%")
   - `vs_best`: improvement factor vs current best (e.g., "+2%" or "-1%")
   - `pass_fail`: "PASS" if quality within budget AND primary metric improved or held, else "FAIL"
   Append one row per iteration. Never delete rows.

   ## Research Loop

   ### Phase 0: Baseline (mandatory — do this first, before any optimization)
   1. Create the evaluate harness and editable file with the UNMODIFIED starting state
   2. Run the harness 3 times to confirm determinism and get stable measurements
   3. Record baseline metrics in results.tsv as iteration 0 (phase="baseline", vs_baseline="1.0x", vs_best="N/A")
   4. Initialize program.md with:
      - Decision State: current best = baseline values
      - Experiment Phases: plan your phases based on what you observe in the baseline system
   5. Commit: "baseline: [metric values]"
   6. Proceed to Phase 1

   ### Phase 1-N: Optimization Loop
   Each iteration:
   1. Read program.md — orient on decision state, current phase, next experiment
   2. **Check termination**: if primary target met AND quality within budget → write final findings.md and STOP
   3. **Check stall**: if 5+ consecutive FAILs in current phase → move to next phase; if all phases exhausted → write findings.md and STOP
   4. Update program.md with hypothesis for this iteration
   5. Modify the editable file to test your hypothesis (keep changes small and reversible)
   6. Run the evaluate harness
   7. Compute deltas: vs_baseline, vs_best, quality_delta, pass/fail
   8. Append row to results.tsv
   9. Update decision state in program.md:
      - If PASS and new best → update "current best", build on this change
      - If PASS but not new best → keep if quality_delta acceptable, note diminishing returns
      - If FAIL → revert editable file to current best state, note what didn't work, try next experiment in phase
   10. Commit: "iter [N] [phase]: [hypothesis] → [result] ([metric] [delta])"
   11. Every 5 iterations: update findings.md with key discoveries and current best configuration
   12. Go to step 1

   ## Rules
   - Baseline measurement is NON-NEGOTIABLE — never skip Phase 0
   - Each iteration must produce one commit and one results.tsv row
   - Never skip evaluation — no untested changes
   - If the harness fails, fix it before continuing (do not count as an iteration)
   - One hypothesis per iteration — keep changes small and focused
   - When reverting, revert to the current best, not just the previous iteration
   - Track your current best explicitly — never lose a good result
   - Phases are a guide, not a prison — if you discover a promising direction mid-phase, note it and either pursue it or add it as a future phase
   - findings.md is your cumulative knowledge document — update it regularly

   ## Termination Criteria
   [Fill in from issue targets. If open-ended: "Iterate for N iterations, then produce final findings.md"]
   ```

   Customize the template: name the harness and editable files appropriately for the domain (e.g., `evaluate.py` + `compress.py`), fill in domain-specific metrics, adapt phase descriptions to the problem, and fill in concrete target values.

   After writing `CLAUDE.md`, create the initial file structure, then begin the research loop starting with Phase 0 (baseline).

   ---

   Do NOT ask the user for confirmation before starting — the whole point of autoresearch is autonomous operation.

5. **Report back.** Tell the user: the issue URL, that the research session has been started, and that the agent will iterate autonomously following the structured OPTIMIZE protocol (baseline → phases → termination).

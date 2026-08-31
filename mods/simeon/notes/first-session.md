# Simeon, session one — what a general-purpose coding agent does when you point it at a canvas

The first Simeon build drove its UI from an **interactive Claude Code session** calling an MCP
tool. This is what that session actually did, why it was replaced by
[`../runner.js`](../runner.js), and the numbers that justified the change.

Kept because the failure is not obvious in advance and is very obvious in hindsight: every
individual thing the agent did was reasonable, and the aggregate was useless.

**Raw transcript:** `~/.claude/projects/-Users-michael-github-deepsteve-experimental/11492905-cf48-44ba-b3ef-cc8ee5f2dcfb.jsonl`
(claudeSessionId `11492905-cf48-44ba-b3ef-cc8ee5f2dcfb`, deepsteve session `5a6fcb01`, 2026-08-30).
Not committed: it is ~740 KB and includes `env` dumps naming `DEEPSTEVE_API_TOKEN`. The
distilled per-turn counts are in [`first-session-turns.json`](first-session-turns.json), which
is what the table below is generated from. Claude prunes project transcripts, so treat the
raw file as expiring and the JSON as the record.

## The numbers

| | |
|---|---|
| Turns | 9 |
| Tool calls | **74** |
| Of those, `simeon_render` (i.e. actually drawing) | **9** |
| `Bash` | 37 |
| `browser_eval` / `browser_console` | 14 |
| Thinking blocks | 54 |
| Thinking characters | 40,051 |

**Roughly 88% of the agent's work was not drawing.**

## Per turn

| # | Ask | Tools | Think | What it spent them on |
|---|---|---|---|---|
| 1 | (the operating brief) | 2 | 0 | `ToolSearch`, `simeon_say` — correct |
| 2 | "why does it say no gent" | **15** | 13 (4.1k) | `Bash`×10 grepping `mods/simeon/*`, `browser_eval` |
| 3 | "make a bar chart … Woop data" | 3 | 2 (1.3k) | `find ~` for a Whoop export, then drew |
| 4 | (same, re-asked) | **11** | 8 (5.5k) | `browser_eval`×3, `Bash`×3 re-reading `tools.js` |
| 5 | (same, re-asked) | 3 | 3 (2.1k) | `Bash`×2, no render at all |
| 6 | "three charts — HR, sleep, …" | 3 | 1 (1.2k) | drew once |
| 7 | "make resting HR red + a beating svg heart" | **28** | 21 (**16.1k**) | `Bash`×17, `browser_eval`×8 |
| 8 | (re-asked) | 4 | 2 (1.9k) | `browser_console`, `Bash` |
| 9 | (re-asked) | 5 | 4 (7.8k) | `Bash`×3 |

Turns 3–5 and 6–9 are the same request typed repeatedly. That is the real cost: the human
could not tell whether it had failed or was still working, because **nothing appears until an
MCP tool call completes**, so they asked again.

## Turn 7 is the whole problem in one turn

Asked to *"Change the resting heart rate to be red and have a beating svg heart"*, it:

1. read `render.js`, `simeon.css`, `tools.js`,
2. **patched all three with `python3` heredocs** to add a `heart` component,
3. `cp -f`'d them into `~/.deepsteve/mods/simeon/` to deploy,
4. polled the browser eight times waiting for hot-reload.

It modified and shipped Simeon itself instead of drawing a red number. Nothing told it not
to, it had `Bash` and a checkout, and editing the renderer is a *better* answer to "add a
beating heart" than any row could be — if you are a software engineer. That is the trap: the
behaviour is competent, and competence at the wrong job is still the wrong job.

## Three causes, in order of severity

1. **An MCP tool call is atomic.** The model composes the whole `rows` argument and only then
   does anything reach the canvas. Streaming was impossible by construction. First component
   on screen: **19.3s**. This is why the request kept getting re-typed.
2. **It was spawned in the deepsteve checkout** with the full toolset, so it inherited
   `CLAUDE.md` and a repo to grep. Given a shell and source, a coding agent investigates.
3. **Thinking**, 54 blocks / 40k chars. Real, and the smallest of the three.

## What replaced it

`claude -p --output-format stream-json --include-partial-messages`, one subprocess per
message, rows pushed as each newline lands. Plus `--system-prompt` (replacing, not appending,
so the coding-agent persona is gone), `--restricted` (verified: 21 tools, no `Bash`),
`MAX_THINKING_TOKENS=0`, and a neutral cwd at `~/.deepsteve/simeon` with no repo in it.

Measured through the full pipeline, browser included:

```
request sent              @ 0.03s
FIRST COMPONENT ON SCREEN @ 1.84s
  4 nodes @ 2.15s  ·  5 @ 2.45s  ·  8 @ 3.05s  →  34 nodes
```

**19.3s → 1.84s to first paint**, and the interface assembles while the model is still
writing it. Rationale lives in [`../runner.js`](../runner.js)'s header.

## Two things this session left behind

- **The `heart` component in `render.js` was written by the Simeon agent**, in turn 7, and is
  kept. It follows the `build`/`paint` contract, clamps its beat period against a bad `d` row,
  carries tone variants, and has its `LANGUAGE` entry. Reviewed and retained on merit — but
  its provenance is why it exists, and it is the only part of this mod its own agent wrote.
- **`@root`.** A later run emitted `n app col @root`; the store had no node named `root`, so
  the entire tree parked as an orphan and nothing mounted. Fixed with a root alias in
  `store.js` and pinned by a test. Predictable improvisations deserve aliases, not empty
  canvases.

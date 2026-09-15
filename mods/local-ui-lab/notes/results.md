# Local UI Lab (#706): measurements, and how to get small completions

**Status: stopped on 2026-09-14 after a few smoke runs, because the laptop was running hot.** The
full benchmark, WebLLM and the markup-first variant never ran. Nothing in "Small completions" below
has been run. It is the plan, with the prompts written out so the next attempt starts from text
rather than from a description.

## Setup

- Apple M4 Pro, 24 GB. Ollama 0.33.3. Chrome 152.
- `qwen3.5:4b` (4.7B, Q4_K_M), thinking off. `think: false` was confirmed to return a clean reply
  with no `thinking` field.
- `qwen2.5-coder:7b` (7.6B, Q4_K_M) was pulled, but only used for one 8-token streaming check.

## What was measured

All rows use `qwen3.5:4b` on Ollama, warm unless noted.

| Request | Output tokens | First token | First paint / change | Total | tok/s |
|---|---|---|---|---|---|
| Warm-up: "a page with one heading that says Hello" | 447–534 | 0.39s warm, 4.5s cold (4.1s model load) | – | 9.1–12.3s | 57–59 |
| New page: a counter | 881–959 | 0.37s | 11.2–12.2s | 15.2–16.5s | 59 |
| Edit: rename the heading, as a patch | 33 | 1.4s (prefill of the ~1.1k-token page) | 2.0s | 2.0s | 60 |

`qwen2.5-coder:7b` decoded at 54 tok/s, with a 3.1s cold load.

## What went wrong

**The prompt asked for a whole document in one completion, and nothing limited its size.** The model
did what it was asked:
- about 900 tokens per page
- the CSS first, so `</style>` arrived at 69% of the output and nothing could paint before it
- a code fence around the document
- about 500 tokens even for a single heading

The one request that was small by construction, the 33-token patch edit, was also the one that
finished in 2s. The fix is to make **every completion small, by prompt and by hard limit**, and to
build the page out of many of them.

## Small completions

### Rules every prompt follows

1. **Name one unit of output and give its size.** Write "reply with one `<section>` element of at
   most 12 lines", not "keep it compact".
2. **Show one example of exactly that size.** The example sets the length as much as the
   instruction does. Measure how closely the model matches it (below).
3. **Keep the expensive parts out of every completion.** No `<html>`, `<head>`, `<style>` or
   `<script>`.
   - **Styling:** a fixed set of classes that the preview's own stylesheet defines, listed in the
     prompt.
   - **Behaviour:** `data-` attributes that a small host runtime in the preview interprets.
   - This is the HTML version of what makes Simeon fast: the renderer owns the look, so the model
     does not spend tokens on it.
4. **Enforce the size in the runtime, not only in words.**
   - **Ollama:** `options.num_predict` caps the tokens. `options.stop: ["</section>"]` ends the
     completion the moment the element closes. The stop string is not returned, so append it back.
   - **WebLLM:** use the OpenAI-style `max_tokens` and `stop`. Confirm both exist on its request
     type before relying on them.
5. **Start the answer for the model.**
   - Call Ollama's `/api/generate` with `raw: true`, a full hand-templated prompt. Its API
     documentation describes `raw` for exactly this.
   - End the prompt with the first characters of the reply: `<section id="counter" class="`.
   - The model then cannot open with a code fence, a doctype or a sentence.
   - Qwen uses the ChatML format (`<|im_start|>` … `<|im_end|>`). Before writing it by hand, check
     the exact template `qwen3.5` uses, including how its turn marks thinking as off.
6. **Send only the context the unit needs:** the request, the plan, and a one-line summary of each
   section already written. Never the whole page.
7. **Keep the system prompt byte-identical across calls,** so Ollama can serve it from its prompt
   cache. `prompt_eval_cached_count` in the response shows whether it did.

### Generating a page: plan, then one section per completion

1. **Plan.** One completion, capped at 80 tokens, stopping at a blank line (`stop: ["\n\n"]`).
2. **Sections.** One completion per plan line, in order, capped at 220 tokens, with
   `stop: ["</section>"]`.
   - Each section streams token by token into its own slot, so the page visibly grows one section
     at a time.
3. **Behaviour the vocabulary cannot express** (adding items to a list, drawing a chart) gets its own
   completion: "the script for #todo, at most 15 lines". Use it only where it is needed.

Plan prompt:

```
List the sections this page needs, top to bottom, one per line, as
id: what it shows
Use at most 5 lines. Ids are lowercase words. Nothing else.
```

Section system prompt:

```
You write ONE section of a web page at a time.

Reply with a single <section> element and nothing else, at most 12 lines.
No <html>, <head>, <style>, <script>, markdown or explanation.

Style it only with these classes:
  stack  row  grid-2  grid-3  card  title  subtitle  muted  big
  btn  btn-primary  input  badge  divider

Make it interactive only with these attributes:
  data-state="name=0"      declare a value on the section
  data-text="name"         show a value
  data-action="name+=1"    on click: =, += or -=
  data-toggle="class"      on click: toggle a class on the section

Example:
<section id="counter" class="card stack" data-state="count=0">
  <h2 class="title">Counter</h2>
  <p class="big" data-text="count">0</p>
  <div class="row">
    <button class="btn" data-action="count-=1">−</button>
    <button class="btn btn-primary" data-action="count+=1">+</button>
    <button class="btn" data-action="count=0">Reset</button>
  </div>
</section>
```

Section user message, followed by the assistant prefill `<section id="counter" class="`:

```
PAGE: a counter with −, + and Reset buttons
PLAN:
counter: the number and its three buttons
ALREADY WRITTEN: (none)
WRITE: counter
```

### Editing a page: locate, then rewrite one section

1. **Locate.** Capped at 8 tokens.
   ```
   SECTIONS:
   header: title and dark mode button
   list: the tasks
   CHANGE: make the title say Groceries
   Which section does this change? Reply with its id only, or NEW.
   ```
2. **Rewrite that section.** Use the section prompt with `CURRENT:` followed by that one section in
   place of the plan, capped at 220 tokens. Replace the element by id.
   - There is no SEARCH text to copy verbatim, and the context is one section, not the page.
   - `NEW` writes a section instead, and the plan gains a line.

### Expected sizes

These are estimates from the example's length. Nothing here has been measured.

| Completion | Tokens | At the measured ~59 tok/s |
|---|---|---|
| Plan | ~40 | under 1s |
| One section | ~100–150 | 2–3s |
| Locate | ~5 | about 0.1s after prefill |
| Rewrite a section | ~100–150 | 2–3s |

That puts the first section on screen roughly 3–4s after sending, against the measured 11–12s to
first paint, with another visible section every 2–3s after it.

### What to measure

Run one request at a time. A back-to-back suite is what overheated the laptop.

- Tokens per completion, and how often a completion **hits the `num_predict` cap**. A truncated
  section is the main failure to watch for.
- How often the reply is **exactly one `<section>` with the requested id**.
- How often it uses a **class or attribute outside the vocabulary**.
- Time to first section, time per section, and `prompt_eval_cached_count`.
- Start with `qwen3.5:4b` on the counter and pricing requests before adding anything else.

### Where it goes in the code, when resumed

- **`prompts.js`:** `PLAN_PROMPT`, `SECTION_PROMPT` and `LOCATE_PROMPT` replace the three
  whole-document prompts.
- **`tools.js`:**
  - Accept `stop` (a string array; `pickOptions` currently only passes numbers) alongside the
    existing `num_predict`.
  - Add a `raw` `/api/generate` path, for the prefill.
- **`lab.js`:** `runRequest` becomes a loop.
  - A new page is plan, then sections.
  - An edit is locate, then rewrite one section.
- **`preview.js`:**
  - The bootstrap gains the class stylesheet and the ~50-line `data-*` runtime.
  - Sections are appended or replaced by id, instead of re-parsing a whole document.
- **`patch.js`:** SEARCH/REPLACE is no longer needed for edits.

**Simeon's rows are the same idea taken to one line per unit.** The same loop, with a group of rows
as the unit and a blank line as the stop, would drive a local runner there.

## Never done

- the full benchmark
- `qwen2.5-coder:7b` output quality
- WebLLM download, compile and speed
- the markup-first ordering (cut off mid-run)
- Firefox's WebGPU status
- everything in "Small completions"

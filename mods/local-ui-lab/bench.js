/**
 * Local UI Lab: the fixed benchmark, run identically on every backend.
 *
 * Six new pages, then six edits to one baseline page, and every edit is run twice: as
 * SEARCH/REPLACE blocks and as a full rewrite. That pair is the direct answer to "can it make
 * a targeted edit instead of regenerating the page".
 *
 * WHAT A PASS MEANS. The page rendered, threw no script errors, and a mechanical check found
 * the thing that was asked for. An edit must also leave the rest of the page intact. The
 * checks are deliberately loose: they separate "did it" from "did not" without grading taste.
 * Taste is graded by eye from screenshots, in notes/results.md.
 */

import { runRequest, summarize } from './lab.js';
import { loadWebllm } from './backends.js';

export const BASELINE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Todo</title>
  <style>
    body {
      margin: 0;
      font-family: system-ui, -apple-system, sans-serif;
      background: #f4f4f5;
      color: #18181b;
    }
    header {
      background: #3b82f6;
      color: #ffffff;
      padding: 20px 32px;
    }
    header h1 {
      margin: 0;
      font-size: 24px;
    }
    main {
      max-width: 520px;
      margin: 32px auto;
      padding: 0 16px;
    }
    form {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    input {
      flex: 1;
      padding: 10px 12px;
      border: 1px solid #d4d4d8;
      border-radius: 8px;
      font-size: 15px;
    }
    button {
      padding: 10px 16px;
      border: 0;
      border-radius: 8px;
      background: #3b82f6;
      color: #ffffff;
      font-size: 15px;
      cursor: pointer;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      background: #ffffff;
      padding: 12px 14px;
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
    }
    li.done {
      text-decoration: line-through;
      color: #a1a1aa;
    }
  </style>
</head>
<body>
  <header>
    <h1>My Todo List</h1>
  </header>
  <main>
    <form id="add-form">
      <input id="new-item" placeholder="Add a task" autocomplete="off">
      <button type="submit">Add</button>
    </form>
    <ul id="list">
      <li>Buy milk</li>
      <li>Walk the dog</li>
      <li>Finish the report</li>
    </ul>
  </main>
  <script>
    const list = document.getElementById('list');
    const form = document.getElementById('add-form');
    const input = document.getElementById('new-item');

    list.addEventListener('click', (event) => {
      if (event.target.tagName === 'LI') {
        event.target.classList.toggle('done');
      }
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const item = document.createElement('li');
      item.textContent = text;
      list.appendChild(item);
      input.value = '';
    });
  </script>
</body>
</html>`;

const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

/** The parts of the baseline no edit task asks to remove. */
function intact(html) {
  return /Buy milk/.test(html) && /Walk the dog/.test(html)
    && /<style[\s>]/i.test(html) && /<script[\s>]/i.test(html)
    && /addEventListener\(\s*'submit'/.test(html);
}

export const TASKS = [
  { id: 'counter', kind: 'generate',
    request: 'A counter: a big number in the middle, with − , + and Reset buttons under it.',
    check: (html, s) => s.buttons >= 3 && /\d/.test(s.text) },
  { id: 'todo', kind: 'generate',
    request: 'A todo list. Type a task and press Enter or an Add button to add it; click a task to mark it done; each task has a × button that deletes it.',
    check: (html, s) => s.inputs >= 1 && s.buttons >= 1 },
  { id: 'pricing', kind: 'generate',
    request: 'A pricing section with three plan cards, Free, Pro and Team, each with a price, a short feature list and a button. Highlight Pro as the most popular.',
    check: (html, s) => /free/i.test(s.text) && /pro/i.test(s.text) && /team/i.test(s.text) && s.buttons >= 3 },
  { id: 'calculator', kind: 'generate',
    request: 'A working calculator: a display, digit buttons 0 to 9, + − × ÷, a decimal point, C to clear and = to evaluate, laid out in a grid.',
    check: (html, s) => s.buttons >= 16 },
  { id: 'chart', kind: 'generate',
    request: 'A bar chart of monthly sales from January to June (make up the numbers), drawn on a <canvas> with the month under each bar.',
    check: (html, s) => s.canvases >= 1 && s.inkedCanvas },
  { id: 'login', kind: 'generate',
    request: 'A centred login form with email and password fields and a Sign in button. On submit, show an error message under each field that is empty, or under the email if it is not a valid address.',
    check: (html, s) => s.inputs >= 2 && /type=["']?password/i.test(html) },

  { id: 'rename', kind: 'edit',
    request: 'Change the heading to "Groceries".',
    check: (html) => parse(html).querySelector('h1')?.textContent.trim() === 'Groceries' },
  { id: 'recolor', kind: 'edit',
    request: 'Make the header background dark green (#1f5130).',
    check: (html) => /header\s*\{[^}]*#1f5130/i.test(html) },
  { id: 'add-item', kind: 'edit',
    request: 'Add a fourth task to the list: "Call the plumber".',
    check: (html, s) => /Call the plumber/.test(s.text) },
  { id: 'clear-done', kind: 'edit',
    request: 'Add a "Clear completed" button under the list that removes every task marked done.',
    check: (html, s) => /clear completed/i.test(s.text) && s.buttons >= 2 },
  { id: 'items-left', kind: 'edit',
    request: 'Under the list, show how many tasks are not done yet, like "3 tasks left", and keep it up to date when tasks are added or marked done.',
    check: (html, s) => /\b3\s+tasks?\s+left\b/i.test(s.text) },
  { id: 'dark-mode', kind: 'edit',
    request: 'Add a "Dark mode" button in the header that switches the whole page to dark colours when clicked.',
    check: (html, s) => /dark mode/i.test(s.text) && s.buttons >= 2 && /dark/i.test(html.replace(/Dark mode/gi, '')) },
];

export const EDIT_MODES = ['patch', 'rewrite'];

/** Run one task. For an edit task, `mode` is 'patch' or 'rewrite'. */
export async function runTask({ backend, preview, taskId, mode, order, signal, onText, onProgress }) {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const edit = task.kind === 'edit';
  if (edit && !EDIT_MODES.includes(mode)) throw new Error(`an edit task needs mode patch or rewrite, got ${mode}`);

  const html = edit ? BASELINE : '';
  if (edit) {
    preview.show(html);
    await preview.settle();
  }

  const r = await runRequest({
    backend, mode: edit ? mode : 'generate', request: task.request, html, order, preview, signal, onText, onProgress,
  });
  r.task = task.id;

  const summary = r.render?.summary || null;
  const scriptErrors = (r.render?.errors || []).filter((e) => !e.resource);
  let goal = false;
  try { goal = !!(summary && task.check(r.html, summary)); } catch {}
  r.check = {
    goal,
    rendered: !!r.render?.loaded && (summary?.elements || 0) > 0,
    scriptErrors: scriptErrors.length,
    errorMessages: scriptErrors.slice(0, 3).map((e) => e.message),
    intact: edit ? intact(r.html) : null,
    changed: edit ? r.html !== BASELINE : null,
  };
  r.pass = r.check.goal && r.check.rendered && r.check.scriptErrors === 0
    && r.check.intact !== false && !r.error && !r.aborted;
  return r;
}

/**
 * The whole suite on one backend. A warm-up request goes first, so the one-time model load
 * is reported on its own rather than hidden inside the first task's latency.
 */
export async function runBenchmark({ backend, preview, order, signal, onStart, onRun, onText, onProgress }) {
  const out = {
    backend: backend.key,
    order: order || null,
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    loadMs: null,
    warmup: null,
    runs: [],
  };

  if (backend.kind === 'webllm') out.loadMs = (await loadWebllm(onProgress)).loadMs;

  onStart?.({ id: 'warmup', mode: 'generate' });
  const warm = await runRequest({
    backend, mode: 'generate', request: 'A page with one heading that says Hello.', preview, signal, onText, onProgress,
  });
  out.warmup = { ttftMs: warm.ttftMs, totalMs: warm.totalMs, metrics: warm.metrics, error: warm.error };

  const plan = [];
  for (const t of TASKS.filter((t) => t.kind === 'generate')) plan.push([t.id, 'generate']);
  for (const t of TASKS.filter((t) => t.kind === 'edit')) for (const m of EDIT_MODES) plan.push([t.id, m]);

  for (const [taskId, mode] of plan) {
    if (signal?.aborted) break;
    onStart?.({ id: taskId, mode });
    const r = await runTask({ backend, preview, taskId, mode, order, signal, onText, onProgress });
    out.runs.push(r);
    onRun?.(r);
  }

  out.finishedAt = new Date().toISOString();
  out.summary = summarize(out.runs);
  return out;
}

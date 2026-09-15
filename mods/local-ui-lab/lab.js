/**
 * Local UI Lab: one request, end to end, measured.
 *
 * The chat box and the benchmark both go through runRequest, so a number in notes/results.md
 * was measured the same way as what a person sees in the app.
 *
 * What gets timed, all from the moment the request is sent:
 * - ttftMs: the first token of any kind.
 * - firstPaintMs: something visible changed. For a new page or a rewrite, the first partial
 *   document with content in its body. For a patch, the first block that applied.
 * - totalMs: the last token.
 * The runtime's own counters (tokens, tok/s, load time) come back in `metrics`.
 */

import { buildMessages, DEFAULT_ORDER } from './prompts.js';
import { createPatchParser, applyBlock, extractHtml, createThinkFilter } from './patch.js';
import { ollamaStream, webllmStream, WEBLLM_MODEL } from './backends.js';

/** `ollama:<model>` or `webllm`, the value the backend picker and window.lab use. */
export function parseBackend(key) {
  if (key === 'webllm') return { kind: 'webllm', model: WEBLLM_MODEL, key };
  if (typeof key === 'string' && key.startsWith('ollama:')) return { kind: 'ollama', model: key.slice(7), key };
  throw new Error(`unknown backend: ${key}`);
}

function streamFor(backend, messages, signal, onProgress) {
  return backend.kind === 'webllm'
    ? webllmStream({ messages, signal, onProgress })
    : ollamaStream({ model: backend.model, messages, signal });
}

export async function runRequest({ backend, mode, request, html = '', order, preview, signal, onText, onBlock, onProgress }) {
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);

  const messages = buildMessages(mode, html, request, { order });
  const result = {
    backend: backend.key,
    runtime: backend.kind,
    model: backend.model,
    mode,
    order: mode === 'generate' ? (order || DEFAULT_ORDER) : null,
    request,
    at: new Date().toISOString(),
    inputChars: messages.reduce((n, m) => n + m.content.length, 0),
    ttftMs: null,
    firstPaintMs: null,
    totalMs: null,
    metrics: null,
    error: null,
    aborted: false,
    // What the model added that it was told not to.
    fenced: false,
    prose: false,
    thought: false,
    // A new page or rewrite: did `</html>` arrive? A patch: did the reply stop mid-block?
    complete: null,
    unterminated: false,
    patches: mode === 'patch' ? { blocks: 0, applied: 0, failed: 0, whitespace: 0, ambiguous: 0, failures: [] } : null,
    raw: '',
    html,
    render: null,
  };

  const think = createThinkFilter();
  const parser = mode === 'patch' ? createPatchParser() : null;
  let text = '';
  let page = html;

  const unsubscribe = preview.subscribe((m) => {
    if (m.kind === 'paint' && result.firstPaintMs === null) result.firstPaintMs = since();
  });

  const applyBlocks = (blocks) => {
    const p = result.patches;
    for (const block of blocks) {
      const r = applyBlock(page, block);
      p.blocks++;
      if (r.ok) {
        page = r.html;
        p.applied++;
        if (r.how === 'whitespace') p.whitespace++;
        if (r.occurrences > 1) p.ambiguous++;
        preview.show(page);
        if (result.firstPaintMs === null) result.firstPaintMs = since();
      } else {
        p.failed++;
        p.failures.push({ reason: r.reason, search: block.search.slice(0, 240) });
      }
      onBlock?.(block, r);
    }
  };

  const take = (chunk) => {
    if (!chunk) return;
    text += chunk;
    if (parser) {
      applyBlocks(parser.feed(chunk));
    } else {
      const { html: partial } = extractHtml(text);
      if (partial) preview.stream(partial);
    }
  };

  try {
    for await (const ev of streamFor(backend, messages, signal, onProgress)) {
      if (ev.delta) {
        if (result.ttftMs === null) result.ttftMs = since();
        result.raw += ev.delta;
        onText?.(ev.delta);
        take(think.push(ev.delta));
      }
      if (ev.metrics) result.metrics = ev.metrics;
    }
  } catch (e) {
    if (e?.name === 'AbortError' || signal?.aborted) result.aborted = true;
    else result.error = e?.message || String(e);
  }
  take(think.end());
  result.totalMs = since();
  result.thought = think.thought;
  unsubscribe();

  if (parser) {
    const end = parser.end();
    applyBlocks(end.blocks);
    result.unterminated = end.unterminated;
    const s = parser.stats;
    result.prose = s.prose > 0;
    result.fenced = s.fences > 0;
    result.html = page;
    if (result.patches.applied > 0) result.render = await preview.settle();
  } else {
    const ex = extractHtml(text);
    result.fenced = ex.fenced;
    result.prose = ex.prose;
    result.complete = ex.complete;
    if (ex.html) {
      result.html = ex.html;
      preview.show(ex.html);
      result.render = await preview.settle();
    } else if (html) {
      // Nothing usable came back. Put the page that was there back on screen.
      preview.show(html);
    }
  }
  return result;
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};

/** Per-mode medians and counts over a set of benchmark runs. */
export function summarize(runs) {
  const out = {};
  for (const mode of ['generate', 'patch', 'rewrite']) {
    const rs = runs.filter((r) => r.mode === mode);
    if (!rs.length) continue;
    out[mode] = {
      runs: rs.length,
      pass: rs.filter((r) => r.pass).length,
      ttftMs: median(rs.map((r) => r.ttftMs)),
      firstPaintMs: median(rs.map((r) => r.firstPaintMs)),
      totalMs: median(rs.map((r) => r.totalMs)),
      outputTokens: median(rs.map((r) => r.metrics?.outputTokens)),
      tokPerSec: median(rs.map((r) => r.metrics?.tokPerSec)),
      scriptErrors: rs.reduce((n, r) => n + (r.check?.scriptErrors || 0), 0),
      fenced: rs.filter((r) => r.fenced).length,
      prose: rs.filter((r) => r.prose).length,
      errors: rs.filter((r) => r.error).length,
      ...(mode === 'patch' ? {
        blocksApplied: rs.reduce((n, r) => n + r.patches.applied, 0),
        blocksFailed: rs.reduce((n, r) => n + r.patches.failed, 0),
      } : {}),
    };
  }
  return out;
}

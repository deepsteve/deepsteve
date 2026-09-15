/**
 * Local UI Lab: the two model backends, behind one interface.
 *
 * Each is an async generator that yields `{ delta }` as text arrives and one `{ metrics }` when
 * the model is done. Everything downstream (the preview, the patcher, the benchmark) handles
 * both identically, which is what makes their numbers comparable.
 *
 * - Ollama: a model served on this machine. The page cannot reach Ollama itself (its CORS
 *   allowlist does not include deepsteve.localhost), so this reads the NDJSON stream that
 *   tools.js relays.
 * - WebLLM: the model runs in this page on WebGPU. Nothing is installed; the weights download
 *   once into the browser's cache. It never touches the daemon.
 */

import { SAMPLING } from './prompts.js';

export const WEBLLM_VERSION = '0.2.85';
export const WEBLLM_MODEL = 'Qwen3.5-4B-q4f16_1-MLC';

export async function listOllamaModels() {
  const res = await fetch('/api/local-ui-lab/models');
  if (!res.ok) throw new Error(`model list failed (${res.status})`);
  return res.json();
}

export async function* ollamaStream({ model, messages, signal }) {
  const res = await fetch('/api/local-ui-lab/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, options: SAMPLING }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `generate failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        if (ev.delta) yield { delta: ev.delta };
        if (ev.done) yield { metrics: { runtime: 'ollama', model, ...ev.metrics } };
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// ── WebLLM ──────────────────────────────────────────────────────────────────────────

let engine = null;
let loading = null;
let progressListener = null;
// Reported once, on the first request after a load, so a warm request never claims it.
let unreportedLoadMs = 0;

export function webgpuAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Download (first time) or restore from cache, then compile, the in-browser model.
 * Resolves to `{ loadMs }`, where loadMs is 0 if it was already loaded.
 */
export function loadWebllm(onProgress) {
  if (onProgress) progressListener = onProgress;
  if (engine) return Promise.resolve({ loadMs: 0 });
  if (!loading) {
    loading = (async () => {
      if (!webgpuAvailable()) {
        throw new Error('This browser has no WebGPU (navigator.gpu is missing), so the in-browser model cannot run here.');
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('WebGPU is present, but the browser granted no GPU adapter.');
      const started = performance.now();
      const webllm = await import(`https://esm.run/@mlc-ai/web-llm@${WEBLLM_VERSION}`);
      engine = await webllm.CreateMLCEngine(WEBLLM_MODEL, {
        initProgressCallback: (report) => progressListener?.(report),
      });
      const loadMs = Math.round(performance.now() - started);
      unreportedLoadMs = loadMs;
      return { loadMs };
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

export async function* webllmStream({ messages, signal, onProgress }) {
  await loadWebllm(onProgress);
  const loadMs = unreportedLoadMs;
  unreportedLoadMs = 0;

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const stop = () => { try { engine.interruptGenerate(); } catch {} };
  signal?.addEventListener('abort', stop);
  try {
    const chunks = await engine.chat.completions.create({
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: SAMPLING.temperature,
      top_p: SAMPLING.top_p,
      presence_penalty: SAMPLING.presence_penalty,
      // Qwen3 and 3.5 think by default; this is the switch WebLLM's own qwen3 example uses.
      extra_body: { enable_thinking: false },
    });
    let doneReason = null;
    for await (const chunk of chunks) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) yield { delta: choice.delta.content };
      if (choice?.finish_reason) doneReason = choice.finish_reason;
      if (chunk.usage) {
        const u = chunk.usage;
        const decode = u.extra?.decode_tokens_per_s;
        yield {
          metrics: {
            runtime: 'webllm',
            model: WEBLLM_MODEL,
            loadMs,
            promptTokens: u.prompt_tokens ?? null,
            promptMs: u.extra?.time_to_first_token_s != null ? Math.round(u.extra.time_to_first_token_s * 1000) : null,
            outputTokens: u.completion_tokens ?? null,
            evalMs: decode ? Math.round((u.completion_tokens / decode) * 1000) : null,
            tokPerSec: decode ? +decode.toFixed(1) : null,
            prefillTokPerSec: u.extra?.prefill_tokens_per_s ? +u.extra.prefill_tokens_per_s.toFixed(1) : null,
            doneReason,
          },
        };
      }
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

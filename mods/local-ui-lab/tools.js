/**
 * Local UI Lab (experiment, #706): the server half, which is only a streaming bridge to Ollama.
 *
 * WHY THE BROWSER CANNOT CALL OLLAMA ITSELF. Ollama's default CORS allowlist is localhost,
 * 127.0.0.1 and 0.0.0.0 on any port. The app's origin is http://deepsteve.localhost:<port>,
 * which is not on it, so a fetch from the page is refused unless the user reconfigures Ollama
 * with OLLAMA_ORIGINS. Node has no CORS, so the page asks this route and the route asks
 * Ollama. /api/proxy cannot do the job: it is GET-only and buffers the whole response.
 *
 * WHY THE UPSTREAM IS A CONSTANT. The request names a model, never a URL, and the model has to
 * be one Ollama already lists. So this route can reach one loopback port and nothing else.
 *
 * WHY THIS REGISTERS NO MCP TOOLS. The lab measures a small model driven by a human, and it is
 * the page that measures it. The in-browser backend (WebLLM on WebGPU) never touches the
 * server at all, which is also the "nothing to install" half of the comparison.
 */

const OLLAMA = 'http://127.0.0.1:11434';

// Only the sampling knobs a comparison needs. Anything else a client sends is dropped.
const OPTION_KEYS = ['temperature', 'top_p', 'top_k', 'presence_penalty', 'repeat_penalty', 'num_ctx', 'num_predict', 'seed'];

// A page, a change request and a rewritten page fit comfortably in this. Ollama's default
// is smaller on some versions, and a silently truncated prompt looks like a bad model.
const DEFAULT_NUM_CTX = 8192;

let ctx = null;
const log = (...a) => (ctx?.log || console.log)(...a);

/** Ollama's local models. A cloud model is listed too, but is not a local model, so it is dropped. */
async function listModels() {
  const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const body = await res.json();
  return (body.models || [])
    .filter(m => !m.remote_host && !/(^|[:-])cloud$/.test(m.name))
    .map(m => ({
      name: m.name,
      size: m.size,
      parameterSize: m.details?.parameter_size || null,
      quantization: m.details?.quantization_level || null,
      family: m.details?.family || null,
    }));
}

function pickOptions(raw) {
  const out = { num_ctx: DEFAULT_NUM_CTX };
  for (const key of OPTION_KEYS) {
    const v = raw?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

const ns = (v) => (typeof v === 'number' ? Math.round(v / 1e6) : null);

/** Ollama's own timings from the final frame, in milliseconds. */
function pickMetrics(ev) {
  const evalMs = ns(ev.eval_duration);
  return {
    loadMs: ns(ev.load_duration),
    promptTokens: ev.prompt_eval_count ?? null,
    promptMs: ns(ev.prompt_eval_duration),
    outputTokens: ev.eval_count ?? null,
    evalMs,
    tokPerSec: ev.eval_count && evalMs ? +(ev.eval_count / (evalMs / 1000)).toFixed(1) : null,
    doneReason: ev.done_reason || null,
  };
}

function validMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.length <= 8
    && messages.every(m => ['system', 'user', 'assistant'].includes(m?.role) && typeof m.content === 'string');
}

function init(context) {
  ctx = context;
  return {};
}

function registerRoutes(app, context) {
  ctx = ctx || context;

  app.get('/api/local-ui-lab/models', async (req, res) => {
    try {
      res.json({ ollama: 'up', models: await listModels() });
    } catch (e) {
      res.json({ ollama: 'down', models: [], error: e.message });
    }
  });

  // One generation, streamed back as NDJSON: `{delta}` lines as tokens arrive, then one
  // `{done, metrics}`. The page reads the body incrementally, so the first token reaches the
  // preview as soon as Ollama produces it.
  app.post('/api/local-ui-lab/generate', async (req, res) => {
    const { model, messages, options } = req.body || {};
    if (typeof model !== 'string' || !validMessages(messages)) {
      return res.status(400).json({ error: 'model (string) and messages [{role, content}] required' });
    }

    let models;
    try {
      models = await listModels();
    } catch (e) {
      return res.status(503).json({ error: `Ollama is not reachable at ${OLLAMA}. Start it with \`ollama serve\` or the Ollama app.` });
    }
    if (!models.some(m => m.name === model)) {
      return res.status(400).json({ error: `"${model}" is not a local Ollama model. Pull it with \`ollama pull ${model}\`.` });
    }

    // Closing the response (Stop in the page, or a reload) aborts the upstream request, which
    // is what makes Ollama actually stop generating rather than finishing into the void.
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const startedAt = Date.now();
    let upstream;
    try {
      upstream = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          think: false,
          keep_alive: '15m',
          options: pickOptions(options),
        }),
        signal: abort.signal,
      });
    } catch (e) {
      if (abort.signal.aborted) return;
      return res.status(502).json({ error: `Ollama request failed: ${e.message}` });
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(502).json({ error: `Ollama returned ${upstream.status}: ${text.slice(0, 400)}` });
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    const write = (obj) => { try { res.write(`${JSON.stringify(obj)}\n`); } catch {} };

    let buf = '';
    let metrics = null;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.error) { write({ error: String(ev.error) }); continue; }
          const delta = ev.message?.content;
          if (delta) write({ delta });
          if (ev.done) {
            metrics = pickMetrics(ev);
            write({ done: true, metrics });
          }
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) write({ error: e.message });
    }
    res.end();

    log(`[local-ui-lab] ${model} ${abort.signal.aborted && !metrics ? 'aborted' : 'done'} in ${Date.now() - startedAt}ms`
      + (metrics ? ` tokens=${metrics.outputTokens} tok/s=${metrics.tokPerSec} load=${metrics.loadMs}ms` : ''));
  });
}

module.exports = { init, registerRoutes };

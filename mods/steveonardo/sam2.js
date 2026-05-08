// SAM2.1 click-prompt segmentation in the browser via ONNX Runtime Web.
//
// Uses the quantized uint8 export from `onnx-community/sam2.1-hiera-tiny-ONNX`,
// mirrored to the deepsteve R2 bucket. The fp32 fp32 hiera-tiny encoder we
// shipped first (134 MB) failed to instantiate in Firefox WASM with an opaque
// raw pointer error; the uint8 quantized encoder is ~53 MB and loads fine.
//
// Each session needs two files: a small .onnx graph + a sibling .onnx_data
// blob holding the externalized weights. ORT-Web wires them up via the
// `externalData` session option.
//
// `ort` is expected to be loaded as a global via the <script> tag in index.html.

const MODEL_BASE = 'https://models.deepsteve.com/models/sam2.1-hiera-tiny-uint8/';
const MODELS = {
  encoder: { graph: 'vision_encoder_uint8.onnx', data: 'vision_encoder_uint8.onnx_data' },
  decoder: { graph: 'prompt_encoder_mask_decoder_uint8.onnx', data: 'prompt_encoder_mask_decoder_uint8.onnx_data' },
};

// Bump when re-uploading models to invalidate the Cache API.
const CACHE_NAME = 'steveonardo-models-v2';

// SAM2 hiera-tiny operates on 1024×1024 inputs.
const SAM2_INPUT_SIZE = 1024;

// ImageNet normalization (matches preprocessor_config.json on HuggingFace).
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

async function fetchWithCache(url, onProgress) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    onProgress?.({ phase: 'cached', loaded: 1, total: 1 });
    return await cached.arrayBuffer();
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);

  const total = Number(resp.headers.get('content-length')) || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ phase: 'download', loaded, total });
  }

  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }

  await cache.put(url, new Response(buf, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(loaded) },
  }));

  return buf.buffer;
}

async function fetchModelPair(spec, onProgress) {
  // Fetch graph and external-data files concurrently, reporting combined progress.
  const graphUrl = MODEL_BASE + spec.graph;
  const dataUrl = MODEL_BASE + spec.data;
  let graphLoaded = 0, dataLoaded = 0, graphTotal = 0, dataTotal = 0;
  const report = () => onProgress?.({
    phase: 'download',
    loaded: graphLoaded + dataLoaded,
    total: graphTotal && dataTotal ? graphTotal + dataTotal : 0,
  });
  const [graph, data] = await Promise.all([
    fetchWithCache(graphUrl, p => {
      if (p.phase === 'cached') return onProgress?.(p);
      graphLoaded = p.loaded; graphTotal = p.total; report();
    }),
    fetchWithCache(dataUrl, p => {
      if (p.phase === 'cached') return;
      dataLoaded = p.loaded; dataTotal = p.total; report();
    }),
  ]);
  return { graph, data };
}

function letterboxToTensor(bitmap) {
  // Resize the source bitmap into a 1024×1024 canvas, preserving aspect ratio
  // by padding with zeros. Returns the NCHW float32 tensor + the transform
  // needed to map canvas (image-space) coordinates into the 1024 space.
  const srcW = bitmap.width, srcH = bitmap.height;
  const scale = SAM2_INPUT_SIZE / Math.max(srcW, srcH);
  const dstW = Math.round(srcW * scale);
  const dstH = Math.round(srcH * scale);
  const padX = Math.floor((SAM2_INPUT_SIZE - dstW) / 2);
  const padY = Math.floor((SAM2_INPUT_SIZE - dstH) / 2);

  const off = new OffscreenCanvas(SAM2_INPUT_SIZE, SAM2_INPUT_SIZE);
  const ctx = off.getContext('2d');
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, SAM2_INPUT_SIZE, SAM2_INPUT_SIZE);
  ctx.drawImage(bitmap, padX, padY, dstW, dstH);

  const { data } = ctx.getImageData(0, 0, SAM2_INPUT_SIZE, SAM2_INPUT_SIZE);
  const planeSize = SAM2_INPUT_SIZE * SAM2_INPUT_SIZE;
  const out = new Float32Array(3 * planeSize);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] / 255 - MEAN[0]) / STD[0];
    out[p + planeSize] = (data[i + 1] / 255 - MEAN[1]) / STD[1];
    out[p + planeSize * 2] = (data[i + 2] / 255 - MEAN[2]) / STD[2];
  }

  return {
    tensor: new ort.Tensor('float32', out, [1, 3, SAM2_INPUT_SIZE, SAM2_INPUT_SIZE]),
    transform: { scale, padX, padY, srcW, srcH },
  };
}

function mapPoint(p, t) {
  return [p.x * t.scale + t.padX, p.y * t.scale + t.padY];
}

// Render a 256×256 logit mask plane into a canvas at original-image dimensions.
// The decoder produces a [1, 1, 3, 256, 256] tensor; pass which mask index to use.
function maskPlaneToCanvas(maskTensor, planeIdx, transform) {
  const { dims, data } = maskTensor;
  const maskH = dims[dims.length - 2];
  const maskW = dims[dims.length - 1];
  const planeSize = maskH * maskW;
  const offset = planeIdx * planeSize;

  const lo = new OffscreenCanvas(maskW, maskH);
  const lctx = lo.getContext('2d');
  const img = lctx.createImageData(maskW, maskH);
  for (let i = 0; i < planeSize; i++) {
    const v = data[offset + i] > 0 ? 255 : 0;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = v;
  }
  lctx.putImageData(img, 0, 0);

  const { scale, padX, padY, srcW, srcH } = transform;
  const activeW = Math.round(srcW * scale);
  const activeH = Math.round(srcH * scale);
  const cropX = (padX / SAM2_INPUT_SIZE) * maskW;
  const cropY = (padY / SAM2_INPUT_SIZE) * maskH;
  const cropW = (activeW / SAM2_INPUT_SIZE) * maskW;
  const cropH = (activeH / SAM2_INPUT_SIZE) * maskH;

  const out = document.createElement('canvas');
  out.width = srcW;
  out.height = srcH;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.drawImage(lo, cropX, cropY, cropW, cropH, 0, 0, srcW, srcH);
  return out;
}

export async function initSAM2(onProgress) {
  if (typeof ort === 'undefined') throw new Error('ONNX Runtime Web (ort) is not loaded');

  // Single-threaded WASM works without cross-origin isolation; SAB threads need COOP/COEP.
  ort.env.wasm.numThreads = 1;

  // Run inference in a Web Worker so the encoder (~6s) doesn't freeze the UI.
  // The worker needs an absolute wasmPaths since its base URL differs from
  // the iframe document.
  ort.env.wasm.proxy = true;
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

  onProgress?.({ stage: 'encoder-fetch' });
  const encParts = await fetchModelPair(MODELS.encoder, p => onProgress?.({ stage: 'encoder-fetch', ...p }));
  onProgress?.({ stage: 'encoder-init' });
  const encoder = await createSession(encParts, MODELS.encoder.data, 'encoder');

  onProgress?.({ stage: 'decoder-fetch' });
  const decParts = await fetchModelPair(MODELS.decoder, p => onProgress?.({ stage: 'decoder-fetch', ...p }));
  onProgress?.({ stage: 'decoder-init' });
  const decoder = await createSession(decParts, MODELS.decoder.data, 'decoder');

  let embeds = null;  // { e0, e1, e2 }
  let transform = null;

  async function setImage(bitmap) {
    const { tensor, transform: t } = letterboxToTensor(bitmap);
    const out = await encoder.run({ pixel_values: tensor });
    embeds = {
      e0: out['image_embeddings.0'],
      e1: out['image_embeddings.1'],
      e2: out['image_embeddings.2'],
    };
    if (!embeds.e0 || !embeds.e1 || !embeds.e2) {
      throw new Error(`Unexpected encoder outputs: ${encoder.outputNames.join(', ')}`);
    }
    transform = t;
  }

  async function predict(points, box) {
    if (!embeds) throw new Error('setImage() must be called before predict()');
    if (!points?.length && !box) return null;

    // The decoder needs at least one entry in input_points; pad with a
    // sentinel point (label = -1) when the prompt is box-only.
    const pts = points?.length ? points : [{ x: 0, y: 0, label: -1 }];
    const N = pts.length;
    const coords = new Float32Array(N * 2);
    const labels = new BigInt64Array(N);
    pts.forEach((p, i) => {
      const [mx, my] = mapPoint(p, transform);
      coords[i * 2] = mx;
      coords[i * 2 + 1] = my;
      labels[i] = BigInt(p.label);  // 1=fg, 0=bg, -1=padding/box-only
    });

    // Box: corner-to-corner in 1024-space, shape [1,1,4]. Empty [1,0,4] when
    // there is no box — passing [1,1,4] zeros gets read as a real box at the
    // origin and tanks IoU.
    let boxData, boxDims;
    if (box) {
      const [x1, y1] = mapPoint({ x: box.x1, y: box.y1 }, transform);
      const [x2, y2] = mapPoint({ x: box.x2, y: box.y2 }, transform);
      boxData = new Float32Array([x1, y1, x2, y2]);
      boxDims = [1, 1, 4];
    } else {
      boxData = new Float32Array(0);
      boxDims = [1, 0, 4];
    }

    const feeds = {
      input_points: new ort.Tensor('float32', coords, [1, 1, N, 2]),
      input_labels: new ort.Tensor('int64', labels, [1, 1, N]),
      input_boxes: new ort.Tensor('float32', boxData, boxDims),
      'image_embeddings.0': embeds.e0,
      'image_embeddings.1': embeds.e1,
      'image_embeddings.2': embeds.e2,
    };

    const out = await decoder.run(feeds);
    const masks = out.pred_masks;     // [1, 1, 3, 256, 256]
    const ious = out.iou_scores;      // [1, 1, 3]

    // Pick the candidate with highest predicted IoU.
    let bestIdx = 0, bestIou = -Infinity;
    for (let k = 0; k < ious.data.length; k++) {
      if (ious.data[k] > bestIou) { bestIou = ious.data[k]; bestIdx = k; }
    }
    return maskPlaneToCanvas(masks, bestIdx, transform);
  }

  function reset() {
    embeds = null;
    transform = null;
  }

  function isReady() { return embeds !== null; }

  onProgress?.({ stage: 'ready' });
  return { setImage, predict, reset, isReady };
}

async function createSession(parts, dataPath, label) {
  const ctx = { model: label, graphBytes: parts.graph.byteLength, dataBytes: parts.data.byteLength, ua: navigator.userAgent };
  const opts = {
    executionProviders: ['webgpu', 'wasm'],
    externalData: [{ data: parts.data, path: dataPath }],
  };
  try {
    return await ort.InferenceSession.create(parts.graph, opts);
  } catch (e) {
    console.warn('[SAM2] WebGPU init failed, falling back to WASM:', { ...ctx, message: decodeOrtError(e) || e.message });
    try {
      return await ort.InferenceSession.create(parts.graph, { ...opts, executionProviders: ['wasm'] });
    } catch (e2) {
      const decoded = decodeOrtError(e2);
      console.error('[SAM2] WASM init failed:', { ...ctx, message: decoded || e2.message });
      if (decoded) throw new Error(`${label}: ${decoded}`);
      throw e2;
    }
  }
}

// ORT-Web throws raw WASM heap pointers (or errors whose .message is one).
// Decoding them requires reaching the WASM module's HEAPU8, which ORT does
// not expose publicly. We try a handful of likely places and give up
// gracefully — the verbose console log set in initSAM2 is the real fallback.
export function decodeOrtError(e) {
  const ptr = typeof e === 'number' ? e
            : typeof e?.message === 'number' ? e.message
            : null;
  if (ptr == null) return null;
  const heap = findOrtHeap();
  if (!heap) return null;
  try {
    let end = ptr;
    while (end < heap.length && heap[end] !== 0) end++;
    const str = new TextDecoder().decode(heap.subarray(ptr, end));
    return str || null;
  } catch {
    return null;
  }
}

function findOrtHeap() {
  const ort = globalThis.ort;
  const candidates = [
    ort?.env?.wasm,
    ort?.env?.wasm?.module,
    globalThis.ortWasmThreaded,
    globalThis.ortWasm,
  ];
  for (const c of candidates) {
    if (c?.HEAPU8 instanceof Uint8Array) return c.HEAPU8;
  }
  if (ort) {
    for (const k of Object.keys(ort)) {
      const v = ort[k];
      if (v && typeof v === 'object' && v.HEAPU8 instanceof Uint8Array) return v.HEAPU8;
    }
  }
  return null;
}

// SAM2 click-prompt segmentation in the browser via ONNX Runtime Web.
//
// The encoder runs once per image (~hundreds of MB of compute, slow on first call).
// The decoder runs per click (cheap). Models are cached in the Cache API so the
// 50–60 MB download is paid only once per browser/origin.
//
// `ort` is expected to be loaded as a global via the <script> tag in index.html.

const MODELS = {
  encoder: 'https://models.deepsteve.com/models/sam2/sam2_hiera_tiny.encoder.onnx',
  decoder: 'https://models.deepsteve.com/models/sam2/sam2_hiera_tiny.decoder.onnx',
};

// Bump this to invalidate cached weights (e.g. after re-uploading models).
const CACHE_NAME = 'steveonardo-models-v1';

// SAM2 hiera-tiny operates on 1024×1024 inputs.
const SAM2_INPUT_SIZE = 1024;

// ImageNet normalization (the SAM2 export expects this preprocessing).
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

  // Persist for next time. Use a fresh Response — the original was consumed.
  await cache.put(url, new Response(buf, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(loaded),
    },
  }));

  return buf.buffer;
}

// Find the input/output name in `names` that contains any of the keywords.
// SAM2 ONNX exports vary slightly between authors; this lets us tolerate that.
function pickName(names, ...keywords) {
  for (const kw of keywords) {
    const hit = names.find(n => n.toLowerCase().includes(kw));
    if (hit) return hit;
  }
  return null;
}

function mapDecoderInputs(names) {
  const get = (...kw) => pickName(names, ...kw);
  return {
    imageEmbed: get('image_embed', 'image_embeddings'),
    feats0: get('high_res_feats_0', 'high_res_features_0', 'high_res_feat0'),
    feats1: get('high_res_feats_1', 'high_res_features_1', 'high_res_feat1'),
    pointCoords: get('point_coord'),
    pointLabels: get('point_label'),
    maskInput: get('mask_input'),
    hasMaskInput: get('has_mask'),
    origImSize: get('orig_im_size', 'image_size'),
  };
}

function mapDecoderOutputs(names) {
  return {
    masks: pickName(names, 'mask'),
    iou: pickName(names, 'iou', 'score'),
  };
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
  // RGBA → CHW float, ImageNet-normalized.
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

// Map a click in canvas/image-space into the model's 1024-space.
function mapPoint(p, t) {
  return [p.x * t.scale + t.padX, p.y * t.scale + t.padY];
}

// Decode the lowest-res mask (256×256, logits) into an image-space binary mask
// drawn on a canvas matching the original image dimensions.
function maskTensorToCanvas(maskTensor, transform) {
  const { dims, data } = maskTensor;
  // dims: [1, num_masks, H, W] — pick the first mask plane.
  const maskH = dims[dims.length - 2];
  const maskW = dims[dims.length - 1];

  // Render the 256×256 logit mask into a canvas, then resample into image-space.
  const lo = new OffscreenCanvas(maskW, maskH);
  const lctx = lo.getContext('2d');
  const img = lctx.createImageData(maskW, maskH);
  for (let i = 0; i < maskW * maskH; i++) {
    const v = data[i] > 0 ? 255 : 0;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = v;
  }
  lctx.putImageData(img, 0, 0);

  // Crop the active (non-padded) region from the 1024-space, then upscale to image-space.
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
  // jsDelivr serves the matching .wasm assets next to ort.min.js automatically.
  // wasmPaths is left at default unless overridden.

  onProgress?.({ stage: 'encoder-fetch' });
  const encoderBuf = await fetchWithCache(MODELS.encoder, p => onProgress?.({ stage: 'encoder-fetch', ...p }));
  onProgress?.({ stage: 'encoder-init' });
  const encoder = await createSession(encoderBuf, 'encoder');

  onProgress?.({ stage: 'decoder-fetch' });
  const decoderBuf = await fetchWithCache(MODELS.decoder, p => onProgress?.({ stage: 'decoder-fetch', ...p }));
  onProgress?.({ stage: 'decoder-init' });
  const decoder = await createSession(decoderBuf, 'decoder');

  const decIn = mapDecoderInputs(decoder.inputNames);
  const decOut = mapDecoderOutputs(decoder.outputNames);

  let imageEmbed = null;
  let feats0 = null;
  let feats1 = null;
  let transform = null;

  async function setImage(bitmap) {
    const { tensor, transform: t } = letterboxToTensor(bitmap);
    const encoderInputName = encoder.inputNames[0];
    const out = await encoder.run({ [encoderInputName]: tensor });
    // Find embeddings + high-res features in the encoder output by name pattern.
    const embedName = pickName(encoder.outputNames, 'image_embed', 'image_embeddings');
    const f0Name = pickName(encoder.outputNames, 'high_res_feats_0', 'high_res_features_0');
    const f1Name = pickName(encoder.outputNames, 'high_res_feats_1', 'high_res_features_1');
    if (!embedName) throw new Error(`Could not find image embedding in encoder outputs: ${encoder.outputNames.join(', ')}`);
    imageEmbed = out[embedName];
    feats0 = f0Name ? out[f0Name] : null;
    feats1 = f1Name ? out[f1Name] : null;
    transform = t;
  }

  async function predict(points) {
    if (!imageEmbed) throw new Error('setImage() must be called before predict()');
    if (points.length === 0) return null;

    const coords = new Float32Array(points.length * 2);
    const labels = new Float32Array(points.length);
    points.forEach((p, i) => {
      const [mx, my] = mapPoint(p, transform);
      coords[i * 2] = mx;
      coords[i * 2 + 1] = my;
      labels[i] = p.label;
    });

    const feeds = {};
    if (decIn.imageEmbed) feeds[decIn.imageEmbed] = imageEmbed;
    if (decIn.feats0 && feats0) feeds[decIn.feats0] = feats0;
    if (decIn.feats1 && feats1) feeds[decIn.feats1] = feats1;
    if (decIn.pointCoords) feeds[decIn.pointCoords] = new ort.Tensor('float32', coords, [1, points.length, 2]);
    if (decIn.pointLabels) feeds[decIn.pointLabels] = new ort.Tensor('float32', labels, [1, points.length]);
    if (decIn.maskInput) feeds[decIn.maskInput] = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]);
    if (decIn.hasMaskInput) feeds[decIn.hasMaskInput] = new ort.Tensor('float32', new Float32Array([0]), [1]);
    if (decIn.origImSize) feeds[decIn.origImSize] = new ort.Tensor('float32', new Float32Array([SAM2_INPUT_SIZE, SAM2_INPUT_SIZE]), [2]);

    const missing = decoder.inputNames.filter(n => !(n in feeds));
    if (missing.length) {
      // Tell the user which inputs we couldn't auto-fill so they can patch the
      // mapping in mapDecoderInputs() rather than hit a cryptic ORT error.
      console.warn('[SAM2] Decoder inputs not auto-mapped:', missing, 'Available:', decoder.inputNames);
    }

    const out = await decoder.run(feeds);
    const maskTensor = decOut.masks ? out[decOut.masks] : out[decoder.outputNames[0]];
    return maskTensorToCanvas(maskTensor, transform);
  }

  function reset() {
    imageEmbed = null;
    feats0 = null;
    feats1 = null;
    transform = null;
  }

  function isReady() { return imageEmbed !== null; }

  onProgress?.({ stage: 'ready' });
  return { setImage, predict, reset, isReady };
}

async function createSession(buf, label) {
  // Try WebGPU first (Chrome/Edge/Safari recent), fall back to WASM. ORT
  // throws if the requested EP isn't available, so we catch and retry.
  const ctx = { model: label, bytes: buf.byteLength, ua: navigator.userAgent };
  try {
    return await ort.InferenceSession.create(buf, { executionProviders: ['webgpu', 'wasm'] });
  } catch (e) {
    console.warn('[SAM2] WebGPU init failed, falling back to WASM:', { ...ctx, message: decodeOrtError(e) || e.message });
    try {
      return await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    } catch (e2) {
      const decoded = decodeOrtError(e2);
      console.error('[SAM2] WASM init failed:', { ...ctx, message: decoded || e2.message });
      // Rethrow with a real string so callers' describeError() surfaces it
      // instead of the raw WASM heap pointer that ORT-Web hands back.
      if (decoded) throw new Error(`${label}: ${decoded}`);
      throw e2;
    }
  }
}

// ORT-Web throws errors whose .message is a numeric pointer into the WASM
// linear memory rather than a string. Walk the heap from that offset to the
// next NUL byte and decode as UTF-8. Returns null when the error isn't an
// ORT pointer-message, or when the heap isn't reachable.
export function decodeOrtError(e) {
  if (!e || typeof e.message !== 'number') return null;
  const wasm = globalThis.ort?.env?.wasm;
  const heap = wasm?.HEAPU8 || wasm?.module?.HEAPU8;
  if (!heap) return null;
  try {
    let end = e.message;
    while (end < heap.length && heap[end] !== 0) end++;
    const str = new TextDecoder().decode(heap.subarray(e.message, end));
    return str || null;
  } catch {
    return null;
  }
}

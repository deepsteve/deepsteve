# Steveonardo

In-browser image editor with click-prompt segmentation via SAM2 (Segment Anything 2) running on ONNX Runtime Web.

## SAM2 weight hosting

The mod streams two ONNX files from `models.deepsteve.com`:

- `https://models.deepsteve.com/models/sam2/sam2_hiera_tiny.encoder.onnx`
- `https://models.deepsteve.com/models/sam2/sam2_hiera_tiny.decoder.onnx`

Combined size is ~50 MB. The first time a browser loads the mod, both files are fetched and stored in the [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache) under the key `steveonardo-models-v1`. Subsequent loads read from cache — no network round trip — and the cache survives page reloads, daemon restarts, and browser quits.

To force re-download (e.g. after re-uploading models), bump `CACHE_NAME` in [`sam2.js`](./sam2.js) to `steveonardo-models-v2`.

### CORS

The R2/CDN origin must allow the deepsteve origin to read the `.onnx` files. A permissive policy works:

```
Access-Control-Allow-Origin: *
```

## Adapting to a different SAM2 export

ONNX exports of SAM2 differ slightly between authors (input/output names). [`sam2.js`](./sam2.js) tries to auto-map common names — `image_embed`/`image_embeddings`, `high_res_feats_0`, `point_coords`, etc.

If a model with different names is dropped in, the editor will log

```
[SAM2] Decoder inputs not auto-mapped: [...] Available: [...]
```

to the iframe's console (DevTools). Patch `mapDecoderInputs` / `mapDecoderOutputs` in `sam2.js` to add the new keyword.

## Files

- `mod.json` — manifest (`display: tab`, label `Steveonardo`).
- `index.html` — UI, inline styles, loads ORT from CDN.
- `editor.js` — canvas, drag-drop, paste, copy, undo, click-to-mask wiring.
- `sam2.js` — ONNX session management, encoder/decoder pipeline, Cache API.
- `storage.js` — IndexedDB undo history (10 entries, per-tab).

// The phone bridge's pure parts, tested in test/unit/fly-tiktok-phone.test.js.

// A page on this machine (Deep Steve serves deepsteve.localhost), or no Origin at all (curl, an
// <img>). Anything else is some other site in the same browser, which mustn't swipe the phone.
export function allowedOrigin(origin) {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return ['127.0.0.1', '[::1]', 'localhost'].includes(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

// Splits the helper's video stream, where each JPEG is a 4-byte big-endian length and then the
// bytes, back into JPEGs. Feed it chunks as they arrive; it calls onJpeg with each whole one.
export function jpegSplitter(onJpeg) {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (pending.length < 4 + length) break;
      onJpeg(Buffer.from(pending.subarray(4, 4 + length)));
      pending = pending.subarray(4 + length);
    }
  };
}

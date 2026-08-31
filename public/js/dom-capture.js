/**
 * DOM → PNG capture, shared by every feature that rasterizes the deepsteve UI (#667).
 *
 * This used to live inside mods/screenshots/screenshots.jsx, where it was reachable only
 * from that mod's own iframe. Timelapse needs the same rasterizer from the top document,
 * and the rule is one capture mechanism rather than two — so it lives here and both
 * import it.
 *
 * The library is `modern-screenshot`, loaded as a UMD global. The screenshots mod's
 * index.html still carries a <script> tag for it; the top document does not, so
 * ensureModernScreenshot() injects one on first use. Loading it lazily rather than from
 * public/index.html keeps 29 KB off every page load for a feature most sessions never
 * touch.
 */

export const MODERN_SCREENSHOT_VERSION = '4.6.8';
export const MODERN_SCREENSHOT_SRC =
  `https://cdn.jsdelivr.net/npm/modern-screenshot@${MODERN_SCREENSHOT_VERSION}/dist/index.js`;
// sha384 of the pinned dist, matching the SRI convention every CDN tag in
// public/index.html follows. Recompute if the version above ever moves:
//   curl -sfL <src> | openssl dgst -sha384 -binary | openssl base64 -A
export const MODERN_SCREENSHOT_SRI =
  'sha384-iLW2ozJS2l9FzbYKLQIW9TNbqNXam8a7J1ZRyNFZB9TjNxzwgyzTx8iMYBqSLa+W';

let _loading = null;

/**
 * Resolve once `window.modernScreenshot` exists in THIS document.
 *
 * Memoized on the promise, not on a boolean: two captures firing before the script has
 * loaded must await the same <script>, not append a second one.
 */
export function ensureModernScreenshot() {
  if (window.modernScreenshot) return Promise.resolve(window.modernScreenshot);
  if (_loading) return _loading;
  _loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MODERN_SCREENSHOT_SRC;
    s.integrity = MODERN_SCREENSHOT_SRI;
    s.crossOrigin = 'anonymous';
    s.addEventListener('load', () => {
      if (window.modernScreenshot) resolve(window.modernScreenshot);
      else reject(new Error('modern-screenshot loaded but exposed no global'));
    });
    s.addEventListener('error', () => {
      _loading = null; // let a later capture retry — a CDN blip should not be permanent
      reject(new Error('Failed to load modern-screenshot from ' + MODERN_SCREENSHOT_SRC));
    });
    document.head.appendChild(s);
  });
  return _loading;
}

/**
 * The child iframe that IS this element's content, or null.
 *
 * modern-screenshot can't see inside an <iframe>, so when the target is (or wraps) a
 * same-origin iframe — display tabs (`/api/display-tab/...`) and mod panels — the caller
 * captures the iframe's own document instead. The iframe is same-origin and sandboxed
 * with `allow-same-origin`, so its contentDocument is reachable.
 *
 * A child iframe only counts as "the content" when it is visible and covers at
 * least half of the element's area. Without that guard, capturing a container
 * that merely contains iframes (e.g. `#app-container`, which holds every hidden
 * panel-mod iframe) diverted to the first display:none iframe, whose 0×0 canvas
 * serializes to an invalid `data:,` URL and the capture failed.
 */
export function contentIframeOf(el) {
  if (el.tagName === 'IFRAME') return el;
  const elArea = Math.max(1, el.clientWidth * el.clientHeight);
  for (const fr of el.querySelectorAll('iframe')) {
    const area = fr.clientWidth * fr.clientHeight;
    if (area > 0 && area / elArea >= 0.5) return fr;
  }
  return null;
}

/**
 * Render a DOM element to a PNG data URL.
 *
 * @param {Element} el                    the element to rasterize
 * @param {boolean} [opts.divertToIframe] follow contentIframeOf() into a dominant child
 *   iframe (default true — what `screenshot_capture` has always done, and what makes
 *   capturing a display tab return the tab's content rather than a blank rectangle).
 *
 *   **Timelapse passes false, and that is load-bearing.** Its target is `#app-container`,
 *   and with a fullscreen App on screen — or a display-tab / project-mod tab active — the
 *   dominant iframe is that tab, so diverting would return the app and throw away the
 *   chrome the frame exists to record. The cost of not diverting is that iframe regions
 *   render blank, which the JSON sidecar makes interpretable by naming the active tab.
 * @param {number}  [opts.scale]          passed straight through to domToPng; < 1 shrinks
 *   the output. Timelapse uses 0.5 to keep a day-long run to tens of MB.
 */
export async function captureElementToPng(el, { divertToIframe = true, scale } = {}) {
  const modernScreenshot = await ensureModernScreenshot();
  const extra = scale === undefined ? {} : { scale };

  const iframe = divertToIframe ? contentIframeOf(el) : null;
  if (iframe) {
    let doc = null;
    try { doc = iframe.contentDocument; } catch { /* cross-origin */ }
    if (!doc || !doc.documentElement) {
      throw new Error('Cannot read iframe content (not yet loaded or cross-origin)');
    }
    const node = doc.documentElement;
    const bodyBg = doc.body && (doc.defaultView || window).getComputedStyle(doc.body).backgroundColor;
    return modernScreenshot.domToPng(node, {
      width: iframe.clientWidth || node.scrollWidth,
      height: iframe.clientHeight || node.scrollHeight,
      backgroundColor: bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' ? bodyBg : '#ffffff',
      ...extra,
    });
  }
  return modernScreenshot.domToPng(el, extra);
}

/**
 * Local UI Lab: the preview, the iframe the model's page renders into.
 *
 * WHY sandbox="allow-scripts" AND NOTHING ELSE. The page was written by a 4B model a moment
 * ago. Without allow-same-origin its origin is opaque: its scripts run, but they cannot touch
 * this app's document, the host's, or the daemon's API (a request from an opaque origin sends
 * no cookie and `Origin: null`). That is stricter than display tabs and project mods, which
 * carry trusted agent output. Nothing here needs more, because the parent never reads the
 * frame's DOM. Everything it learns about the page arrives by postMessage.
 *
 * TWO WAYS A DOCUMENT GETS IN.
 * - stream(partial), while a reply is still arriving. Reloading srcdoc on every token would
 *   flash and restart the page many times a second. Instead the frame holds a small bootstrap
 *   that parses each partial document with DOMParser and swaps in its styles and body.
 *   DOMParser marks scripts unexecutable, and the bootstrap drops them anyway, so nothing
 *   half-written ever runs.
 * - show(full), for a finished document. It loads for real through srcdoc, so its scripts
 *   run, with a reporter injected at the top of <head> that posts back runtime errors and a
 *   summary of what rendered.
 */

const TAG = 'local-ui-lab';

// A partial document is re-parsed at most this often. Fast enough to read as live, slow enough
// that a 60 tok/s model does not re-parse the page on every token.
const STREAM_INTERVAL_MS = 50;

const BOOTSTRAP = `<!DOCTYPE html><html><head><meta charset="utf-8"><style id="lab-live"></style></head><body><script>
(function () {
  var TAG = '${TAG}';
  var parser = new DOMParser();
  var live = document.getElementById('lab-live');
  var painted = false;
  function syncAttrs(from, to) {
    var i;
    for (i = to.attributes.length - 1; i >= 0; i--) to.removeAttribute(to.attributes[i].name);
    for (i = 0; i < from.attributes.length; i++) to.setAttribute(from.attributes[i].name, from.attributes[i].value);
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.lab !== TAG || m.kind !== 'partial') return;
    var doc = parser.parseFromString(m.html, 'text/html');
    var css = [];
    doc.querySelectorAll('style').forEach(function (s) { css.push(s.textContent); s.remove(); });
    doc.querySelectorAll('script').forEach(function (s) { s.remove(); });
    live.textContent = css.join('\\n');
    syncAttrs(doc.documentElement, document.documentElement);
    syncAttrs(doc.body, document.body);
    var nodes = [];
    doc.body.childNodes.forEach(function (n) { nodes.push(document.importNode(n, true)); });
    document.body.replaceChildren.apply(document.body, nodes);
    if (!painted && (document.body.children.length || document.body.textContent.trim())) {
      painted = true;
      parent.postMessage({ lab: TAG, kind: 'paint' }, '*');
    }
  });
  parent.postMessage({ lab: TAG, kind: 'boot-ready' }, '*');
})();
</script></body></html>`;

// Injected into every finished document. `loaded` carries a summary the benchmark's checks
// read: the parent cannot inspect an opaque-origin frame, so the frame describes itself.
// A canvas counts as drawn on only if its pixels are not all one colour, so a canvas that
// was merely filled with a background does not pass as a chart.
const REPORTER = `<script>(function () {
  var TAG = '${TAG}';
  function post(kind, extra) {
    var m = { lab: TAG, kind: kind };
    for (var k in extra) m[k] = extra[k];
    try { parent.postMessage(m, '*'); } catch (_) {}
  }
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window) {
      post('error', { resource: true, message: 'failed to load <' + String(e.target.tagName || '?').toLowerCase() + '>' });
    } else {
      post('error', { message: String(e.message || 'error'), line: e.lineno || 0 });
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    post('error', { message: 'unhandled rejection: ' + String(e.reason) });
  });
  function inked(c) {
    try {
      var g = c.getContext('2d');
      if (!g || !c.width || !c.height) return false;
      var d = g.getImageData(0, 0, c.width, c.height).data;
      for (var j = 4 * 13; j < d.length; j += 4 * 13) {
        if (d[j] !== d[0] || d[j + 1] !== d[1] || d[j + 2] !== d[2] || d[j + 3] !== d[3]) return true;
      }
    } catch (_) {}
    return false;
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      var b = document.body;
      if (!b) { post('loaded', { summary: { elements: 0, buttons: 0, inputs: 0, canvases: 0, inkedCanvas: false, text: '' } }); return; }
      var canvases = b.querySelectorAll('canvas');
      var anyInked = false;
      for (var i = 0; i < canvases.length && !anyInked; i++) anyInked = inked(canvases[i]);
      post('loaded', { summary: {
        elements: b.querySelectorAll('*').length,
        buttons: b.querySelectorAll('button, input[type=button], input[type=submit]').length,
        inputs: b.querySelectorAll('input:not([type=button]):not([type=submit]), textarea, select').length,
        canvases: canvases.length,
        inkedCanvas: anyInked,
        text: String(b.innerText || '').slice(0, 800)
      } });
    }, 150);
  });
})();</script>`;

/** Put the reporter first in <head>, or as early as the document allows without quirks mode. */
export function withReporter(html) {
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + REPORTER + html.slice(at);
    }
  }
  return REPORTER + html;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EMPTY = '<!DOCTYPE html><html><body></body></html>';

/**
 * @param opts.onMode  called with 'empty' | 'stream' | 'final' whenever that changes, so the
 *                     host can derive its own chrome (the empty-state card) from what is
 *                     actually in the frame rather than from a copy of it
 */
export function createPreview(iframe, { onMode } = {}) {
  // Set in index.html too. Re-asserted here because a wider sandbox is the one change to this
  // file that would fail silently: every generated page would simply gain the host's authority.
  iframe.setAttribute('sandbox', 'allow-scripts');

  const listeners = new Set();
  let mode = 'empty';   // 'empty' | 'stream' | 'final'
  let bootReady = false;
  let pending = null;
  let timer = 0;
  let current = null;   // the finished document on screen: { errors, summary, loaded, resolve }
  let html = '';

  window.addEventListener('message', (e) => {
    if (e.source !== iframe.contentWindow) return;
    const m = e.data;
    if (!m || m.lab !== TAG) return;
    if (m.kind === 'boot-ready' && mode === 'stream') {
      bootReady = true;
      flush();
    }
    if (mode === 'final' && current) {
      if (m.kind === 'error') current.errors.push({ message: String(m.message).slice(0, 300), resource: !!m.resource });
      if (m.kind === 'loaded') {
        current.summary = m.summary;
        current.resolve();
      }
    }
    for (const fn of listeners) fn(m);
  });

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    onMode?.(next);
  }

  function flush() {
    timer = 0;
    if (mode !== 'stream' || !bootReady || pending === null) return;
    iframe.contentWindow.postMessage({ lab: TAG, kind: 'partial', html: pending }, '*');
    pending = null;
  }

  return {
    /** Show a document that is still arriving. Coalesced, and its scripts do not run. */
    stream(partial) {
      if (mode !== 'stream') {
        setMode('stream');
        bootReady = false;
        current = null;
        iframe.srcdoc = BOOTSTRAP;
      }
      pending = partial;
      if (!timer) timer = setTimeout(flush, STREAM_INTERVAL_MS);
    },

    /** Load a finished document for real, so its scripts run. */
    show(full) {
      setMode('final');
      pending = null;
      html = full;
      let resolve;
      const loaded = new Promise((r) => { resolve = r; });
      current = { errors: [], summary: null, loaded, resolve };
      iframe.srcdoc = withReporter(full);
    },

    clear() {
      setMode('empty');
      pending = null;
      current = null;
      html = '';
      iframe.srcdoc = EMPTY;
    },

    /**
     * Wait for the document on screen to load, plus a moment for errors thrown by whatever it
     * started on load. Returns what the reporter said about it.
     */
    async settle(timeoutMs = 4000) {
      if (mode !== 'final' || !current) return { loaded: false, errors: [], summary: null };
      const doc = current;
      const loaded = await Promise.race([doc.loaded.then(() => true), sleep(timeoutMs).then(() => false)]);
      await sleep(300);
      return { loaded, errors: [...doc.errors], summary: doc.summary };
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    get html() { return html; },
  };
}

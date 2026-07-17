import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
const { useState, useCallback, useRef, useEffect, useMemo } = React;

function formatTimestamp(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function screenshotUrl(id) {
  return `/api/screenshots/${id}.png`;
}

/**
 * Render a DOM element to a PNG data URL.
 *
 * modern-screenshot can't see inside an <iframe>, so when the target is (or wraps) a
 * same-origin iframe — display tabs (`/api/display-tab/...`) and mod panels — we capture
 * the iframe's own document instead. The iframe is same-origin and sandboxed with
 * `allow-same-origin`, so its contentDocument is reachable.
 *
 * A child iframe only counts as "the content" when it is visible and covers at
 * least half of the element's area. Without that guard, capturing a container
 * that merely contains iframes (e.g. `#app-container`, which holds every hidden
 * panel-mod iframe) diverted to the first display:none iframe, whose 0×0 canvas
 * serializes to an invalid `data:,` URL and the capture failed.
 */
function contentIframeOf(el) {
  if (el.tagName === 'IFRAME') return el;
  const elArea = Math.max(1, el.clientWidth * el.clientHeight);
  for (const fr of el.querySelectorAll('iframe')) {
    const area = fr.clientWidth * fr.clientHeight;
    if (area > 0 && area / elArea >= 0.5) return fr;
  }
  return null;
}

async function captureElementToPng(el) {
  const iframe = contentIframeOf(el);
  if (iframe) {
    let doc = null;
    try { doc = iframe.contentDocument; } catch { /* cross-origin */ }
    if (!doc || !doc.documentElement) {
      throw new Error('Cannot read iframe content (not yet loaded or cross-origin)');
    }
    const node = doc.documentElement;
    const bodyBg = doc.body && (doc.defaultView || window).getComputedStyle(doc.body).backgroundColor;
    return window.modernScreenshot.domToPng(node, {
      width: iframe.clientWidth || node.scrollWidth,
      height: iframe.clientHeight || node.scrollHeight,
      backgroundColor: bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' ? bodyBg : '#ffffff',
    });
  }
  return window.modernScreenshot.domToPng(el);
}

function ScreenshotsPanel() {
  const [screenshots, setScreenshots] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [status, setStatus] = useState(null);
  const statusTimer = useRef(null);

  const showStatus = useCallback((text, type) => {
    setStatus({ text, type });
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 3000);
  }, []);

  // Hydrate from server on mount — persisted across page refresh and daemon restarts.
  useEffect(() => {
    fetch('/api/screenshots')
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d?.screenshots) ? d.screenshots : [];
        setScreenshots(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch((e) => console.error('Failed to load screenshots:', e));
  }, []);

  // Subscribe to server broadcasts so new captures appear in every open window.
  useEffect(() => {
    if (!window.deepsteve?.onScreenshotEvent) return;
    return window.deepsteve.onScreenshotEvent((msg) => {
      if (msg.type === 'screenshot-added' && msg.meta) {
        setScreenshots((prev) => {
          if (prev.some((s) => s.id === msg.meta.id)) return prev;
          return [msg.meta, ...prev];
        });
        setSelectedId((prev) => prev ?? msg.meta.id);
      } else if (msg.type === 'screenshot-deleted' && msg.id) {
        setScreenshots((prev) => {
          const idx = prev.findIndex((s) => s.id === msg.id);
          if (idx === -1) return prev;
          const next = prev.filter((s) => s.id !== msg.id);
          setSelectedId((sel) => {
            if (sel !== msg.id) return sel;
            return next.length === 0 ? null : (next[idx] || next[idx - 1] || next[0]).id;
          });
          return next;
        });
      }
    });
  }, []);

  const selected = useMemo(
    () => screenshots.find((s) => s.id === selectedId) || null,
    [screenshots, selectedId]
  );

  const capture = useCallback(async () => {
    setCapturing(true);
    setStatus(null);
    try {
      const activeContainer = parent.document.querySelector('.terminal-container.active');
      // Terminal tabs render an .xterm; display tabs / mod panels render an <iframe>.
      const target = activeContainer && (activeContainer.querySelector('.xterm') || activeContainer.querySelector('iframe'));
      if (!target) {
        showStatus('No active tab to capture', 'error');
        setCapturing(false);
        return;
      }
      const dataUrl = await captureElementToPng(target);
      const res = await fetch('/api/screenshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, source: 'manual' }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const meta = await res.json();
      setScreenshots((prev) => (prev.some((s) => s.id === meta.id) ? prev : [meta, ...prev]));
      setSelectedId(meta.id);
      showStatus('Captured', 'success');
    } catch (e) {
      console.error('Screenshot capture failed:', e);
      showStatus('Capture failed: ' + e.message, 'error');
    }
    setCapturing(false);
  }, [showStatus]);

  const copyToClipboard = useCallback(async () => {
    if (!selected) return;
    try {
      const res = await fetch(screenshotUrl(selected.id));
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showStatus('Copied to clipboard', 'success');
    } catch (e) {
      console.error('Copy failed:', e);
      showStatus('Copy failed — try downloading instead', 'error');
    }
  }, [selected, showStatus]);

  const download = useCallback(() => {
    if (!selected) return;
    const timestamp = new Date(selected.timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = screenshotUrl(selected.id);
    a.download = `deepsteve-${timestamp}.png`;
    a.click();
    showStatus('Downloaded', 'success');
  }, [selected, showStatus]);

  const removeScreenshot = useCallback((id) => {
    fetch(`/api/screenshots/${id}`, { method: 'DELETE' }).catch((e) => {
      console.error('Delete failed:', e);
    });
    // Broadcast will drive the state update.
  }, []);

  const clearAll = useCallback(() => {
    const ids = screenshots.map((s) => s.id);
    Promise.all(
      ids.map((id) => fetch(`/api/screenshots/${id}`, { method: 'DELETE' }).catch(() => {}))
    );
  }, [screenshots]);

  // Handle MCP screenshot_capture requests
  useEffect(() => {
    if (!window.deepsteve?.onScreenshotCaptureRequest) return;
    return window.deepsteve.onScreenshotCaptureRequest(async (req) => {
      const { requestId, selector } = req;
      try {
        const el = parent.document.querySelector(selector);
        if (!el) {
          await fetch('/api/screenshots/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId, error: `Element not found: ${selector}` }),
          });
          return;
        }
        const dataUrl = await captureElementToPng(el);
        // Let the server persist into the collection + broadcast — no local add here.
        await fetch('/api/screenshots/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, dataUrl }),
        });
      } catch (e) {
        await fetch('/api/screenshots/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, error: e.message }),
        });
      }
    });
  }, []);

  const hasScreenshots = screenshots.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>
            Screenshots{hasScreenshots ? ` (${screenshots.length})` : ''}
          </div>
          {hasScreenshots && (
            <button
              onClick={clearAll}
              title="Remove all screenshots"
              style={{
                padding: '4px 8px',
                fontSize: 11,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                background: 'rgba(255,255,255,0.06)',
                color: '#8b949e',
              }}
            >
              Clear
            </button>
          )}
        </div>
        <button
          onClick={capture}
          disabled={capturing}
          style={{
            width: '100%',
            padding: '8px 12px',
            fontSize: 13,
            fontWeight: 600,
            border: 'none',
            borderRadius: 6,
            cursor: capturing ? 'wait' : 'pointer',
            background: capturing ? '#1a5c2a' : '#238636',
            color: '#fff',
            opacity: capturing ? 0.7 : 1,
          }}
        >
          {capturing ? 'Capturing...' : 'Capture Terminal'}
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* Status message */}
        {status && (
          <div style={{
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 4,
            marginBottom: 10,
            background: status.type === 'error' ? 'rgba(248,81,73,0.1)' : 'rgba(63,185,80,0.1)',
            color: status.type === 'error' ? '#f85149' : '#3fb950',
            border: `1px solid ${status.type === 'error' ? 'rgba(248,81,73,0.2)' : 'rgba(63,185,80,0.2)'}`,
          }}>
            {status.text}
          </div>
        )}

        {selected ? (
          <div>
            {/* Preview */}
            <img
              src={screenshotUrl(selected.id)}
              style={{
                width: '100%',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.06)',
                marginBottom: 6,
                display: 'block',
              }}
              alt="Terminal screenshot"
            />
            <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 10 }}>
              {formatTimestamp(selected.timestamp)}
              {selected.source === 'mcp' && selected.selector ? ` · ${selected.selector}` : ''}
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                onClick={copyToClipboard}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  fontSize: 12,
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#c9d1d9',
                }}
              >
                Copy
              </button>
              <button
                onClick={download}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  fontSize: 12,
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#c9d1d9',
                }}
              >
                Download
              </button>
            </div>

            {/* History grid */}
            {screenshots.length > 1 && (
              <div>
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#8b949e',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 6,
                }}>
                  History
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
                  gap: 6,
                }}>
                  {screenshots.map((s) => (
                    <Thumbnail
                      key={s.id}
                      item={s}
                      isSelected={s.id === selectedId}
                      onSelect={() => setSelectedId(s.id)}
                      onRemove={() => removeScreenshot(s.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            Capture a screenshot of the active tab (terminal or display tab).
          </div>
        )}
      </div>
    </div>
  );
}

function Thumbnail({ item, isSelected, onSelect, onRemove }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onSelect}
      title={formatTimestamp(item.timestamp) + (item.selector ? ` · ${item.selector}` : '')}
      style={{
        position: 'relative',
        aspectRatio: '4 / 3',
        borderRadius: 4,
        overflow: 'hidden',
        cursor: 'pointer',
        border: `2px solid ${isSelected ? '#58a6ff' : 'rgba(255,255,255,0.08)'}`,
        background: '#0d1117',
      }}
    >
      <img
        src={screenshotUrl(item.id)}
        alt=""
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          opacity: isSelected ? 1 : 0.85,
        }}
      />
      {hover && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove"
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            width: 18,
            height: 18,
            padding: 0,
            border: 'none',
            borderRadius: '50%',
            cursor: 'pointer',
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            fontSize: 12,
            lineHeight: '18px',
            textAlign: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('screenshots-root'));
root.render(<ScreenshotsPanel />);

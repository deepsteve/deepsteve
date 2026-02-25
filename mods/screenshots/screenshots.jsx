const { useState, useCallback, useRef } = React;

function ScreenshotsPanel() {
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [status, setStatus] = useState(null);
  const statusTimer = useRef(null);

  const showStatus = useCallback((text, type) => {
    setStatus({ text, type });
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 3000);
  }, []);

  const capture = useCallback(async () => {
    setCapturing(true);
    setStatus(null);
    try {
      const xtermEl = parent.document.querySelector('.terminal-container.active .xterm');
      if (!xtermEl) {
        showStatus('No active terminal', 'error');
        setCapturing(false);
        return;
      }
      const dataUrl = await window.modernScreenshot.domToPng(xtermEl);
      setImageDataUrl(dataUrl);
      showStatus('Captured', 'success');
    } catch (e) {
      console.error('Screenshot capture failed:', e);
      showStatus('Capture failed: ' + e.message, 'error');
    }
    setCapturing(false);
  }, [showStatus]);

  const copyToClipboard = useCallback(async () => {
    if (!imageDataUrl) return;
    try {
      const res = await fetch(imageDataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showStatus('Copied to clipboard', 'success');
    } catch (e) {
      console.error('Copy failed:', e);
      showStatus('Copy failed — try downloading instead', 'error');
    }
  }, [imageDataUrl, showStatus]);

  const download = useCallback(() => {
    if (!imageDataUrl) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = imageDataUrl;
    a.download = `deepsteve-${timestamp}.png`;
    a.click();
    showStatus('Downloaded', 'success');
  }, [imageDataUrl, showStatus]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc', marginBottom: 8 }}>
          Screenshots
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

        {imageDataUrl ? (
          <div>
            {/* Preview */}
            <img
              src={imageDataUrl}
              style={{
                width: '100%',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.06)',
                marginBottom: 10,
              }}
              alt="Terminal screenshot"
            />

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8 }}>
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
          </div>
        ) : (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            Capture a screenshot of the active terminal viewport.
          </div>
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('screenshots-root'));
root.render(<ScreenshotsPanel />);

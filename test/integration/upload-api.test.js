/**
 * Integration tests for PUT /api/upload/:filename — the endpoint behind
 * dropping a file onto a terminal tab (public/js/file-drop.js).
 *
 * The suite exists for one bug: the route parsed its body with express.raw
 * under the wildcard type, which reads like "any body" but is matched by type-is
 * against the Content-Type *header*. A file macOS has no MIME type for
 * (extensionless, .jsonl, .tsx, …) has File.type === '', so xhr.send(file) sends
 * no Content-Type at all, body-parser skipped the request, and the write failed
 * on a `{}` body — silently, since the client only types paths it got back. So
 * the assertion that matters is the *headerless* PUT, not the happy path.
 *
 * Assertions stop at the HTTP response: under the docker suites the daemon's
 * filesystem is not this process's, so the returned path can't be read back.
 */
const { describe, it } = require('node:test');
const net = require('node:net');
const assert = require('node:assert');
const { BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');

async function upload(filename, body, headers = {}) {
  const res = await fetch(`${BASE_URL}/api/upload/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}`, ...headers },
    body,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, body: parsed };
}

describe('PUT /api/upload/:filename', () => {
  it('accepts a file sent with no Content-Type header', async () => {
    // fetch() adds no Content-Type for a Buffer/Uint8Array body — the same shape
    // the browser produces for a file it can't classify.
    const res = await upload('ds-upload-untyped.jsonl', Buffer.from('{"a":1}\n'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    // -N suffix tolerated: DROPS_DIR is a shared tmpdir the endpoint deduplicates
    // into, so a re-run of this suite lands on ds-upload-untyped-1.jsonl.
    assert.match(res.body.path, /ds-upload-untyped(-\d+)?\.jsonl$/);
  });

  it('accepts a file sent with a known Content-Type', async () => {
    const res = await upload('ds-upload-typed.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      'Content-Type': 'image/png',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.path, /ds-upload-typed(-\d+)?\.png$/);
  });

  it('rejects a path traversal in the filename', async () => {
    const res = await upload('../escaped.txt', Buffer.from('x'));
    assert.strictEqual(res.status, 400);
  });

  it('stores a zero-byte file rather than treating it as a missing body', async () => {
    // Content-Length: 0 is still a body; body-parser hands over an empty Buffer.
    const res = await upload('ds-upload-empty.txt', Buffer.alloc(0));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });

  it('answers a truly bodyless PUT with 400, not a 500 about argument types', async () => {
    // Needs a hand-rolled request: every HTTP client sends Content-Length: 0 for
    // a bodyless PUT, and that counts as a body. Omit both length and encoding
    // and body-parser skips the route entirely, leaving req.body as `{}` — the
    // one shape that used to reach fs.writeFileSync and raise a 500.
    const { hostname, port } = new URL(BASE_URL);
    const status = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: hostname, port: Number(port) }, () => {
        sock.write(
          'PUT /api/upload/ds-upload-nobody.txt HTTP/1.1\r\n' +
          `Host: ${hostname}:${port}\r\n` +
          `Authorization: Bearer ${AUTH_TOKEN}\r\n` +
          'Connection: close\r\n\r\n'
        );
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('error', reject);
      sock.on('close', () => resolve(Number(buf.split(' ')[1])));
    });
    assert.strictEqual(status, 400);
  });
});

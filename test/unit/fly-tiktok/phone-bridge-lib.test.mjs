import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigin, jpegSplitter } from '../../../mods/fly-tiktok/phone/phone-bridge-lib.mjs';

test('only pages on this machine, or no page at all, may call the bridge', () => {
  for (const origin of [undefined, '', 'http://deepsteve.localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173']) {
    assert.equal(allowedOrigin(origin), true, String(origin));
  }
  for (const origin of ['https://example.com', 'http://localhost.example.com', 'http://10.0.0.5:3000', 'null', 'not a url']) {
    assert.equal(allowedOrigin(origin), false, origin);
  }
});

test('the video stream splits back into whole JPEGs, however it arrives', () => {
  const packet = bytes => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), Buffer.from(bytes)]);
  const stream = Buffer.concat([packet([0xff, 0xd8, 1, 2, 3]), packet([0xff, 0xd8, 9]), Buffer.from([0, 0, 0, 4, 0xff])]);
  const got = [];
  const feed = jpegSplitter(jpeg => got.push([...jpeg]));
  let offset = 0;
  for (const size of [1, 2, 3, 5, 100]) {
    feed(stream.subarray(offset, offset + size));
    offset += size;
  }
  assert.deepEqual(got, [[0xff, 0xd8, 1, 2, 3], [0xff, 0xd8, 9]]); // the unfinished third waits
});

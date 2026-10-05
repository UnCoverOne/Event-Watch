import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url)));
for (const icon of manifest.icons) {
  test(`manifest icon ${icon.src} has complete, decodable PNG data`, () => {
    const path = new URL(icon.src, 'https://event-watch.test').pathname;
    const bytes = readFileSync(new URL(`../public${path}`, import.meta.url));
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const data = [];
    let width, height, channels, ended = false;
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      assert.ok(offset + length + 12 <= bytes.length, 'PNG chunk must not be truncated');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
        assert.equal(chunk[8], 8);
        assert.ok([2, 6].includes(chunk[9]));
        channels = chunk[9] === 2 ? 3 : 4;
        assert.equal(chunk[12], 0, 'non-interlaced icon');
      }
      if (type === 'IDAT') data.push(chunk);
      if (type === 'IEND') ended = true;
      offset += length + 12;
    }
    assert.equal(`${width}x${height}`, icon.sizes);
    assert.ok(ended, 'PNG requires its end chunk');
    const pixels = inflateSync(Buffer.concat(data));
    assert.equal(pixels.length, height * (1 + width * channels));
  });
}

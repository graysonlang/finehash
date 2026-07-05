import assert from 'node:assert/strict';

import {
  DEFAULT_LONGEST,
  MAX_ENCODED_SIZE,
  decode,
  downsampleToWorkingGrid,
  encode,
  fromBase64,
  toBase64,
} from '../src/finehash.js';

function fixture(width, height, { alpha = false } = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 7 + y * 3) & 255;
      rgba[i + 1] = (x * 2 + y * 11) & 255;
      rgba[i + 2] = (x * 13 + y * 5) & 255;
      rgba[i + 3] = alpha ? Math.min(255, 32 + x * 3 + y * 2) : 255;
    }
  }
  return rgba;
}

const rgba = fixture(64, 48, { alpha: true });
const hash = encode(rgba, 64, 48);
assert.ok(hash instanceof Uint8Array);
assert.equal(hash.length % 3, 0);
assert.ok(hash.length <= MAX_ENCODED_SIZE);

const base64 = toBase64(hash);
assert.equal(base64.includes('='), false);
assert.deepEqual(fromBase64(base64), hash);

const decoded = decode(base64, { width: 64, height: 48 });
assert.equal(decoded.width, 64);
assert.equal(decoded.height, 48);
assert.equal(decoded.hasAlpha, true);
assert.equal(decoded.rgba.length, 64 * 48 * 4);

const defaultDecoded = decode(hash);
assert.ok(defaultDecoded.width <= DEFAULT_LONGEST || defaultDecoded.height <= DEFAULT_LONGEST);
assert.equal(defaultDecoded.rgba.length, defaultDecoded.width * defaultDecoded.height * 4);

const opaque = decode(encode(fixture(32, 32), 32, 32), { width: 16 });
assert.equal(opaque.hasAlpha, false);
assert.equal(opaque.width, 16);
assert.equal(opaque.rgba.length, opaque.width * opaque.height * 4);

const downsampled = downsampleToWorkingGrid(fixture(8, 4), 8, 4, 4);
assert.equal(downsampled.width, 4);
assert.equal(downsampled.height, 2);
assert.equal(downsampled.data.length, 4 * 2 * 4);

assert.throws(() => encode(new Uint8Array(3), 1, 1), /rgba length/);
assert.throws(() => decode(hash, { width: 0 }), /invalid decode dimensions/);
assert.throws(() => fromBase64(`${base64}=`), /padded base64/);

console.log('finehash smoke tests passed');

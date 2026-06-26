// End-to-end encode/decode:
//   - encode produces a padded (multiple of 3) hash within the size bound
//   - encoding is deterministic (same input -> identical bytes)
//   - decode reconstructs a plausible blur: mean color near the source mean
//   - alpha survives the round-trip
//
// Compiles the TypeScript sources in-memory with esbuild; run with:
//   node test/codec.test.mjs

import * as esbuild from 'esbuild';
import assert from 'node:assert/strict';

async function importTs(entry) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64');
  return import(url);
}

const { encode, encodeToBase64 } = await importTs('src/encode.ts');
const { decode, decodeFromBase64 } = await importTs('src/decode.ts');
const { maxEncodedSize } = await importTs('src/size.ts');

// A smooth diagonal gradient - the content FineHash targets.
function gradient(w, h, alpha = false) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const j = (y * w + x) * 4;
      data[j] = (x / (w - 1)) * 255;
      data[j + 1] = (y / (h - 1)) * 255;
      data[j + 2] = 128;
      data[j + 3] = alpha ? (x / (w - 1)) * 255 : 255;
    }
  }
  return data;
}

const meanRGB = (px) => {
  let r = 0, g = 0, b = 0;
  const n = px.length / 4;
  for (let i = 0; i < n; ++i) {
    r += px[i * 4];
    g += px[i * 4 + 1];
    b += px[i * 4 + 2];
  }
  return [r / n, g / n, b / n];
};

// --- 1. Size bound + padding ----------------------------------------------
{
  const px = gradient(80, 60);
  const bytes = encode(px, 80, 60);
  assert.equal(bytes.length % 3, 0, 'hash padded to a multiple of 3 bytes');
  assert.ok(bytes.length <= maxEncodedSize(), `hash ${bytes.length}B over the size bound`);
  const base64 = encodeToBase64(px, 80, 60);
  assert.equal(base64.length, (bytes.length / 3) * 4);
  const fromString = decodeFromBase64(base64, { width: 80 });
  assert.equal(fromString.width, 80, 'decodeFromBase64 honors explicit width');
  assert.ok(fromString.height > 0 && fromString.height < fromString.width, 'height derives from stored aspect');
  assert.equal(fromString.pixels.length, fromString.width * fromString.height * 4, 'derived dimensions match pixels');
}

// --- 2. Deterministic --------------------------------------------------------
{
  const px = gradient(64, 64);
  const a = encode(px, 64, 64);
  const b = encode(px, 64, 64);
  assert.deepEqual([...a], [...b], 'encoding must be deterministic');
}

// --- 3. Decode reconstructs a plausible blur ------------------------------
{
  const px = gradient(96, 72);
  const bytes = encode(px, 96, 72);
  const out = decode(bytes);
  assert.ok(out.width > 0 && out.height > 0 && !out.hasAlpha);
  assert.ok(out.width > out.height, 'landscape aspect preserved');
  const [sr, sg, sb] = meanRGB(px);
  const [dr, dg, db] = meanRGB(out.pixels);
  assert.ok(Math.abs(sr - dr) < 24 && Math.abs(sg - dg) < 24 && Math.abs(sb - db) < 24,
    `mean color drifted: src ${[sr, sg, sb].map(Math.round)} vs decoded ${[dr, dg, db].map(Math.round)}`);
}

// --- 4. Alpha round-trips --------------------------------------------------
{
  const px = gradient(64, 64, true);
  const out = decode(encode(px, 64, 64));
  assert.equal(out.hasAlpha, true, 'alpha flag set');
  let min = 255, max = 0;
  for (let i = 0; i < out.pixels.length / 4; ++i) {
    const a = out.pixels[i * 4 + 3];
    min = Math.min(min, a);
    max = Math.max(max, a);
  }
  assert.ok(max - min > 40, `alpha gradient should vary, got range ${min}..${max}`);
}

// --- 5. Extreme aspect ratios survive the round-trip via the escape hatch ---
// A very wide image must decode at (close to) its true aspect, not collapse to
// the ~3:1 the implicit short count would otherwise floor it at.
{
  const w = 240, h = 30; // 8:1
  const px = gradient(w, h);
  const bytes = encode(px, w, h);
  assert.ok(bytes.length <= maxEncodedSize(), 'extreme-aspect hash within the size bound');
  const out = decode(bytes); // natural size (no explicit dims)
  const aspect = out.width / out.height;
  assert.ok(aspect > 5, `extreme aspect should survive, got ${aspect.toFixed(2)} (${out.width}x${out.height})`);
}

// --- 6. Public input validation -------------------------------------------
{
  assert.throws(() => encode(new Uint8ClampedArray(3), 1, 1), /pixels/, 'short RGBA input should reject');
  assert.throws(() => encode(new Uint8ClampedArray(4), 0, 1), /width/, 'zero width should reject');

  const px = gradient(16, 16);
  const bytes = encode(px, 16, 16);
  assert.throws(() => decode(bytes.subarray(0, 3)), /truncated/, 'truncated hash should reject');
  assert.throws(() => decode(bytes, { height: -1 }), /height/, 'invalid decode height should reject');
  assert.throws(() => decodeFromBase64('not base64!'), /base64/, 'invalid base64 should reject');
}

console.log('codec: all checks passed');

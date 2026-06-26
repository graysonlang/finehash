// Verifies bit I/O and quantization/packing:
//   - BitWriter/BitReader round-trip arbitrary fields MSB-first
//   - packChannel -> unpackChannel recovers coefficients within quant tolerance
//
// Compiles the TypeScript sources in-memory with esbuild; run with:
//   node test/pack.test.mjs

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

const { BitWriter, BitReader } = await importTs('src/bitio.ts');
const { packChannel, unpackChannel } = await importTs('src/pack.ts');
const { allocate } = await importTs('src/allocate.ts');
const { acTerms, forwardDctChannel } = await importTs('src/dct.ts');

// --- 1. BitWriter / BitReader round-trip ----------------------------------
{
  const fields = [[5, 3], [200, 8], [1, 1], [0, 4], [63, 6], [9, 5]];
  const w = new BitWriter();
  for (const [v, b] of fields) w.write(v, b);
  const r = new BitReader(w.finish());
  for (const [v, b] of fields) assert.equal(r.read(b), v, `field ${v}/${b}`);
}

// --- 2. packChannel -> unpackChannel within quant tolerance ---------------
{
  const scaleBits = 5;
  const layout = allocate(1, false).luma; // luma channel layout at Q1 (top)
  const terms = acTerms(layout.nx, layout.ny);
  const scale = 600; // within luma scaleMax (765); avoids clamping
  const ac = Float64Array.from(terms, (_, j) => Math.round(scale * Math.sin(j + 1)));
  const dct = { dc: 712, ac };

  const w = new BitWriter();
  packChannel(w, dct, layout, 'luma', scaleBits);
  const got = unpackChannel(new BitReader(w.finish()), layout, 'luma', scaleBits);

  // DC tolerance: one quant step over the luma DC range (1530).
  assert.ok(Math.abs(got.dc - dct.dc) <= 1530 / ((1 << layout.dcBits) - 1), `DC off: ${got.dc} vs ${dct.dc}`);
  // AC tolerance: one quant step over [-scale, scale] at each term's bit depth,
  // plus one scale-quantization step (the max-magnitude coefficient sits at the
  // quantized-scale edge and reconstructs ~one step low - inherent to the
  // mid-tread quantizer).
  const scaleStep = 765 / ((1 << scaleBits) - 1); // luma scaleMax / scale levels
  for (let j = 0; j < terms.length; ++j) {
    const bits = layout.acBits[Math.min(Math.max(terms[j][0] + terms[j][1] - 1, 0), layout.acBits.length - 1)];
    const step = (2 * scale) / ((1 << bits) - 1) + scaleStep;
    assert.ok(Math.abs(got.ac[j] - ac[j]) <= step, `AC[${j}] off by > one step`);
  }
}

// --- 3. Signed chroma DC survives the round-trip --------------------------
{
  const scaleBits = 5;
  const layout = allocate(1, false).chroma;
  const terms = acTerms(layout.nx, layout.ny);
  const dct = { dc: -900, ac: Float64Array.from(terms, () => 0) };
  const w = new BitWriter();
  packChannel(w, dct, layout, 'chroma', scaleBits);
  const got = unpackChannel(new BitReader(w.finish()), layout, 'chroma', scaleBits);
  assert.ok(got.dc < 0, `chroma DC sign lost: ${got.dc}`);
  assert.ok(Math.abs(got.dc - dct.dc) <= 2 * 1530 / ((1 << layout.dcBits) - 1), `chroma DC off: ${got.dc}`);
}

// --- 4. AC scale stays within the tightened vrange/2 bound (no clamping) ---
// A normalized DCT-II AC coefficient cannot exceed half the channel's value
// swing, so the scale quantizes over [0, vrange/2] without ever clamping - even
// for a worst-case hard step (the highest-energy non-smooth signal).
{
  const w = 32, h = 8;
  const lumaStep = new Int32Array(w * h);
  const chromaStep = new Int32Array(w * h);
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      lumaStep[y * w + x] = x < w / 2 ? 0 : 1530; // [0, 1530] -> bound 765
      chromaStep[y * w + x] = x < w / 2 ? -1530 : 1530; // [-1530, 1530] -> bound 1530
    }
  }
  const maxAc = (ch) => {
    const { ac } = forwardDctChannel(ch, w, h, w, h);
    let s = 0;
    for (const a of ac) s = Math.max(s, Math.abs(a));
    return s;
  };
  assert.ok(maxAc(lumaStep) <= 765, `luma AC scale exceeds vrange/2 bound: ${maxAc(lumaStep)}`);
  assert.ok(maxAc(chromaStep) <= 1530, `chroma AC scale exceeds vrange/2 bound: ${maxAc(chromaStep)}`);
}

// --- 5. Zero coefficients round-trip to exactly zero (mid-tread quantizer) --
// A zero coefficient must reconstruct as zero, not a small offset - otherwise
// near-zero high-frequency terms inject noise that grows with the term count.
{
  const scaleBits = 5;
  const layout = allocate(1, false).chroma; // signed DC, zero-exact
  const terms = acTerms(layout.nx, layout.ny);
  const dct = { dc: 0, ac: Float64Array.from(terms, () => 0) };
  const w = new BitWriter();
  packChannel(w, dct, layout, 'chroma', scaleBits);
  const got = unpackChannel(new BitReader(w.finish()), layout, 'chroma', scaleBits);
  assert.equal(got.dc, 0, 'zero chroma DC must reconstruct as exactly 0');
  for (const a of got.ac) assert.equal(a, 0, 'zero AC must reconstruct as exactly 0');
}

console.log('pack: all checks passed');

// Verifies the separable fixed-point DCT:
//   - DC term equals the channel mean
//   - a constant channel round-trips exactly (AC ~ 0)
//   - acCount matches the triangular term layout
//   - a smooth horizontal ramp reconstructs within a small tolerance
//
// Compiles the TypeScript sources in-memory with esbuild; run with:
//   node test/dct.test.mjs

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

const { forwardDctChannel, inverseDctChannel, acCount, acTerms, applyLanczosWindow } = await importTs('src/dct.ts');

const maxAbsError = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; ++i) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

// --- 1. DC equals the channel mean ----------------------------------------
{
  const w = 6, h = 5;
  const ch = Int32Array.from({ length: w * h }, (_, i) => (i * 37) % 211 - 90);
  const mean = ch.reduce((s, v) => s + v, 0) / (w * h);
  const { dc } = forwardDctChannel(ch, w, h, 5, 5);
  assert.ok(Math.abs(dc - mean) < 1e-9, `DC ${dc} != mean ${mean}`);
}

// --- 2. Constant channel: exact DC, negligible AC, round-trips within +-1 --
// The fixed-point cosine basis is not perfectly orthogonal (rounded integers),
// so a flat channel leaks a tiny bias into AC - bounded well under one channel
// unit by COS_BITS. DC is still exact (cos(0) = 1 exactly).
{
  const w = 8, h = 7;
  const ch = new Int32Array(w * h).fill(600);
  const { dc, ac } = forwardDctChannel(ch, w, h, 6, 6);
  assert.ok(Math.abs(dc - 600) < 1e-9, `constant DC ${dc}`);
  for (const c of ac) assert.ok(Math.abs(c) < 1, `constant AC leakage too large: ${c}`);
  const recon = inverseDctChannel(dc, ac, w, h, 6, 6);
  assert.ok(maxAbsError(recon, ch) <= 1, `constant round-trip off by ${maxAbsError(recon, ch)}`);
}

// --- 3. acCount matches the triangular layout -----------------------------
{
  // 3x3 triangle: (cx,cy) with cx/3 + cy/3 < 1, minus DC.
  // cy=0: cx in {1,2}; cy=1: cx in {0,1}; cy=2: cx in {0} -> 5 AC terms.
  assert.equal(acCount(3, 3), 5);
  // The forward AC array length must equal acCount.
  const { ac } = forwardDctChannel(new Int32Array(8 * 8), 8, 8, 4, 5);
  assert.equal(ac.length, acCount(4, 5));
}

// --- 4. Smooth horizontal ramp reconstructs within tolerance --------------
{
  const w = 16, h = 4;
  const ch = new Int32Array(w * h);
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) ch[y * w + x] = Math.round((x / (w - 1)) * 1500);
  }
  // Purely horizontal signal: ny=1 keeps the full 1-D x-DCT, so it should
  // reconstruct the ramp closely.
  const { dc, ac } = forwardDctChannel(ch, w, h, w, 1);
  const recon = inverseDctChannel(dc, ac, w, h, w, 1);
  assert.ok(maxAbsError(recon, ch) <= 2, `ramp reconstruction off by ${maxAbsError(recon, ch)}`);
}

// --- 5. Lanczos window tapers high frequencies ----------------------------
{
  const nx = 9, ny = 9;
  const terms = acTerms(nx, ny);
  const ones = new Float64Array(terms.length).fill(1);
  const w = applyLanczosWindow(ones, nx, ny);
  // First AC term is the lowest frequency (cx+cy=1), last is the highest.
  assert.ok(w[0] > 0.9, `lowest AC barely attenuated, got ${w[0]}`);
  const last = w[w.length - 1];
  assert.ok(last < 0.4, `highest AC strongly attenuated, got ${last}`);
  assert.ok(w[0] > last, 'window must decrease with frequency');
}

// --- 6. Window reduces Gibbs overshoot on a hard step ---------------------
// Truncated terms (nx < w) are what make a hard step ring; the window tames it.
{
  const w = 32, h = 8, nx = 8, ny = 4;
  const step = new Int32Array(w * h);
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) step[y * w + x] = x < w / 2 ? 0 : 1530;
  }
  const { dc, ac } = forwardDctChannel(step, w, h, nx, ny);
  const overshoot = (recon) => {
    let m = 0;
    for (const v of recon) m = Math.max(m, v - 1530, -v); // beyond [0, 1530]
    return m;
  };
  const raw = inverseDctChannel(dc, ac, w, h, nx, ny);
  const windowed = inverseDctChannel(dc, applyLanczosWindow(ac, nx, ny), w, h, nx, ny);
  assert.ok(overshoot(raw) > 0, 'a truncated hard step should ring (overshoot) without the window');
  assert.ok(overshoot(windowed) < overshoot(raw),
    `window must reduce overshoot: ${overshoot(windowed)} vs ${overshoot(raw)}`);
}

console.log('dct: all checks passed');

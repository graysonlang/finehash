// Verifies the gamma-correct downsample:
//   - averages in LINEAR LIGHT (black + white -> ~188 sRGB, not the naive 128)
//   - alpha-weighted coverage (fully transparent pixels contribute no color)
//   - workingDims caps the longest side, preserves aspect, never upscales
//
// Compiles the TypeScript sources in-memory with esbuild;
// run with:  node test/downsample.test.mjs

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

const { resampleLinear, downsampleToWorkingGrid, workingDims } = await importTs('src/downsample.ts');

// --- 1. Linear-light averaging --------------------------------------------
// A 2x1 black|white image averaged to a single pixel must land at the linear
// midpoint (~188 sRGB), not the gamma-naive byte average (128).
{
  const src = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  const { data } = resampleLinear(src, 2, 1, 1, 1);
  assert.ok(data[0] >= 180 && data[0] <= 195, `linear-light midpoint expected ~188, got ${data[0]}`);
  assert.ok(Math.abs(data[0] - 128) > 30, `must not be the naive byte average (128), got ${data[0]}`);
  assert.equal(data[3], 255, 'opaque input stays opaque');
}

// --- 2. Alpha-weighted coverage -------------------------------------------
// Left = opaque red, right = fully transparent green. The transparent green
// must not bleed into the averaged color; alpha is straight coverage (~128).
{
  const src = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0]);
  const [r, g, b, a] = resampleLinear(src, 2, 1, 1, 1).data;
  assert.ok(r > 240 && g < 15 && b < 15, `transparent green leaked into color: got ${[r, g, b]}`);
  assert.ok(Math.abs(a - 128) <= 2, `coverage alpha expected ~128, got ${a}`);
}

// --- 3. Fully transparent region ------------------------------------------
{
  const src = new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 0]);
  const [r, g, b, a] = resampleLinear(src, 2, 1, 1, 1).data;
  assert.deepEqual([r, g, b, a], [0, 0, 0, 0], 'transparent input -> transparent black, no NaN');
}

// --- 4. Working dimensions -------------------------------------------------
{
  assert.deepEqual(workingDims(200, 100, 100), { width: 100, height: 50 }, 'caps longest side, keeps aspect');
  assert.deepEqual(workingDims(50, 30, 100), { width: 50, height: 30 }, 'never upscales');
  assert.deepEqual(workingDims(100, 100, 100), { width: 100, height: 100 }, 'exact fit passes through');
}

// --- 5. Passthrough when already small ------------------------------------
{
  const src = new Uint8ClampedArray(3 * 3 * 4).fill(120);
  const grid = downsampleToWorkingGrid(src, 3, 3, 100);
  assert.equal(grid.width, 3);
  assert.equal(grid.height, 3);
  assert.equal(grid.data[0], 120, 'small images pass through unchanged');
}

console.log('downsample: all checks passed');

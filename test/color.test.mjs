// Verifies the opponent color space transform:
//   - gray (R=G=B) decorrelates to zero chroma (rg = by = 0)
//   - the forward transform is exact; an opaque round-trip recovers within +-1
//   - transparent pixels blend toward the average color (no color bleed)
//
// Compiles the TypeScript sources in-memory with esbuild; run with:
//   node test/color.test.mjs

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

const { colorTransform, channelsToRgba, oppToRgb, OPP_SCALE } = await importTs('src/color.ts');

const grid = (data, width, height) => ({ data: Uint8ClampedArray.from(data), width, height });

// --- 1. Gray decorrelates to zero chroma ----------------------------------
{
  const planes = colorTransform(grid([100, 100, 100, 255, 7, 7, 7, 255], 2, 1));
  assert.equal(planes.rg[0], 0, 'gray rg must be 0');
  assert.equal(planes.by[0], 0, 'gray by must be 0');
  assert.equal(planes.i[0], 2 * 300, 'i = 2(R+G+B) at OPP_SCALE');
  assert.equal(planes.hasAlpha, false, 'opaque input has no alpha');
  assert.equal(OPP_SCALE, 6);
}

// --- 2. Chroma is nonzero for colored pixels ------------------------------
{
  const planes = colorTransform(grid([255, 0, 0, 255], 1, 1));
  assert.equal(planes.rg[0], 6 * 255, 'pure red: rg = 6(R-G)');
  assert.ok(planes.by[0] !== 0, 'pure red has nonzero by');
}

// --- 3. Opaque round-trip recovers within +-1 -----------------------------
{
  const px = [10, 20, 30, 255, 200, 130, 60, 255, 0, 255, 128, 255, 255, 255, 255, 255];
  const planes = colorTransform(grid(px, 4, 1));
  const out = channelsToRgba(planes);
  for (let k = 0; k < px.length; ++k) {
    assert.ok(Math.abs(out[k] - px[k]) <= 1, `channel ${k}: ${out[k]} vs ${px[k]} (>1 off)`);
  }
}

// --- 4. oppToRgb inverts the documented identity --------------------------
{
  // gray 120: i = 2*360 = 720, rg = by = 0  ->  back to (120,120,120)
  assert.deepEqual(oppToRgb(720, 0, 0), [120, 120, 120]);
}

// --- 5. Transparent pixels blend toward the average (no bleed) -------------
{
  // Left = opaque red, right = fully transparent green. The average color is
  // pure red (green contributes nothing), so the transparent pixel becomes red.
  const planes = colorTransform(grid([255, 0, 0, 255, 0, 255, 0, 0], 2, 1));
  assert.equal(planes.hasAlpha, true);
  const out = channelsToRgba(planes);
  // Pixel 1 (was transparent green) should now read as red, alpha 0.
  assert.ok(out[4] > 240 && out[5] < 15 && out[6] < 15, `transparent green leaked: ${[out[4], out[5], out[6]]}`);
  assert.equal(out[7], 0, 'alpha preserved as straight coverage');
}

console.log('color: all checks passed');

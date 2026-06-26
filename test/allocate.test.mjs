// Verifies the allocation function:
//   - the single allocation yields a valid, total layout (with and without alpha)
//   - aspect ratio splits the term budget (landscape gets more nx than ny)
//   - acBitsFor follows the per-band schedule
//   - aspectToShort/shortToAspect round-trip the layout via the header
//
// Compiles the TypeScript sources in-memory with esbuild; run with:
//   node test/allocate.test.mjs

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

const { allocate, acBitsFor, aspectToShort, shortToAspect, encodeExtreme, decodeExtreme, ESCAPE_LUMASHORT, LUMA_MAX } = await importTs('src/allocate.ts');

// --- 1. The allocation yields a valid, total layout -----------------------
for (const hasAlpha of [false, true]) {
  const layout = allocate(1, hasAlpha);
  for (const ch of [layout.luma, layout.chroma, ...(layout.alpha ? [layout.alpha] : [])]) {
    assert.ok(ch.nx >= 2 && ch.ny >= 2, `degenerate dims ${ch.nx}x${ch.ny}`);
    assert.ok(ch.dcBits > 0 && ch.acBits.length > 0, 'missing bits');
    assert.ok(ch.acBits.every(b => b > 0 && b <= 8), 'AC bits out of range');
  }
  assert.ok(layout.scaleBits > 0, 'missing scaleBits');
  assert.equal(layout.alpha === null, !hasAlpha, 'alpha presence mismatch');
}

// --- 2. Aspect ratio splits the budget ------------------------------------
{
  const wide = allocate(2, false).luma; // 2:1 landscape
  const tall = allocate(0.5, false).luma; // 1:2 portrait
  assert.ok(wide.nx > wide.ny, `landscape should favor nx: ${wide.nx}x${wide.ny}`);
  assert.ok(tall.ny > tall.nx, `portrait should favor ny: ${tall.nx}x${tall.ny}`);
}

// --- 3. acBitsFor follows the per-band schedule ---------------------------
{
  const ch = { nx: 6, ny: 6, dcBits: 6, acBits: [6, 5, 4] };
  assert.equal(acBitsFor(ch, 1, 0), 6, 'lowest AC band (cx+cy=1) gets acBits[0]');
  assert.equal(acBitsFor(ch, 1, 1), 5, 'band cx+cy=2 gets acBits[1]');
  assert.equal(acBitsFor(ch, 3, 1), 4, 'band cx+cy=4 clamps to last entry');
}

// --- 4. The header's aspect encoding round-trips the layout ----------------
// aspectToShort quantizes a true aspect to (orientation, lumaShort); feeding the
// reconstructed aspect back into allocate must reproduce the same luma dims that
// the stored short count implies (idempotent - the encode/decode determinism rule).
{
  const fields = aspectToShort(16 / 9);
  assert.equal(fields.orientation, 0, 'wide image is landscape');
  assert.ok(fields.lumaShort >= 3 && fields.lumaShort <= LUMA_MAX, `lumaShort in range: ${fields.lumaShort}`);
  assert.equal(aspectToShort(9 / 16).orientation, 1, 'tall image is portrait');
  assert.equal(aspectToShort(1).lumaShort, LUMA_MAX, 'square uses full short axis');

  // Non-extreme aspects use the implicit short count (no escape).
  for (const aspect of [0.5, 0.8, 1, 1.25, 1.78, 3]) {
    const { orientation, lumaShort } = aspectToShort(aspect);
    assert.notEqual(lumaShort, ESCAPE_LUMASHORT, `aspect ${aspect} should not escape`);
    const R = shortToAspect(orientation, lumaShort);
    const luma = allocate(R, false).luma;
    assert.equal(Math.min(luma.nx, luma.ny), lumaShort, `aspect ${aspect}: luma short axis must equal stored lumaShort`);
    assert.equal(Math.max(luma.nx, luma.ny), LUMA_MAX, `aspect ${aspect}: luma long axis must be LUMA_MAX`);
    // Idempotence: re-quantizing R yields the same fields.
    assert.equal(aspectToShort(R).lumaShort, lumaShort, `aspect ${aspect}: lumaShort not idempotent`);
  }
}

// --- 5. Extreme aspects take the escape hatch with a precise payloaded ratio --
{
  // Beyond ~3.6:1 the implicit short count clamps, so these escape.
  for (const aspect of [5, 8, 12, 1 / 5, 1 / 12]) {
    const { orientation, lumaShort } = aspectToShort(aspect);
    assert.equal(lumaShort, ESCAPE_LUMASHORT, `aspect ${aspect} should escape`);
    assert.equal(orientation, aspect >= 1 ? 0 : 1, `aspect ${aspect}: orientation`);
    // The payloaded ratio reconstructs the aspect far closer than the 3:1 the
    // implicit floor would have collapsed it to.
    const R = decodeExtreme(encodeExtreme(aspect), orientation);
    const err = Math.abs(R - aspect) / aspect;
    assert.ok(err < 0.15, `aspect ${aspect}: escape ratio off by ${(err * 100).toFixed(0)}% (got ${R.toFixed(2)})`);
  }
  // Just inside the implicit range must NOT escape.
  assert.notEqual(aspectToShort(3).lumaShort, ESCAPE_LUMASHORT, '3:1 stays implicit');
}

console.log('allocate: all checks passed');

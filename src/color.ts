// Opponent color space: the standard three-channel decorrelation from color-vision
// science - an achromatic intensity channel plus the two chromatic opponent axes
// (red-green and blue-yellow) that correspond to the physiological L-M and
// S-(L+M) cone-opponent pathways.
//
// Carried at 6x byte scale so (R+G+B)/3 and (R+G)/2 stay exact integers:
//   I  = 2(R+G+B)     [= 6*(R+G+B)/3]
//   rg = 6(R-G)       [= 6*(R-G)]
//   by = 3(R+G) - 6B  [= 6*((R+G)/2 - B)]
//
// The forward transform rounds nowhere; the inverse rounds once (/36).

import type { Grid } from './downsample';

export const OPP_SCALE = 6;

export interface ChannelPlanes {
  i: Int32Array; // intensity (achromatic)
  rg: Int32Array; // red-green opponent
  by: Int32Array; // blue-yellow opponent
  a:  Int32Array | null;
  width: number;
  height: number;
  hasAlpha: boolean;
}

/** Integer divide with round-half-away-from-zero. `d` must be positive. */
function roundDiv(n: number, d: number): number {
  const half = d >> 1;
  return n >= 0 ? ((n + half) / d) | 0 : -(((-n + half) / d) | 0);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function colorTransform(grid: Grid): ChannelPlanes {
  const { data, width, height } = grid;
  const n = width * height;
  const i = new Int32Array(n);
  const rg = new Int32Array(n);
  const by = new Int32Array(n);

  let hasAlpha = false;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  for (let k = 0; k < n; ++k) {
    const j = k * 4;
    const alpha = data[j + 3]!;
    if (alpha !== 255) hasAlpha = true;
    sumR += alpha * data[j]!;
    sumG += alpha * data[j + 1]!;
    sumB += alpha * data[j + 2]!;
    sumA += alpha;
  }
  const avgR = sumA > 0 ? roundDiv(sumR, sumA) : 0;
  const avgG = sumA > 0 ? roundDiv(sumG, sumA) : 0;
  const avgB = sumA > 0 ? roundDiv(sumB, sumA) : 0;

  const a = hasAlpha ? new Int32Array(n) : null;

  // Blend transparent pixels toward the alpha-weighted average so undefined
  // transparent color injects no spurious high-frequency energy into the DCT.
  for (let k = 0; k < n; ++k) {
    const j = k * 4;
    let r = data[j]!;
    let g = data[j + 1]!;
    let b = data[j + 2]!;
    if (hasAlpha) {
      const alpha = data[j + 3]!;
      r = avgR + roundDiv(alpha * (r - avgR), 255);
      g = avgG + roundDiv(alpha * (g - avgG), 255);
      b = avgB + roundDiv(alpha * (b - avgB), 255);
      a![k] = alpha;
    }
    i[k] = 2 * (r + g + b);
    rg[k] = 6 * (r - g);
    by[k] = 3 * (r + g) - 6 * b;
  }

  return { i, rg, by, a, width, height, hasAlpha };
}

/** Inverse opponent transform: one scaled (i, rg, by) triple back to an sRGB byte triple, clamped. */
export function oppToRgb(i: number, rg: number, by: number): [number, number, number] {
  return [
    clamp255(roundDiv(6 * i + 2 * by + 3 * rg, 36)),
    clamp255(roundDiv(6 * i + 2 * by - 3 * rg, 36)),
    clamp255(roundDiv(6 * i - 4 * by, 36)),
  ];
}

export function channelsToRgba(planes: ChannelPlanes): Uint8ClampedArray {
  const { i, rg, by, a, width, height, hasAlpha } = planes;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let k = 0; k < n; ++k) {
    const [r, g, b] = oppToRgb(i[k]!, rg[k]!, by[k]!);
    const j = k * 4;
    out[j] = r;
    out[j + 1] = g;
    out[j + 2] = b;
    out[j + 3] = hasAlpha && a ? a[k]! : 255;
  }
  return out;
}

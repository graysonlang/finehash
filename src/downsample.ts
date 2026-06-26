// Area-average box filter to the working grid, resampled in LINEAR LIGHT with
// alpha-weighted coverage. Averaging gamma-encoded bytes directly would darken
// every gradient; linear-light averaging is what keeps the reconstruction clean.

import type { RGBA } from './types';
import { srgbToLinear, linearToSrgb } from './srgb';

export const WORKING_MAX = 128;

export interface Grid {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const ALPHA_EPSILON = 1e-6;

export function workingDims(
  width: number,
  height: number,
  maxSide = WORKING_MAX,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return { width, height };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function resampleLinear(
  src: RGBA,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Grid {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const sx = srcW / dstW;
  const sy = srcH / dstH;

  for (let dy = 0; dy < dstH; ++dy) {
    const y0 = dy * sy;
    const y1 = y0 + sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(srcH, Math.ceil(y1));

    for (let dx = 0; dx < dstW; ++dx) {
      const x0 = dx * sx;
      const x1 = x0 + sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(srcW, Math.ceil(x1));

      let accR = 0; // premultiplied linear color (sum of w*a*linear)
      let accG = 0;
      let accB = 0;
      let accA = 0; // alpha-weighted coverage (sum of w*a)
      let cov = 0; // total coverage (sum of w)

      for (let iy = iy0; iy < iy1; ++iy) {
        const wy = Math.min(y1, iy + 1) - Math.max(y0, iy);
        if (wy <= 0) continue;
        const rowBase = iy * srcW * 4;
        for (let ix = ix0; ix < ix1; ++ix) {
          const wx = Math.min(x1, ix + 1) - Math.max(x0, ix);
          if (wx <= 0) continue;
          const w = wx * wy;
          const p = rowBase + ix * 4;
          const wa = w * (src[p + 3]! / 255);
          accR += srgbToLinear(src[p]!) * wa;
          accG += srgbToLinear(src[p + 1]!) * wa;
          accB += srgbToLinear(src[p + 2]!) * wa;
          accA += wa;
          cov += w;
        }
      }

      const o = (dy * dstW + dx) * 4;
      if (accA > ALPHA_EPSILON) {
        const inv = 1 / accA; // un-premultiply back to straight color
        dst[o] = linearToSrgb(accR * inv);
        dst[o + 1] = linearToSrgb(accG * inv);
        dst[o + 2] = linearToSrgb(accB * inv);
        dst[o + 3] = Math.round((accA / cov) * 255);
      } else {
        dst[o] = 0;
        dst[o + 1] = 0;
        dst[o + 2] = 0;
        dst[o + 3] = 0;
      }
    }
  }

  return { data: dst, width: dstW, height: dstH };
}

export function downsampleToWorkingGrid(
  pixels: RGBA,
  width: number,
  height: number,
  maxSide = WORKING_MAX,
): Grid {
  const dims = workingDims(width, height, maxSide);
  if (dims.width === width && dims.height === height) {
    const data = new Uint8ClampedArray(width * height * 4);
    data.set(pixels.subarray(0, data.length));
    return { data, width, height };
  }
  return resampleLinear(pixels, width, height, dims.width, dims.height);
}

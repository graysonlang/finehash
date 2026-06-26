// `allocate(aspectRatio, hasAlpha) -> Layout` turns aspect ratio and alpha state
// into the full codec layout (per-channel DCT term counts and bit depths). It is
// the only thing that varies between hashes, so the allocation function *is* the
// format spec.

// The codec layout types live here because allocate() is their sole producer and
// the only thing that varies between hashes - they are internal to the format spec,
// not part of the published API surface.
export interface ChannelLayout {
  nx: number;
  ny: number;
  dcBits: number;
  // Per-band AC bit depth, indexed by frequency band `cx + cy - 1`, clamped to the last entry.
  acBits: number[];
}

export interface Layout {
  luma: ChannelLayout;
  chroma: ChannelLayout;
  alpha: ChannelLayout | null;
  scaleBits: number;
}

interface Params {
  lumaMax: number;
  lumaDCBits: number;
  /** Per-band luma AC schedule, lowest band first (the anti-banding lever). */
  lumaACBits: number[];
  chromaMax: number;
  chromaDCBits: number;
  chromaACBits: number[];
  alphaMax: number;
  alphaDCBits: number;
  alphaACBits: number[];
  scaleBits: number;
}

const PARAMS: Params = {
  lumaMax: 9, lumaDCBits: 7, lumaACBits: [6, 5, 4],
  chromaMax: 5, chromaDCBits: 5, chromaACBits: [4],
  alphaMax: 5, alphaDCBits: 5, alphaACBits: [4],
  scaleBits: 6,
};

export const LUMA_MAX = PARAMS.lumaMax;

// Floor for the short axis: extreme aspects collapse it toward 1-2 terms, too few
// to carry a gradient. ThumbHash floors at 3; match it.
const SHORT_AXIS_MIN = 3;

function splitByAspect(maxDim: number, aspectRatio: number): { nx: number; ny: number } {
  if (aspectRatio >= 1) {
    return { nx: maxDim, ny: Math.min(maxDim, Math.max(SHORT_AXIS_MIN, Math.round(maxDim / aspectRatio))) };
  }
  return { nx: Math.min(maxDim, Math.max(SHORT_AXIS_MIN, Math.round(maxDim * aspectRatio))), ny: maxDim };
}

function channel(maxDim: number, aspectRatio: number, dcBits: number, acBits: number[]): ChannelLayout {
  const { nx, ny } = splitByAspect(maxDim, aspectRatio);
  return { nx, ny, dcBits, acBits };
}

// Sentinel carried in the header's lumaShort field when the implicit short count
// would clamp below SHORT_AXIS_MIN; the precise aspect is then payloaded instead.
export const ESCAPE_LUMASHORT = LUMA_MAX + 1;
export const EXTREME_RATIO_BITS = 5;
const EXTREME_LEVELS = (1 << EXTREME_RATIO_BITS) - 1;
// The escape only fires for short/long ratios below 1/SHORT_AXIS_MIN, so quantize
// the payloaded ratio over that tail to spend every code on it.
const EXTREME_MAX_RATIO = 1 / SHORT_AXIS_MIN;

function isExtreme(aspectRatio: number): boolean {
  const longOverShort = aspectRatio >= 1 ? aspectRatio : 1 / aspectRatio;
  return Math.round(LUMA_MAX / longOverShort) < SHORT_AXIS_MIN;
}

export function aspectToShort(aspectRatio: number): { orientation: number; lumaShort: number } {
  const orientation = aspectRatio >= 1 ? 0 : 1;
  if (isExtreme(aspectRatio)) return { orientation, lumaShort: ESCAPE_LUMASHORT };
  const { nx, ny } = splitByAspect(LUMA_MAX, aspectRatio);
  return { orientation, lumaShort: Math.min(nx, ny) };
}

export function shortToAspect(orientation: number, lumaShort: number): number {
  return orientation === 0 ? LUMA_MAX / lumaShort : lumaShort / LUMA_MAX;
}

export function encodeExtreme(aspectRatio: number): number {
  const r = aspectRatio >= 1 ? 1 / aspectRatio : aspectRatio; // short/long, <= 1/SHORT_AXIS_MIN
  const q = Math.round((r / EXTREME_MAX_RATIO) * EXTREME_LEVELS);
  return Math.max(1, Math.min(EXTREME_LEVELS, q));
}

export function decodeExtreme(ratioQ: number, orientation: number): number {
  const r = (ratioQ / EXTREME_LEVELS) * EXTREME_MAX_RATIO; // short/long
  return orientation === 0 ? 1 / r : r;
}

/** Bit depth for one AC coefficient, by frequency band `cx + cy - 1`, clamped to the schedule. */
export function acBitsFor(layout: ChannelLayout, cx: number, cy: number): number {
  const band = cx + cy - 1;
  const i = band < 0 ? 0 : band >= layout.acBits.length ? layout.acBits.length - 1 : band;
  return layout.acBits[i]!;
}

export function allocate(aspectRatio: number, hasAlpha: boolean): Layout {
  const p = PARAMS;
  return {
    luma: channel(p.lumaMax, aspectRatio, p.lumaDCBits, p.lumaACBits),
    chroma: channel(p.chromaMax, aspectRatio, p.chromaDCBits, p.chromaACBits),
    alpha: hasAlpha ? channel(p.alphaMax, aspectRatio, p.alphaDCBits, p.alphaACBits) : null,
    scaleBits: p.scaleBits,
  };
}

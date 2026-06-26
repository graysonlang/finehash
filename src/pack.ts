// Quantize and bit-pack DCT coefficients: per channel a single max-abs AC scale,
// a DC term, then the AC terms in triangular order at the per-band bit depths.
// All field widths come from the Layout, so the wire format is fully determined
// by allocate(aspectRatio, hasAlpha).

import type { DctChannel } from './dct';
import { acTerms } from './dct';
import { acBitsFor } from './allocate';
import type { ChannelLayout } from './allocate';
import type { BitWriter, BitReader } from './bitio';

export type ChannelKind = 'luma' | 'chroma' | 'alpha';

// `dcMax` is the channel's full value range. `scaleMax` bounds the AC *scale*: a
// normalized DCT-II AC coefficient cannot exceed half the channel's value swing
// (|AC| <= vrange/2), so the scale quantizes over that tighter range, never the
// full range. The bound is exact - it never clamps a legitimate coefficient.
const KIND: Record<ChannelKind, { signedDC: boolean; dcMax: number; scaleMax: number }> = {
  luma: { signedDC: false, dcMax: 1530, scaleMax: 765 },
  chroma: { signedDC: true, dcMax: 1530, scaleMax: 1530 },
  alpha: { signedDC: false, dcMax: 255, scaleMax: 128 },
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function quantUnsigned(value: number, max: number, bits: number): number {
  const levels = (1 << bits) - 1;
  return clamp(Math.round((value / max) * levels), 0, levels);
}

function dequantUnsigned(q: number, max: number, bits: number): number {
  return (q / ((1 << bits) - 1)) * max;
}

// Mid-tread quantizer: the center code maps to exactly zero, so a zero
// coefficient reconstructs as zero rather than a small offset that would
// accumulate into reconstruction noise across the many near-zero AC terms.
function quantSigned(value: number, max: number, bits: number): number {
  const half = 1 << (bits - 1);
  return clamp(Math.round((value / max) * half) + half, 0, (1 << bits) - 1);
}

function dequantSigned(q: number, max: number, bits: number): number {
  const half = 1 << (bits - 1);
  return ((q - half) / half) * max;
}

export function packChannel(
  w: BitWriter,
  dct: DctChannel,
  layout: ChannelLayout,
  kind: ChannelKind,
  scaleBits: number,
): void {
  const k = KIND[kind];

  let scale = 0;
  for (const a of dct.ac) scale = Math.max(scale, Math.abs(a));
  const scaleQ = quantUnsigned(scale, k.scaleMax, scaleBits);
  const dscale = dequantUnsigned(scaleQ, k.scaleMax, scaleBits);

  w.write(scaleQ, scaleBits);
  w.write(
    k.signedDC
      ? quantSigned(dct.dc, k.dcMax, layout.dcBits)
      : quantUnsigned(dct.dc, k.dcMax, layout.dcBits),
    layout.dcBits,
  );

  const terms = acTerms(layout.nx, layout.ny);
  for (let j = 0; j < terms.length; ++j) {
    const [cx, cy] = terms[j]!;
    const bits = acBitsFor(layout, cx, cy);
    const half = 1 << (bits - 1);
    const norm = dscale > 0 ? dct.ac[j]! / dscale : 0; // [-1, 1]
    w.write(clamp(Math.round(norm * half) + half, 0, (1 << bits) - 1), bits);
  }
}

export function unpackChannel(
  r: BitReader,
  layout: ChannelLayout,
  kind: ChannelKind,
  scaleBits: number,
): DctChannel {
  const k = KIND[kind];

  const dscale = dequantUnsigned(r.read(scaleBits), k.scaleMax, scaleBits);
  const dcQ = r.read(layout.dcBits);
  const dc = k.signedDC
    ? dequantSigned(dcQ, k.dcMax, layout.dcBits)
    : dequantUnsigned(dcQ, k.dcMax, layout.dcBits);

  const terms = acTerms(layout.nx, layout.ny);
  const ac = new Float64Array(terms.length);
  for (let j = 0; j < terms.length; ++j) {
    const [cx, cy] = terms[j]!;
    const bits = acBitsFor(layout, cx, cy);
    const half = 1 << (bits - 1);
    ac[j] = ((r.read(bits) - half) / half) * dscale;
  }
  return { dc, ac };
}

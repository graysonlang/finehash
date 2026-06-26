// Decode path: parse header -> aspect -> allocate -> unpack -> windowed inverse DCT
// -> reconstruct RGBA. Deliberately relaxed (floating point permitted).

import type { ChannelPlanes } from './color';
import type { DecodeOptions, DecodeResult } from './types';
import { unpackHeader } from './header';
import { BitReader } from './bitio';
import { unpackChannel } from './pack';
import { allocate, shortToAspect, decodeExtreme, ESCAPE_LUMASHORT, EXTREME_RATIO_BITS } from './allocate';
import { inverseDctChannel, applyLanczosWindow } from './dct';
import { channelsToRgba } from './color';
import { base64ToBytes } from './base64';
import { optionalPositiveInteger } from './validate';

const DEFAULT_LONGEST = 32;

function outputDims(aspectRatio: number, opts: DecodeOptions): { width: number; height: number } {
  const width = optionalPositiveInteger(opts.width, 'width');
  const height = optionalPositiveInteger(opts.height, 'height');

  if (width !== undefined && height !== undefined) {
    return { width, height };
  }
  if (width !== undefined) {
    return { width, height: Math.max(1, Math.round(width / aspectRatio)) };
  }
  if (height !== undefined) {
    return { width: Math.max(1, Math.round(height * aspectRatio)), height };
  }
  if (aspectRatio >= 1) {
    return { width: DEFAULT_LONGEST, height: Math.max(1, Math.round(DEFAULT_LONGEST / aspectRatio)) };
  }
  return { width: Math.max(1, Math.round(DEFAULT_LONGEST * aspectRatio)), height: DEFAULT_LONGEST };
}

/** Decode a FineHash byte string back to RGBA pixels. */
export function decode(hash: Uint8Array, opts: DecodeOptions = {}): DecodeResult {
  if (!(hash instanceof Uint8Array)) {
    throw new Error('FineHash must be a Uint8Array');
  }
  if (hash.length === 0) {
    throw new Error('empty FineHash');
  }
  if (hash.length % 3 !== 0) {
    throw new Error('FineHash length must be a multiple of 3 bytes');
  }
  const header = unpackHeader(hash[0]!);
  const reader = new BitReader(hash, 1);
  let aspectRatio;
  if (header.lumaShort === ESCAPE_LUMASHORT) {
    const ratioQ = reader.read(EXTREME_RATIO_BITS);
    if (ratioQ === 0) throw new Error('invalid FineHash aspect ratio');
    aspectRatio = decodeExtreme(ratioQ, header.orientation);
  } else {
    aspectRatio = shortToAspect(header.orientation, header.lumaShort);
  }
  const layout = allocate(aspectRatio, header.hasAlpha);

  const luma = unpackChannel(reader, layout.luma,   'luma',   layout.scaleBits);
  const by   = unpackChannel(reader, layout.chroma, 'chroma', layout.scaleBits);
  const rg   = unpackChannel(reader, layout.chroma, 'chroma', layout.scaleBits);
  const alpha = header.hasAlpha && layout.alpha
    ? unpackChannel(reader, layout.alpha, 'alpha', layout.scaleBits)
    : null;

  // The anti-ring window applies to luma only - the channel that carries hard,
  // ring-prone edges. Chroma and alpha stay unwindowed so color and transparency
  // edges keep their crispness.
  const { luma: ll, chroma: cl, alpha: al } = layout;
  const { width, height } = outputDims(aspectRatio, opts);
  const planes: ChannelPlanes = {
    i:  inverseDctChannel(luma.dc, applyLanczosWindow(luma.ac, ll.nx, ll.ny), width, height, ll.nx, ll.ny),
    by: inverseDctChannel(by.dc, by.ac, width, height, cl.nx, cl.ny),
    rg: inverseDctChannel(rg.dc, rg.ac, width, height, cl.nx, cl.ny),
    a: alpha && al
      ? inverseDctChannel(alpha.dc, alpha.ac, width, height, al.nx, al.ny)
      : null,
    width,
    height,
    hasAlpha: header.hasAlpha,
  };

  return { pixels: channelsToRgba(planes), width, height, hasAlpha: header.hasAlpha };
}

/** Decode a base64 FineHash string back to RGBA pixels. */
export function decodeFromBase64(hash: string, opts: DecodeOptions = {}): DecodeResult {
  return decode(base64ToBytes(hash), opts);
}

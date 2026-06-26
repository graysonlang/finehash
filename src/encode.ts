// Encode path: downsample -> opponent color space -> DCT -> quantize/pack. A single straight-line
// pass - the fixed allocation determines the coefficient set directly, so there
// is no quality search.

import type { RGBA } from './types';
import { downsampleToWorkingGrid } from './downsample';
import { colorTransform } from './color';
import { forwardDctChannel } from './dct';
import {
  allocate,
  aspectToShort,
  shortToAspect,
  encodeExtreme,
  decodeExtreme,
  ESCAPE_LUMASHORT,
  EXTREME_RATIO_BITS,
} from './allocate';
import { packHeader, VERSION_V1 } from './header';
import { BitWriter } from './bitio';
import { packChannel } from './pack';
import { bytesToBase64 } from './base64';
import { requirePositiveInteger, validatePixels } from './validate';

function assemble(header: number, payload: Uint8Array): Uint8Array {
  const len = 1 + payload.length;
  const out = new Uint8Array(len + ((3 - (len % 3)) % 3));
  out[0] = header;
  out.set(payload, 1);
  return out;
}

/** Encode RGBA pixels to a FineHash byte string. */
export function encode(pixels: RGBA, width: number, height: number): Uint8Array {
  width = requirePositiveInteger(width, 'width');
  height = requirePositiveInteger(height, 'height');
  validatePixels(pixels, width, height);

  const grid = downsampleToWorkingGrid(pixels, width, height);
  const planes = colorTransform(grid);
  const { width: w, height: h, hasAlpha } = planes;

  // Aspect is quantized to the luma short count and carried in the header byte;
  // extreme aspects take the escape hatch (a precise ratio leads the payload).
  // Either way the decoder rebuilds exactly the layout used here.
  const aspect = grid.width / grid.height;
  const { orientation, lumaShort } = aspectToShort(aspect);
  const escape = lumaShort === ESCAPE_LUMASHORT;
  const ratioQ = escape ? encodeExtreme(aspect) : 0;
  const reconstructed = escape ? decodeExtreme(ratioQ, orientation) : shortToAspect(orientation, lumaShort);
  const layout = allocate(reconstructed, hasAlpha);
  const writer = new BitWriter();
  if (escape) writer.write(ratioQ, EXTREME_RATIO_BITS);

  const { luma, chroma, alpha, scaleBits } = layout;
  packChannel(writer, forwardDctChannel(planes.i,  w, h, luma.nx,   luma.ny),   luma,   'luma',   scaleBits);
  packChannel(writer, forwardDctChannel(planes.by, w, h, chroma.nx, chroma.ny), chroma, 'chroma', scaleBits);
  packChannel(writer, forwardDctChannel(planes.rg, w, h, chroma.nx, chroma.ny), chroma, 'chroma', scaleBits);
  if (alpha && planes.a) {
    packChannel(writer, forwardDctChannel(planes.a, w, h, alpha.nx, alpha.ny), alpha, 'alpha', scaleBits);
  }
  return assemble(packHeader({ version: VERSION_V1, hasAlpha, orientation, lumaShort }), writer.finish());
}

/** Encode RGBA pixels straight to a base64 FineHash string. */
export function encodeToBase64(pixels: RGBA, width: number, height: number): string {
  return bytesToBase64(encode(pixels, width, height));
}

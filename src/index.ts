// Full export surface, used by the test suite. The distributable bundle ships the
// smaller public surface in public.ts.

export { encode, encodeToBase64 } from './encode';
export { decode, decodeFromBase64 } from './decode';
export { maxEncodedSize, maxBase64Length, MAX_ENCODED_SIZE } from './size';
export { packHeader, unpackHeader, VERSION_V1 } from './header';
export {
  allocate,
  acBitsFor,
  aspectToShort,
  shortToAspect,
  encodeExtreme,
  decodeExtreme,
  ESCAPE_LUMASHORT,
  EXTREME_RATIO_BITS,
  LUMA_MAX,
} from './allocate';
export type { Layout, ChannelLayout } from './allocate';
export { downsampleToWorkingGrid, resampleLinear, workingDims, WORKING_MAX } from './downsample';
export { srgbToLinear, linearToSrgb } from './srgb';
export { colorTransform, channelsToRgba, oppToRgb, OPP_SCALE } from './color';
export { forwardDctChannel, inverseDctChannel, applyLanczosWindow, acCount, acTerms, COS_BITS } from './dct';
export { BitWriter, BitReader } from './bitio';
export { packChannel, unpackChannel } from './pack';

export type {
  RGBA,
  DecodeOptions,
  DecodeResult,
} from './types';

export type { Grid } from './downsample';
export type { ChannelPlanes } from './color';
export type { DctChannel } from './dct';
export type { ChannelKind } from './pack';

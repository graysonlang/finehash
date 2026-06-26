// Public API surface bundled into the npm package by scripts/dist.mjs.

export { encode, encodeToBase64 } from './encode';
export { decode, decodeFromBase64 } from './decode';
export { maxEncodedSize, maxBase64Length } from './size';
export type { RGBA, DecodeOptions, DecodeResult } from './types';

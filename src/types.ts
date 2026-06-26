export type RGBA = Uint8Array | Uint8ClampedArray;

export interface DecodeOptions {
  width?: number;
  height?: number;
}

export interface DecodeResult {
  pixels: RGBA;
  width: number;
  height: number;
  hasAlpha: boolean;
}

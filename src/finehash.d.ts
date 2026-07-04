/**
 * finehash — deterministic image placeholder hashes that decode to a blurred
 * preview before the full image loads.
 */

/** Raw image/hash bytes. Canvas `ImageData.data` is a `Uint8ClampedArray`. */
export type ByteArray = Uint8Array | Uint8ClampedArray;

/** A hash as produced by {@link encode}: raw bytes, a typed-array view, or canonical base64. */
export type Hash = Uint8Array | ArrayBufferView | string;

/** Maximum encoded hash size, in bytes. */
export declare const MAX_ENCODED_SIZE: number;

/** Default longest output edge, in pixels, used by {@link decode} when no size is given. */
export declare const DEFAULT_LONGEST: number;

/** Options controlling the output dimensions of {@link decode}. */
export interface DecodeOptions {
  /** Explicit output width, in pixels. Height is derived from the aspect ratio if omitted. */
  width?: number;
  /** Explicit output height, in pixels. Width is derived from the aspect ratio if omitted. */
  height?: number;
}

/** Result of {@link decode}: a decoded RGBA preview and its metadata. */
export interface DecodeResult {
  /** Output width, in pixels. */
  width: number;
  /** Output height, in pixels. */
  height: number;
  /** Decoded RGBA pixels, row-major, 4 bytes per pixel. */
  rgba: Uint8ClampedArray;
  /** Decoded aspect ratio (width / height). */
  aspectRatio: number;
  /** Whether the hash carries an alpha channel. */
  hasAlpha: boolean;
}

/**
 * Encode an RGBA image into a finehash.
 *
 * @param rgba   Row-major RGBA pixels, 4 bytes per pixel (`width * height * 4`).
 * @param width  Source width, in pixels.
 * @param height Source height, in pixels.
 * @returns The encoded hash bytes (length is a multiple of 3, at most {@link MAX_ENCODED_SIZE}).
 */
export function encode(rgba: ByteArray, width: number, height: number): Uint8Array;

/**
 * Gamma-correct (linear-light) area-average downsample to a grid whose longest
 * side is at most `maxSide`. {@link encode} applies this itself; exposed for
 * callers that want the same resampler for display or preprocessing.
 *
 * @param rgba    Row-major RGBA pixels, 4 bytes per pixel.
 * @param width   Source width, in pixels.
 * @param height  Source height, in pixels.
 * @param maxSide Longest output edge, in pixels (default 128). Images already
 *                within bounds are copied through unchanged.
 */
export function downsampleToWorkingGrid(
  rgba: ByteArray,
  width: number,
  height: number,
  maxSide?: number,
): { data: Uint8ClampedArray; width: number; height: number };

/**
 * Decode a finehash back into a blurred RGBA preview.
 *
 * @param hash    Hash bytes (or a typed-array view) or a canonical base64 string.
 * @param options Optional output-dimension overrides.
 */
export function decode(hash: Hash, options?: DecodeOptions): DecodeResult;

/** Encode hash bytes as canonical (unpadded) base64. */
export function toBase64(hash: ByteArray): string;

/** Decode canonical (unpadded) base64 into hash bytes. Throws on padded input. */
export function fromBase64(base64: string): Uint8Array;

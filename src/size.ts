// The single fixed allocation gives one encoded-size bound (worst case: square
// aspect + alpha), so callers can size a database column without encoding anything.

// A multiple of 3 so the base64 form needs no padding.
export const MAX_ENCODED_SIZE = 51;

/** Maximum encoded size in bytes for any FineHash. */
export function maxEncodedSize(): number {
  return MAX_ENCODED_SIZE;
}

/** Maximum base64 length for any FineHash. */
export function maxBase64Length(): number {
  return (MAX_ENCODED_SIZE / 3) * 4;
}

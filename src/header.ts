// The one self-describing header byte:
//   7-5 version (000 = v1; decoders reject unknown)
//   4 hasAlpha
//   3 orientation (0 = landscape, 1 = portrait)
//   2-0 lumaShort (count - 3 -> 3..9; 7 = escape)
// Bit 7 is the MSB; this byte and the payload after it are packed MSB-first (see bitio.ts).

export const VERSION_V1 = 0b000;

export interface Header {
  version: number;
  hasAlpha: boolean;
  orientation: number;
  /** Luma short-axis term count, 3..9; or `ESCAPE_LUMASHORT` (10) for the payloaded-aspect escape. */
  lumaShort: number;
}

export function packHeader({ version, hasAlpha, orientation, lumaShort }: Header): number {
  return (
    ((version & 0b111) << 5)
    | ((hasAlpha ? 1 : 0) << 4)
    | ((orientation & 1) << 3)
    | ((lumaShort - 3) & 0b111)
  );
}

export function unpackHeader(byte: number): Header {
  const version = (byte >> 5) & 0b111;
  if (version !== VERSION_V1) {
    throw new Error(`unsupported FineHash version ${version}`);
  }
  return {
    version,
    hasAlpha: ((byte >> 4) & 1) === 1,
    orientation: (byte >> 3) & 1,
    lumaShort: (byte & 0b111) + 3,
  };
}

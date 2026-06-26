const SRGB_GAMMA = 2.4;
export const LINEAR_TABLE_MAX = 4095;

export const SRGB_TO_LINEAR: Float64Array = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; ++i) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, SRGB_GAMMA);
  }
  return table;
})();

export const LINEAR_TO_SRGB: Uint8Array = (() => {
  const table = new Uint8Array(LINEAR_TABLE_MAX + 1);
  const invGamma = 1 / SRGB_GAMMA;
  for (let i = 0; i <= LINEAR_TABLE_MAX; ++i) {
    const c = i / LINEAR_TABLE_MAX;
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, invGamma) - 0.055;
    table[i] = Math.min(255, Math.max(0, Math.round(s * 255)));
  }
  return table;
})();

export function srgbToLinear(byte: number): number {
  return SRGB_TO_LINEAR[byte & 0xff]!;
}

export function linearToSrgb(v: number): number {
  const clamped = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return LINEAR_TO_SRGB[(clamped * LINEAR_TABLE_MAX + 0.5) | 0]!;
}

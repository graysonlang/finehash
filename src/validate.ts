import type { RGBA } from './types';

export function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : requirePositiveInteger(value, name);
}

export function validatePixels(pixels: RGBA, width: number, height: number): void {
  const expected = width * height * 4;
  if (!Number.isSafeInteger(expected)) {
    throw new Error('image dimensions are too large');
  }
  if (pixels.length < expected) {
    throw new Error(`pixels must contain at least ${expected} RGBA bytes`);
  }
}

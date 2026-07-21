const WORKING_MAX = 128;
const OPP_SCALE = 6;
const COS_BITS = 12;
const COS_ONE = 1 << COS_BITS;
const LUMA_MAX = 9;
const CHROMA_MAX = 5;
const ALPHA_MAX = 5;
const SHORT_AXIS_MIN = 3;
const ESCAPE_LUMASHORT = 10;
const EXTREME_RATIO_BITS = 5;
const EXTREME_MAX_RATIO = 1 / 3;
export const MAX_ENCODED_SIZE = 51;
export const DEFAULT_LONGEST = 32;

const SCALE_BITS = 6;
const SCALE_QMAX = (1 << SCALE_BITS) - 1;

const CHANNELS = {
  luma: { dcBits: 7, acBits: [6, 5, 4], dcMax: 1530, scaleMax: 765, signedDc: false },
  chroma: { dcBits: 5, acBits: [4], dcMax: 1530, scaleMax: 1530, signedDc: true },
  alpha: { dcBits: 5, acBits: [4], dcMax: 255, scaleMax: 128, signedDc: false },
};

const cosCache = new Map();

function roundHalfAwayFromZero(v) {
  return v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
}

function roundHalfUp(v) {
  return Math.floor(v + 0.5);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function workingDims(width, height, maxSide = WORKING_MAX) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('invalid dimensions');
  }
  const long = Math.max(width, height);
  if (long <= maxSide) return { width, height };
  const s = maxSide / long;
  return {
    width: Math.max(1, roundHalfAwayFromZero(width * s)),
    height: Math.max(1, roundHalfAwayFromZero(height * s)),
  };
}

function srgbToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v) {
  const x = clamp(v, 0, 1);
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return clamp(roundHalfAwayFromZero(c * 255), 0, 255);
}

// Tabulated srgbToLinear over the byte domain; the resample inner loop is the
// encode hot path and the pow call dominates it.
const SRGB_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) SRGB_LINEAR[i] = srgbToLinear(i);

function resampleLinear(rgba, width, height, outWidth, outHeight) {
  assertRgba(rgba, width, height);
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const sx = width / outWidth;
  const sy = height / outHeight;

  for (let dy = 0; dy < outHeight; dy++) {
    const y0 = dy * sy;
    const y1 = y0 + sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.ceil(y1);
    for (let dx = 0; dx < outWidth; dx++) {
      const x0 = dx * sx;
      const x1 = x0 + sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.ceil(x1);
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;
      let cov = 0;

      for (let syi = iy0; syi < iy1; syi++) {
        if (syi < 0 || syi >= height) continue;
        const wy = Math.max(0, Math.min(y1, syi + 1) - Math.max(y0, syi));
        for (let sxi = ix0; sxi < ix1; sxi++) {
          if (sxi < 0 || sxi >= width) continue;
          const wx = Math.max(0, Math.min(x1, sxi + 1) - Math.max(x0, sxi));
          const w = wx * wy;
          const si = (syi * width + sxi) * 4;
          const a = rgba[si + 3] / 255;
          const wa = w * a;
          accR += SRGB_LINEAR[rgba[si]] * wa;
          accG += SRGB_LINEAR[rgba[si + 1]] * wa;
          accB += SRGB_LINEAR[rgba[si + 2]] * wa;
          accA += wa;
          cov += w;
        }
      }

      const oi = (dy * outWidth + dx) * 4;
      if (accA > 1e-6) {
        out[oi] = linearToSrgb(accR / accA);
        out[oi + 1] = linearToSrgb(accG / accA);
        out[oi + 2] = linearToSrgb(accB / accA);
        out[oi + 3] = clamp(roundHalfAwayFromZero((255 * accA) / cov), 0, 255);
      } else {
        out[oi] = 0;
        out[oi + 1] = 0;
        out[oi + 2] = 0;
        out[oi + 3] = 0;
      }
    }
  }

  return out;
}

// Area-average downsample to a grid whose longest side is at most `maxSide`,
// returning { data, width, height }. Convenience wrapper over resampleLinear
// (copies through unchanged when the image is already within bounds).
export function downsampleToWorkingGrid(rgba, width, height, maxSide = WORKING_MAX) {
  const { width: w, height: h } = workingDims(width, height, maxSide);
  if (w === width && h === height) {
    const data = new Uint8ClampedArray(width * height * 4);
    data.set(rgba.subarray(0, data.length));
    return { data, width, height };
  }
  return { data: resampleLinear(rgba, width, height, w, h), width: w, height: h };
}

// Composite straight-alpha pixels over the image's alpha-weighted mean color
// (Porter-Duff "over") so transparent regions are flat and don't spend scarce
// DCT terms on undefined color. The original alpha passes through unchanged.
function flattenAlpha(rgba, width, height) {
  assertRgba(rgba, width, height);
  const out = new Uint8ClampedArray(rgba.length);
  let hasAlpha = false;
  let sumA = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    if (rgba[i + 3] !== 255) hasAlpha = true;
    sumA += a;
    sumR += a * rgba[i];
    sumG += a * rgba[i + 1];
    sumB += a * rgba[i + 2];
  }

  const bgR = sumA > 0 ? sumR / sumA : 0;
  const bgG = sumA > 0 ? sumG / sumA : 0;
  const bgB = sumA > 0 ? sumB / sumA : 0;

  for (let i = 0; i < rgba.length; i += 4) {
    const aByte = rgba[i + 3];
    const a = aByte / 255;
    if (aByte === 255) {
      out[i] = rgba[i];
      out[i + 1] = rgba[i + 1];
      out[i + 2] = rgba[i + 2];
    } else if (aByte === 0) {
      out[i] = roundHalfAwayFromZero(bgR);
      out[i + 1] = roundHalfAwayFromZero(bgG);
      out[i + 2] = roundHalfAwayFromZero(bgB);
    } else {
      out[i] = clamp(roundHalfAwayFromZero(rgba[i] * a + bgR * (1 - a)), 0, 255);
      out[i + 1] = clamp(roundHalfAwayFromZero(rgba[i + 1] * a + bgG * (1 - a)), 0, 255);
      out[i + 2] = clamp(roundHalfAwayFromZero(rgba[i + 2] * a + bgB * (1 - a)), 0, 255);
    }
    out[i + 3] = aByte;
  }

  return { rgba: out, hasAlpha };
}

// Split a channel's term budget across the axes in proportion to aspect ratio
// (DCT energy compaction: a longer axis carries more usable low-frequency
// terms), flooring the short axis at SHORT_AXIS_MIN. Encoder and decoder must
// compute identical results from the same ratio; the layout depends on it.
function splitByAspect(maxTerms, ratio) {
  if (!(ratio > 0)) throw new Error('invalid aspect ratio');
  if (ratio >= 1) {
    return {
      nx: maxTerms,
      ny: clamp(roundHalfUp(maxTerms / ratio), SHORT_AXIS_MIN, maxTerms),
    };
  }
  return {
    nx: clamp(roundHalfUp(maxTerms * ratio), SHORT_AXIS_MIN, maxTerms),
    ny: maxTerms,
  };
}

function allocate(ratio, hasAlpha) {
  return {
    luma: { ...splitByAspect(LUMA_MAX, ratio), ...CHANNELS.luma },
    rg: { ...splitByAspect(CHROMA_MAX, ratio), ...CHANNELS.chroma },
    by: { ...splitByAspect(CHROMA_MAX, ratio), ...CHANNELS.chroma },
    alpha: hasAlpha ? { ...splitByAspect(ALPHA_MAX, ratio), ...CHANNELS.alpha } : null,
  };
}

// Reconstruct the ratio the decoder derives from the header fields. Both sides
// build their layouts from this value, so it is the single statement of the
// header -> ratio rule.
function ratioFromHeader(orientation, lumaShort, extremeRatio) {
  if (lumaShort === ESCAPE_LUMASHORT) {
    const shortOverLong = (extremeRatio / ((1 << EXTREME_RATIO_BITS) - 1)) * EXTREME_MAX_RATIO;
    return orientation === 0 ? 1 / shortOverLong : shortOverLong;
  }
  return orientation === 0 ? LUMA_MAX / lumaShort : lumaShort / LUMA_MAX;
}

function quantizeAspect(width, height) {
  const r = width / height;
  const orientation = r >= 1 ? 0 : 1;
  const longOverShort = Math.max(r, 1 / r);
  if (roundHalfUp(LUMA_MAX / longOverShort) < SHORT_AXIS_MIN) {
    const shortOverLong = 1 / longOverShort;
    const extremeRatio = clamp(
      roundHalfUp((shortOverLong / EXTREME_MAX_RATIO) * ((1 << EXTREME_RATIO_BITS) - 1)),
      1,
      (1 << EXTREME_RATIO_BITS) - 1,
    );
    return {
      orientation,
      lumaShort: ESCAPE_LUMASHORT,
      extremeRatio,
      ratio: ratioFromHeader(orientation, ESCAPE_LUMASHORT, extremeRatio),
    };
  }

  const { nx, ny } = splitByAspect(LUMA_MAX, r);
  const lumaShort = Math.min(nx, ny);
  return {
    orientation,
    lumaShort,
    extremeRatio: null,
    ratio: ratioFromHeader(orientation, lumaShort, null),
  };
}

function packHeader({ hasAlpha, orientation, lumaShort }) {
  if (orientation !== 0 && orientation !== 1) throw new Error('invalid orientation');
  if (lumaShort < 3 || lumaShort > 10) throw new Error('invalid lumaShort');
  const stored = lumaShort === ESCAPE_LUMASHORT ? 7 : lumaShort - 3;
  return ((hasAlpha ? 1 : 0) << 4) | (orientation << 3) | stored;
}

function unpackHeader(byte) {
  const version = byte >> 5;
  if (version !== 0) throw new Error('unknown version');
  const stored = byte & 7;
  return {
    version,
    hasAlpha: ((byte >> 4) & 1) === 1,
    orientation: (byte >> 3) & 1,
    lumaShort: stored === 7 ? ESCAPE_LUMASHORT : stored + 3,
  };
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.bitPos = 0;
  }

  write(value, bits) {
    if (!Number.isInteger(value) || value < 0 || value > (1 << bits) - 1) {
      throw new Error('value does not fit field');
    }
    for (let i = bits - 1; i >= 0; i--) {
      this.current |= ((value >> i) & 1) << (7 - this.bitPos);
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.bitPos = 0;
      }
    }
  }

  finish() {
    if (this.bitPos > 0) {
      this.bytes.push(this.current);
      this.current = 0;
      this.bitPos = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bytePos = 0;
    this.bitPos = 0;
  }

  read(bits) {
    let value = 0;
    for (let i = 0; i < bits; i++) {
      if (this.bytePos >= this.bytes.length) throw new Error('truncated');
      value = (value << 1) | ((this.bytes[this.bytePos] >> (7 - this.bitPos)) & 1);
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return value;
  }
}

function scanCoefficients(nx, ny) {
  const out = [];
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = cy === 0 ? 1 : 0; cx < nx; cx++) {
      if (cx * ny < nx * (ny - cy)) out.push({ cx, cy });
    }
  }
  return out;
}

function cosTable(n, count) {
  const key = `${n}:${count}`;
  const cached = cosCache.get(key);
  if (cached) return cached;
  const table = [];
  for (let c = 0; c < count; c++) {
    const row = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      row[i] = roundHalfAwayFromZero(Math.cos((Math.PI / n) * c * (i + 0.5)) * COS_ONE);
    }
    table.push(row);
  }
  cosCache.set(key, table);
  return table;
}

function forwardDctChannel(plane, width, height, nx, ny) {
  const cosX = cosTable(width, nx);
  const cosY = cosTable(height, ny);
  const rowf = Array.from({ length: nx }, () => new Float64Array(height));
  for (let cx = 0; cx < nx; cx++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const off = y * width;
      for (let x = 0; x < width; x++) sum += plane[off + x] * cosX[cx][x];
      rowf[cx][y] = sum;
    }
  }

  const denom = width * height * COS_ONE * COS_ONE;
  let dcSum = 0;
  for (let y = 0; y < height; y++) dcSum += rowf[0][y] * cosY[0][y];
  const ac = [];
  for (const { cx, cy } of scanCoefficients(nx, ny)) {
    let sum = 0;
    for (let y = 0; y < height; y++) sum += rowf[cx][y] * cosY[cy][y];
    ac.push(sum / denom);
  }
  return { dc: dcSum / denom, ac };
}

function inverseDctChannel(dc, ac, width, height, nx, ny) {
  const cosX = cosTable(width, nx);
  const cosY = cosTable(height, ny);
  const coords = scanCoefficients(nx, ny);
  const rows = coords.map(({ cx }) => cosX[cx]);
  const cols = coords.map(({ cy }) => cosY[cy]);
  const out = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = dc;
      for (let j = 0; j < ac.length; j++) {
        v += ac[j] * rows[j][x] * (cols[j][y] * 2) / (COS_ONE * COS_ONE);
      }
      out[y * width + x] = roundHalfAwayFromZero(v);
    }
  }
  return out;
}

function applyLanczosWindow(ac, nx, ny) {
  const coords = scanCoefficients(nx, ny);
  const out = new Array(ac.length);
  for (let i = 0; i < ac.length; i++) {
    const { cx, cy } = coords[i];
    out[i] = ac[i] * (sinc(cx / nx) * sinc(cy / ny));
  }
  return out;
}

export function encode(rgba, width, height) {
  assertRgba(rgba, width, height);
  const grid = downsampleToWorkingGrid(rgba, width, height);
  const flattened = flattenAlpha(grid.data, grid.width, grid.height);
  // hasAlpha is judged on the working grid: transparency that averages away in
  // the downsample would only buy a constant-255 alpha plane.
  const hasAlpha = flattened.hasAlpha;
  const aspect = quantizeAspect(grid.width, grid.height);
  const layout = allocate(aspect.ratio, hasAlpha);
  const planes = makePlanes(flattened.rgba, grid.width, grid.height, hasAlpha);
  const coeffs = {
    luma: forwardDctChannel(planes.luma, grid.width, grid.height, layout.luma.nx, layout.luma.ny),
    rg: forwardDctChannel(planes.rg, grid.width, grid.height, layout.rg.nx, layout.rg.ny),
    by: forwardDctChannel(planes.by, grid.width, grid.height, layout.by.nx, layout.by.ny),
    alpha: hasAlpha
      ? forwardDctChannel(planes.alpha, grid.width, grid.height, layout.alpha.nx, layout.alpha.ny)
      : null,
  };

  const writer = new BitWriter();
  if (aspect.lumaShort === ESCAPE_LUMASHORT) writer.write(aspect.extremeRatio, EXTREME_RATIO_BITS);
  writeChannel(writer, coeffs.luma, layout.luma);
  writeChannel(writer, coeffs.rg, layout.rg);
  writeChannel(writer, coeffs.by, layout.by);
  if (hasAlpha) writeChannel(writer, coeffs.alpha, layout.alpha);

  const payload = writer.finish();
  const out = [packHeader({ hasAlpha, orientation: aspect.orientation, lumaShort: aspect.lumaShort })];
  for (const byte of payload) out.push(byte);
  while (out.length % 3 !== 0) out.push(0);
  if (out.length > MAX_ENCODED_SIZE) throw new Error('encoded size exceeds maximum');
  return Uint8Array.from(out);
}

export function decode(hash, options = {}) {
  const bytes = normalizeHash(hash);
  if (bytes.length < 1 || bytes.length % 3 !== 0) throw new Error('invalid length');
  if (bytes.length > MAX_ENCODED_SIZE) throw new Error('oversized');
  const header = unpackHeader(bytes[0]);
  const reader = new BitReader(bytes.subarray(1));
  let extremeRatio = null;
  if (header.lumaShort === ESCAPE_LUMASHORT) {
    extremeRatio = reader.read(EXTREME_RATIO_BITS);
    if (extremeRatio < 1) throw new Error('invalid extreme ratio');
  }
  const ratio = ratioFromHeader(header.orientation, header.lumaShort, extremeRatio);

  const layout = allocate(ratio, header.hasAlpha);
  const width = decodeWidth(options, ratio);
  const height = decodeHeight(options, ratio, width);
  const luma = readChannel(reader, layout.luma);
  const rg = readChannel(reader, layout.rg);
  const by = readChannel(reader, layout.by);
  const alpha = header.hasAlpha ? readChannel(reader, layout.alpha) : null;

  const lumaPlane = inverseDctChannel(luma.dc, applyLanczosWindow(luma.ac, layout.luma.nx, layout.luma.ny), width, height, layout.luma.nx, layout.luma.ny);
  const byPlane = inverseDctChannel(by.dc, by.ac, width, height, layout.by.nx, layout.by.ny);
  const rgPlane = inverseDctChannel(rg.dc, rg.ac, width, height, layout.rg.nx, layout.rg.ny);
  const alphaPlane = alpha ? inverseDctChannel(alpha.dc, alpha.ac, width, height, layout.alpha.nx, layout.alpha.ny) : null;
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const I = lumaPlane[i];
    const byv = byPlane[i];
    const rgv = rgPlane[i];
    rgba[i * 4] = clamp(roundHalfAwayFromZero((6 * I + 2 * byv + 3 * rgv) / 36), 0, 255);
    rgba[i * 4 + 1] = clamp(roundHalfAwayFromZero((6 * I + 2 * byv - 3 * rgv) / 36), 0, 255);
    rgba[i * 4 + 2] = clamp(roundHalfAwayFromZero((6 * I - 4 * byv) / 36), 0, 255);
    rgba[i * 4 + 3] = alphaPlane ? clamp(alphaPlane[i], 0, 255) : 255;
  }

  return { width, height, rgba, aspectRatio: ratio, hasAlpha: header.hasAlpha };
}

export function toBase64(hash) {
  let binary = '';
  for (let i = 0; i < hash.length; i++) binary += String.fromCharCode(hash[i]);
  return btoa(binary).replace(/=+$/, '');
}

export function fromBase64(base64) {
  if (/=/.test(base64)) throw new Error('padded base64 is not canonical');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function writeChannel(writer, coeffs, layout) {
  const ac = coeffs.ac;
  const scale = ac.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const scaleQ = clamp(roundHalfUp((scale / layout.scaleMax) * SCALE_QMAX), 0, SCALE_QMAX);
  const dscale = (scaleQ / SCALE_QMAX) * layout.scaleMax;
  writer.write(scaleQ, SCALE_BITS);
  writer.write(quantizeDc(coeffs.dc, layout), layout.dcBits);
  const coords = scanCoefficients(layout.nx, layout.ny);
  for (let i = 0; i < coords.length; i++) {
    const bits = acBitsFor(layout, coords[i]);
    const half = 1 << (bits - 1);
    const norm = dscale > 0 ? ac[i] / dscale : 0;
    writer.write(clamp(roundHalfUp(norm * half) + half, 0, (1 << bits) - 1), bits);
  }
}

function readChannel(reader, layout) {
  const scaleQ = reader.read(SCALE_BITS);
  const dscale = (scaleQ / SCALE_QMAX) * layout.scaleMax;
  const dc = dequantizeDc(reader.read(layout.dcBits), layout);
  const ac = [];
  for (const coord of scanCoefficients(layout.nx, layout.ny)) {
    const bits = acBitsFor(layout, coord);
    const half = 1 << (bits - 1);
    const q = reader.read(bits);
    ac.push(((q - half) / half) * dscale);
  }
  return { dc, ac };
}

function quantizeDc(dc, layout) {
  const maxQ = (1 << layout.dcBits) - 1;
  if (layout.signedDc) {
    const half = 1 << (layout.dcBits - 1);
    return clamp(roundHalfUp((dc / layout.dcMax) * half) + half, 0, maxQ);
  }
  return clamp(roundHalfUp((dc / layout.dcMax) * maxQ), 0, maxQ);
}

function dequantizeDc(q, layout) {
  if (layout.signedDc) {
    const half = 1 << (layout.dcBits - 1);
    return ((q - half) / half) * layout.dcMax;
  }
  return (q / ((1 << layout.dcBits) - 1)) * layout.dcMax;
}

function acBitsFor(layout, { cx, cy }) {
  const band = cx + cy - 1;
  return layout.acBits[Math.min(band, layout.acBits.length - 1)];
}

// Rotate RGB into an opponent color space - an achromatic intensity axis plus
// red-green and blue-yellow chromatic axes - so the channels decorrelate and
// chroma can carry fewer terms than luma. Carried at OPP_SCALE (6x) so the
// forward transform stays exact integer arithmetic.
function makePlanes(rgba, width, height, hasAlpha) {
  const n = width * height;
  const luma = new Float64Array(n);
  const rg = new Float64Array(n);
  const by = new Float64Array(n);
  const alpha = hasAlpha ? new Float64Array(n) : null;
  for (let i = 0; i < n; i++) {
    const R = rgba[i * 4];
    const G = rgba[i * 4 + 1];
    const B = rgba[i * 4 + 2];
    luma[i] = 2 * (R + G + B);
    rg[i] = OPP_SCALE * (R - G);
    by[i] = 3 * (R + G) - OPP_SCALE * B;
    if (alpha) alpha[i] = rgba[i * 4 + 3];
  }
  return { luma, rg, by, alpha };
}

function decodeWidth(options, ratio) {
  if (options.width != null) return checkedDim(options.width);
  if (options.height != null) return Math.max(1, roundHalfUp(checkedDim(options.height) * ratio));
  return ratio >= 1 ? DEFAULT_LONGEST : Math.max(1, roundHalfUp(DEFAULT_LONGEST * ratio));
}

function decodeHeight(options, ratio, width) {
  if (options.height != null) return checkedDim(options.height);
  if (options.width != null) return Math.max(1, roundHalfUp(width / ratio));
  return ratio >= 1 ? Math.max(1, roundHalfUp(DEFAULT_LONGEST / ratio)) : DEFAULT_LONGEST;
}

function checkedDim(v) {
  if (!Number.isInteger(v) || v < 1) throw new Error('invalid decode dimensions');
  return v;
}

function normalizeHash(hash) {
  if (typeof hash === 'string') return fromBase64(hash);
  if (hash instanceof Uint8Array) return hash;
  if (ArrayBuffer.isView(hash)) return new Uint8Array(hash.buffer, hash.byteOffset, hash.byteLength);
  throw new Error('invalid hash');
}

function sinc(x) {
  return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}

function assertRgba(rgba, width, height) {
  if (!(rgba instanceof Uint8Array) && !ArrayBuffer.isView(rgba)) throw new Error('rgba must be a byte array');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('invalid dimensions');
  if (rgba.length !== width * height * 4) throw new Error('rgba length does not match dimensions');
}

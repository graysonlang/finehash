// Separable DCT-II with triangular truncation. The cosine basis is precomputed
// into fixed-point integer tables so the per-coefficient accumulation is pure
// integer arithmetic (a prerequisite for cross-platform-deterministic encoding).
// Coefficients (cx, cy) are kept where `cx/nx + cy/ny < 1`, iterated cy-outer /
// cx-inner, (0,0) as DC; forward and inverse share that exact ordering.

export const COS_BITS = 12;
const COS_ONE = 1 << COS_BITS;
const INV_COS2 = 1 / (COS_ONE * COS_ONE);

export interface DctChannel {
  dc: number;
  ac: Float64Array;
}

const tableCache = new Map<string, Int32Array>();

function cosTable(n: number, count: number): Int32Array {
  const key = `${n}:${count}`;
  const cached = tableCache.get(key);
  if (cached) return cached;
  const t = new Int32Array(count * n);
  for (let c = 0; c < count; ++c) {
    for (let i = 0; i < n; ++i) {
      t[c * n + i] = Math.round(Math.cos((Math.PI / n) * c * (i + 0.5)) * COS_ONE);
    }
  }
  tableCache.set(key, t);
  return t;
}

export function acCount(nx: number, ny: number): number {
  let count = 0;
  for (let cy = 0; cy < ny; ++cy) {
    for (let cx = cy === 0 ? 1 : 0; cx * ny < nx * (ny - cy); ++cx) count++;
  }
  return count;
}

/** AC frequency pairs `[cx, cy]` in triangular order - the canonical coefficient order. */
export function acTerms(nx: number, ny: number): Array<[number, number]> {
  const terms: Array<[number, number]> = [];
  for (let cy = 0; cy < ny; ++cy) {
    for (let cx = cy === 0 ? 1 : 0; cx * ny < nx * (ny - cy); ++cx) terms.push([cx, cy]);
  }
  return terms;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

const windowCache = new Map<string, Float64Array>();
function windowWeights(nx: number, ny: number): Float64Array {
  const key = `${nx}:${ny}`;
  const cached = windowCache.get(key);
  if (cached) return cached;
  const terms = acTerms(nx, ny);
  const w = new Float64Array(terms.length);
  for (let j = 0; j < terms.length; ++j) {
    const [cx, cy] = terms[j]!;
    w[j] = sinc(cx / nx) * sinc(cy / ny);
  }
  windowCache.set(key, w);
  return w;
}

/**
 * Decode-side Lanczos anti-ring window: scale each AC coefficient by
 * `sinc(cx/nx)*sinc(cy/ny)`, tapering high frequencies toward zero to suppress
 * Gibbs ringing. Part of the format's defined appearance; DC is untouched.
 */
export function applyLanczosWindow(
  ac: ArrayLike<number>,
  nx: number,
  ny: number,
  strength = 1,
): Float64Array {
  const w = windowWeights(nx, ny);
  const out = new Float64Array(ac.length);
  for (let j = 0; j < ac.length; ++j) {
    out[j] = (ac[j] ?? 0) * (strength * w[j]! + (1 - strength));
  }
  return out;
}

export function forwardDctChannel(
  channel: Int32Array,
  w: number,
  h: number,
  nx: number,
  ny: number,
): DctChannel {
  const cosX = cosTable(w, nx);
  const cosY = cosTable(h, ny);

  const rowf = new Float64Array(nx * h);
  for (let cx = 0; cx < nx; ++cx) {
    const cb = cx * w;
    for (let y = 0; y < h; ++y) {
      const rb = y * w;
      let s = 0;
      for (let x = 0; x < w; ++x) s += channel[rb + x]! * cosX[cb + x]!;
      rowf[cx * h + y] = s;
    }
  }

  const norm = 1 / (w * h * COS_ONE * COS_ONE);
  let dc = 0;
  const ac: number[] = [];
  for (let cy = 0; cy < ny; ++cy) {
    const yb = cy * h;
    for (let cx = 0; cx * ny < nx * (ny - cy); ++cx) {
      const rb = cx * h;
      let s = 0;
      for (let y = 0; y < h; ++y) s += rowf[rb + y]! * cosY[yb + y]!;
      const f = s * norm;
      if (cx === 0 && cy === 0) dc = f;
      else ac.push(f);
    }
  }
  return { dc, ac: Float64Array.from(ac) };
}

export function inverseDctChannel(
  dc: number,
  ac: ArrayLike<number>,
  w: number,
  h: number,
  nx: number,
  ny: number,
): Int32Array {
  const cosX = cosTable(w, nx);
  const cosY = cosTable(h, ny);
  const out = new Int32Array(w * h);

  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      let v = dc;
      let j = 0;
      for (let cy = 0; cy < ny; ++cy) {
        const fy = cosY[cy * h + y]! * 2; // AC terms reconstruct with x2
        for (let cx = cy === 0 ? 1 : 0; cx * ny < nx * (ny - cy); ++cx, ++j) {
          v += ac[j]! * cosX[cx * w + x]! * fy * INV_COS2;
        }
      }
      out[y * w + x] = Math.round(v);
    }
  }
  return out;
}

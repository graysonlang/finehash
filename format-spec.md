# FineHash v1 — Codec & Bitstream Specification

A FineHash is a tiny (≤ 51-byte) code that encodes a blurred, resolution-independent placeholder of an image. This document specifies the whole codec end to end.

- **Part I** is a readable walkthrough of the pipeline and the design choices.
- **Part II** is the byte-exact appendix: every constant, bit position, and formula needed to write an interoperable, drop-in v1 encoder/decoder from scratch.

---

# Part I — Overview

## What it is

FineHash trades a fixed, tiny byte budget for a smooth low-frequency preview. Unlike a thumbnail, the code stores **DCT coefficients**, not pixels, so it can be decoded to *any* output size. The layout (how many coefficients, at what bit depths) is a pure function of the image's aspect ratio and whether it has alpha — there is **no quality search and no entropy coder**, so encode is a single straight-line pass and every field width is known in advance.

## Pipeline

```
ENCODE  RGBA(W×H)
  ├─ 1. downsample ......... area-average box filter in linear light → working grid (≤128 long side)
  ├─ 2. color transform .... flatten alpha over mean color; RGB → opponent planes (I, rg, by) + straight A
  ├─ 3. aspect → header .... quantize W/H to a small integer; pick orientation; set the escape if extreme
  ├─ 4. allocate ........... aspect + alpha → per-channel (nx, ny) term grids and bit depths
  ├─ 5. forward DCT ........ separable DCT-II per plane, triangular-truncated to nx×ny (integer cosine table)
  ├─ 6. quantize + pack .... per channel: AC scale, DC, then AC terms at per-band bit depths, MSB-first
  └─ 7. frame .............. header byte + payload; pad to a multiple of 3 bytes → (optional base64)

DECODE  bytes
  ├─ parse header, recover aspect (+ escape)
  ├─ allocate the identical layout
  ├─ unpack per channel → DC + AC coefficients
  ├─ luma AC only: apply the Lanczos anti-ring window
  ├─ inverse DCT each plane, evaluated at the requested OUTPUT W×H (resolution-independent)
  └─ opponent → RGB, reattach alpha → RGBA
```

## Stage notes

**1. Downsample.** The image is reduced so its longest side is ≤ 128 px, using an exact area-average (box) filter. Averaging is done in **linear light** with **alpha-weighted** (premultiplied) coverage; averaging gamma-encoded bytes directly would darken gradients, and ignoring alpha would bleed hidden colors across edges.

**2. Color transform.** Straight-alpha pixels are composited over the image's alpha-weighted mean color (so transparent regions are flat and don't waste DCT terms), then RGB is rotated into an **opponent color space** — one achromatic intensity channel (I) plus two chromatic axes (red–green `rg`, blue–yellow `by`). This decorrelates the channels so each compresses well independently, and lets chroma carry far fewer terms than luma. Alpha rides along as its own straight channel. The transform is carried at 6× integer scale so it's exact on the forward path.

**3. Aspect → header.** The working grid's aspect ratio is quantized to the luma short-axis term count (an integer 3..9) and packed, with orientation, into the single header byte. Very elongated images (short/long below 1∕3) can't express their ratio that way, so an **escape** stores a finer 5-bit ratio at the front of the payload instead.

**4. Allocate.** Given the (reconstructed) aspect and alpha flag, a deterministic function yields, per channel, an `nx × ny` grid of retained low-frequency coefficients and the bit depths for the DC term and each AC frequency band. **This function *is* the format** — encoder and decoder must compute byte-identical layouts. Longer axes get more terms (energy compaction); the short axis is floored at 3.

**5. Forward DCT.** Each plane gets a **separable 2-D DCT-II**, computed with a precomputed **integer** cosine table so the forward path is bit-identical across platforms. Only the low-frequency triangle `cx/nx + cy/ny < 1` is kept, in a fixed scan order shared by forward and inverse.

**6. Quantize + pack.** Per channel: find the peak AC magnitude, quantize it to a shared **scale** (6 bits); write the **DC** term (unsigned for luma/alpha, mid-tread signed for chroma); then every **AC** term as a mid-tread signed value normalized by the scale, at its band's bit depth. All widths come from the layout, so there are no length prefixes.

**7. Frame.** Header byte, then the MSB-first payload bitstream, zero-padded to a byte and then up to a multiple of 3 bytes (so the base64 form needs no `=` padding).

**Decode** mirrors this, with two asymmetries that are part of the defined appearance: the **inverse DCT is evaluated at the requested output resolution** (the code is resolution-independent — you ask for any W×H), and a **Lanczos window** tapers the luma AC coefficients to suppress Gibbs ringing at hard edges (chroma/alpha are left crisp).

## Design properties a reimplementation must preserve

- **Deterministic forward path.** Downsample, color transform, and forward DCT use integer/table arithmetic; given the same input bytes, every encoder produces the same code. The decoder is allowed floating point (its output is a blurred preview).
- **Fixed allocation.** No search; layout depends only on aspect + alpha. This is what bounds the size at **51 bytes** and lets callers size storage without encoding.
- **Resolution independence.** Decoders synthesize at arbitrary W×H from the same coefficients; there is no stored pixel grid.

---

# Part II — Exact appendix

All integers are non-negative unless noted. `round()` is round-half-away-from-zero for the pixel/color paths and round-half-up (`Math.round`, ties → +∞) for the layout math; both are called out where they matter. `clamp(v,lo,hi)` returns `lo`/`hi` when out of range.

## A. Constants

| Name | Value | Meaning |
|---|---|---|
| `WORKING_MAX` | 128 | longest side of the working grid |
| `SRGB_GAMMA` | 2.4 | sRGB transfer exponent |
| `OPP_SCALE` | 6 | opponent-space integer scale |
| `COS_BITS` / `COS_ONE` | 12 / 4096 | DCT cosine fixed-point (1.0 = 4096) |
| `LUMA_MAX` | 9 | luma long-axis term budget |
| luma `dcBits` / `acBits` | 7 / `[6,5,4]` | luma DC bits, per-band AC bits |
| `CHROMA_MAX` | 5 | chroma long-axis term budget |
| chroma `dcBits` / `acBits` | 5 / `[4]` | |
| `ALPHA_MAX` | 5 | alpha long-axis term budget |
| alpha `dcBits` / `acBits` | 5 / `[4]` | |
| `scaleBits` | 6 | AC scale field width (all channels) |
| `SHORT_AXIS_MIN` | 3 | floor for the short-axis term count |
| `ESCAPE_LUMASHORT` | 10 | header luma-short sentinel = extreme aspect |
| `EXTREME_RATIO_BITS` | 5 | payload ratio field width (escape only) |
| `EXTREME_MAX_RATIO` | 1/3 | top of the escaped short/long range |
| `MAX_ENCODED_SIZE` | 51 | worst-case bytes (square + alpha) |

Per-channel quantization ranges (Part II.G):

| channel | signed DC | `dcMax` | `scaleMax` |
|---|---|---|---|
| luma (I) | no | 1530 | 765 |
| chroma (rg, by) | yes | 1530 | 1530 |
| alpha (A) | no | 255 | 128 |

## B. Header byte (byte 0)

MSB-first within the byte:

| bits | field | values |
|---|---|---|
| 7–5 | version | `000` = v1 (decoders MUST reject others) |
| 4 | hasAlpha | 0/1 |
| 3 | orientation | 0 = landscape (`W ≥ H`), 1 = portrait |
| 2–0 | lumaShort − 3 | stored 0..6 → lumaShort 3..9; stored 7 → lumaShort 10 = **escape** |

## C. Payload grammar (starts at byte 1, MSB-first bitstream)

```
payload := [ extremeRatio ]        ; present iff lumaShort == 10 (escape)
           channel(luma)
           channel(chroma:rg)      ; Lab-family order: red-green, then blue-yellow
           channel(chroma:by)
           [ channel(alpha) ]      ; present iff hasAlpha

extremeRatio := u(5)               ; 1..31, see II.E

channel(c) := u(scaleBits=6)                       ; AC scale, quantized over scaleMax
              dc(c)                                ; dcBits wide, signed-ness per channel
              AC[0..K-1]                           ; K = number of retained AC terms
; AC terms are emitted in the canonical triangular scan (II.F), each at its band's
; bit depth acBits[min(cx+cy-1, len-1)], as a mid-tread signed code (II.G).
```

After the last field, zero-fill to a byte boundary, then append zero bytes until the total length (header + payload) is a multiple of 3.

**Bit I/O.** Big-endian bit order. Writer emits each value's bits from MSB to LSB into a byte being filled MSB-first; on `finish()` a partial byte is left-aligned (low bits zero). Reader mirrors it: `bit = (byte >> (7 − bitPos)) & 1`, MSB first. Reading past the end is an error (`truncated`).

## D. Downsample (working grid)

`workingDims(W,H)`: if `max(W,H) ≤ 128` keep `W,H`; else `s = 128/max(W,H)`, `W' = max(1, round(W·s))`, `H' = max(1, round(H·s))`.

`resampleLinear` — exact area average. For destination pixel `(dx,dy)` covering source rectangle `[dx·sx, dx·sx+sx) × [dy·sy, dy·sy+sy)` where `sx=W/W'`, `sy=H/H'`, sum over every overlapped source pixel with weight `w = wx·wy` (axis overlap lengths):

```
wa = w · (Aₛ/255)
accR += srgbToLinear(Rₛ)·wa ;  accG,accB likewise
accA += wa                  ;  cov += w
```

Output: if `accA > 1e-6`: `R = linearToSrgb(accR/accA)` (etc.), `A = round(255·accA/cov)`; else the pixel is transparent black `(0,0,0,0)`. Color is averaged **premultiplied** in linear light and un-premultiplied on write.

**sRGB transfer** (`γ = 2.4`): `srgbToLinear(b) = c ≤ 0.04045 ? c/12.92 : ((c+0.055)/1.055)^γ`, `c=b/255`. `linearToSrgb(v)`: clamp `v∈[0,1]`, then `v ≤ 0.0031308 ? 12.92v : 1.055·v^(1/γ) − 0.055`, `×255` rounded and clamped to `[0,255]`. (Reference impl tabulates these; a direct computation is equivalent within ±1.)

## E. Aspect quantization & the extreme escape

Let `r = W_grid / H_grid`, `long/short = max(r, 1/r)`.

- **orientation** = `r ≥ 1 ? 0 : 1`.
- **extreme?** `round(9 / (long/short)) < 3`.
- If not extreme: `lumaShort = min(nx, ny)` from `splitByAspect(9, r)` (II.F) — an integer 3..9. Decoder recovers `r ≈ orientation==0 ? 9/lumaShort : lumaShort/9`.
- If extreme: header `lumaShort = 10`; write `extremeRatio = clamp(round((short/long) / (1/3) · 31), 1, 31)` as `u(5)`. Decoder recovers `short/long = ratioQ/31 · (1/3)`, then `r = orientation==0 ? 1/(short/long) : short/long`.

The layout is always built from the **reconstructed** `r`, so encoder and decoder agree.

## F. Allocation & coefficient scan

`splitByAspect(M, r)` → `{nx, ny}`:
```
if r ≥ 1:  nx = M,                                   ny = clamp(round(M/r), 3, M)
else:      nx = clamp(round(M·r), 3, M),             ny = M
```
`allocate(r, hasAlpha)`:
```
luma   = { splitByAspect(9, r),  dcBits 7, acBits [6,5,4] }
chroma = { splitByAspect(5, r),  dcBits 5, acBits [4] }
alpha  = hasAlpha ? { splitByAspect(5, r), dcBits 5, acBits [4] } : null
scaleBits = 6
```

**Retained coefficients / scan order.** Keep `(cx, cy)` with `cx·ny < nx·(ny−cy)` (equivalently `cx/nx + cy/ny < 1`). Iterate **cy outer** `0..ny−1`, **cx inner** starting at `cx = (cy==0 ? 1 : 0)`. `(0,0)` is DC; the rest are AC in exactly this order. Forward pack, unpack, inverse, and the window all use this identical sequence.

**AC band → bit depth.** For AC term `(cx,cy)`, `band = cx + cy − 1`, bit depth = `acBits[min(band, acBits.length−1)]`.

## G. Quantization & packing (per channel)

Let `k` be the channel's row from the ranges table (II.A). `bits2^ = (1<<bits)−1`.

- **AC scale:** `scale = max|AC|`; `scaleQ = clamp(round(scale/scaleMax · (2^scaleBits−1)), 0, 2^scaleBits−1)`; `dscale = scaleQ/(2^scaleBits−1) · scaleMax`. Write `scaleQ` as `u(scaleBits)`. (`scaleMax = vrange/2`, the exact upper bound on a normalized DCT-II AC coefficient, so it never clamps a real coefficient.)
- **DC:** width `dcBits`.
  - unsigned (luma, alpha): `q = clamp(round(dc/dcMax · (2^dcBits−1)), 0, 2^dcBits−1)`; inverse `dc = q/(2^dcBits−1) · dcMax`.
  - signed / mid-tread (chroma): `half = 1<<(dcBits−1)`; `q = clamp(round(dc/dcMax · half) + half, 0, 2^dcBits−1)`; inverse `dc = (q−half)/half · dcMax`.
- **AC terms** (mid-tread signed, per band): for each retained AC `(cx,cy)` in scan order, `bits = acBits[…]`, `half = 1<<(bits−1)`, `norm = dscale>0 ? ac/dscale : 0` (∈[−1,1]); write `clamp(round(norm·half) + half, 0, 2^bits−1)` as `u(bits)`; inverse `ac = (q−half)/half · dscale`.

Mid-tread means the center code decodes to exactly 0, so a zero AC term reconstructs as zero (no bias accumulating across many near-zero terms).

## H. Separable DCT

**Cosine table** (integer, cached): `cos[n,count]` has `cos[c][i] = round(cos(π/n · c · (i+0.5)) · 4096)` for `c∈[0,count)`, `i∈[0,n)`.

**Forward** `forwardDctChannel(plane, w, h, nx, ny)` — `w,h` are the *working-grid* dims:
```
row pass:   rowf[cx][y] = Σ_x plane[y·w+x] · cosX[cx][x]         (cosX = cos[w,nx])
col pass:   for each kept (cx,cy) in scan order:
              s = Σ_y rowf[cx][y] · cosY[cy][y]                  (cosY = cos[h,ny])
              f = s / (w · h · 4096²)
DC = f at (0,0); AC = the rest, in scan order.
```
The forward path is exact integer accumulation until the final `·(1/(w·h·4096²))`.

**Inverse** `inverseDctChannel(dc, ac, W, H, nx, ny)` — `W,H` are the *output* dims:
```
for each output pixel (x,y):
  v = dc + Σ_j ac[j] · cosX[cx][x] · (cosY[cy][y]·2) · (1/4096²)      (scan order j)
  out[y·W+x] = round(v)                                              (integers)
```
Note the asymmetry: forward normalizes all coefficients by `1/(w·h·4096²)`; inverse weights **AC by 2** (DC by 1) — the standard DCT-II analysis / DCT-III synthesis pair. Because the basis is re-evaluated at `W,H`, decode resolution is arbitrary.

## I. Lanczos anti-ring window (decode, **luma AC only**)

`sinc(x) = x==0 ? 1 : sin(πx)/(πx)`. For each AC term `(cx,cy)`, `w[j] = sinc(cx/nx)·sinc(cy/ny)`. Before the luma inverse DCT, scale `ac[j] ← ac[j]·w[j]`. DC is untouched; **chroma and alpha are not windowed** (color and transparency edges stay crisp).

## J. Color transform

**Alpha flatten** (encoder-side, on the working grid, before the transform). `hasAlpha = (any working-grid pixel's A ≠ 255)` - transparency that averages away in the downsample is not encoded. If `!hasAlpha`: RGB passes through unchanged and no alpha plane is encoded. If `hasAlpha`: composite each pixel's RGB over the image's alpha-weighted mean color `b_c = Σ(α·src_c) / Σα` per channel (`α = A/255`; if `Σα = 0` use `b = 0`) with the over operator `out = src·α + b·(1 − α)`, round-half-away-from-zero, clamp 0..255. `A` itself passes through unchanged and is encoded as its own plane. Boundary behavior holds exactly: `α = 0` → RGB becomes `b`; `α = 255` → RGB unchanged.

Per pixel (bytes 0..255), with alpha already flattened:
```
I  = 2·(R+G+B)          ; 0..1530
rg = 6·(R−G)            ; −1530..1530
by = 3·(R+G) − 6·B      ; −1530..1530
```
Inverse (round-half-away-from-zero, then clamp 0..255):
```
R = round((6·I + 2·by + 3·rg) / 36)
G = round((6·I + 2·by − 3·rg) / 36)
B = round((6·I − 4·by)        / 36)
```
Channels are DCT'd and packed in the order **I (luma), rg (chroma), by (chroma), A** - the L, a (red-green), b (blue-yellow) ordering of Lab-family opponent spaces.

## K. Framing, decode dims, base64

- **Assemble:** `out[0] = header`; append payload bytes; final length rounded up to a multiple of 3 with zero bytes. A valid FineHash length is ≥ 1 and a multiple of 3.
- **Output dims** (`decode(hash, {width?, height?})`): both given → use them; one given → derive the other from the aspect (`round`, min 1); neither → longest side `DEFAULT_LONGEST = 32` (`r≥1`: `32 × round(32/r)`, else `round(32·r) × 32`), min 1.
- **base64:** standard alphabet; because the byte length is a multiple of 3, the base64 form has no `=` padding. Max base64 length = `51/3·4 = 68`.

## L. Worst-case size (conformance check)

Square + alpha, no escape. Term counts (triangle `cx+cy < M`, minus DC): luma 44 AC, each chroma 14 AC, alpha 14 AC. Bits:

- luma  = 6 (scale) + 7 (DC) + [ band0:2·6 + band1:3·5 + bands≥2:39·4 ] = 6+7+183 = **196**
- chroma = 6 + 5 + 14·4 = **67** (×2 = 134)
- alpha = 6 + 5 + 14·4 = **67**
- header = **8**

Total = 8 + 196 + 134 + 67 = **405 bits = 50.625 B → 51 B** (padded to a multiple of 3).

## M. Conformance properties (test the behavior, not any reference bytes)

1. **Header round-trips**: pack/unpack of every `(hasAlpha, orientation, lumaShort∈3..10)`.
2. **Bit I/O**: writing then reading a random field sequence recovers it; a partial final byte is zero-padded; over-read throws.
3. **Color**: gray `(v,v,v)` → `rg=by=0`; opaque round-trip within ±1; a flattened transparent pixel takes the mean color and keeps `A=0`.
4. **Allocation determinism**: `allocate(r, α)` identical on repeat; `r`↔`1/r` transpose; square → full `M×M`; extreme aspect flips to the escape.
5. **DCT**: a constant plane → `DC = the constant`, all `AC = 0`; a reconstructed constant is flat at any output size.
6. **Codec**: `encode` output length is a multiple of 3 and ≤ 51; `decode` of it at some `W×H` yields a plausible blur (DC ≈ mean color); truncated/oversized/`len%3≠0` inputs throw; unknown version byte throws.
7. **Resolution independence**: decoding one code at 16×16 vs 64×64 gives consistent low-frequency content (downscaling the larger ≈ the smaller).

---

## Prior art (for the two primitive stages)

- Porter, T. & Duff, T. (1984). *Compositing Digital Images.* SIGGRAPH — alpha flatten.
- Rao, K. R. & Yip, P. (1990). *Discrete Cosine Transform.* — separable DCT / energy compaction underlying the term allocation.

Everything else (opponent scaling, triangular truncation, the fixed allocation table, mid-tread scale/DC/AC packing, the header/escape format, the Lanczos decode window) is FineHash's own definition.

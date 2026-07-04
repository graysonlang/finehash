# FineHash

Deterministic image **placeholder hashes** - a tiny, base64-friendly string that lives in a database column and decodes to a blurred preview before the real image loads. FineHash is in the family of low-quality image placeholders (LQIP) like [ThumbHash](https://evanw.github.io/thumbhash/) and [BlurHash](https://blurha.sh/); it averages in linear light and spends extra bits on low-frequency luma so smooth gradients don't band at blur scale.

A single dependency-free ES module. The format is fully specified in [format-spec.md](format-spec.md).

## Install

```
npm install @graysonlang/finehash
```

## Usage

```js
import { encode, decode, toBase64, fromBase64 } from '@graysonlang/finehash';

// rgba: tightly-packed RGBA bytes (4 per pixel, row-major)
const hash = encode(rgba, width, height);   // Uint8Array  (<= 51 bytes)
const text = toBase64(hash);                 // string      (<= 68 chars)

// decode returns its natural aspect-derived size unless you pass width/height.
// The DCT is resolution-independent, so you can decode straight at display size.
const { rgba: preview, width: w, height: h } = decode(fromBase64(text), { width: 320 });
```

### API

```ts
encode(rgba, width, height) -> Uint8Array
decode(hash, opts?: { width?, height? }) -> { rgba, width, height, hasAlpha, aspectRatio }
toBase64(hash) -> string
fromBase64(base64) -> Uint8Array
downsampleToWorkingGrid(rgba, width, height, maxSide?) -> { data, width, height }
```

`rgba` in and out is tightly-packed RGBA (4 bytes/pixel, row-major). Passing only one of `width`/`height` to `decode` derives the other from the stored aspect ratio.

## How it works

Encoding is deterministic (integer / fixed-point throughout, so the same pixels yield the same bytes on every platform):

1. **Gamma-correct downsample** to a working grid (longest side <= 128): an area-average box filter in *linear light* with alpha-weighted coverage. Averaging gamma-encoded bytes directly darkens gradients and is where banding starts.
2. **Opponent color decorrelation**: an achromatic intensity axis plus two chromatic axes - `I=(R+G+B)/3`, `rg=R-G`, `by=(R+G)/2-B` - carried at 6x scale so the forward transform is exact integer arithmetic. Partially-transparent pixels are first flattened over the image's average color so undefined color doesn't inject spurious high-frequency energy.
3. **Separable DCT-II** with triangular truncation (keep terms where `cx/nx + cy/ny < 1`) over a precomputed fixed-point cosine basis.
4. **Quantize and bit-pack** per a fixed allocation into one header byte plus a bit-packed payload, padded to a multiple of 3 bytes so the base64 form needs no `=`.

Decoding is deliberately relaxed (floating point allowed): parse the header, dequantize, apply a decode-side Lanczos anti-ring window to luma (suppressing ringing at hard edges), inverse DCT at the requested output size, and reconstruct RGBA.

The full byte layout, constants, and per-stage math are in [format-spec.md](format-spec.md).

## Size

One fixed allocation, no quality levels. Size floats with aspect ratio and alpha under a single bound:

| Case                        | Bytes | Base64 |
|-----------------------------|-------|--------|
| Square + alpha (worst case) | 51    | 68     |
| Square, opaque              | 45    | 60     |
| 16:9 landscape, opaque      | 33    | 44     |

Every hash fits `VARCHAR(68)`.

## Structure

- [src/finehash.js](src/finehash.js) - the entire library (one ES module, no runtime dependencies).
- [demo/](demo/) - a side-by-side comparison demo (FineHash vs BlurHash, ThumbHash, and an uber-compressed WebP), bundled with esbuild and deployed to GitHub Pages.
- [scripts/](scripts/) - the demo build (`build.mjs`) and a `gen:samples` renderer for the procedural test images (`gen-samples.mjs`).
- [format-spec.md](format-spec.md) - the specification the implementation is built from.

### Local demo

The library itself has no dependencies; the demo does (esbuild, blurhash, thumbhash). To run it:

```
npm install
npm run serve      # dev server with live reload
npm run build      # or produce a static bundle in www/
```

# @graysonlang/finehash

Deterministic image **placeholder hashes** - a tiny, base64-friendly string that lives in a database column and decodes to a blurred preview before the real image loads. FineHash is in the same family as [BlurHash](https://blurha.sh/) and [ThumbHash](https://github.com/evanw/thumbhash); it averages in linear light and spends extra bits on low-frequency luma to keep smooth gradients from banding at blur scale, in exchange for a larger payload (roughly 2x ThumbHash).

**[Live demo](https://graysonlang.github.io/finehash/)** - drop in your own image and compare FineHash against BlurHash, ThumbHash, and an uber-compressed WebP.

## Install

```sh
npm install @graysonlang/finehash
```

## Usage

```ts
import { encode, encodeToBase64, decode, decodeFromBase64, maxBase64Length } from '@graysonlang/finehash';

const hash = encode(rgba, width, height);             // Uint8Array  (<= 51 bytes)
const { pixels, width: w, height: h } = decode(hash); //             RGBA placeholder

const text = encodeToBase64(rgba, width, height);     // string      (<= 68 chars)
decodeFromBase64(text, { width: 320 });               //             height is aspect-derived

maxBase64Length(); // 68 - size a VARCHAR column without encoding anything
```

```ts
encode(pixels: RGBA, width, height): Uint8Array
encodeToBase64(pixels: RGBA, width, height): string

decode(hash: Uint8Array, opts?: { width?: number; height?: number }): {
  pixels: RGBA; width: number; height: number; hasAlpha: boolean
}
decodeFromBase64(hash: string, opts?: { width?: number; height?: number }): DecodeResult

maxEncodedSize(): number  // bytes (51)
maxBase64Length(): number // base64 chars (68)
```

`pixels` is tightly-packed RGBA (4 bytes/pixel, row-major). `decode` returns its natural aspect-derived size unless you pass `width`, `height`, or both - the DCT is resolution-independent, so you can decode straight at display size with no separate upscale.

**Decode-only consumers.** The encoder and decoder share no mutable state and the package is side-effect-free, so importing just `decode` lets any tree-shaking bundler drop the encoder (plus the downsampler and gamma tables it needs) - roughly half the bytes (~1.8 KB gzipped vs ~3.5 KB for the full surface). No separate entry point needed; `import { decode } from '@graysonlang/finehash'` is enough.

## How it works

FineHash concentrates its byte budget on low-frequency luma bit depth and downsamples in linear light, so gamma handling doesn't bake banding into the placeholder before it is ever encoded.

**Encode** (deterministic; integer / fixed-point throughout, so the same pixels yield the same bytes on every platform):

1. **Gamma-correct downsample** to a <=100x100 working grid: an area-average box filter in *linear light* (sRGB -> linear, average, -> sRGB) with alpha-weighted coverage. Averaging gamma-encoded bytes directly darkens every gradient; this is where banding starts, so it is fixed first.
2. **LPQ color decorrelation** (lifted from ThumbHash): `L=(R+G+B)/3`, `P=(R+G)/2-B`, `Q=R-G`, carried at 6x scale so the forward transform is exact integer arithmetic.
3. **Separable DCT-II** with triangular truncation - keep terms where `cx/nx + cy/ny < 1` - over a precomputed fixed-point cosine basis.
4. **Quantize and bit-pack** per the fixed allocation below, into one header byte plus a bit-packed payload padded to a multiple of 3 bytes (so the base64 form needs no `=`).

**Decode** is deliberately relaxed (floating point allowed; +/-1/channel differences across platforms are harmless): parse the header -> dequantize -> apply a decode-side Lanczos anti-ring window to luma (`sinc(cx/nx)*sinc(cy/ny)`, suppressing Gibbs ringing at hard edges) -> inverse DCT -> RGBA. No chroma-saturation boost is applied - the richer default chroma already matches the source.

### Format

A FineHash is **one self-describing header byte** followed by the bit-packed coefficient payload. There are no length or layout fields on the wire: the layout is derived entirely from `(aspectRatio, hasAlpha)` by a shared allocation function, so the allocation function *is* the spec.

| Bits | Field         | Meaning                                       |
|------|---------------|-----------------------------------------------|
| 7-5  | `version`     | `000` = v1; decoders reject unknown versions. |
| 4    | `hasAlpha`    | 1 if an alpha channel is encoded.             |
| 3    | `orientation` | 0 = landscape (w >= h), 1 = portrait.         |
| 2-0  | `lumaShort`   | Luma short-axis term count - 3 (-> 3..9). This *is* the aspect ratio; the long axis is fixed at 9. Value `7` is the **escape sentinel** - too extreme for the implicit count, so a precise 5-bit ratio is payloaded ahead of the channels. |

Bit ordering: every field - the header byte and the payload that follows - is packed most-significant-bit first (bit 7 is the MSB). A FineHash is a plain byte string with no multi-byte integers, so byte-order endianness never applies. Any final partial byte is left-aligned, with the unused low bits zeroed.

The fixed per-channel allocation (luma carries full depth; chroma and alpha run leaner):

| Channel       | max dim | DC bits | DC signed | AC bits (per band) | scale |
|---------------|---------|---------|-----------|--------------------|-------|
| L (luma)      | 9       | 7       | no        | `[6, 5, 4]`        | u6    |
| P, Q (chroma) | 5       | 5       | yes       | `[4]`              | u6    |
| A (alpha)     | 5       | 5       | no        | `[4]`              | u6    |

Each AC coefficient's width comes from its frequency band (`cx + cy - 1`, clamped) via the channel's `acBits` schedule - the deep low-frequency luma bands are the anti-banding lever. Each channel also stores one quantized max-`|AC|` scale; signed values use a mid-tread quantizer so a zero coefficient reconstructs as exactly zero.

**Size.** One fixed allocation, no quality levels. Actual size floats with aspect ratio and alpha under a single bound:

| Case                        | Bytes | Base64 |
|-----------------------------|-------|--------|
| Square + alpha (worst case) | 51    | 68     |
| Square, opaque              | 45    | 60     |
| 16:9 landscape, opaque      | 33    | 44     |

Every hash fits `VARCHAR(68)` - roughly 2x ThumbHash.

## Structure

- [src/](src/) - the TypeScript library. `index.ts` re-exports the full surface (used by the tests); `public.ts` is the smaller surface bundled to npm.
- [example/app/](example/app/) - the drag-and-drop comparison demo deployed to GitHub Pages, with sample images under [example/app/assets/](example/app/assets/).
- [scripts/build.mjs](scripts/build.mjs) - builds the demo. [scripts/dist.mjs](scripts/dist.mjs) - bundles the single-file library + type declarations for publishing.
- [test/](test/) - the unit suite (`npm test`).

## Development

```sh
npm install
npm run dev        # watch + serve the demo (auto-launches Chrome)
npm run build      # one-shot demo build into dist/
npm test           # run the unit suite
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run dist       # build the publishable library bundle + .d.ts
```

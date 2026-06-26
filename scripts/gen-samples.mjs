// Render every procedural demo sample to a PNG under dist/samples/.
//
// The sample definitions live in example/app/samples.mjs and are shared with the
// browser demo; here they are drawn with @napi-rs/canvas (headless) instead of a
// DOM canvas, then written out as files.
//
// Run: npm run gen:samples

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas, ImageData } from '@napi-rs/canvas';

import { createSampleSuite } from '../example/app/samples.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'dist', 'samples');

const build = createSampleSuite({
  makeCanvas: (w, h) => {
    const canvas = createCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d') };
  },
  makeImageData: (data, w, h) => new ImageData(data, w, h),
});

await mkdir(outDir, { recursive: true });

const samples = build();
await Promise.all(samples.map(({ name, canvas }) =>
  writeFile(path.join(outDir, name), canvas.toBuffer('image/png')),
));

console.log(`gen-samples: wrote ${samples.length} PNGs to ${path.relative(root, outDir)}/`);
for (const { name } of samples) console.log(`  ${name}`);

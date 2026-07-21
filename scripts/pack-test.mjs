// Deploy test: verify the package as a consumer would receive it.
//
//   node scripts/pack-test.mjs
//
// Builds the exact tarball `npm publish` would ship, installs it into a
// throwaway project, and checks:
//   - the tarball carries src/ + package metadata and nothing stray
//   - the package imports by name (ESM) and round-trips a FineHash
//   - the bundled type declarations type-check for a strict consumer

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finehash-pack-test-'));
const npmCache = path.join(tmp, '.npm-cache');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    ...opts,
    env: { ...process.env, npm_config_cache: npmCache, ...opts.env },
  });

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${label}: ${e.message}`);
  }
};

try {
  const packOut = run('npm', ['pack', '--pack-destination', tmp], { cwd: repo });
  const tarball = path.join(tmp, packOut.trim().split('\n').pop());

  check('tarball contents are src/ + metadata only', () => {
    const listing = run('tar', ['-tzf', tarball]);
    const entries = listing.trim().split('\n').map(l => l.replace(/^package\//, ''));
    if (!entries.includes('src/finehash.js')) throw new Error('src/finehash.js missing');
    if (!entries.includes('src/finehash.d.ts')) throw new Error('src/finehash.d.ts missing');
    const stray = entries.filter(
      e => !e.startsWith('src/') && !['package.json', 'README.md', 'LICENSE.md'].includes(e),
    );
    if (stray.length) throw new Error(`unexpected files in tarball: ${stray.join(', ')}`);
  });

  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  run('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: consumer });

  fs.writeFileSync(
    path.join(consumer, 'smoke.mjs'),
    `
import { MAX_ENCODED_SIZE, decode, downsampleToWorkingGrid, encode, fromBase64, toBase64 } from ${JSON.stringify(pkg.name)};
const w = 40, h = 24;
const px = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 4;
  px[i] = (x * 9) & 255; px[i + 1] = (y * 13) & 255; px[i + 2] = 180;
  px[i + 3] = Math.min(255, 48 + x * 5);
}
const hash = encode(px, w, h);
if (!(hash instanceof Uint8Array)) throw new Error('encode did not return Uint8Array');
if (hash.length % 3 || hash.length > MAX_ENCODED_SIZE) throw new Error('bad hash length');
const b64 = toBase64(hash);
if (b64.includes('=')) throw new Error('base64 should be unpadded');
const round = fromBase64(b64);
if (round.length !== hash.length || round.some((v, i) => v !== hash[i])) throw new Error('base64 roundtrip mismatch');
const decoded = decode(round, { width: w, height: h });
if (decoded.width !== w || decoded.height !== h || !decoded.hasAlpha) throw new Error('bad decode metadata');
if (decoded.rgba.length !== w * h * 4) throw new Error('bad decoded pixels');
const grid = downsampleToWorkingGrid(px, w, h, 20);
if (grid.width !== 20 || grid.height < 1 || grid.data.length !== grid.width * grid.height * 4) {
  throw new Error('bad downsample grid');
}
console.log('smoke: encode/decode/base64/downsample ok');
`,
  );
  check('installed package works via node ESM import', () => {
    run('node', ['smoke.mjs'], { cwd: consumer });
  });

  fs.writeFileSync(
    path.join(consumer, 'consumer.ts'),
    `
import {
  DEFAULT_LONGEST,
  MAX_ENCODED_SIZE,
  decode,
  downsampleToWorkingGrid,
  encode,
  fromBase64,
  toBase64,
  type ByteArray,
  type DecodeOptions,
  type DecodeResult,
} from ${JSON.stringify(pkg.name)};

const rgba: ByteArray = new Uint8ClampedArray(4);
const hash: Uint8Array = encode(rgba, 1, 1);
const base64: string = toBase64(hash);
const raw: Uint8Array = fromBase64(base64);
const opts: DecodeOptions = { width: 8 };
const result: DecodeResult = decode(raw, opts);
const grid: { data: Uint8ClampedArray; width: number; height: number } =
  downsampleToWorkingGrid(rgba, 1, 1, 1);
const maxSize: number = MAX_ENCODED_SIZE;
const defaultLongest: number = DEFAULT_LONGEST;
void result; void grid; void maxSize; void defaultLongest;
`,
  );
  fs.writeFileSync(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['consumer.ts'],
    }),
  );
  check('type declarations pass strict tsc', () => {
    run(path.join(repo, 'node_modules', '.bin', 'tsc'), ['-p', '.'], { cwd: consumer });
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} deploy-test failure(s)`);
  process.exit(1);
}
console.log('\ndeploy test: package is publishable');
